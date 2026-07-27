// test/qbo-reference.test.ts
//
// QBO-05 coverage for the reference cache, driven against a real better-sqlite3 handle on a temp
// file (the test/migrate.test.ts pattern) and a fake fetch, so there is no Electron and no network.
//
// The three properties this file exists to pin, all of them silent failures if they regress:
//
//   1. REALM SCOPING. Two companies must never see each other's vendors. The failure mode is not a
//      crash: it is a category dropdown offering an account that does not exist in the open
//      company, and a posting rejection much later.
//
//   2. ENTITY KIND IN THE KEY. QuickBooks numbers each entity type independently, so Vendor 58 and
//      Item 58 both exist. A key of (realm, id) would overwrite one with the other, and the loser
//      would simply be missing.
//
//   3. DEACTIVATE, DO NOT DELETE. A record that disappears upstream stops being a candidate but
//      stays resolvable by id, so an entry already posted against it still shows a name.
//
// Counts and ids in the sandbox fixtures below mirror test-fixtures/MANIFEST.md.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { migrate } from '../src/main/db/migrate'
import { createFakeSecretStore, jsonResponse } from './helpers/fake-secret-store'
import {
  accountShortName,
  clearReference,
  readReference,
  syncReference
} from '../src/main/qbo/reference'
import { QBO_REQUEST_FAILED } from '../src/main/qbo/errors'
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

let dir: string
let db: Database.Database

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nb-qbo-ref-'))
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

interface Entities {
  vendors?: Array<Record<string, unknown>>
  accounts?: Array<Record<string, unknown>>
  items?: Array<Record<string, unknown>>
}

/** A fetch double that answers each of the three reference queries from a fixed set. */
function fakeApi(entities: Entities): typeof globalThis.fetch {
  return vi.fn(async (url: unknown) => {
    const target = decodeURIComponent(String(url)).replace(/\+/g, ' ')
    if (target.includes('FROM Vendor')) {
      return jsonResponse({ QueryResponse: { Vendor: entities.vendors ?? [] } })
    }
    if (target.includes('FROM Account')) {
      return jsonResponse({ QueryResponse: { Account: entities.accounts ?? [] } })
    }
    if (target.includes('FROM Item')) {
      return jsonResponse({ QueryResponse: { Item: entities.items ?? [] } })
    }
    return jsonResponse({ QueryResponse: {} })
  }) as unknown as typeof globalThis.fetch
}

function deps(fetchImpl: typeof globalThis.fetch) {
  return { db, secretStore: connectedStore(), fetch: fetchImpl, now: () => NOW }
}

/** The six vendors the sandbox corpus was seeded with (MANIFEST.md). */
const SANDBOX_VENDORS = [
  { Id: '58', DisplayName: 'Apex Plumbing Supply', Active: true },
  { Id: '59', DisplayName: 'Brightline Electric Supply', Active: true },
  { Id: '60', DisplayName: 'Metro Fuel Oil Corp', Active: true },
  { Id: '61', DisplayName: 'Cedar Lane Landscaping Supply', Active: true },
  { Id: '62', DisplayName: 'Northside Auto Parts', Active: true },
  { Id: '63', DisplayName: 'Pinnacle Office Supplies', Active: true }
]

/** The bank, credit card, and expense accounts the corpus reconciles against. */
const SANDBOX_ACCOUNTS = [
  { Id: '35', Name: 'Checking', FullyQualifiedName: 'Checking', AccountType: 'Bank', AccountSubType: 'Checking', Active: true },
  { Id: '36', Name: 'Savings', FullyQualifiedName: 'Savings', AccountType: 'Bank', AccountSubType: 'Savings', Active: true },
  { Id: '41', Name: 'Mastercard', FullyQualifiedName: 'Mastercard', AccountType: 'Credit Card', AccountSubType: 'CreditCard', Active: true },
  { Id: '42', Name: 'Visa', FullyQualifiedName: 'Visa', AccountType: 'Credit Card', AccountSubType: 'CreditCard', Active: true },
  { Id: '63', Name: 'Job Materials', FullyQualifiedName: 'Job Expenses:Job Materials', AccountType: 'Expense', AccountSubType: 'SuppliesMaterials', Active: true },
  { Id: '56', Name: 'Fuel', FullyQualifiedName: 'Automobile:Fuel', AccountType: 'Expense', AccountSubType: 'Auto', Active: true },
  { Id: '15', Name: 'Office Expenses', FullyQualifiedName: 'Office Expenses', AccountType: 'Expense', AccountSubType: 'OfficeGeneralAdministrativeExpenses', Active: true }
]

describe('syncReference writes what the API returned', () => {
  it('stores vendors, accounts, and items and reports the counts by list', async () => {
    const result = await syncReference(
      REALM,
      deps(fakeApi({
        vendors: SANDBOX_VENDORS,
        accounts: SANDBOX_ACCOUNTS,
        items: [{ Id: '1', Name: 'Services', Active: true }]
      }))
    )

    expect(result).toEqual({
      vendors: 6,
      expenseAccounts: 3,
      paymentAccounts: 4,
      items: 1,
      syncedAt: new Date(NOW).toISOString()
    })
  })

  it('splits the two account lists by AccountType, which is what the review grid filters on', async () => {
    // Offering a bank account as a bill category (or an expense account as a payment source) is a
    // posting error QuickBooks would reject mid-batch, so the split is enforced in the cache.
    await syncReference(REALM, deps(fakeApi({ accounts: SANDBOX_ACCOUNTS })))
    const reference = readReference(REALM, null, db)

    expect(reference.paymentAccounts.map((a) => a.id).sort()).toEqual(['35', '36', '41', '42'])
    expect(reference.expenseAccounts.map((a) => a.id).sort()).toEqual(['15', '56', '63'])
    for (const account of reference.expenseAccounts) {
      expect(account.accountType).toBe('Expense')
    }
    for (const account of reference.paymentAccounts) {
      expect(['Bank', 'Credit Card']).toContain(account.accountType)
    }
  })

  it('keeps the fully qualified account name and derives the leaf beside it', async () => {
    await syncReference(REALM, deps(fakeApi({ accounts: SANDBOX_ACCOUNTS })))
    const reference = readReference(REALM, null, db)
    const jobMaterials = reference.expenseAccounts.find((a) => a.id === '63')

    // The full path is what QuickBooks shows and the only way to tell two same-named sub-accounts
    // apart. The leaf is what a parsed bill actually says.
    expect(jobMaterials?.name).toBe('Job Expenses:Job Materials')
    expect(jobMaterials?.shortName).toBe('Job Materials')
  })

  it('carries the six seeded sandbox vendors through with their ids intact', async () => {
    await syncReference(REALM, deps(fakeApi({ vendors: SANDBOX_VENDORS })))
    const byId = new Map(readReference(REALM, null, db).vendors.map((v) => [v.id, v.name]))

    expect(byId.get('58')).toBe('Apex Plumbing Supply')
    expect(byId.get('59')).toBe('Brightline Electric Supply')
    expect(byId.get('60')).toBe('Metro Fuel Oil Corp')
    expect(byId.get('61')).toBe('Cedar Lane Landscaping Supply')
    expect(byId.get('62')).toBe('Northside Auto Parts')
    expect(byId.get('63')).toBe('Pinnacle Office Supplies')
  })

  it('falls back to CompanyName when a vendor has no DisplayName, and skips a nameless one', async () => {
    await syncReference(
      REALM,
      deps(fakeApi({
        vendors: [
          { Id: '70', CompanyName: 'Company Only Inc', Active: true },
          { Id: '71', Active: true },
          { Id: '72', DisplayName: 'Normal Vendor', Active: true }
        ]
      }))
    )
    const vendors = readReference(REALM, null, db).vendors
    // One malformed record must not blank out a whole company's vendor list.
    expect(vendors.map((v) => v.id).sort()).toEqual(['70', '72'])
    expect(vendors.find((v) => v.id === '70')?.name).toBe('Company Only Inc')
  })

  it('skips an account with no AccountType, because the grid could not file it either way', async () => {
    await syncReference(
      REALM,
      deps(fakeApi({ accounts: [{ Id: '99', Name: 'Mystery', Active: true }] }))
    )
    const reference = readReference(REALM, null, db)
    expect(reference.expenseAccounts).toEqual([])
    expect(reference.paymentAccounts).toEqual([])
  })

  it('sorts each list by name so a dropdown is predictable', async () => {
    await syncReference(
      REALM,
      deps(fakeApi({
        vendors: [
          { Id: '3', DisplayName: 'zeta supply', Active: true },
          { Id: '1', DisplayName: 'Alpha Supply', Active: true },
          { Id: '2', DisplayName: 'Mid Supply', Active: true }
        ]
      }))
    )
    expect(readReference(REALM, null, db).vendors.map((v) => v.name)).toEqual([
      'Alpha Supply',
      'Mid Supply',
      'zeta supply'
    ])
  })
})

describe('the cache is scoped to one realm', () => {
  it('never mixes two companies', async () => {
    await syncReference(REALM, deps(fakeApi({ vendors: SANDBOX_VENDORS })))
    await syncReference(
      OTHER_REALM,
      deps(fakeApi({ vendors: [{ Id: '58', DisplayName: 'A Completely Different Vendor', Active: true }] }))
    )

    // Vendor id 58 exists in both companies and means something different in each.
    expect(readReference(REALM, null, db).vendors.find((v) => v.id === '58')?.name).toBe(
      'Apex Plumbing Supply'
    )
    expect(readReference(OTHER_REALM, null, db).vendors.find((v) => v.id === '58')?.name).toBe(
      'A Completely Different Vendor'
    )
  })

  it('keeps a Vendor and an Item that share an id as separate records', async () => {
    // QuickBooks numbers each entity type independently. A key of (realm, id) would collapse these.
    await syncReference(
      REALM,
      deps(fakeApi({
        vendors: [{ Id: '58', DisplayName: 'Apex Plumbing Supply', Active: true }],
        items: [{ Id: '58', Name: 'Installation Service', Active: true }]
      }))
    )
    const reference = readReference(REALM, null, db)
    expect(reference.vendors).toHaveLength(1)
    expect(reference.items).toHaveLength(1)
    expect(reference.vendors[0].name).toBe('Apex Plumbing Supply')
    expect(reference.items[0].name).toBe('Installation Service')
  })

  it('a re-sync of one realm leaves the other realm untouched', async () => {
    await syncReference(REALM, deps(fakeApi({ vendors: SANDBOX_VENDORS })))
    await syncReference(OTHER_REALM, deps(fakeApi({ vendors: [{ Id: '9', DisplayName: 'Other Co', Active: true }] })))
    await syncReference(REALM, deps(fakeApi({ vendors: [SANDBOX_VENDORS[0]] })))

    expect(readReference(OTHER_REALM, null, db).vendors).toHaveLength(1)
    expect(readReference(REALM, null, db).vendors.filter((v) => v.active)).toHaveLength(1)
  })

  it('clearReference drops exactly one company', async () => {
    await syncReference(REALM, deps(fakeApi({ vendors: SANDBOX_VENDORS })))
    await syncReference(OTHER_REALM, deps(fakeApi({ vendors: [{ Id: '9', DisplayName: 'Other Co', Active: true }] })))

    clearReference(REALM, db)
    expect(readReference(REALM, null, db).vendors).toEqual([])
    expect(readReference(OTHER_REALM, null, db).vendors).toHaveLength(1)
  })
})

describe('a re-sync deactivates rather than deletes', () => {
  it('marks a vanished vendor inactive but keeps it resolvable by id', async () => {
    await syncReference(REALM, deps(fakeApi({ vendors: SANDBOX_VENDORS })))
    // Apex was deactivated in QuickBooks, so the active-only query no longer returns it.
    await syncReference(REALM, deps(fakeApi({ vendors: SANDBOX_VENDORS.slice(1) })))

    const vendors = readReference(REALM, null, db).vendors
    const apex = vendors.find((v) => v.id === '58')
    expect(apex).toBeDefined()
    expect(apex?.active).toBe(false)
    expect(apex?.name).toBe('Apex Plumbing Supply')
    expect(vendors.filter((v) => v.active)).toHaveLength(5)
  })

  it('reactivates a record that comes back', async () => {
    await syncReference(REALM, deps(fakeApi({ vendors: SANDBOX_VENDORS })))
    await syncReference(REALM, deps(fakeApi({ vendors: [] })))
    await syncReference(REALM, deps(fakeApi({ vendors: SANDBOX_VENDORS })))

    expect(readReference(REALM, null, db).vendors.every((v) => v.active)).toBe(true)
  })

  it('updates a renamed record in place rather than adding a second row', async () => {
    await syncReference(REALM, deps(fakeApi({ vendors: [{ Id: '58', DisplayName: 'Apex Plumbing', Active: true }] })))
    await syncReference(REALM, deps(fakeApi({ vendors: [{ Id: '58', DisplayName: 'Apex Plumbing Supply', Active: true }] })))

    const vendors = readReference(REALM, null, db).vendors
    expect(vendors).toHaveLength(1)
    expect(vendors[0].name).toBe('Apex Plumbing Supply')
  })
})

describe('a failed sync leaves the previous cache intact', () => {
  it('does not empty the lists when a pull fails partway', async () => {
    // The network pulls happen before the transaction opens precisely so this holds. A user who
    // loses their internet connection mid-sync must not lose their category dropdown.
    await syncReference(REALM, deps(fakeApi({ vendors: SANDBOX_VENDORS, accounts: SANDBOX_ACCOUNTS })))

    const failing = vi.fn(async (url: unknown) => {
      const target = decodeURIComponent(String(url)).replace(/\+/g, ' ')
      if (target.includes('FROM Account')) throw new Error('socket hang up')
      return jsonResponse({ QueryResponse: { Vendor: [], Item: [] } })
    }) as unknown as typeof globalThis.fetch

    await expect(syncReference(REALM, deps(failing))).rejects.toThrow(QBO_REQUEST_FAILED)

    const reference = readReference(REALM, null, db)
    expect(reference.vendors.filter((v) => v.active)).toHaveLength(6)
    expect(reference.expenseAccounts).toHaveLength(3)
    expect(reference.paymentAccounts).toHaveLength(4)
  })
})

describe('readReference', () => {
  it('returns empty lists and a null timestamp when nothing is connected', () => {
    expect(readReference(null, null, db)).toEqual({
      vendors: [],
      expenseAccounts: [],
      paymentAccounts: [],
      items: [],
      syncedAt: null
    })
  })

  it('passes the caller-supplied last-sync timestamp straight through', () => {
    expect(readReference(REALM, '2026-07-27T12:00:00.000Z', db).syncedAt).toBe(
      '2026-07-27T12:00:00.000Z'
    )
  })

  it('stores an SQL-shaped vendor name as text rather than executing it', async () => {
    // A vendor DisplayName is chosen inside somebody else's QuickBooks company, so this is a
    // legitimate name, not a hypothetical. Bound parameters are what make it inert.
    const hostile = "Robert'); DROP TABLE qbo_reference; --"
    await syncReference(REALM, deps(fakeApi({ vendors: [{ Id: '1', DisplayName: hostile, Active: true }] })))

    expect(readReference(REALM, null, db).vendors[0].name).toBe(hostile)
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'qbo_reference'")
      .all()
    expect(tables).toHaveLength(1)
  })
})

describe('accountShortName', () => {
  it('returns the last segment of a fully qualified name', () => {
    expect(accountShortName('Job Expenses:Job Materials')).toBe('Job Materials')
    expect(accountShortName('Job Expenses:Job Materials:Plants and Soil')).toBe('Plants and Soil')
  })

  it('returns the name unchanged when there is no hierarchy', () => {
    expect(accountShortName('Office Expenses')).toBe('Office Expenses')
  })

  it('falls back to the whole name rather than returning an empty string', () => {
    expect(accountShortName('Trailing:')).toBe('Trailing:')
  })
})
