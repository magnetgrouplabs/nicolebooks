// test/qbo-tokens.test.ts
//
// QBO-02 coverage for the token lifecycle: proactive refresh, rotation persisted before use, the
// invalid_grant to 'expired' path, and the credential guards.
//
// THE ASSERTION THAT MATTERS MOST is the ordering one. Intuit rotates the refresh token and kills
// the one that was sent, so a refresh that returns before persisting, or that writes the access
// token first and then crashes, leaves a dead credential on disk. The failure is invisible for up
// to an hour, and then the connection stops working with nothing to point at. The fake store
// records write order precisely so that ordering can be pinned rather than assumed.
//
// Everything runs against a fake store, a fake fetch, and a fake clock, so there is no Electron, no
// safeStorage, and no network anywhere in this file.

import { describe, expect, it, vi } from 'vitest'
import { createFakeSecretStore, jsonResponse, textResponse } from './helpers/fake-secret-store'
import {
  QBO_CLIENT_CREDENTIALS_MISSING,
  QBO_NOT_CONNECTED,
  QBO_REAUTH_REQUIRED,
  QBO_SECRET_STORE_UNAVAILABLE,
  QBO_TOKEN_EXCHANGE_FAILED,
  QBO_TOKEN_REFRESH_FAILED
} from '../src/main/qbo/errors'
import {
  QBO_ACCESS_TOKEN_SECRET,
  QBO_CLIENT_ID_SECRET,
  QBO_CLIENT_SECRET_SECRET,
  QBO_REFRESH_TOKEN_SECRET,
  QBO_TOKEN_EXPIRY_SECRET
} from '../src/main/qbo/secret-keys'
import {
  REFRESH_SKEW_MS,
  assertSecretStoreAvailable,
  clearTokenSet,
  exchangeAuthorizationCode,
  getAccessToken,
  needsRefresh,
  readClientCredentials,
  readTokenSet,
  refreshTokenSet,
  requireClientCredentials,
  writeTokenSet
} from '../src/main/qbo/tokens'

const NOW = Date.parse('2026-07-27T12:00:00.000Z')

/** A store holding valid app credentials and a connected token set. */
function connectedStore(overrides: Record<string, string> = {}) {
  return createFakeSecretStore({
    [QBO_CLIENT_ID_SECRET]: 'client-id-value',
    [QBO_CLIENT_SECRET_SECRET]: 'client-secret-value',
    [QBO_ACCESS_TOKEN_SECRET]: 'access-old',
    [QBO_REFRESH_TOKEN_SECRET]: 'refresh-old',
    [QBO_TOKEN_EXPIRY_SECRET]: String(NOW + 60 * 60 * 1000),
    ...overrides
  })
}

function deps(store: ReturnType<typeof connectedStore>, fetchImpl: typeof globalThis.fetch) {
  return { secretStore: store, fetch: fetchImpl, now: () => NOW }
}

describe('reading and writing the token set', () => {
  it('returns null when nothing is stored', () => {
    expect(readTokenSet({ secretStore: createFakeSecretStore() })).toBeNull()
  })

  it('treats a missing refresh token as not connected even when an access token survives', () => {
    // A stray access token without its refresh token is unusable: it expires within the hour and
    // there is nothing to renew it with. Reporting it as a connection would show "Connected" on a
    // card that is about to stop working.
    const store = createFakeSecretStore({ [QBO_ACCESS_TOKEN_SECRET]: 'orphan' })
    expect(readTokenSet({ secretStore: store })).toBeNull()
  })

  it('reads an unparseable expiry as 0 rather than discarding the connection', () => {
    // An expiry we cannot trust must force a refresh, not throw away a working refresh token.
    const store = createFakeSecretStore({
      [QBO_REFRESH_TOKEN_SECRET]: 'refresh-old',
      [QBO_ACCESS_TOKEN_SECRET]: 'access-old',
      [QBO_TOKEN_EXPIRY_SECRET]: 'not-a-number'
    })
    const tokens = readTokenSet({ secretStore: store })
    expect(tokens?.refreshToken).toBe('refresh-old')
    expect(tokens?.expiresAt).toBe(0)
    expect(needsRefresh(tokens!, NOW)).toBe(true)
  })

  it('writes the refresh token FIRST, so an interrupted write cannot strand the connection', () => {
    const store = createFakeSecretStore()
    writeTokenSet({ accessToken: 'a', refreshToken: 'r', expiresAt: NOW }, { secretStore: store })
    expect(store.keysWritten).toEqual([
      QBO_REFRESH_TOKEN_SECRET,
      QBO_ACCESS_TOKEN_SECRET,
      QBO_TOKEN_EXPIRY_SECRET
    ])
  })

  it('clears the token set but KEEPS the Intuit app credentials', () => {
    // Client id and secret identify the app, not the connection. Deleting them would make a
    // disconnect followed by a reconnect require pasting them again.
    const store = connectedStore()
    clearTokenSet({ secretStore: store })
    expect(store.deletes).toEqual([
      QBO_ACCESS_TOKEN_SECRET,
      QBO_REFRESH_TOKEN_SECRET,
      QBO_TOKEN_EXPIRY_SECRET
    ])
    expect(store.get(QBO_CLIENT_ID_SECRET)).toBe('client-id-value')
    expect(store.get(QBO_CLIENT_SECRET_SECRET)).toBe('client-secret-value')
  })
})

describe('client credentials', () => {
  it('reads both halves or nothing', () => {
    const both = createFakeSecretStore({
      [QBO_CLIENT_ID_SECRET]: 'id',
      [QBO_CLIENT_SECRET_SECRET]: 'secret'
    })
    expect(readClientCredentials({ secretStore: both })).toEqual({
      clientId: 'id',
      clientSecret: 'secret'
    })

    const halfway = createFakeSecretStore({ [QBO_CLIENT_ID_SECRET]: 'id' })
    expect(readClientCredentials({ secretStore: halfway })).toBeNull()
  })

  it('throws the missing-credentials code rather than proceeding with a half configuration', () => {
    const store = createFakeSecretStore()
    expect(() => requireClientCredentials({ secretStore: store })).toThrow(
      QBO_CLIENT_CREDENTIALS_MISSING
    )
  })

  it('refuses to proceed when the OS keychain backend is unavailable', () => {
    const store = createFakeSecretStore()
    store.encryptionAvailable = false
    expect(() => assertSecretStoreAvailable({ secretStore: store })).toThrow(
      QBO_SECRET_STORE_UNAVAILABLE
    )
  })
})

describe('needsRefresh honours the proactive skew', () => {
  it('is false for a token comfortably inside its life', () => {
    expect(needsRefresh({ accessToken: 'a', refreshToken: 'r', expiresAt: NOW + 60 * 60 * 1000 }, NOW)).toBe(false)
  })

  it('is true exactly at the skew boundary', () => {
    // At the boundary the token could expire inside a single long operation, so it is refreshed.
    expect(needsRefresh({ accessToken: 'a', refreshToken: 'r', expiresAt: NOW + REFRESH_SKEW_MS }, NOW)).toBe(true)
  })

  it('is false one millisecond outside the boundary', () => {
    expect(needsRefresh({ accessToken: 'a', refreshToken: 'r', expiresAt: NOW + REFRESH_SKEW_MS + 1 }, NOW)).toBe(false)
  })

  it('is true when there is no access token at all', () => {
    expect(needsRefresh({ accessToken: '', refreshToken: 'r', expiresAt: NOW + 60 * 60 * 1000 }, NOW)).toBe(true)
  })
})

describe('refreshTokenSet persists the rotation before returning', () => {
  it('writes the NEW refresh token to the store before the caller can use the new access token', async () => {
    const store = connectedStore()
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ access_token: 'access-new', refresh_token: 'refresh-new', expires_in: 3600 })
    ) as unknown as typeof globalThis.fetch

    const result = await refreshTokenSet(deps(store, fetchImpl))

    // The rotated value is on disk by the time the promise settles. That is the whole guarantee:
    // whatever the caller does next, even throwing, cannot lose it.
    expect(store.get(QBO_REFRESH_TOKEN_SECRET)).toBe('refresh-new')
    expect(store.get(QBO_ACCESS_TOKEN_SECRET)).toBe('access-new')
    expect(store.get(QBO_TOKEN_EXPIRY_SECRET)).toBe(String(NOW + 3600 * 1000))
    expect(result.accessToken).toBe('access-new')
    expect(result.refreshToken).toBe('refresh-new')
    // Refresh token first, again, on the rotation path.
    expect(store.keysWritten).toEqual([
      QBO_REFRESH_TOKEN_SECRET,
      QBO_ACCESS_TOKEN_SECRET,
      QBO_TOKEN_EXPIRY_SECRET
    ])
  })

  it('sends the CURRENT stored refresh token, re-read at call time', async () => {
    const store = connectedStore()
    let sentBody = ''
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      sentBody = String(init?.body ?? '')
      return jsonResponse({ access_token: 'a2', refresh_token: 'r2', expires_in: 3600 })
    }) as unknown as typeof globalThis.fetch

    // Something rotated the stored value between operations. The refresh must use what is on disk
    // NOW, not a value captured earlier, or it replays a token Intuit has already killed.
    store.values.set(QBO_REFRESH_TOKEN_SECRET, 'refresh-rotated-elsewhere')
    await refreshTokenSet(deps(store, fetchImpl))

    expect(sentBody).toContain('refresh_token=refresh-rotated-elsewhere')
    expect(sentBody).toContain('grant_type=refresh_token')
  })

  it('keeps the existing refresh token when Intuit answers without a new one', async () => {
    const store = connectedStore()
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ access_token: 'access-new', expires_in: 3600 })
    ) as unknown as typeof globalThis.fetch

    const result = await refreshTokenSet(deps(store, fetchImpl))
    expect(result.refreshToken).toBe('refresh-old')
    expect(store.get(QBO_REFRESH_TOKEN_SECRET)).toBe('refresh-old')
  })

  it('defaults the lifetime when expires_in is absent rather than expiring immediately', async () => {
    const store = connectedStore()
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ access_token: 'a', refresh_token: 'r' })
    ) as unknown as typeof globalThis.fetch

    const result = await refreshTokenSet(deps(store, fetchImpl))
    expect(result.expiresAt).toBe(NOW + 3600 * 1000)
  })

  it('sends HTTP Basic built from the stored client credentials', async () => {
    const store = connectedStore()
    let auth = ''
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      auth = String((init?.headers as Record<string, string>)?.['Authorization'] ?? '')
      return jsonResponse({ access_token: 'a', refresh_token: 'r', expires_in: 3600 })
    }) as unknown as typeof globalThis.fetch

    await refreshTokenSet(deps(store, fetchImpl))
    const expected = Buffer.from('client-id-value:client-secret-value', 'utf8').toString('base64')
    expect(auth).toBe(`Basic ${expected}`)
  })
})

describe('refreshTokenSet failure classification', () => {
  it('maps invalid_grant to the reauthorization code', async () => {
    const store = connectedStore()
    const fetchImpl = vi.fn(async () =>
      textResponse('{"error":"invalid_grant"}', 400)
    ) as unknown as typeof globalThis.fetch

    await expect(refreshTokenSet(deps(store, fetchImpl))).rejects.toThrow(QBO_REAUTH_REQUIRED)
  })

  it('maps a 5xx to the RETRYABLE code, not to reauthorization', async () => {
    // Telling somebody to sign in again over an Intuit outage would be a lie that costs them a
    // browser round trip and still fails.
    const store = connectedStore()
    const fetchImpl = vi.fn(async () =>
      textResponse('service unavailable', 503)
    ) as unknown as typeof globalThis.fetch

    await expect(refreshTokenSet(deps(store, fetchImpl))).rejects.toThrow(QBO_TOKEN_REFRESH_FAILED)
  })

  it('maps a thrown network error to the retryable code', async () => {
    const store = connectedStore()
    const fetchImpl = vi.fn(async () => {
      throw new Error('getaddrinfo ENOTFOUND oauth.platform.intuit.com')
    }) as unknown as typeof globalThis.fetch

    await expect(refreshTokenSet(deps(store, fetchImpl))).rejects.toThrow(QBO_TOKEN_REFRESH_FAILED)
  })

  it('never lets the provider response body into the thrown error', async () => {
    // An Intuit fault body carries the request URL and can carry the client id.
    const store = connectedStore()
    const body = 'invalid_grant for client_id=ABqUf65aKcrFRI9J at https://oauth.platform.intuit.com/x'
    const fetchImpl = vi.fn(async () => textResponse(body, 400)) as unknown as typeof globalThis.fetch

    const rejection = await refreshTokenSet(deps(store, fetchImpl)).catch((err: unknown) => err)
    const text = `${(rejection as Error).message} ${(rejection as Error).stack ?? ''}`
    expect(text).not.toContain('ABqUf65aKcrFRI9J')
    expect(text).not.toContain('oauth.platform.intuit.com')
  })

  it('does NOT clear the stored tokens on invalid_grant', async () => {
    // Keeping the dead refresh token is what lets the status read 'expired' rather than
    // 'disconnected', which is the difference between "press Reconnect" and "set this up again".
    const store = connectedStore()
    const fetchImpl = vi.fn(async () =>
      textResponse('invalid_grant', 400)
    ) as unknown as typeof globalThis.fetch

    await refreshTokenSet(deps(store, fetchImpl)).catch(() => null)
    expect(store.get(QBO_REFRESH_TOKEN_SECRET)).toBe('refresh-old')
  })

  it('rejects a malformed success body rather than storing a broken token set', async () => {
    const store = connectedStore()
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ nothing: 'useful' })
    ) as unknown as typeof globalThis.fetch

    await expect(refreshTokenSet(deps(store, fetchImpl))).rejects.toThrow(QBO_TOKEN_REFRESH_FAILED)
    expect(store.get(QBO_ACCESS_TOKEN_SECRET)).toBe('access-old')
  })

  it('refuses to refresh when nothing is connected', async () => {
    const store = createFakeSecretStore({
      [QBO_CLIENT_ID_SECRET]: 'id',
      [QBO_CLIENT_SECRET_SECRET]: 'secret'
    })
    const fetchImpl = vi.fn() as unknown as typeof globalThis.fetch
    await expect(refreshTokenSet({ secretStore: store, fetch: fetchImpl, now: () => NOW })).rejects.toThrow(
      QBO_NOT_CONNECTED
    )
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

describe('getAccessToken refreshes proactively', () => {
  it('returns the stored token without a network call when it is fresh', async () => {
    const store = connectedStore()
    const fetchImpl = vi.fn() as unknown as typeof globalThis.fetch
    await expect(getAccessToken(deps(store, fetchImpl))).resolves.toBe('access-old')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('refreshes when the token is inside the ten-minute window, before any request is made', async () => {
    const store = connectedStore({ [QBO_TOKEN_EXPIRY_SECRET]: String(NOW + 5 * 60 * 1000) })
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ access_token: 'access-fresh', refresh_token: 'refresh-fresh', expires_in: 3600 })
    ) as unknown as typeof globalThis.fetch

    await expect(getAccessToken(deps(store, fetchImpl))).resolves.toBe('access-fresh')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(store.get(QBO_REFRESH_TOKEN_SECRET)).toBe('refresh-fresh')
  })

  it('refreshes an already-expired token', async () => {
    const store = connectedStore({ [QBO_TOKEN_EXPIRY_SECRET]: String(NOW - 1000) })
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ access_token: 'access-fresh', refresh_token: 'refresh-fresh', expires_in: 3600 })
    ) as unknown as typeof globalThis.fetch

    await expect(getAccessToken(deps(store, fetchImpl))).resolves.toBe('access-fresh')
  })

  it('reports not connected when the store is empty', async () => {
    const store = createFakeSecretStore()
    const fetchImpl = vi.fn() as unknown as typeof globalThis.fetch
    await expect(getAccessToken({ secretStore: store, fetch: fetchImpl, now: () => NOW })).rejects.toThrow(
      QBO_NOT_CONNECTED
    )
  })
})

describe('exchangeAuthorizationCode', () => {
  it('posts the code and redirect URI and returns the first token set', async () => {
    let body = ''
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      body = String(init?.body ?? '')
      return jsonResponse({ access_token: 'a1', refresh_token: 'r1', expires_in: 3600 })
    }) as unknown as typeof globalThis.fetch

    const tokens = await exchangeAuthorizationCode(
      {
        code: 'auth-code',
        redirectUri: 'http://localhost:8734/oauth/callback',
        credentials: { clientId: 'id', clientSecret: 'secret' }
      },
      { fetch: fetchImpl, now: () => NOW }
    )

    expect(body).toContain('grant_type=authorization_code')
    expect(body).toContain('code=auth-code')
    expect(body).toContain('redirect_uri=http')
    expect(tokens).toEqual({ accessToken: 'a1', refreshToken: 'r1', expiresAt: NOW + 3600 * 1000 })
  })

  it('does NOT persist anything itself, so a half-connected state cannot be observed', async () => {
    // The caller stores the tokens and the realm id together; writing here would let a status read
    // land between the two.
    const store = createFakeSecretStore()
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ access_token: 'a1', refresh_token: 'r1', expires_in: 3600 })
    ) as unknown as typeof globalThis.fetch

    await exchangeAuthorizationCode(
      {
        code: 'c',
        redirectUri: 'http://localhost:8734/oauth/callback',
        credentials: { clientId: 'id', clientSecret: 'secret' }
      },
      { secretStore: store, fetch: fetchImpl, now: () => NOW }
    )
    expect(store.keysWritten).toEqual([])
  })

  it('maps a rejected exchange to its own code and forwards no response text', async () => {
    const fetchImpl = vi.fn(async () =>
      textResponse('invalid_client for ABqUf65aKcrFRI9J', 401)
    ) as unknown as typeof globalThis.fetch

    const rejection = await exchangeAuthorizationCode(
      {
        code: 'c',
        redirectUri: 'http://localhost:8734/oauth/callback',
        credentials: { clientId: 'id', clientSecret: 'secret' }
      },
      { fetch: fetchImpl, now: () => NOW }
    ).catch((err: unknown) => err)

    expect((rejection as Error).message).toBe(QBO_TOKEN_EXCHANGE_FAILED)
    expect((rejection as Error).message).not.toContain('ABqUf65aKcrFRI9J')
  })

  it('rejects a success body with no refresh token', async () => {
    // Without a refresh token the connection would die silently within the hour.
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ access_token: 'a1', expires_in: 3600 })
    ) as unknown as typeof globalThis.fetch

    await expect(
      exchangeAuthorizationCode(
        {
          code: 'c',
          redirectUri: 'http://localhost:8734/oauth/callback',
          credentials: { clientId: 'id', clientSecret: 'secret' }
        },
        { fetch: fetchImpl, now: () => NOW }
      )
    ).rejects.toThrow(QBO_TOKEN_EXCHANGE_FAILED)
  })
})
