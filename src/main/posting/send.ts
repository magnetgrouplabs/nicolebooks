// src/main/posting/send.ts
//
// The batch send flow: the part of this app that spends money, and therefore the part that is
// written to be boring.
//
// THE ORDER OF OPERATIONS IS THE PRODUCT.
//
//   1. Validate the whole batch. Nothing is written if any row is unpostable.
//   2. PERSIST EVERY ENTRY, EACH WITH ITS IDEMPOTENCY KEY, BEFORE THE FIRST NETWORK CALL.
//   3. Only then send, one entry at a time, in order.
//
// Step 2 is the one that matters. A request id minted just before its own request would be lost in
// exactly the window it exists to cover: the process dies between "QuickBooks created the bill"
// and "we wrote down that it did". Because the key is already on disk, the re-send replays it and
// QuickBooks returns the original bill instead of creating a second one.
//
// RESUME SEMANTICS, EXACTLY AS IMPLEMENTED
//
//   * A batch is RESUMABLE while any of its entries is pending, sent, or failed. That is computed
//     from the entries, never read off the batch header.
//   * A send RESUMES the most recent resumable batch when at least one row in the send already has
//     an entry there. Otherwise it opens a new batch. Rows with no matching entry are appended to
//     the resumed batch as new entries with fresh keys.
//   * For a row whose entry already exists in that batch:
//       - state 'confirmed'                -> SKIPPED. No payload is built, no request is made. It
//                                             is reported as confirmed and counted as done.
//       - state 'pending' | 'sent' | 'failed' -> RETRIED WITH THE SAME request_id. The editable
//                                             fields are refreshed from the row and the state
//                                             returns to 'pending'; the key is never regenerated.
//   * A row failing does not stop the batch. It is marked failed with mapped copy and the loop
//     continues, so one bad vendor reference cannot strand nineteen good rows.
//   * A document already in posted_file_hashes, and not already confirmed IN THIS BATCH, is
//     refused before any request. That is the cross-batch guard: the ledger is the record of what
//     has genuinely gone in, and it outranks anything the review grid believes.
//
// THE COST OF REUSING A KEY, STATED PLAINLY. If the user EDITS a row that was already dispatched
// (state 'sent' or 'failed') and re-sends, the same key goes out. If QuickBooks had in fact created
// the original, it replays the ORIGINAL entity and the edit is not applied. That is deliberate:
// this app will lose an edit before it will create a second bill, because a wrong amount is
// visible and fixable in QuickBooks while a silent duplicate payment is neither.

import type Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { getDatabase } from '../db/connection'
import type { PostingProgress, PostingRow } from '../../shared/ipc-contract'
import {
  buildBillPayload,
  buildPurchasePayload,
  entityNameFor,
  type EntityRowInput
} from './entity-builders'
import {
  POSTING_ALREADY_ENTERED,
  POSTING_BATCH_IN_FLIGHT,
  recoverablePostingReason
} from './errors'
import type { QboApi } from './qbo-api'
import { getPostingReference, safeReference, type PostingReference } from './reference'
import { assertPostableRows } from './rows'
import {
  findEntryInBatch,
  findResumableBatch,
  getEntry,
  insertBatch,
  insertEntry,
  insertPostedHash,
  isHashPosted,
  listEntries,
  lookupFilename,
  markEntryConfirmed,
  markEntryFailed,
  markEntrySent,
  refreshBatchState,
  updateEntryFields
} from './store'

/** ISO timestamp source, injectable so a spec can pin exact audit timestamps. */
export type Clock = () => string

const systemClock: Clock = () => new Date().toISOString()

export interface SendBatchOptions {
  db?: Database.Database
  api: QboApi
  reference?: PostingReference
  now?: Clock
  onProgress?: (progress: PostingProgress) => void
}

/** What prepareBatch hands back: the id to return to the renderer, and the work still to do. */
export interface PreparedBatch {
  batchId: string
  /** Whether this send joined an existing unfinished batch rather than opening a new one. */
  resumed: boolean
  /** Runs the sends. Never rejects: every per-entry failure is recorded, not thrown. */
  run: () => Promise<void>
}

/**
 * One batch at a time, process wide.
 *
 * Two concurrent sends would interleave against the same resumable batch and the same ledger, and
 * the second one's view of "which entries are already confirmed" would be stale the moment it read
 * it. The renderer disables the button, but a guard the user cannot click past belongs here.
 */
let inFlight = false

/** Test and shutdown escape hatch: drop the in-flight flag. */
export function resetPostingInFlight(): void {
  inFlight = false
}

function toEntityRow(row: PostingRow): EntityRowInput {
  return {
    entryType: row.entryType,
    vendorId: row.vendorId,
    categoryAccountId: row.categoryAccountId,
    paidFromAccountId: row.paidFromAccountId,
    txnDate: row.txnDate,
    dueDate: row.dueDate,
    refNumber: row.refNumber,
    amountCents: row.amountCents,
    memo: row.memo
  }
}

/**
 * Steps 1 and 2: validate, then persist the batch and every entry (each with its key) in ONE
 * transaction. Synchronous on purpose: when this returns, the idempotency keys are durable.
 */
export function prepareBatch(rows: readonly PostingRow[], options: SendBatchOptions): PreparedBatch {
  if (inFlight) throw new Error(POSTING_BATCH_IN_FLIGHT)

  const db = options.db ?? getDatabase()
  const api = options.api
  const reference = safeReference(options.reference ?? getPostingReference())
  const now = options.now ?? systemClock
  const onProgress = options.onProgress

  assertPostableRows(rows)

  const createdAt = now()
  const targeted: number[] = []
  let batchId = ''
  let resumed = false

  const persist = db.transaction(() => {
    const resumable = findResumableBatch(db)
    const joinable =
      resumable !== null && rows.some((row) => findEntryInBatch(db, resumable.id, row.fileHash))

    if (joinable && resumable) {
      batchId = resumable.id
      resumed = true
    } else {
      batchId = randomUUID()
      insertBatch(db, { id: batchId, createdAt, realmId: api.realmId, entryCount: 0 })
    }

    let nextPosition = listEntries(db, batchId).length

    for (const row of rows) {
      const filename = lookupFilename(db, row.fileHash)
      const vendorName = reference.vendorName(row.vendorId)
      const categoryAccountName = reference.accountName(row.categoryAccountId)
      const paidFromAccountName =
        row.paidFromAccountId === null ? null : reference.accountName(row.paidFromAccountId)

      const existing = findEntryInBatch(db, batchId, row.fileHash)
      if (existing) {
        // A confirmed entry is left completely alone: touching it would move it back to pending
        // and hand the loop a reason to call QuickBooks about a bill that is already in.
        if (existing.state !== 'confirmed') {
          updateEntryFields(db, existing.id, {
            filename,
            entryType: row.entryType,
            vendorId: row.vendorId,
            vendorName,
            categoryAccountId: row.categoryAccountId,
            categoryAccountName,
            paidFromAccountId: row.paidFromAccountId,
            paidFromAccountName,
            txnDate: row.txnDate,
            dueDate: row.dueDate,
            refNumber: row.refNumber,
            memo: row.memo,
            amountCents: row.amountCents,
            updatedAt: createdAt
          })
        }
        targeted.push(existing.id)
        continue
      }

      const inserted = insertEntry(db, {
        batchId,
        position: nextPosition,
        fileHash: row.fileHash,
        filename,
        entryType: row.entryType,
        // The idempotency key, minted here and committed with the row. Everything downstream
        // depends on this value existing on disk before any request is made.
        requestId: randomUUID(),
        vendorId: row.vendorId,
        vendorName,
        categoryAccountId: row.categoryAccountId,
        categoryAccountName,
        paidFromAccountId: row.paidFromAccountId,
        paidFromAccountName,
        txnDate: row.txnDate,
        dueDate: row.dueDate,
        refNumber: row.refNumber,
        memo: row.memo,
        amountCents: row.amountCents,
        realmId: api.realmId,
        createdAt
      })
      targeted.push(inserted.id)
      nextPosition += 1
    }

    db.prepare('UPDATE posting_batches SET entry_count = ?, updated_at = ? WHERE id = ?').run(
      listEntries(db, batchId).length,
      createdAt,
      batchId
    )
  })

  persist()
  inFlight = true

  return {
    batchId,
    resumed,
    run: async () => {
      try {
        await runEntries({ db, api, reference, now, onProgress, batchId, entryIds: targeted })
      } finally {
        inFlight = false
      }
    }
  }
}

interface RunOptions {
  db: Database.Database
  api: QboApi
  reference: PostingReference
  now: Clock
  onProgress?: (progress: PostingProgress) => void
  batchId: string
  entryIds: readonly number[]
}

/**
 * Step 3: send, sequentially, one entry at a time.
 *
 * Sequential rather than parallel on purpose. The volume is five to twenty bills, so throughput is
 * irrelevant, and a serial loop means the progress counter is honest, a mid-batch failure has an
 * unambiguous "everything after this is untouched" boundary, and nothing races the ledger write.
 *
 * Never throws. A failure inside the loop is recorded on its entry and the loop continues; a
 * failure outside any entry would strand the batch, so there is deliberately no work outside.
 */
async function runEntries(options: RunOptions): Promise<void> {
  const { db, api, reference, now, onProgress, batchId, entryIds } = options
  const total = entryIds.length
  let done = 0

  for (const entryId of entryIds) {
    const entry = getEntry(db, entryId)
    if (!entry) {
      done += 1
      continue
    }

    // Already in. Report it and move on: no payload, no request, no possible duplicate.
    if (entry.state === 'confirmed') {
      done += 1
      onProgress?.({
        batchId,
        done,
        total,
        current: { fileHash: entry.fileHash, state: 'confirmed' }
      })
      continue
    }

    // The cross-batch guard. The ledger records what has genuinely gone into QuickBooks, so a hash
    // sitting in it that this entry did not put there means some earlier batch already posted this
    // exact document.
    if (isHashPosted(db, entry.fileHash)) {
      markEntryFailed(db, entryId, recoverablePostingReason(new Error(POSTING_ALREADY_ENTERED)), now())
      done += 1
      onProgress?.({ batchId, done, total, current: { fileHash: entry.fileHash, state: 'failed' } })
      continue
    }

    const entity = entityNameFor(entry.entryType)
    const rowInput: EntityRowInput = {
      entryType: entry.entryType,
      vendorId: entry.vendorId,
      categoryAccountId: entry.categoryAccountId,
      paidFromAccountId: entry.paidFromAccountId,
      txnDate: entry.txnDate,
      dueDate: entry.dueDate,
      refNumber: entry.refNumber,
      amountCents: entry.amountCents,
      memo: entry.memo
    }

    // Build BEFORE the state moves to 'sent'. A payload that cannot be built never left, so the
    // entry goes straight to 'failed' and no idempotency question arises.
    let dispatch: () => Promise<{ id: string; syncToken: string }>
    try {
      if (entry.entryType === 'bill') {
        const payload = buildBillPayload(rowInput)
        dispatch = () => api.createBill(payload, entry.requestId)
      } else {
        // The account type is resolved at post time rather than stored, because a Purchase's
        // payment method is a property of the account today, not of the audit row.
        const accountType =
          entry.paidFromAccountId === null ? null : reference.accountType(entry.paidFromAccountId)
        const payload = buildPurchasePayload(rowInput, accountType)
        dispatch = () => api.createPurchase(payload, entry.requestId)
      }
    } catch (err) {
      markEntryFailed(db, entryId, recoverablePostingReason(err), now())
      done += 1
      onProgress?.({ batchId, done, total, current: { fileHash: entry.fileHash, state: 'failed' } })
      continue
    }

    // 'sent' is written BEFORE the request, not after. It is the marker for "a create may exist in
    // QuickBooks that we have not confirmed", which is exactly what a crash on the next line
    // leaves behind, and what the request id makes recoverable.
    markEntrySent(db, entryId, now())
    onProgress?.({ batchId, done, total, current: { fileHash: entry.fileHash, state: 'sent' } })

    try {
      const result = await dispatch()

      const confirmedAt = now()
      // One transaction, two writes: the audit row and the dedupe ledger. Splitting them would
      // allow a state where QuickBooks holds a bill the ledger has never heard of.
      db.transaction(() => {
        markEntryConfirmed(db, entryId, {
          qboId: result.id,
          syncToken: result.syncToken,
          now: confirmedAt
        })
        insertPostedHash(db, {
          hash: entry.fileHash,
          postedAt: confirmedAt,
          originalFilename: entry.filename ?? entry.fileHash,
          qboEntity: entity,
          qboId: result.id
        })
      })()

      done += 1
      onProgress?.({
        batchId,
        done,
        total,
        current: { fileHash: entry.fileHash, state: 'confirmed' }
      })
    } catch (err) {
      // Mapped copy only. An Intuit fault body carries the request URL and the realm id, and this
      // string is persisted and later read back through posting:batch-detail.
      markEntryFailed(db, entryId, recoverablePostingReason(err), now())
      done += 1
      onProgress?.({ batchId, done, total, current: { fileHash: entry.fileHash, state: 'failed' } })
    }
  }

  refreshBatchState(db, batchId, now())
  onProgress?.({ batchId, done: total, total, current: null })
}

/**
 * Convenience for callers that want the whole thing awaited (the unit suite, and any future
 * synchronous path). The IPC handler deliberately does NOT use this: it returns the batch id as
 * soon as the entries are durable and lets the sends run behind the progress broadcast, so closing
 * the window cannot lose a batch.
 */
export async function sendBatch(
  rows: readonly PostingRow[],
  options: SendBatchOptions
): Promise<string> {
  const prepared = prepareBatch(rows, options)
  await prepared.run()
  return prepared.batchId
}
