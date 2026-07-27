// src/main/posting/summary.ts
//
// The read side: the batch list, one batch's entries, and the printable "what did I just send"
// report (REPORT-01).
//
// EVERYTHING THE REPORT PRINTS IS RESOLVED MAIN-SIDE. The renderer never joins an id against the
// reference cache to render a line, because the report has to be printable months later, offline,
// after a vendor was renamed or made inactive in QuickBooks. The names were denormalized onto the
// entry when it was posted (see reference.ts); this module reads them back and nothing more.
//
// A name that was never resolved falls back to the id rather than to an empty cell. "Vendor 42" is
// a poor report line, but a blank one is a worse one: it reads as "no vendor" instead of "the name
// was not available", and on a printed page there is nobody to ask.

import type Database from 'better-sqlite3'
import { getDatabase } from '../db/connection'
import type {
  PostingBatchDetail,
  PostingBatchesResult,
  PostingSummary,
  PostingSummaryLine
} from '../../shared/ipc-contract'
import { POSTING_BATCH_NOT_FOUND } from './errors'
import { getPostingReference, safeReference, type PostingReference } from './reference'
import { getBatch, listBatches, listEntries, type PostingEntryRecord } from './store'

/** The batch history list, newest first. */
export function batchesResult(db: Database.Database = getDatabase()): PostingBatchesResult {
  return {
    batches: listBatches(db).map((batch) => {
      const entries = listEntries(db, batch.id)
      const confirmed = entries.filter((e) => e.state === 'confirmed')
      return {
        batchId: batch.id,
        createdAt: batch.createdAt,
        total: entries.length,
        confirmed: confirmed.length,
        failed: entries.filter((e) => e.state === 'failed').length,
        undone: confirmed.filter((e) => e.undoneAt !== null).length,
        state: batch.state
      }
    })
  }
}

/** One batch's entries, in send order, with their states and their mapped error copy. */
export function batchDetailResult(
  db: Database.Database = getDatabase(),
  batchId: string
): PostingBatchDetail {
  if (!getBatch(db, batchId)) throw new Error(POSTING_BATCH_NOT_FOUND)
  return {
    entries: listEntries(db, batchId).map((entry) => ({
      fileHash: entry.fileHash,
      // Denormalized at post time, exactly like the report's names: the History screen must be able
      // to say WHICH document an entry came from months later, without a join that can come back
      // empty once the ingestion ledger has moved on.
      filename: entry.filename,
      entryType: entry.entryType,
      qboId: entry.qboId,
      syncToken: entry.syncToken,
      state: entry.state,
      error: entry.error,
      undoneAt: entry.undoneAt,
      undoReason: entry.undoReason
    }))
  }
}

/** A displayable name: the one recorded at post time, or the id when none was ever resolved. */
function displayName(name: string | null, id: string): string {
  return name !== null && name.trim() !== '' ? name : id
}

function toLine(entry: PostingEntryRecord): PostingSummaryLine {
  return {
    fileHash: entry.fileHash,
    // The filename is the only handle a user has on WHICH document a line came from, so a missing
    // one falls back to the short hash rather than to an empty cell.
    filename: entry.filename ?? `${entry.fileHash.slice(0, 12)}...`,
    vendorName: displayName(entry.vendorName, entry.vendorId),
    categoryName: displayName(entry.categoryAccountName, entry.categoryAccountId),
    paidFromName:
      entry.paidFromAccountId === null
        ? null
        : displayName(entry.paidFromAccountName, entry.paidFromAccountId),
    entryType: entry.entryType,
    txnDate: entry.txnDate,
    refNumber: entry.refNumber,
    amountCents: entry.amountCents,
    state: entry.state,
    qboId: entry.qboId,
    error: entry.error,
    undoneAt: entry.undoneAt
  }
}

/**
 * Everything a printable batch report needs, in one object.
 *
 * The amount total counts CONFIRMED, NOT-UNDONE entries only. A total that included failed rows
 * would tell the user they entered money they did not enter, which on a report that gets filed is
 * worse than no total at all.
 */
export function summaryResult(
  db: Database.Database = getDatabase(),
  batchId: string,
  reference: PostingReference = getPostingReference()
): PostingSummary {
  const batch = getBatch(db, batchId)
  if (!batch) throw new Error(POSTING_BATCH_NOT_FOUND)

  const entries = listEntries(db, batchId)
  const confirmed = entries.filter((e) => e.state === 'confirmed')
  const counted = confirmed.filter((e) => e.undoneAt === null)

  return {
    batchId: batch.id,
    createdAt: batch.createdAt,
    companyName: safeReference(reference).companyName(),
    realmId: batch.realmId,
    state: batch.state,
    totals: {
      entries: entries.length,
      confirmed: confirmed.length,
      failed: entries.filter((e) => e.state === 'failed').length,
      undone: confirmed.filter((e) => e.undoneAt !== null).length,
      amountCents: counted.reduce((sum, e) => sum + e.amountCents, 0)
    },
    lines: entries.map(toLine)
  }
}
