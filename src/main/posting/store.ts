// src/main/posting/store.ts
//
// Every read and write against posting_batches, posting_entries, and the Phase 2 dedupe ledger.
//
// This module is the WRITE HALF OF DESIGN B. src/main/ingestion/ledger.ts says it out loud: Phase 2
// only ever SELECTs from posted_file_hashes, and "the 'mark sent' write is owned by Phase 7". It is
// owned here, in exactly one function (insertPostedHash), called from exactly one place: the moment
// an entry reaches 'confirmed'. That is what makes the Phase 2 scan's "already entered on ..."
// message true rather than hopeful.
//
// SECURITY. Every value is bound through a prepared statement; nothing is interpolated into SQL.
// That matters here for the same reason it matters in parse/cache.ts: several of these values
// (vendor names, memos, filenames) originate in a document a stranger mailed in.
//
// The db handle is the first argument everywhere, defaulted to the main-process singleton, so the
// temp-database unit suite drives all of it without electron. Same shape as ledger.ts and cache.ts.

import type Database from 'better-sqlite3'
import { getDatabase } from '../db/connection'
import type { PostingEntryState, PostingEntryType } from '../../shared/ipc-contract'

/**
 * Batch header state, for display only.
 *
 * Whether a batch can be RESUMED is never read from this column: it is computed from the entries
 * (see isResumable). A header is a summary, and letting a summary authorize a second post is how
 * you get two bills.
 */
export type PostingBatchState = 'open' | 'complete' | 'partially-undone' | 'undone'

/** One posting_entries row, camelCased. */
export interface PostingEntryRecord {
  id: number
  batchId: string
  position: number
  fileHash: string
  filename: string | null
  entryType: PostingEntryType
  requestId: string
  state: PostingEntryState
  qboId: string | null
  syncToken: string | null
  error: string | null
  vendorId: string
  vendorName: string | null
  categoryAccountId: string
  categoryAccountName: string | null
  paidFromAccountId: string | null
  paidFromAccountName: string | null
  txnDate: string
  dueDate: string | null
  refNumber: string | null
  memo: string | null
  amountCents: number
  realmId: string
  createdAt: string
  updatedAt: string
  sentAt: string | null
  confirmedAt: string | null
  undoneAt: string | null
  undoReason: string | null
}

/** One posting_batches row, camelCased. */
export interface PostingBatchRecord {
  id: string
  createdAt: string
  updatedAt: string
  realmId: string
  state: PostingBatchState
  entryCount: number
}

/** The snake_case shapes SQLite hands back. */
interface EntryRow {
  id: number
  batch_id: string
  position: number
  file_hash: string
  filename: string | null
  entry_type: string
  request_id: string
  state: string
  qbo_id: string | null
  sync_token: string | null
  error: string | null
  vendor_id: string
  vendor_name: string | null
  category_account_id: string
  category_account_name: string | null
  paid_from_account_id: string | null
  paid_from_account_name: string | null
  txn_date: string
  due_date: string | null
  ref_number: string | null
  memo: string | null
  amount_cents: number
  realm_id: string
  created_at: string
  updated_at: string
  sent_at: string | null
  confirmed_at: string | null
  undone_at: string | null
  undo_reason: string | null
}

interface BatchRow {
  id: string
  created_at: string
  updated_at: string
  realm_id: string
  state: string
  entry_count: number
}

function toEntry(row: EntryRow): PostingEntryRecord {
  return {
    id: row.id,
    batchId: row.batch_id,
    position: row.position,
    fileHash: row.file_hash,
    filename: row.filename,
    entryType: row.entry_type as PostingEntryType,
    requestId: row.request_id,
    state: row.state as PostingEntryState,
    qboId: row.qbo_id,
    syncToken: row.sync_token,
    error: row.error,
    vendorId: row.vendor_id,
    vendorName: row.vendor_name,
    categoryAccountId: row.category_account_id,
    categoryAccountName: row.category_account_name,
    paidFromAccountId: row.paid_from_account_id,
    paidFromAccountName: row.paid_from_account_name,
    txnDate: row.txn_date,
    dueDate: row.due_date,
    refNumber: row.ref_number,
    memo: row.memo,
    amountCents: row.amount_cents,
    realmId: row.realm_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    sentAt: row.sent_at,
    confirmedAt: row.confirmed_at,
    undoneAt: row.undone_at,
    undoReason: row.undo_reason
  }
}

function toBatch(row: BatchRow): PostingBatchRecord {
  return {
    id: row.id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    realmId: row.realm_id,
    state: row.state as PostingBatchState,
    entryCount: row.entry_count
  }
}

// ---------------------------------------------------------------------------
// Batches
// ---------------------------------------------------------------------------

const INSERT_BATCH_SQL = `INSERT INTO posting_batches
  (id, created_at, updated_at, realm_id, state, entry_count)
  VALUES (@id, @created_at, @updated_at, @realm_id, @state, @entry_count)`

export function insertBatch(
  db: Database.Database = getDatabase(),
  batch: { id: string; createdAt: string; realmId: string; entryCount: number }
): void {
  db.prepare(INSERT_BATCH_SQL).run({
    id: batch.id,
    created_at: batch.createdAt,
    updated_at: batch.createdAt,
    realm_id: batch.realmId,
    state: 'open',
    entry_count: batch.entryCount
  })
}

export function getBatch(
  db: Database.Database = getDatabase(),
  batchId: string
): PostingBatchRecord | null {
  const row = db.prepare('SELECT * FROM posting_batches WHERE id = ?').get(batchId) as
    | BatchRow
    | undefined
  return row ? toBatch(row) : null
}

/** Newest first, which is the order the History screen lists them in. */
export function listBatches(db: Database.Database = getDatabase()): PostingBatchRecord[] {
  const rows = db
    .prepare('SELECT * FROM posting_batches ORDER BY created_at DESC, id DESC')
    .all() as BatchRow[]
  return rows.map(toBatch)
}

export function listEntries(
  db: Database.Database = getDatabase(),
  batchId: string
): PostingEntryRecord[] {
  const rows = db
    .prepare('SELECT * FROM posting_entries WHERE batch_id = ? ORDER BY position ASC, id ASC')
    .all(batchId) as EntryRow[]
  return rows.map(toEntry)
}

/**
 * The most recent batch that still has unfinished work.
 *
 * "Unfinished" is any entry in pending, sent, or failed. This is the RESUME TARGET, and computing
 * it from the entries rather than from posting_batches.state is deliberate: the header is written
 * by a separate statement and a crash between the two would leave it stale, which is precisely the
 * moment resume matters most.
 */
export function findResumableBatch(
  db: Database.Database = getDatabase()
): PostingBatchRecord | null {
  const row = db
    .prepare(
      `SELECT b.* FROM posting_batches b
         WHERE EXISTS (
           SELECT 1 FROM posting_entries e
             WHERE e.batch_id = b.id AND e.state IN ('pending', 'sent', 'failed')
         )
         ORDER BY b.created_at DESC, b.id DESC
         LIMIT 1`
    )
    .get() as BatchRow | undefined
  return row ? toBatch(row) : null
}

/** The most recent batch holding at least one confirmed, not-yet-undone entry. Undo's target. */
export function findUndoableBatch(
  db: Database.Database = getDatabase()
): PostingBatchRecord | null {
  const row = db
    .prepare(
      `SELECT b.* FROM posting_batches b
         WHERE EXISTS (
           SELECT 1 FROM posting_entries e
             WHERE e.batch_id = b.id AND e.state = 'confirmed' AND e.undone_at IS NULL
         )
         ORDER BY b.created_at DESC, b.id DESC
         LIMIT 1`
    )
    .get() as BatchRow | undefined
  return row ? toBatch(row) : null
}

/**
 * Recompute and store a batch's display state from its entries.
 *
 * Priority is undo first: a batch that was complete and then reversed must not keep reading
 * "complete", because that is the one label that would make a user think the money is still in.
 */
export function refreshBatchState(
  db: Database.Database = getDatabase(),
  batchId: string,
  now: string
): PostingBatchState {
  const entries = listEntries(db, batchId)
  const confirmed = entries.filter((e) => e.state === 'confirmed')
  const undone = confirmed.filter((e) => e.undoneAt !== null)

  let state: PostingBatchState
  if (undone.length > 0) {
    state = undone.length === confirmed.length ? 'undone' : 'partially-undone'
  } else if (entries.length > 0 && confirmed.length === entries.length) {
    state = 'complete'
  } else {
    state = 'open'
  }

  db.prepare('UPDATE posting_batches SET state = ?, updated_at = ? WHERE id = ?').run(
    state,
    now,
    batchId
  )
  return state
}

// ---------------------------------------------------------------------------
// Entries
// ---------------------------------------------------------------------------

/** Everything an entry needs at insert time. The request id is already minted by the caller. */
export interface NewEntryInput {
  batchId: string
  position: number
  fileHash: string
  filename: string | null
  entryType: PostingEntryType
  requestId: string
  vendorId: string
  vendorName: string | null
  categoryAccountId: string
  categoryAccountName: string | null
  paidFromAccountId: string | null
  paidFromAccountName: string | null
  txnDate: string
  dueDate: string | null
  refNumber: string | null
  memo: string | null
  amountCents: number
  realmId: string
  createdAt: string
}

const INSERT_ENTRY_SQL = `INSERT INTO posting_entries (
    batch_id, position, file_hash, filename, entry_type, request_id, state,
    vendor_id, vendor_name, category_account_id, category_account_name,
    paid_from_account_id, paid_from_account_name,
    txn_date, due_date, ref_number, memo, amount_cents, realm_id,
    created_at, updated_at
  ) VALUES (
    @batch_id, @position, @file_hash, @filename, @entry_type, @request_id, 'pending',
    @vendor_id, @vendor_name, @category_account_id, @category_account_name,
    @paid_from_account_id, @paid_from_account_name,
    @txn_date, @due_date, @ref_number, @memo, @amount_cents, @realm_id,
    @created_at, @created_at
  )`

/**
 * Insert one entry in state 'pending', with its request id already on it.
 *
 * The ORDER of operations across the whole engine is the guarantee: every entry of a batch is
 * inserted, with its idempotency key, BEFORE the first network call of that batch. A key minted
 * later would not exist during the window it is meant to cover.
 */
export function insertEntry(
  db: Database.Database = getDatabase(),
  entry: NewEntryInput
): PostingEntryRecord {
  const info = db.prepare(INSERT_ENTRY_SQL).run({
    batch_id: entry.batchId,
    position: entry.position,
    file_hash: entry.fileHash,
    filename: entry.filename,
    entry_type: entry.entryType,
    request_id: entry.requestId,
    vendor_id: entry.vendorId,
    vendor_name: entry.vendorName,
    category_account_id: entry.categoryAccountId,
    category_account_name: entry.categoryAccountName,
    paid_from_account_id: entry.paidFromAccountId,
    paid_from_account_name: entry.paidFromAccountName,
    txn_date: entry.txnDate,
    due_date: entry.dueDate,
    ref_number: entry.refNumber,
    memo: entry.memo,
    amount_cents: entry.amountCents,
    realm_id: entry.realmId,
    created_at: entry.createdAt
  })
  const row = db
    .prepare('SELECT * FROM posting_entries WHERE id = ?')
    .get(Number(info.lastInsertRowid)) as EntryRow
  return toEntry(row)
}

/** One entry of one batch by document. The UNIQUE (batch_id, file_hash) index makes it a point read. */
export function findEntryInBatch(
  db: Database.Database = getDatabase(),
  batchId: string,
  fileHash: string
): PostingEntryRecord | null {
  const row = db
    .prepare('SELECT * FROM posting_entries WHERE batch_id = ? AND file_hash = ?')
    .get(batchId, fileHash) as EntryRow | undefined
  return row ? toEntry(row) : null
}

export function getEntry(
  db: Database.Database = getDatabase(),
  entryId: number
): PostingEntryRecord | null {
  const row = db.prepare('SELECT * FROM posting_entries WHERE id = ?').get(entryId) as
    | EntryRow
    | undefined
  return row ? toEntry(row) : null
}

/**
 * Update the mutable review fields of an entry that is being re-sent, WITHOUT touching request_id.
 *
 * The request id is immutable for the life of an entry, and that is the whole idempotency contract:
 * a re-send of a document already in this batch replays against the same key, so QuickBooks either
 * creates it once or returns what it already created. See the resume rules in send.ts for the
 * consequence when the user edited the row between the two sends.
 */
export function updateEntryFields(
  db: Database.Database = getDatabase(),
  entryId: number,
  fields: {
    filename: string | null
    entryType: PostingEntryType
    vendorId: string
    vendorName: string | null
    categoryAccountId: string
    categoryAccountName: string | null
    paidFromAccountId: string | null
    paidFromAccountName: string | null
    txnDate: string
    dueDate: string | null
    refNumber: string | null
    memo: string | null
    amountCents: number
    updatedAt: string
  }
): void {
  db.prepare(
    `UPDATE posting_entries SET
       filename = @filename, entry_type = @entry_type,
       vendor_id = @vendor_id, vendor_name = @vendor_name,
       category_account_id = @category_account_id, category_account_name = @category_account_name,
       paid_from_account_id = @paid_from_account_id,
       paid_from_account_name = @paid_from_account_name,
       txn_date = @txn_date, due_date = @due_date, ref_number = @ref_number, memo = @memo,
       amount_cents = @amount_cents, state = 'pending', error = NULL, updated_at = @updated_at
     WHERE id = @id`
  ).run({
    id: entryId,
    filename: fields.filename,
    entry_type: fields.entryType,
    vendor_id: fields.vendorId,
    vendor_name: fields.vendorName,
    category_account_id: fields.categoryAccountId,
    category_account_name: fields.categoryAccountName,
    paid_from_account_id: fields.paidFromAccountId,
    paid_from_account_name: fields.paidFromAccountName,
    txn_date: fields.txnDate,
    due_date: fields.dueDate,
    ref_number: fields.refNumber,
    memo: fields.memo,
    amount_cents: fields.amountCents,
    updated_at: fields.updatedAt
  })
}

/** Move an entry to 'sent': the create was dispatched and the outcome is not known yet. */
export function markEntrySent(
  db: Database.Database = getDatabase(),
  entryId: number,
  now: string
): void {
  db.prepare(
    "UPDATE posting_entries SET state = 'sent', sent_at = ?, updated_at = ?, error = NULL WHERE id = ?"
  ).run(now, now, entryId)
}

/** Move an entry to 'confirmed' and record what QuickBooks created. */
export function markEntryConfirmed(
  db: Database.Database = getDatabase(),
  entryId: number,
  result: { qboId: string; syncToken: string; now: string }
): void {
  db.prepare(
    `UPDATE posting_entries
       SET state = 'confirmed', qbo_id = ?, sync_token = ?, confirmed_at = ?, updated_at = ?,
           error = NULL
     WHERE id = ?`
  ).run(result.qboId, result.syncToken, result.now, result.now, entryId)
}

/** Move an entry to 'failed' with ALREADY-MAPPED copy. Raw provider text never reaches this. */
export function markEntryFailed(
  db: Database.Database = getDatabase(),
  entryId: number,
  reason: string,
  now: string
): void {
  db.prepare(
    "UPDATE posting_entries SET state = 'failed', error = ?, updated_at = ? WHERE id = ?"
  ).run(reason, now, entryId)
}

/** Record that undo removed this entity from QuickBooks. */
export function markEntryUndone(
  db: Database.Database = getDatabase(),
  entryId: number,
  now: string
): void {
  db.prepare(
    'UPDATE posting_entries SET undone_at = ?, undo_reason = NULL, updated_at = ? WHERE id = ?'
  ).run(now, now, entryId)
}

/** Record WHY an undo left this entity alone. The entry stays confirmed, because it still exists. */
export function markUndoRefused(
  db: Database.Database = getDatabase(),
  entryId: number,
  reason: string,
  now: string
): void {
  db.prepare('UPDATE posting_entries SET undo_reason = ?, updated_at = ? WHERE id = ?').run(
    reason,
    now,
    entryId
  )
}

// ---------------------------------------------------------------------------
// The Phase 2 dedupe ledger: the write half of Design B
// ---------------------------------------------------------------------------

/**
 * Mark a document posted. Called at exactly one moment: an entry reaching 'confirmed'.
 *
 * INSERT OR REPLACE rather than a plain INSERT because a hash can legitimately be re-posted after
 * an undo removed its row, and because the alternative (a UNIQUE violation aborting the batch
 * loop) would turn a bookkeeping detail into a lost batch.
 *
 * qbo_entity/qbo_id are the provenance Phase 2's ledger columns were created empty to hold.
 */
export function insertPostedHash(
  db: Database.Database = getDatabase(),
  record: {
    hash: string
    postedAt: string
    originalFilename: string
    qboEntity: string
    qboId: string
  }
): void {
  db.prepare(
    `INSERT OR REPLACE INTO posted_file_hashes (hash, posted_at, original_filename, qbo_entity, qbo_id)
     VALUES (?, ?, ?, ?, ?)`
  ).run(record.hash, record.postedAt, record.originalFilename, record.qboEntity, record.qboId)
}

/**
 * Remove a document from the ledger, so it can be entered again.
 *
 * This is undo's other half and it is easy to forget: reversing the QuickBooks entity without
 * clearing the ledger row would leave the document permanently un-enterable, because the Phase 2
 * scan would keep excluding it as "already entered" for a bill that no longer exists.
 */
export function deletePostedHash(db: Database.Database = getDatabase(), hash: string): void {
  db.prepare('DELETE FROM posted_file_hashes WHERE hash = ?').run(hash)
}

/** Is this document already marked posted? The guard that runs before any create. */
export function isHashPosted(db: Database.Database = getDatabase(), hash: string): boolean {
  const row = db.prepare('SELECT 1 AS present FROM posted_file_hashes WHERE hash = ?').get(hash)
  return row !== undefined
}

/**
 * The filename this document arrived under, from the Phase 3 parse cache.
 *
 * Looked up ONCE, at post time, and copied onto the entry. The parse cache is a cache: it can be
 * cleared, and a report that says "bill from Home Depot" is worth keeping when it has been.
 * Returns null when the document was never parsed (a manually built row), which is not an error.
 */
export function lookupFilename(
  db: Database.Database = getDatabase(),
  fileHash: string
): string | null {
  const row = db
    .prepare('SELECT original_filename FROM parsed_results WHERE file_hash = ?')
    .get(fileHash) as { original_filename: string } | undefined
  return row?.original_filename ?? null
}

// ---------------------------------------------------------------------------
// The duplicate warning (wired to a channel by the REVIEW-UI wave)
// ---------------------------------------------------------------------------

/** What to look for: this vendor, this amount, around this date. */
export interface DuplicateQuery {
  vendorId: string
  amountCents: number
  txnDate: string
  /** Days either side of txnDate to search. Defaults to 3. */
  windowDays?: number
}

/** One prior entry that looks like the row the user is about to send. */
export interface DuplicateWarning {
  batchId: string
  fileHash: string
  filename: string | null
  entryType: PostingEntryType
  qboId: string | null
  vendorId: string
  vendorName: string | null
  amountCents: number
  txnDate: string
  /** Signed offset in days from the queried date. Negative means the prior entry is earlier. */
  daysApart: number
  postedAt: string | null
}

export const DUPLICATE_WINDOW_DAYS = 3

/**
 * Shift an ISO 'YYYY-MM-DD' date by whole days.
 *
 * Date.UTC only, never local time: a local-time round trip near a daylight-saving boundary can
 * land on the wrong calendar day, and this function decides which prior bills a user is warned
 * about. Exported because the off-by-one at the window edge is worth pinning directly.
 */
export function shiftIsoDate(iso: string, days: number): string {
  const [year, month, day] = iso.split('-').map(Number)
  const shifted = new Date(Date.UTC(year, month - 1, day + days))
  return shifted.toISOString().slice(0, 10)
}

/** Whole days between two ISO dates, b minus a. */
export function isoDaysBetween(a: string, b: string): number {
  const [ay, am, ad] = a.split('-').map(Number)
  const [by, bm, bd] = b.split('-').map(Number)
  const msPerDay = 86_400_000
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / msPerDay)
}

/**
 * Prior CONFIRMED entries that match a vendor and an amount within a few days.
 *
 * This is the "you may already have entered this" warning for the review screen, and it is
 * deliberately different from the Phase 2 dedupe check. Dedupe catches the SAME FILE by hash. This
 * catches the same BILL arriving as a different file: a re-scanned paper copy, a PDF that was also
 * photographed, a vendor's duplicate email. Same money, different bytes, so the hash says nothing.
 *
 * Undone entries are excluded: reversing a batch is exactly how a user says "that did not happen",
 * and warning about it afterwards would train them to ignore the warning.
 *
 * Returns [] rather than throwing when the tables are absent, so a caller on a half-migrated
 * database degrades to "no warning" instead of failing the review screen.
 */
export function findPriorConfirmedEntries(
  db: Database.Database = getDatabase(),
  query: DuplicateQuery
): DuplicateWarning[] {
  const window = query.windowDays ?? DUPLICATE_WINDOW_DAYS
  const from = shiftIsoDate(query.txnDate, -window)
  const to = shiftIsoDate(query.txnDate, window)

  const rows = db
    .prepare(
      `SELECT e.*, p.posted_at AS ledger_posted_at
         FROM posting_entries e
         LEFT JOIN posted_file_hashes p ON p.hash = e.file_hash
        WHERE e.vendor_id = ?
          AND e.amount_cents = ?
          AND e.state = 'confirmed'
          AND e.undone_at IS NULL
          AND e.txn_date BETWEEN ? AND ?
        ORDER BY e.txn_date ASC, e.id ASC`
    )
    .all(query.vendorId, query.amountCents, from, to) as Array<
    EntryRow & { ledger_posted_at: string | null }
  >

  return rows.map((row) => ({
    batchId: row.batch_id,
    fileHash: row.file_hash,
    filename: row.filename,
    entryType: row.entry_type as PostingEntryType,
    qboId: row.qbo_id,
    vendorId: row.vendor_id,
    vendorName: row.vendor_name,
    amountCents: row.amount_cents,
    txnDate: row.txn_date,
    daysApart: isoDaysBetween(query.txnDate, row.txn_date),
    postedAt: row.ledger_posted_at
  }))
}
