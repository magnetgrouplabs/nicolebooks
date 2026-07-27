// src/main/qbo/reference.ts
//
// The QuickBooks reference cache: pull vendors, accounts, and items from the connected company and
// serve them back to the review grid from SQLite (QBO-05).
//
// WHY A CACHE AT ALL. The review grid needs every vendor and every account in a dropdown the moment
// a batch is parsed. Fetching them per render would put three network calls on the critical path of
// a screen the user is typing in, and would make the grid unusable offline. So the sync is an
// explicit action ("Sync now"), and every read is local.
//
// NAMES RESOLVE TO IDS AT RUNTIME (QBO-05 success criterion 4). Nothing in this app hardcodes a
// QuickBooks entity id. Everything the grid offers comes from this table, populated from the live
// company, so the same build works against the sandbox, against Nicole's real company, and against
// any company the app is ever pointed at.
//
// THE TWO ACCOUNT LISTS. QuickBooks Accounts are one entity with an AccountType, so they are pulled
// once and split on read: AccountType 'Expense' are the CATEGORY candidates, 'Bank' and
// 'Credit Card' are the "Paid from" candidates for an Expense row. Offering a bank account as a
// category (or an expense account as a payment source) is a posting error QuickBooks would reject
// mid-batch, so the separation is enforced here rather than in the UI.
//
// SYNC IS MARK-THEN-UPSERT, IN ONE TRANSACTION. Every row for the realm is marked inactive first,
// then the API results are upserted as active. A vendor deleted upstream therefore stops appearing
// as a candidate but stays resolvable by id (see the migration header). The transaction means a
// sync that fails halfway leaves the previous cache exactly as it was rather than a half-emptied
// list of categories.
//
// SECURITY. Every value is bound through a prepared statement, never interpolated (T-01-06/T-03-06).
// That matters here because the values are vendor and account names chosen inside someone else's
// QuickBooks company: a vendor literally named `Robert'); DROP TABLE qbo_reference; --` is a
// legitimate DisplayName. Bound, it is stored as text. The query STATEMENTS sent to Intuit are
// code-controlled constants below and contain no user or renderer input.
//
// NO SECRET MATERIAL. This module writes names, ids, and types. Tokens live in the OS keychain.

import type Database from 'better-sqlite3'
import { z } from 'zod'
import type { QboReference, QboRefAccount, QboRefRecord, QboSyncResult } from '../../shared/ipc-contract'
import { getDatabase } from '../db/connection'
import { qboPost, qboQueryAll, type QboClientDeps } from './client'
import { QBO_REQUEST_FAILED } from './errors'

/** The three kinds stored in qbo_reference. Part of the primary key (see the migration header). */
export type QboEntityKind = 'vendor' | 'account' | 'item'

/** AccountType values that make an account a CATEGORY candidate. */
export const EXPENSE_ACCOUNT_TYPES: readonly string[] = ['Expense']

/** AccountType values that make an account a "Paid from" candidate for an Expense row. */
export const PAYMENT_ACCOUNT_TYPES: readonly string[] = ['Bank', 'Credit Card']

/**
 * The three code-controlled query statements. Pagination is appended by qboQueryAll.
 *
 * Vendors and Items are filtered to Active = true because an inactive record must not be offered as
 * a new choice. Accounts are filtered by AccountType instead: pulling the whole chart of accounts
 * would drag in income, asset, and equity accounts that can never be a bill category or a payment
 * source, and every one of them would be a wrong answer sitting in a dropdown.
 */
export const VENDOR_QUERY = 'SELECT * FROM Vendor WHERE Active = true'
export const ITEM_QUERY = 'SELECT * FROM Item WHERE Active = true'
export const ACCOUNT_QUERY =
  "SELECT * FROM Account WHERE AccountType IN ('Expense', 'Bank', 'Credit Card')"

/**
 * Lenient validators for the entity shapes. Loose, because Intuit returns dozens of fields this app
 * does not consume and a strict object would fail the whole sync over an added one. Only the two
 * fields that make a record usable are required: without an Id it cannot be posted against, and
 * without a name it cannot be shown. An entry missing either is skipped rather than fatal, so one
 * malformed record cannot blank out a company's whole vendor list.
 */
const VendorSchema = z.looseObject({
  Id: z.string().min(1),
  DisplayName: z.string().min(1).nullish(),
  CompanyName: z.string().nullish(),
  Active: z.boolean().nullish()
})

const ItemSchema = z.looseObject({
  Id: z.string().min(1),
  Name: z.string().min(1).nullish(),
  Active: z.boolean().nullish()
})

const AccountSchema = z.looseObject({
  Id: z.string().min(1),
  Name: z.string().min(1).nullish(),
  FullyQualifiedName: z.string().nullish(),
  AccountType: z.string().nullish(),
  AccountSubType: z.string().nullish(),
  Active: z.boolean().nullish()
})

/** One row as it is written to qbo_reference. */
interface ReferenceRow {
  entityKind: QboEntityKind
  entityId: string
  name: string
  active: boolean
  accountType: string | null
  accountSubType: string | null
}

/** The raw qbo_reference row as SQLite returns it. */
interface ReferenceDbRow {
  realm_id: string
  entity_kind: string
  entity_id: string
  name: string
  active: number
  account_type: string | null
  account_sub_type: string | null
  synced_at: string
}

const UPSERT_SQL = `INSERT INTO qbo_reference (
    realm_id, entity_kind, entity_id, name, active, account_type, account_sub_type, synced_at
  ) VALUES (
    @realm_id, @entity_kind, @entity_id, @name, @active, @account_type, @account_sub_type, @synced_at
  )
  ON CONFLICT(realm_id, entity_kind, entity_id) DO UPDATE SET
    name             = excluded.name,
    active           = excluded.active,
    account_type     = excluded.account_type,
    account_sub_type = excluded.account_sub_type,
    synced_at        = excluded.synced_at`

const DEACTIVATE_SQL = 'UPDATE qbo_reference SET active = 0 WHERE realm_id = ? AND entity_kind = ?'

const SELECT_SQL =
  'SELECT * FROM qbo_reference WHERE realm_id = ? AND entity_kind = ? ORDER BY name COLLATE NOCASE'

const DELETE_REALM_SQL = 'DELETE FROM qbo_reference WHERE realm_id = ?'

const LOOKUP_SQL =
  'SELECT name, account_type FROM qbo_reference WHERE realm_id = ? AND entity_kind = ? AND entity_id = ?'

/** Injectable dependencies for a sync (Shared Pattern B): network, clock, and database. */
export interface SyncReferenceDeps extends QboClientDeps {
  db?: Database.Database
}

/** Map a raw Vendor entity to a cache row, or null when it is unusable. */
function toVendorRow(raw: unknown): ReferenceRow | null {
  const parsed = VendorSchema.safeParse(raw)
  if (!parsed.success) return null
  const name = parsed.data.DisplayName ?? parsed.data.CompanyName
  if (!name) return null
  return {
    entityKind: 'vendor',
    entityId: parsed.data.Id,
    name,
    active: parsed.data.Active ?? true,
    accountType: null,
    accountSubType: null
  }
}

/** Map a raw Item entity to a cache row, or null when it is unusable. */
function toItemRow(raw: unknown): ReferenceRow | null {
  const parsed = ItemSchema.safeParse(raw)
  if (!parsed.success || !parsed.data.Name) return null
  return {
    entityKind: 'item',
    entityId: parsed.data.Id,
    name: parsed.data.Name,
    active: parsed.data.Active ?? true,
    accountType: null,
    accountSubType: null
  }
}

/**
 * Map a raw Account entity to a cache row, or null when it is unusable.
 *
 * FullyQualifiedName is preferred over Name because QuickBooks charts of accounts are hierarchical:
 * two different sub-accounts can both be called "Supplies", and the fully qualified form
 * ("Job Expenses:Supplies") is the only one a user can tell apart in a dropdown.
 */
function toAccountRow(raw: unknown): ReferenceRow | null {
  const parsed = AccountSchema.safeParse(raw)
  if (!parsed.success) return null
  const name = parsed.data.FullyQualifiedName ?? parsed.data.Name
  if (!name || !parsed.data.AccountType) return null
  return {
    entityKind: 'account',
    entityId: parsed.data.Id,
    name,
    active: parsed.data.Active ?? true,
    accountType: parsed.data.AccountType,
    accountSubType: parsed.data.AccountSubType ?? null
  }
}

/**
 * Pull every reference list for one realm and replace the cache for that realm.
 *
 * The three network pulls happen BEFORE the transaction opens: better-sqlite3 transactions are
 * synchronous, so awaiting inside one is not possible, and holding a write transaction open across
 * three round trips would be wrong even if it were. The consequence is the useful one: if any pull
 * fails, nothing is written and the previous cache survives intact.
 */
export async function syncReference(
  realmId: string,
  deps: SyncReferenceDeps = {}
): Promise<QboSyncResult> {
  const db = deps.db ?? getDatabase()
  const syncedAt = new Date((deps.now ?? Date.now)()).toISOString()

  const [vendorsRaw, accountsRaw, itemsRaw] = await Promise.all([
    qboQueryAll(realmId, VENDOR_QUERY, 'Vendor', deps),
    qboQueryAll(realmId, ACCOUNT_QUERY, 'Account', deps),
    qboQueryAll(realmId, ITEM_QUERY, 'Item', deps)
  ])

  const rows: ReferenceRow[] = []
  for (const raw of vendorsRaw) {
    const row = toVendorRow(raw)
    if (row) rows.push(row)
  }
  for (const raw of accountsRaw) {
    const row = toAccountRow(raw)
    if (row) rows.push(row)
  }
  for (const raw of itemsRaw) {
    const row = toItemRow(raw)
    if (row) rows.push(row)
  }

  writeReferenceRows(db, realmId, rows, syncedAt)

  const accounts = rows.filter((r) => r.entityKind === 'account')
  return {
    vendors: rows.filter((r) => r.entityKind === 'vendor').length,
    expenseAccounts: accounts.filter((r) => isExpenseAccount(r.accountType)).length,
    paymentAccounts: accounts.filter((r) => isPaymentAccount(r.accountType)).length,
    items: rows.filter((r) => r.entityKind === 'item').length,
    syncedAt
  }
}

/**
 * Mark every existing row for the realm inactive, then upsert what the API returned. One
 * transaction, so a failure mid-write cannot leave the grid with an empty category list.
 *
 * Exported for the unit spec, which drives it against a temp database with no network.
 */
export function writeReferenceRows(
  db: Database.Database,
  realmId: string,
  rows: readonly ReferenceRow[],
  syncedAt: string
): void {
  const deactivate = db.prepare(DEACTIVATE_SQL)
  const upsert = db.prepare(UPSERT_SQL)

  const run = db.transaction(() => {
    for (const kind of ['vendor', 'account', 'item'] as const) {
      deactivate.run(realmId, kind)
    }
    for (const row of rows) {
      upsert.run({
        realm_id: realmId,
        entity_kind: row.entityKind,
        entity_id: row.entityId,
        name: row.name,
        // STRICT has no BOOLEAN and better-sqlite3 refuses to bind a JS boolean (Pitfall 8).
        active: row.active ? 1 : 0,
        account_type: row.accountType,
        account_sub_type: row.accountSubType,
        synced_at: syncedAt
      })
    }
  })

  run()
}

function isExpenseAccount(accountType: string | null): boolean {
  return accountType !== null && EXPENSE_ACCOUNT_TYPES.includes(accountType)
}

function isPaymentAccount(accountType: string | null): boolean {
  return accountType !== null && PAYMENT_ACCOUNT_TYPES.includes(accountType)
}

function selectKind(db: Database.Database, realmId: string, kind: QboEntityKind): ReferenceDbRow[] {
  return db.prepare(SELECT_SQL).all(realmId, kind) as ReferenceDbRow[]
}

function toRecord(row: ReferenceDbRow): QboRefRecord {
  // 0/1 INTEGER back to the boolean the QboRefRecord contract exposes (Pitfall 8).
  return { id: row.entity_id, name: row.name, active: row.active === 1 }
}

/**
 * The last segment of a fully qualified account name. QuickBooks uses ':' as the hierarchy
 * separator and reserves it, so splitting on it is exact rather than heuristic. A name with no
 * separator is already its own leaf.
 */
export function accountShortName(fullyQualifiedName: string): string {
  const segments = fullyQualifiedName.split(':')
  return segments[segments.length - 1]?.trim() || fullyQualifiedName
}

function toAccount(row: ReferenceDbRow): QboRefAccount {
  return {
    ...toRecord(row),
    accountType: row.account_type ?? '',
    accountSubType: row.account_sub_type,
    shortName: accountShortName(row.name)
  }
}

/**
 * Read the whole cached reference set for one realm. LOCAL ONLY: this never reaches the network, so
 * an offline user still gets working dropdowns from the last sync.
 */
export function readReference(
  realmId: string | null,
  lastSyncAt: string | null,
  db: Database.Database = getDatabase()
): QboReference {
  if (!realmId) {
    return { vendors: [], expenseAccounts: [], paymentAccounts: [], items: [], syncedAt: null }
  }

  const accounts = selectKind(db, realmId, 'account')
  return {
    vendors: selectKind(db, realmId, 'vendor').map(toRecord),
    expenseAccounts: accounts.filter((r) => isExpenseAccount(r.account_type)).map(toAccount),
    paymentAccounts: accounts.filter((r) => isPaymentAccount(r.account_type)).map(toAccount),
    items: selectKind(db, realmId, 'item').map(toRecord),
    syncedAt: lastSyncAt
  }
}

/** Drop every cached row for one realm. Called on disconnect so no company's data outlives it. */
export function clearReference(realmId: string, db: Database.Database = getDatabase()): void {
  db.prepare(DELETE_REALM_SQL).run(realmId)
}

/** One cached record resolved by id: what it is called, and (for accounts) what kind it is. */
export interface QboReferenceLookup {
  name: string
  accountType: string | null
}

/**
 * Resolve ONE cached record by id, INCLUDING an inactive one.
 *
 * Inactive rows are deliberately in scope. The two callers are the posting report (which prints the
 * name a posted entry was filed under) and the Purchase payment-type decision, and both are asking
 * about a record that has ALREADY been chosen. A vendor deactivated in QuickBooks after a bill was
 * entered against it still has to render its name on that bill's receipt; filtering it out here
 * would silently degrade a months-old report to a bare id.
 */
export function lookupReferenceRecord(
  realmId: string,
  kind: QboEntityKind,
  entityId: string,
  db: Database.Database = getDatabase()
): QboReferenceLookup | null {
  const row = db.prepare(LOOKUP_SQL).get(realmId, kind, entityId) as
    | { name: string; account_type: string | null }
    | undefined
  if (!row) return null
  return { name: row.name, accountType: row.account_type }
}

/**
 * Create a vendor in the connected company and cache the record it returns.
 *
 * ONLY reached from an explicit user click on the review screen (RECON-03: reconciliation itself
 * never creates anything). The cache is written from the RESPONSE rather than from the name that was
 * typed, because QuickBooks is the authority on the id and on what the DisplayName ended up as.
 *
 * The row is upserted immediately rather than waiting for the next full sync, so the vendor the user
 * just created is selectable in the same breath. `synced_at` records this write, which is honest: the
 * row IS current as of now, and the next sync will simply confirm it.
 *
 * A duplicate name is Intuit's error 6240 and is mapped to its own code by qboPost, so the caller can
 * say "pick it from the list instead" rather than "something went wrong".
 */
export async function createVendorRecord(
  realmId: string,
  displayName: string,
  deps: SyncReferenceDeps = {}
): Promise<QboRefRecord> {
  const body = await qboPost(realmId, 'vendor', { DisplayName: displayName }, deps)
  const parsed = z.looseObject({ Vendor: VendorSchema }).safeParse(body)
  if (!parsed.success) throw new Error(QBO_REQUEST_FAILED)

  const row = toVendorRow(parsed.data.Vendor)
  if (!row) throw new Error(QBO_REQUEST_FAILED)

  const db = deps.db ?? getDatabase()
  const syncedAt = new Date((deps.now ?? Date.now)()).toISOString()
  db.prepare(UPSERT_SQL).run({
    realm_id: realmId,
    entity_kind: row.entityKind,
    entity_id: row.entityId,
    name: row.name,
    active: row.active ? 1 : 0,
    account_type: null,
    account_sub_type: null,
    synced_at: syncedAt
  })

  return { id: row.entityId, name: row.name, active: row.active }
}
