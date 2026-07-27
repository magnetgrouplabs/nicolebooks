// test/posting-bridge.test.ts
//
// The wiring point: the one file that introduces the posting engine to the live QuickBooks
// connection. Until it ran, every send in the shipped app mapped to "connect on the Settings
// screen" no matter what was stored, and every Purchase posted as 'Check'.
//
// WHY THIS FILE EXISTS AT ALL. The seam it closes is invisible: nothing fails to compile, no test
// goes red, and the app looks connected on the Settings screen. The only symptom is that posting
// says the app is not connected. So the wiring itself gets a spec, driven against a temp database, a
// fake secret store, and a fake fetch, with no Electron.
//
// The five properties pinned here:
//
//   1. THE REALM IS RESOLVED PER CALL. Connecting a different company must send the next batch to
//      the new one. A realm captured at install would keep posting into whichever company happened
//      to be open at startup, which is the worst possible version of this bug.
//
//   2. THE BASE URL IS THE API ORIGIN. createHttpQboApi builds its own '/v3/company/...' paths, so
//      handing it the environment seam's apiBaseUrl verbatim would produce '/v3/company/v3/company'
//      and a 404 on every post.
//
//   3. THE TOKEN REFRESHES TRANSPARENTLY. A token inside the ten minute skew is rotated before the
//      request rather than after a 401, so a batch that crosses the hour boundary does not fail
//      halfway through.
//
//   4. CONNECTION FAILURES SPEAK POSTING'S VOCABULARY. The qbo modules throw QBO_* codes the
//      posting error table has never heard of, so without translation an expired connection would
//      reach the user as "something went wrong" instead of "connect on the Settings screen".
//
//   5. NAMES AND ACCOUNT TYPES COME FROM THE 0004 CACHE. The report prints names, and the Purchase
//      payment method is decided entirely by the paid-from account's type.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { migrate } from '../src/main/db/migrate'
import { createFakeSecretStore, jsonResponse } from './helpers/fake-secret-store'
import {
  createLiveQboApi,
  createLiveReference,
  installPostingBridge,
  qboApiOrigin,
  translateConnectionError
} from '../src/main/integration/posting-bridge'
import { POSTING_NOT_CONNECTED, POSTING_UNAVAILABLE } from '../src/main/posting/errors'
import { resolveQboApi, setQboApiProvider } from '../src/main/posting/qbo-api'
import { getPostingReference, setPostingReference } from '../src/main/posting/reference'
import {
  QBO_COMPANY_NAME_SETTING,
  QBO_REALM_ID_SETTING,
  isReauthRequired,
  writeSetting
} from '../src/main/qbo/connection'
import {
  QBO_NOT_CONNECTED,
  QBO_REAUTH_REQUIRED,
  QBO_TOKEN_REFRESH_FAILED
} from '../src/main/qbo/errors'
import { writeReferenceRows } from '../src/main/qbo/reference'
import {
  QBO_ACCESS_TOKEN_SECRET,
  QBO_CLIENT_ID_SECRET,
  QBO_CLIENT_SECRET_SECRET,
  QBO_REFRESH_TOKEN_SECRET,
  QBO_TOKEN_EXPIRY_SECRET
} from '../src/main/qbo/secret-keys'

const NOW = Date.parse('2026-07-27T12:00:00.000Z')
const REALM = '9341457604445280'
const OTHER_REALM = '1111111111111111'
const SANDBOX_ORIGIN = 'https://sandbox-quickbooks.api.intuit.com'

let dir: string
let db: Database.Database

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nb-bridge-'))
  db = new Database(join(dir, 'app.db'))
  migrate(db)
})

afterEach(() => {
  // A provider leaking out of one spec would silently satisfy the next one's not-connected check.
  setQboApiProvider(null)
  setPostingReference(null)
  try {
    db.close()
  } catch {
    /* already closed */
  }
  rmSync(dir, { recursive: true, force: true })
})

function store(expiresAt = NOW + 60 * 60 * 1000) {
  return createFakeSecretStore({
    [QBO_CLIENT_ID_SECRET]: 'client-id',
    [QBO_CLIENT_SECRET_SECRET]: 'client-secret',
    [QBO_ACCESS_TOKEN_SECRET]: 'access-token',
    [QBO_REFRESH_TOKEN_SECRET]: 'refresh-token',
    [QBO_TOKEN_EXPIRY_SECRET]: String(expiresAt)
  })
}

function connect(realmId = REALM, companyName = 'Magnet Book'): void {
  writeSetting(QBO_REALM_ID_SETTING, realmId, { db })
  writeSetting(QBO_COMPANY_NAME_SETTING, companyName, { db })
}

interface Call {
  url: string
  method: string
  authorization: string
}

/** A fetch double that records what was signed and how. */
function recordingFetch(respond: (call: Call) => Response): {
  fetch: typeof globalThis.fetch
  calls: Call[]
} {
  const calls: Call[] = []
  const impl = vi.fn(async (url: unknown, init: unknown) => {
    const request = (init ?? {}) as { method?: string; headers?: Record<string, string> }
    const call: Call = {
      url: String(url),
      method: request.method ?? 'GET',
      authorization: request.headers?.['Authorization'] ?? ''
    }
    calls.push(call)
    return respond(call)
  })
  return { fetch: impl as unknown as typeof globalThis.fetch, calls }
}

const CREATED_BILL = { Bill: { Id: '145', SyncToken: '0' } }

describe('qboApiOrigin', () => {
  // The environment seam publishes apiBaseUrl with '/v3/company' already appended, because every
  // other caller builds a company-scoped URL from it. The posting client builds its own full paths.
  it('strips the company path segment the posting client supplies itself', () => {
    expect(qboApiOrigin('sandbox')).toBe(SANDBOX_ORIGIN)
    expect(qboApiOrigin('production')).toBe('https://quickbooks.api.intuit.com')
    expect(qboApiOrigin('sandbox')).not.toContain('/v3/company')
  })
})

describe('createLiveQboApi', () => {
  it('refuses to build a client when no company is connected', () => {
    expect(() => createLiveQboApi({ db, secretStore: store() })).toThrow(POSTING_NOT_CONNECTED)
  })

  it('reads the realm at RESOLVE time, so reconnecting to another company redirects the next batch', () => {
    connect(REALM)
    const deps = { db, secretStore: store(), now: () => NOW }
    expect(createLiveQboApi(deps).realmId).toBe(REALM)

    connect(OTHER_REALM)
    expect(createLiveQboApi(deps).realmId).toBe(OTHER_REALM)
  })

  it('posts to the company endpoint with the stored access token', async () => {
    connect()
    const api = recordingFetch(() => jsonResponse(CREATED_BILL))
    // The HTTP client takes its fetch from the global, so this is the honest way to inject one.
    const realFetch = globalThis.fetch
    globalThis.fetch = api.fetch
    try {
      const client = createLiveQboApi({ db, secretStore: store(), now: () => NOW })
      const result = await client.createBill(
        {
          VendorRef: { value: '58' },
          TxnDate: '2026-07-08',
          Line: [
            {
              Amount: '629.97',
              DetailType: 'AccountBasedExpenseLineDetail',
              AccountBasedExpenseLineDetail: { AccountRef: { value: '63' } }
            }
          ]
        },
        'request-1'
      )
      expect(result).toEqual({ id: '145', syncToken: '0', replayed: false })
    } finally {
      globalThis.fetch = realFetch
    }

    expect(api.calls).toHaveLength(1)
    const [call] = api.calls
    expect(call.method).toBe('POST')
    expect(call.url).toBe(`${SANDBOX_ORIGIN}/v3/company/${REALM}/bill?minorversion=75&requestid=request-1`)
    expect(call.authorization).toBe('Bearer access-token')
  })

  it('refreshes a token inside the proactive window BEFORE the request, not after a 401', async () => {
    connect()
    // Five minutes of life left, inside the ten minute skew.
    const secretStore = store(NOW + 5 * 60 * 1000)
    const api = recordingFetch((call) =>
      call.url.includes('oauth2')
        ? jsonResponse({ access_token: 'fresh-token', refresh_token: 'rotated', expires_in: 3600 })
        : jsonResponse(CREATED_BILL)
    )

    const realFetch = globalThis.fetch
    globalThis.fetch = api.fetch
    try {
      const client = createLiveQboApi({ db, secretStore, fetch: api.fetch, now: () => NOW })
      await client.createBill(
        {
          VendorRef: { value: '58' },
          TxnDate: '2026-07-08',
          Line: [
            {
              Amount: '629.97',
              DetailType: 'AccountBasedExpenseLineDetail',
              AccountBasedExpenseLineDetail: { AccountRef: { value: '63' } }
            }
          ]
        },
        'request-1'
      )
    } finally {
      globalThis.fetch = realFetch
    }

    // Refresh first, then the create, signed with the NEW token.
    expect(api.calls[0].url).toContain('oauth2')
    expect(api.calls[1].authorization).toBe('Bearer fresh-token')
    // And the rotated refresh token was persisted before the create went out.
    expect(secretStore.get(QBO_REFRESH_TOKEN_SECRET)).toBe('rotated')
  })

  it('translates a dead grant into posting copy the user can act on', async () => {
    connect()
    const secretStore = store(NOW - 1000)
    const api = recordingFetch(
      () => new Response('{"error":"invalid_grant"}', { status: 400 })
    )

    const client = createLiveQboApi({ db, secretStore, fetch: api.fetch, now: () => NOW })
    await expect(client.query('SELECT * FROM Vendor')).rejects.toThrow(POSTING_NOT_CONNECTED)
    // ...and the connection card is left offering Reconnect rather than claiming all is well.
    expect(isReauthRequired({ db })).toBe(true)
  })
})

describe('translateConnectionError', () => {
  it('maps every "you must reconnect" code to the one sentence that names the Settings screen', () => {
    expect(translateConnectionError(new Error(QBO_NOT_CONNECTED), { db }).message).toBe(
      POSTING_NOT_CONNECTED
    )
    expect(translateConnectionError(new Error(QBO_REAUTH_REQUIRED), { db }).message).toBe(
      POSTING_NOT_CONNECTED
    )
  })

  it('maps a transient refresh failure to "try again", not to "reconnect"', () => {
    expect(translateConnectionError(new Error(QBO_TOKEN_REFRESH_FAILED), { db }).message).toBe(
      POSTING_UNAVAILABLE
    )
    // A network blip must NOT flip the connection to expired, or an offline laptop lid would read
    // as a revoked authorization.
    expect(isReauthRequired({ db })).toBe(false)
  })

  it('passes anything it does not recognize through untouched, so posting can map it generically', () => {
    const original = new Error('SOMETHING_ELSE')
    expect(translateConnectionError(original, { db })).toBe(original)
  })
})

describe('createLiveReference', () => {
  beforeEach(() => {
    connect()
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
        },
        {
          entityKind: 'account',
          entityId: '63',
          name: 'Job Expenses:Job Materials',
          active: true,
          accountType: 'Expense',
          accountSubType: 'SuppliesMaterials'
        },
        {
          entityKind: 'account',
          entityId: '42',
          name: 'Visa',
          active: true,
          accountType: 'Credit Card',
          accountSubType: 'CreditCard'
        },
        {
          entityKind: 'account',
          entityId: '35',
          name: 'Checking',
          active: true,
          accountType: 'Bank',
          accountSubType: 'Checking'
        }
      ],
      new Date(NOW).toISOString()
    )
  })

  it('resolves the company, vendor, and account names the report prints', () => {
    const reference = createLiveReference({ db })
    expect(reference.companyName()).toBe('Magnet Book')
    expect(reference.vendorName('58')).toBe('Apex Plumbing Supply')
    expect(reference.accountName('63')).toBe('Job Expenses:Job Materials')
  })

  it('resolves the account TYPE, which is the only thing that decides a Purchase payment method', () => {
    const reference = createLiveReference({ db })
    expect(reference.accountType('42')).toBe('Credit Card')
    expect(reference.accountType('35')).toBe('Bank')
  })

  it('answers null rather than throwing for anything it cannot resolve', () => {
    const reference = createLiveReference({ db })
    expect(reference.vendorName('404')).toBeNull()
    expect(reference.accountName('404')).toBeNull()
    expect(reference.accountType('404')).toBeNull()
  })

  it('answers null for everything once the company is disconnected', () => {
    writeSetting(QBO_REALM_ID_SETTING, '', { db })
    const reference = createLiveReference({ db })
    expect(reference.vendorName('58')).toBeNull()
    expect(reference.accountType('42')).toBeNull()
  })
})

describe('installPostingBridge', () => {
  it('registers both hooks, so resolveQboApi stops throwing not-connected', async () => {
    connect()
    installPostingBridge({ db, secretStore: store(), now: () => NOW })

    const api = await resolveQboApi()
    expect(api.realmId).toBe(REALM)
    expect(getPostingReference().companyName()).toBe('Magnet Book')
  })

  it('is pure registration: it touches nothing until the first post', () => {
    // No company connected, no tokens, no reference rows. Installing must still succeed, because it
    // runs at startup long before anyone has connected anything.
    expect(() => installPostingBridge({ db, secretStore: createFakeSecretStore() })).not.toThrow()
  })
})
