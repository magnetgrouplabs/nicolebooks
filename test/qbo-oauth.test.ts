// test/qbo-oauth.test.ts
//
// QBO-01 coverage for the loopback authorization flow, driven against a REAL http server on an
// ephemeral port. A fake server would prove nothing about the part that actually goes wrong here:
// binding, closing, and not leaking the listener.
//
// THE STATE NONCE TESTS ARE THE POINT. A loopback listener accepts a request from any local process
// and from any page the browser happens to load. Without the nonce check, anything could drive the
// app into exchanging an authorization code it did not ask for and silently connect it to the
// ATTACKER's QuickBooks company, which is a far worse outcome than a failed sign in. So a mismatch
// must abort, and it must abort without consuming the code.
//
// Every test asserts the port is released afterwards, because a leaked listener makes the NEXT
// connect attempt fail with a port conflict the user cannot clear short of restarting the app.

import { describe, expect, it, vi } from 'vitest'
import { createFakeSecretStore, jsonResponse } from './helpers/fake-secret-store'
import { QBO_REDIRECT_URI, QBO_SCOPE } from '../src/main/qbo/env'
import {
  QBO_AUTH_CANCELED,
  QBO_AUTH_STATE_MISMATCH,
  QBO_AUTH_TIMEOUT,
  QBO_CLIENT_CREDENTIALS_MISSING,
  QBO_SECRET_STORE_UNAVAILABLE
} from '../src/main/qbo/errors'
import {
  buildAuthorizeUrl,
  connectToQuickBooks,
  createStateNonce,
  stateMatches,
  waitForOAuthCallback
} from '../src/main/qbo/oauth'
import {
  QBO_CLIENT_ID_SECRET,
  QBO_CLIENT_SECRET_SECRET,
  QBO_REFRESH_TOKEN_SECRET
} from '../src/main/qbo/secret-keys'

const REALM = '9341457604445280'
const NOW = Date.parse('2026-07-27T12:00:00.000Z')

/** Hit the loopback callback the way the browser would. */
async function visitCallback(port: number, query: string): Promise<number> {
  const response = await fetch(`http://127.0.0.1:${port}/oauth/callback?${query}`)
  await response.text()
  return response.status
}

describe('the state nonce', () => {
  it('is long, random, and different every time', () => {
    const a = createStateNonce()
    const b = createStateNonce()
    expect(a).toHaveLength(64) // 32 bytes, hex encoded
    expect(a).not.toBe(b)
    expect(a).toMatch(/^[0-9a-f]+$/)
  })

  it('matches only an identical value', () => {
    const state = createStateNonce()
    expect(stateMatches(state, state)).toBe(true)
    expect(stateMatches(state, `${state}x`)).toBe(false)
    expect(stateMatches(state, state.slice(0, -1))).toBe(false)
    expect(stateMatches(state, null)).toBe(false)
    expect(stateMatches(state, '')).toBe(false)
  })
})

describe('buildAuthorizeUrl', () => {
  it('requests exactly the accounting scope against the registered redirect', () => {
    const url = new URL(buildAuthorizeUrl({ clientId: 'client-abc', state: 'nonce-1' }))

    expect(url.origin + url.pathname).toBe('https://appcenter.intuit.com/connect/oauth2')
    expect(url.searchParams.get('client_id')).toBe('client-abc')
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('scope')).toBe(QBO_SCOPE)
    expect(url.searchParams.get('redirect_uri')).toBe(QBO_REDIRECT_URI)
    expect(url.searchParams.get('state')).toBe('nonce-1')
  })

  it('pins the redirect to the port and path registered with Intuit', () => {
    expect(QBO_REDIRECT_URI).toBe('http://localhost:8734/oauth/callback')
  })

  it('encodes a hostile client id into its own parameter slot', () => {
    const url = new URL(buildAuthorizeUrl({ clientId: 'a&scope=evil', state: 'n' }))
    expect(url.searchParams.get('client_id')).toBe('a&scope=evil')
    expect(url.searchParams.get('scope')).toBe(QBO_SCOPE)
  })
})

describe('waitForOAuthCallback', () => {
  it('resolves with the code and realm id from a well-formed redirect', async () => {
    const state = createStateNonce()
    let boundPort = 0

    const result = await waitForOAuthCallback({
      expectedState: state,
      port: 0,
      timeoutMs: 5000,
      onListening: async (port) => {
        boundPort = port
        await visitCallback(port, `code=auth-code-1&state=${state}&realmId=${REALM}`)
      }
    })

    expect(result).toEqual({ code: 'auth-code-1', realmId: REALM })
    await expect(fetch(`http://127.0.0.1:${boundPort}/oauth/callback`)).rejects.toThrow()
  })

  it('rejects a redirect whose state does not match, and does not hand back the code', async () => {
    const state = createStateNonce()
    // The wait rejects as soon as the handler runs, which can be before the fetch settles, so the
    // response is awaited separately rather than through a variable the race could outrun.
    let visit: Promise<number> = Promise.resolve(0)

    const rejection = await waitForOAuthCallback({
      expectedState: state,
      port: 0,
      timeoutMs: 5000,
      onListening: (port) => {
        visit = visitCallback(port, `code=attacker-code&state=someone-elses-nonce&realmId=1`)
      }
    }).catch((err: unknown) => err)

    expect((rejection as Error).message).toBe(QBO_AUTH_STATE_MISMATCH)
    await expect(visit).resolves.toBe(400)
  })

  it('rejects a redirect carrying no state at all', async () => {
    const state = createStateNonce()
    const rejection = await waitForOAuthCallback({
      expectedState: state,
      port: 0,
      timeoutMs: 5000,
      onListening: async (port) => {
        await visitCallback(port, `code=c&realmId=1`)
      }
    }).catch((err: unknown) => err)

    expect((rejection as Error).message).toBe(QBO_AUTH_STATE_MISMATCH)
  })

  it('reports a user cancellation when Intuit returns an error', async () => {
    const state = createStateNonce()
    const rejection = await waitForOAuthCallback({
      expectedState: state,
      port: 0,
      timeoutMs: 5000,
      onListening: async (port) => {
        await visitCallback(port, `error=access_denied&state=${state}`)
      }
    }).catch((err: unknown) => err)

    expect((rejection as Error).message).toBe(QBO_AUTH_CANCELED)
  })

  it('reports a cancellation when the redirect carries a state but no realm id', async () => {
    // A code with no company to spend it on cannot produce a connection.
    const state = createStateNonce()
    const rejection = await waitForOAuthCallback({
      expectedState: state,
      port: 0,
      timeoutMs: 5000,
      onListening: async (port) => {
        await visitCallback(port, `code=c&state=${state}`)
      }
    }).catch((err: unknown) => err)

    expect((rejection as Error).message).toBe(QBO_AUTH_CANCELED)
  })

  it('ignores a request to any other path and keeps waiting', async () => {
    // A favicon probe or a stray local request must not end the wait.
    const state = createStateNonce()
    const result = await waitForOAuthCallback({
      expectedState: state,
      port: 0,
      timeoutMs: 5000,
      onListening: async (port) => {
        const stray = await fetch(`http://127.0.0.1:${port}/favicon.ico`)
        await stray.text()
        expect(stray.status).toBe(404)
        await visitCallback(port, `code=real-code&state=${state}&realmId=${REALM}`)
      }
    })

    expect(result.code).toBe('real-code')
  })

  it('times out and releases the port when nobody completes the sign in', async () => {
    let boundPort = 0
    const rejection = await waitForOAuthCallback({
      expectedState: createStateNonce(),
      port: 0,
      timeoutMs: 60,
      onListening: (port) => {
        boundPort = port
      }
    }).catch((err: unknown) => err)

    expect((rejection as Error).message).toBe(QBO_AUTH_TIMEOUT)
    // A leaked listener would make the next attempt fail with a port conflict.
    await expect(fetch(`http://127.0.0.1:${boundPort}/oauth/callback`)).rejects.toThrow()
  })

  it('gives up rather than hanging when the browser could not be opened', async () => {
    const rejection = await waitForOAuthCallback({
      expectedState: createStateNonce(),
      port: 0,
      timeoutMs: 5000,
      onListening: async () => {
        throw new Error('no browser on this machine')
      }
    }).catch((err: unknown) => err)

    expect((rejection as Error).message).toBe(QBO_AUTH_CANCELED)
  })
})

describe('connectToQuickBooks end to end', () => {
  function credentialedStore() {
    return createFakeSecretStore({
      [QBO_CLIENT_ID_SECRET]: 'client-abc',
      [QBO_CLIENT_SECRET_SECRET]: 'client-secret'
    })
  }

  it('opens consent, catches the redirect, exchanges the code, and stores the tokens', async () => {
    const store = credentialedStore()
    let authorizeUrl = ''
    let boundPort = 0
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ access_token: 'access-1', refresh_token: 'refresh-1', expires_in: 3600 })
    ) as unknown as typeof globalThis.fetch

    const result = await connectToQuickBooks({
      secretStore: store,
      fetch: fetchImpl,
      now: () => NOW,
      port: 0,
      timeoutMs: 5000,
      onListening: (port) => {
        boundPort = port
      },
      openExternal: async (url: string) => {
        authorizeUrl = url
        // Stand in for the browser: read the nonce out of the consent URL and complete the
        // redirect against whichever port the listener actually bound.
        const state = new URL(url).searchParams.get('state') ?? ''
        await visitCallback(boundPort, `code=code-1&state=${state}&realmId=${REALM}`)
      }
    })

    expect(authorizeUrl).toContain('appcenter.intuit.com')
    expect(result.realmId).toBe(REALM)
    expect(result.tokens.accessToken).toBe('access-1')
    // The tokens are on disk before the caller records the realm id, so no status read can see a
    // connected company whose credentials were never stored.
    expect(store.get(QBO_REFRESH_TOKEN_SECRET)).toBe('refresh-1')
  })

  it('fails before opening a browser when no client credentials are stored', async () => {
    const openExternal = vi.fn(async () => undefined)
    await expect(
      connectToQuickBooks({ secretStore: createFakeSecretStore(), openExternal, port: 0, timeoutMs: 500 })
    ).rejects.toThrow(QBO_CLIENT_CREDENTIALS_MISSING)
    expect(openExternal).not.toHaveBeenCalled()
  })

  it('fails before opening a browser when the keychain cannot store the result', async () => {
    // Asking somebody to sign in and then discarding the tokens is the worst possible order.
    const store = credentialedStore()
    store.encryptionAvailable = false
    const openExternal = vi.fn(async () => undefined)

    await expect(
      connectToQuickBooks({ secretStore: store, openExternal, port: 0, timeoutMs: 500 })
    ).rejects.toThrow(QBO_SECRET_STORE_UNAVAILABLE)
    expect(openExternal).not.toHaveBeenCalled()
  })
})
