// test/qbo-create-vendor.test.ts
//
// The one QuickBooks WRITE outside posting: creating a vendor a document names but the company has
// never billed with.
//
// Four properties, each of which is a real failure if it regresses:
//
//   1. THE CACHE IS WRITTEN FROM THE RESPONSE, NOT FROM THE TYPED NAME. QuickBooks assigns the id
//      and is the authority on what the DisplayName became. Caching what was typed would leave the
//      review row pointing at a name QuickBooks does not have.
//
//   2. THE NEW VENDOR IS SELECTABLE IMMEDIATELY. The row upserts into qbo_reference in the same
//      call, so the user does not have to run a full sync before they can pick what they just made.
//
//   3. A DUPLICATE NAME GETS ITS OWN CODE. Intuit fault 6240 is the one failure whose fix is "pick
//      the existing one", and it is the only fault whose body this app reads. Everything else stays
//      generic, because an Intuit fault message embeds the request URL and therefore the realm id.
//
//   4. THE REQUEST CARRIES A requestid. Intuit treats it as an idempotency key on creates, so a
//      retry across a timeout cannot leave two vendors behind.
//
// Driven against a real better-sqlite3 handle on a temp file and a fake fetch (the
// test/qbo-reference.test.ts pattern): no Electron, no network.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { migrate } from '../src/main/db/migrate'
import { createFakeSecretStore, jsonResponse } from './helpers/fake-secret-store'
import {
  createVendorRecord,
  lookupReferenceRecord,
  readReference,
  writeReferenceRows
} from '../src/main/qbo/reference'
import { QBO_REQUEST_FAILED, QBO_VENDOR_DUPLICATE_NAME } from '../src/main/qbo/errors'
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

/** The fixture vendor the sandbox deliberately does NOT have (test-fixtures/MANIFEST.md). */
const MISSING_VENDOR = 'Quality Craft Tools LLC'

/** The exact fault body Intuit returns for a colliding DisplayName. */
const DUPLICATE_FAULT = JSON.stringify({
  Fault: {
    Error: [
      {
        Message: 'Duplicate Name Exists Error',
        Detail: `The name supplied already exists. : Another customer, vendor or employee is already using this name.`,
        code: '6240'
      }
    ],
    type: 'ValidationFault'
  }
})

let dir: string
let db: Database.Database

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nb-qbo-create-'))
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
    [QBO_CLIENT_ID_SECRET]: 'id',
    [QBO_CLIENT_SECRET_SECRET]: 'secret',
    [QBO_ACCESS_TOKEN_SECRET]: 'access',
    [QBO_REFRESH_TOKEN_SECRET]: 'refresh',
    [QBO_TOKEN_EXPIRY_SECRET]: String(NOW + 60 * 60 * 1000)
  })
}

interface Call {
  url: string
  method: string
  body: unknown
}

/** A fetch double that records the create call and answers with a chosen response. */
function fakeCreate(response: () => Response): { fetch: typeof globalThis.fetch; calls: Call[] } {
  const calls: Call[] = []
  const impl = vi.fn(async (url: unknown, init: unknown) => {
    const request = (init ?? {}) as { method?: string; body?: string }
    calls.push({
      url: String(url),
      method: request.method ?? 'GET',
      body: request.body ? JSON.parse(request.body) : undefined
    })
    return response()
  })
  return { fetch: impl as unknown as typeof globalThis.fetch, calls }
}

function deps(fetchImpl: typeof globalThis.fetch) {
  return { db, secretStore: connectedStore(), fetch: fetchImpl, now: () => NOW }
}

describe('createVendorRecord', () => {
  it('returns the record QuickBooks assigned, not the name that was typed', async () => {
    const api = fakeCreate(() =>
      jsonResponse({ Vendor: { Id: '64', DisplayName: MISSING_VENDOR, Active: true } })
    )

    const record = await createVendorRecord(REALM, MISSING_VENDOR, deps(api.fetch))

    expect(record).toEqual({ id: '64', name: MISSING_VENDOR, active: true })
  })

  it('POSTs the DisplayName to the vendor endpoint with a requestid and the pinned minorversion', async () => {
    const api = fakeCreate(() =>
      jsonResponse({ Vendor: { Id: '64', DisplayName: MISSING_VENDOR, Active: true } })
    )

    await createVendorRecord(REALM, MISSING_VENDOR, deps(api.fetch))

    expect(api.calls).toHaveLength(1)
    const [call] = api.calls
    expect(call.method).toBe('POST')
    expect(call.body).toEqual({ DisplayName: MISSING_VENDOR })
    expect(call.url).toContain(`/${REALM}/vendor`)
    expect(call.url).toContain('minorversion=75')
    // The idempotency key. Its VALUE is a uuid, so what is pinned is that one is present at all:
    // without it a retry across a timeout leaves two vendors behind.
    expect(call.url).toMatch(/requestid=[0-9a-f-]{36}/i)
  })

  it('makes the new vendor selectable immediately, without a full sync', async () => {
    const api = fakeCreate(() =>
      jsonResponse({ Vendor: { Id: '64', DisplayName: MISSING_VENDOR, Active: true } })
    )

    await createVendorRecord(REALM, MISSING_VENDOR, deps(api.fetch))

    const reference = readReference(REALM, null, db)
    expect(reference.vendors).toEqual([{ id: '64', name: MISSING_VENDOR, active: true }])
  })

  it('adds to the existing cache rather than replacing it', async () => {
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
      new Date(NOW).toISOString()
    )

    const api = fakeCreate(() =>
      jsonResponse({ Vendor: { Id: '64', DisplayName: MISSING_VENDOR, Active: true } })
    )
    await createVendorRecord(REALM, MISSING_VENDOR, deps(api.fetch))

    expect(readReference(REALM, null, db).vendors.map((v) => v.name)).toEqual([
      'Apex Plumbing Supply',
      MISSING_VENDOR
    ])
  })

  it('scopes the new row to the connected company', async () => {
    const api = fakeCreate(() =>
      jsonResponse({ Vendor: { Id: '64', DisplayName: MISSING_VENDOR, Active: true } })
    )
    await createVendorRecord(REALM, MISSING_VENDOR, deps(api.fetch))

    expect(readReference(OTHER_REALM, null, db).vendors).toEqual([])
  })

  it('maps Intuit fault 6240 to the duplicate-name code and nothing else', async () => {
    const api = fakeCreate(
      () => new Response(DUPLICATE_FAULT, { status: 400, headers: { 'Content-Type': 'application/json' } })
    )

    await expect(createVendorRecord(REALM, MISSING_VENDOR, deps(api.fetch))).rejects.toThrow(
      QBO_VENDOR_DUPLICATE_NAME
    )
  })

  it('leaves the cache untouched when the create was refused', async () => {
    const api = fakeCreate(
      () => new Response(DUPLICATE_FAULT, { status: 400, headers: { 'Content-Type': 'application/json' } })
    )

    await expect(createVendorRecord(REALM, MISSING_VENDOR, deps(api.fetch))).rejects.toThrow()
    expect(readReference(REALM, null, db).vendors).toEqual([])
  })

  it('keeps every other rejection generic, so no fault text can carry the realm id out', async () => {
    const api = fakeCreate(
      () =>
        new Response(JSON.stringify({ Fault: { Error: [{ Message: `bad request to ${REALM}`, code: '2500' }] } }), {
          status: 400
        })
    )

    await expect(createVendorRecord(REALM, MISSING_VENDOR, deps(api.fetch))).rejects.toThrow(
      QBO_REQUEST_FAILED
    )
  })

  it('refuses a response that carries no usable vendor rather than caching a half record', async () => {
    const api = fakeCreate(() => jsonResponse({ Vendor: { Id: '64' } }))

    await expect(createVendorRecord(REALM, MISSING_VENDOR, deps(api.fetch))).rejects.toThrow(
      QBO_REQUEST_FAILED
    )
    expect(readReference(REALM, null, db).vendors).toEqual([])
  })
})

describe('lookupReferenceRecord', () => {
  beforeEach(() => {
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
          entityKind: 'vendor',
          entityId: '99',
          name: 'Retired Supplier',
          active: false,
          accountType: null,
          accountSubType: null
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

  it('resolves a vendor name by id', () => {
    expect(lookupReferenceRecord(REALM, 'vendor', '58', db)).toEqual({
      name: 'Apex Plumbing Supply',
      accountType: null
    })
  })

  it('resolves an account name and its type, which is what decides a Purchase payment method', () => {
    expect(lookupReferenceRecord(REALM, 'account', '42', db)).toEqual({
      name: 'Visa',
      accountType: 'Credit Card'
    })
    expect(lookupReferenceRecord(REALM, 'account', '35', db)?.accountType).toBe('Bank')
  })

  // The report is the reason. A vendor deactivated after a bill was entered against it must still
  // print its name on that bill's receipt, months later, with nobody left to ask.
  it('still resolves an INACTIVE record, so an old report never degrades to a bare id', () => {
    expect(lookupReferenceRecord(REALM, 'vendor', '99', db)?.name).toBe('Retired Supplier')
  })

  it('never crosses companies, and answers null for an id it does not have', () => {
    expect(lookupReferenceRecord(OTHER_REALM, 'vendor', '58', db)).toBeNull()
    expect(lookupReferenceRecord(REALM, 'vendor', '404', db)).toBeNull()
    // Kinds are numbered independently by QuickBooks: vendor 42 and account 42 are different rows.
    expect(lookupReferenceRecord(REALM, 'vendor', '42', db)).toBeNull()
  })
})
