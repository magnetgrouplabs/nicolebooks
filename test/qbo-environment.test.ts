// test/qbo-environment.test.ts
//
// PROD-MODE coverage: the sandbox/production seam, the setting that selects through it, and the two
// places where picking the wrong one is expensive rather than merely wrong.
//
// WHY THIS FILE EXISTS AT ALL. Every other QuickBooks spec runs against the sandbox default, which
// means a production regression is invisible to all of them: the URLs they assert on are the ones a
// broken build would still produce. The tests below are the only ones that would go red if the
// environment stopped being read, if it were read once and cached, or if it defaulted the wrong way.
//
// THE THREE PROPERTIES BEING PINNED:
//   1. Selection      one stored name resolves the API host AND the redirect address, and every
//                     unrecognized value resolves DOWN to sandbox, never up to production.
//   2. Propagation    a stored 'production' actually reaches the request. The assertion is on the
//                     host in the fetched URL, because that is the only evidence that survives a
//                     refactor: a test that checked the setting would pass against a service that
//                     read it and then ignored it.
//   3. Switching      changing environments clears the credentials, because tokens are issued by one
//                     environment's app keys and are dead in the other. A carried-over token set
//                     fails later as an unexplained authorization error instead of now as the
//                     deliberate act it was.
//
// Runs against a real temp database and a fake secret store: no Electron, no network.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { migrate } from '../src/main/db/migrate'
import { createFakeSecretStore, jsonResponse, textResponse } from './helpers/fake-secret-store'
import {
  getRealmId,
  markConnected,
  readSetting,
  setLastSyncAt,
  writeSetting,
  QBO_LAST_SYNC_SETTING,
  QBO_REALM_ID_SETTING
} from '../src/main/qbo/connection'
import {
  companyApiUrl,
  parseQboEnvironment,
  qboEnvironment,
  redirectUriFor,
  DEFAULT_QBO_ENVIRONMENT,
  QBO_FORWARDER_REDIRECT_URI,
  QBO_MINOR_VERSION,
  QBO_REDIRECT_URI
} from '../src/main/qbo/env'
import {
  getQboEnvironment,
  qboApiHost,
  setQboEnvironment,
  QBO_ENVIRONMENT_SETTING
} from '../src/main/qbo/environment'
import { QBO_REDIRECT_URI_MISMATCH, QBO_TOKEN_EXCHANGE_FAILED } from '../src/main/qbo/errors'
import { buildAuthorizeUrl, connectToQuickBooks } from '../src/main/qbo/oauth'
import { readReference, writeReferenceRows } from '../src/main/qbo/reference'
import { connect, getEnvironment, setEnvironment } from '../src/main/qbo/service'
import {
  QBO_ACCESS_TOKEN_SECRET,
  QBO_CLIENT_ID_SECRET,
  QBO_CLIENT_SECRET_SECRET,
  QBO_REFRESH_TOKEN_SECRET,
  QBO_TOKEN_EXPIRY_SECRET
} from '../src/main/qbo/secret-keys'
import { exchangeAuthorizationCode } from '../src/main/qbo/tokens'

const NOW = Date.parse('2026-07-27T12:00:00.000Z')
const REALM = '9341457604445280'
const SANDBOX_HOST = 'sandbox-quickbooks.api.intuit.com'
const PRODUCTION_HOST = 'quickbooks.api.intuit.com'

let dir: string
let db: Database.Database

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nb-qbo-env-'))
  db = new Database(join(dir, 'app.db'))
  migrate(db)
})

afterEach(() => {
  try {
    db.close()
  } catch {
    /* already closed */
  }
  rmSync(dir, { recursive: true, force: true })
})

function connectedStore() {
  return createFakeSecretStore({
    [QBO_CLIENT_ID_SECRET]: 'client-abc',
    [QBO_CLIENT_SECRET_SECRET]: 'client-secret',
    [QBO_ACCESS_TOKEN_SECRET]: 'access-1',
    [QBO_REFRESH_TOKEN_SECRET]: 'refresh-1',
    [QBO_TOKEN_EXPIRY_SECRET]: String(NOW + 60 * 60 * 1000)
  })
}

// ---------------------------------------------------------------------------
// 1. The seam: one name resolves every host and the redirect
// ---------------------------------------------------------------------------

describe('the environment seam', () => {
  it('sends Accounting API traffic to the sandbox host for sandbox', () => {
    const url = new URL(companyApiUrl(REALM, 'companyinfo/1', {}, 'sandbox'))
    expect(url.host).toBe(SANDBOX_HOST)
    expect(url.pathname).toBe(`/v3/company/${REALM}/companyinfo/1`)
  })

  it('sends Accounting API traffic to the production host for production', () => {
    const url = new URL(companyApiUrl(REALM, 'companyinfo/1', {}, 'production'))
    expect(url.host).toBe(PRODUCTION_HOST)
    expect(url.pathname).toBe(`/v3/company/${REALM}/companyinfo/1`)
  })

  it('pins the minor version in both environments', () => {
    // A server-side default bump would otherwise change a response shape under a shipped installer.
    for (const environment of ['sandbox', 'production'] as const) {
      const url = new URL(companyApiUrl(REALM, 'query', { query: 'SELECT * FROM Vendor' }, environment))
      expect(url.searchParams.get('minorversion')).toBe(QBO_MINOR_VERSION)
    }
  })

  it('exposes the bare host for the posting client, with no path attached', () => {
    // The posting client concatenates its own '/v3/company/...' path, so a trailing path here would
    // produce a doubled segment that only shows up against a live company.
    expect(qboEnvironment('sandbox').apiHost).toBe(`https://${SANDBOX_HOST}`)
    expect(qboEnvironment('production').apiHost).toBe(`https://${PRODUCTION_HOST}`)
  })

  it('shares the OAuth endpoints between the two environments', () => {
    // Intuit issues one set of tokens whose environment is decided by which keys signed the
    // request, not by which URL asked for them. A spec that assumed a sandbox token host would send
    // production traffic somewhere that does not exist.
    const sandbox = qboEnvironment('sandbox')
    const production = qboEnvironment('production')
    expect(production.authorizeUrl).toBe(sandbox.authorizeUrl)
    expect(production.tokenUrl).toBe(sandbox.tokenUrl)
    expect(production.revokeUrl).toBe(sandbox.revokeUrl)
  })

  it('uses the loopback redirect for sandbox and the https forwarder for production', () => {
    // Intuit accepts a plain http://localhost redirect on development keys only. Production keys
    // require https, which is the entire reason the forwarder page exists.
    expect(redirectUriFor('sandbox')).toBe(QBO_REDIRECT_URI)
    expect(redirectUriFor('sandbox')).toMatch(/^http:\/\/localhost:8734\//)
    expect(redirectUriFor('production')).toBe(QBO_FORWARDER_REDIRECT_URI)
    expect(redirectUriFor('production')).toMatch(/^https:\/\//)
  })

  it('coerces anything unrecognized DOWN to sandbox', () => {
    // The direction is the safety property: reading production as sandbox costs a failed request,
    // reading sandbox as production would post real entries into somebody's real books.
    expect(DEFAULT_QBO_ENVIRONMENT).toBe('sandbox')
    for (const value of [null, undefined, '', 'PRODUCTION', 'live', 'prod', 0, {}, ['production']]) {
      expect(parseQboEnvironment(value)).toBe('sandbox')
    }
    expect(parseQboEnvironment('production')).toBe('production')
    expect(parseQboEnvironment('sandbox')).toBe('sandbox')
  })
})

// ---------------------------------------------------------------------------
// 2. Persistence
// ---------------------------------------------------------------------------

describe('the stored environment', () => {
  it('defaults to sandbox on a fresh install', () => {
    expect(getQboEnvironment({ db })).toBe('sandbox')
    expect(readSetting(QBO_ENVIRONMENT_SETTING, { db })).toBeNull()
  })

  it('survives a write and reads back as the value that was chosen', () => {
    setQboEnvironment('production', { db, secretStore: createFakeSecretStore() })
    expect(readSetting(QBO_ENVIRONMENT_SETTING, { db })).toBe('production')
    expect(getQboEnvironment({ db })).toBe('production')
    expect(getEnvironment({ db })).toBe('production')
  })

  it('reads a corrupted value as sandbox rather than throwing or trusting it', () => {
    // A value written by an older build, or edited by hand, must never render or behave as Live.
    writeSetting(QBO_ENVIRONMENT_SETTING, 'Production ', { db })
    expect(getQboEnvironment({ db })).toBe('sandbox')
  })

  it('resolves the posting client base URL from the stored value', () => {
    expect(qboApiHost({ db })).toBe(`https://${SANDBOX_HOST}`)
    setQboEnvironment('production', { db, secretStore: createFakeSecretStore() })
    expect(qboApiHost({ db })).toBe(`https://${PRODUCTION_HOST}`)
  })
})

// ---------------------------------------------------------------------------
// 3. Switching disconnects
// ---------------------------------------------------------------------------

describe('switching environments', () => {
  it('clears the tokens and the connection state', () => {
    const store = connectedStore()
    markConnected({ realmId: REALM, companyName: 'Sandbox Company US 0b8b' }, { db })
    setLastSyncAt('2026-07-27T12:00:00.000Z', { db })

    const status = setEnvironment('production', { db, secretStore: store })

    expect(status).toEqual({
      state: 'disconnected',
      companyName: null,
      realmId: null,
      lastSyncAt: null
    })
    expect(store.get(QBO_REFRESH_TOKEN_SECRET)).toBeNull()
    expect(store.get(QBO_ACCESS_TOKEN_SECRET)).toBeNull()
    expect(readSetting(QBO_REALM_ID_SETTING, { db })).toBeNull()
    expect(readSetting(QBO_LAST_SYNC_SETTING, { db })).toBeNull()
  })

  it('keeps the Intuit app keys, which identify the app rather than the connection', () => {
    // Production and sandbox use DIFFERENT client ids, so the next step after a switch is pasting
    // the other pair. Deleting them here would also delete the pair the user is switching back to.
    const store = connectedStore()
    setEnvironment('production', { db, secretStore: store })
    expect(store.get(QBO_CLIENT_ID_SECRET)).toBe('client-abc')
    expect(store.get(QBO_CLIENT_SECRET_SECRET)).toBe('client-secret')
  })

  it('keeps the reference cache, which is keyed by realm and cannot be served for another company', () => {
    writeReferenceRows(
      db,
      REALM,
      [
        {
          entityKind: 'vendor',
          entityId: '58',
          name: 'Apex Plumbing Supply',
          active: true,
          accountType: null,
          accountSubType: null
        }
      ],
      '2026-07-27T12:00:00.000Z'
    )
    expect(readReference(REALM, null, db).vendors).toHaveLength(1)

    setEnvironment('production', { db, secretStore: connectedStore() })

    // Still there, and still unreachable: readReference is called with the CONNECTED realm id, and
    // there is no connected realm id any more.
    expect(readReference(REALM, null, db).vendors).toHaveLength(1)
    expect(getRealmId({ db })).toBeNull()
  })

  it('does nothing at all when the environment is set to the one it is already on', () => {
    // Re-selecting the current value must not throw away a working connection.
    const store = connectedStore()
    markConnected({ realmId: REALM, companyName: 'Sandbox Company US 0b8b' }, { db })

    const changed = setQboEnvironment('sandbox', { db, secretStore: store })

    expect(changed).toBe(false)
    expect(store.get(QBO_REFRESH_TOKEN_SECRET)).toBe('refresh-1')
    expect(getRealmId({ db })).toBe(REALM)
  })

  it('reports that a real change happened, so a caller can tell a switch from a no-op', () => {
    expect(setQboEnvironment('production', { db, secretStore: connectedStore() })).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 4. The authorize URL and the token exchange agree on the redirect
// ---------------------------------------------------------------------------

describe('the authorization request', () => {
  it('asks Intuit to redirect to the loopback in sandbox', () => {
    const url = new URL(buildAuthorizeUrl({ clientId: 'client-abc', state: 'n', environment: 'sandbox' }))
    expect(url.searchParams.get('redirect_uri')).toBe(QBO_REDIRECT_URI)
  })

  it('asks Intuit to redirect to the https forwarder in production', () => {
    const url = new URL(
      buildAuthorizeUrl({ clientId: 'client-abc', state: 'n', environment: 'production' })
    )
    expect(url.searchParams.get('redirect_uri')).toBe(QBO_FORWARDER_REDIRECT_URI)
  })

  it('defaults to the loopback when no environment is supplied', () => {
    const url = new URL(buildAuthorizeUrl({ clientId: 'client-abc', state: 'n' }))
    expect(url.searchParams.get('redirect_uri')).toBe(QBO_REDIRECT_URI)
  })
})

describe('the token exchange', () => {
  /** Read the form-encoded body a fake fetch was called with. */
  function bodyOf(call: unknown[]): URLSearchParams {
    const init = call[1] as { body?: string }
    return new URLSearchParams(init.body ?? '')
  }

  it('sends the SAME redirect_uri the authorization was granted for', async () => {
    // Intuit compares the two. Drift between them is a rejected exchange AFTER the user has already
    // consented, which is the worst possible place to fail.
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ access_token: 'a', refresh_token: 'r', expires_in: 3600 })
    ) as unknown as typeof globalThis.fetch

    await exchangeAuthorizationCode(
      {
        code: 'code-1',
        redirectUri: QBO_FORWARDER_REDIRECT_URI,
        credentials: { clientId: 'client-abc', clientSecret: 'client-secret' }
      },
      { fetch: fetchImpl, now: () => NOW, environment: 'production' }
    )

    const body = bodyOf(vi.mocked(fetchImpl).mock.calls[0])
    expect(body.get('redirect_uri')).toBe(QBO_FORWARDER_REDIRECT_URI)
    expect(body.get('grant_type')).toBe('authorization_code')
  })

  it('carries the production redirect end to end through a whole connect', async () => {
    const calls: string[] = []
    const fetchImpl = vi.fn(async (url: unknown) => {
      calls.push(String(url))
      return jsonResponse({ access_token: 'a', refresh_token: 'r', expires_in: 3600 })
    }) as unknown as typeof globalThis.fetch

    let boundPort = 0
    let authorizeRedirect = ''

    await connectToQuickBooks({
      secretStore: createFakeSecretStore({
        [QBO_CLIENT_ID_SECRET]: 'client-abc',
        [QBO_CLIENT_SECRET_SECRET]: 'client-secret'
      }),
      fetch: fetchImpl,
      now: () => NOW,
      environment: 'production',
      port: 0,
      timeoutMs: 5000,
      onListening: (port) => {
        boundPort = port
      },
      openExternal: async (url: string) => {
        const authorize = new URL(url)
        authorizeRedirect = authorize.searchParams.get('redirect_uri') ?? ''
        // Stand in for the forwarder page: it hands the query string to the loopback unchanged.
        const state = authorize.searchParams.get('state') ?? ''
        const response = await fetch(
          `http://127.0.0.1:${boundPort}/oauth/callback?code=code-1&state=${state}&realmId=${REALM}`
        )
        await response.text()
      }
    })

    expect(authorizeRedirect).toBe(QBO_FORWARDER_REDIRECT_URI)
    // The exchange must repeat the value the authorization used, not the loopback the socket bound.
    const body = new URLSearchParams(
      (vi.mocked(fetchImpl).mock.calls[0][1] as { body?: string }).body ?? ''
    )
    expect(body.get('redirect_uri')).toBe(QBO_FORWARDER_REDIRECT_URI)
  })

  it('reports a redirect address Intuit does not recognize as its own failure', async () => {
    // The first-run production mistake: production keys carry a SEPARATE redirect list, and it is
    // usually empty. "Check your client id and secret" would send somebody after the wrong thing.
    const fetchImpl = vi.fn(async () =>
      textResponse('{"error":"invalid_request","error_description":"redirect_uri mismatch"}', 400)
    ) as unknown as typeof globalThis.fetch

    await expect(
      exchangeAuthorizationCode(
        {
          code: 'code-1',
          redirectUri: QBO_FORWARDER_REDIRECT_URI,
          credentials: { clientId: 'client-abc', clientSecret: 'client-secret' }
        },
        { fetch: fetchImpl, now: () => NOW }
      )
    ).rejects.toThrow(QBO_REDIRECT_URI_MISMATCH)
  })

  it('still reports a bad client secret as a plain exchange failure', async () => {
    const fetchImpl = vi.fn(async () =>
      textResponse('{"error":"invalid_client"}', 401)
    ) as unknown as typeof globalThis.fetch

    await expect(
      exchangeAuthorizationCode(
        {
          code: 'code-1',
          redirectUri: QBO_REDIRECT_URI,
          credentials: { clientId: 'client-abc', clientSecret: 'wrong' }
        },
        { fetch: fetchImpl, now: () => NOW }
      )
    ).rejects.toThrow(QBO_TOKEN_EXCHANGE_FAILED)
  })
})

// ---------------------------------------------------------------------------
// 5. Propagation: the stored value actually reaches the request
// ---------------------------------------------------------------------------

describe('the service reads the stored environment rather than a constant', () => {
  /** Drive a whole connect against a fake browser and a fake Intuit, capturing every URL fetched. */
  async function connectCapturingUrls(): Promise<string[]> {
    const urls: string[] = []
    const fetchImpl = vi.fn(async (url: unknown) => {
      urls.push(String(url))
      if (String(url).includes('companyinfo')) {
        return jsonResponse({ CompanyInfo: { CompanyName: 'Real Company' } })
      }
      return jsonResponse({ access_token: 'a', refresh_token: 'r', expires_in: 3600 })
    }) as unknown as typeof globalThis.fetch

    let boundPort = 0
    await connect({
      db,
      secretStore: createFakeSecretStore({
        [QBO_CLIENT_ID_SECRET]: 'client-abc',
        [QBO_CLIENT_SECRET_SECRET]: 'client-secret'
      }),
      fetch: fetchImpl,
      now: () => NOW,
      port: 0,
      timeoutMs: 5000,
      onListening: (port) => {
        boundPort = port
      },
      openExternal: async (url: string) => {
        const state = new URL(url).searchParams.get('state') ?? ''
        urls.push(url)
        const response = await fetch(
          `http://127.0.0.1:${boundPort}/oauth/callback?code=code-1&state=${state}&realmId=${REALM}`
        )
        await response.text()
      }
    })
    return urls
  }

  it('talks to the sandbox host when the setting says sandbox', async () => {
    const urls = await connectCapturingUrls()
    expect(urls.some((url) => url.includes(SANDBOX_HOST))).toBe(true)
    expect(urls.some((url) => url.includes(`//${PRODUCTION_HOST}`))).toBe(false)
  })

  it('talks to the production host when the setting says production', async () => {
    // The whole point of the feature, and the only assertion that would catch a service that read
    // the setting and then passed sandbox down anyway.
    writeSetting(QBO_ENVIRONMENT_SETTING, 'production', { db })

    const urls = await connectCapturingUrls()

    expect(urls.some((url) => url.includes(`//${PRODUCTION_HOST}`))).toBe(true)
    expect(urls.some((url) => url.includes(SANDBOX_HOST))).toBe(false)
    // ...and the consent screen it opened asked for the https redirect, not the loopback.
    const authorize = urls.find((url) => url.includes('appcenter.intuit.com'))
    expect(new URL(authorize ?? '').searchParams.get('redirect_uri')).toBe(
      QBO_FORWARDER_REDIRECT_URI
    )
  })
})
