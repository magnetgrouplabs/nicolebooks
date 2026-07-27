// src/main/posting/undo.ts
//
// Reverse the most recent batch, entity by entity, refusing anything that changed since it went in.
//
// THE RULE THAT MAKES THIS SAFE: re-read first, then decide.
//
// Every confirmed entry stored the SyncToken QuickBooks returned when the entity was created.
// SyncToken is QuickBooks' optimistic-concurrency counter: it increments on every edit. So before
// deleting anything, undo READS THE ENTITY LIVE and compares. Three outcomes, and each is reported
// to the user in plain language rather than collapsed into a boolean:
//
//   token unchanged  -> delete it. Nobody has touched it, so removing it restores the exact state
//                       that existed before the batch.
//   token changed    -> REFUSE. Somebody edited it in QuickBooks, or a payment was applied against
//                       it, or it was linked to something else. Deleting it now would destroy work
//                       that was not ours, and the linked records would be the collateral. Say what
//                       happened and leave it alone.
//   entity absent    -> nothing to do. It was already deleted in QuickBooks. Not an error, and the
//                       ledger row is still cleared so the document can be entered again.
//
// The stored token, not a cached read, is the baseline. Re-reading and comparing against whatever
// we just read would compare a value to itself and always pass, which is the shape this check is
// easiest to get subtly wrong in.
//
// THE OTHER HALF OF UNDO, EASY TO FORGET: posted_file_hashes. Reversing the QuickBooks entity
// without clearing the dedupe row would leave the document permanently un-enterable, because the
// Phase 2 scan keeps excluding it as "already entered" for an entity that no longer exists. Every
// path that removes (or discovers the absence of) an entity clears the ledger row too.

import type Database from 'better-sqlite3'
import { getDatabase } from '../db/connection'
import type { PostingUndoResult } from '../../shared/ipc-contract'
import { entityNameFor } from './entity-builders'
import {
  POSTING_NOTHING_TO_UNDO,
  POSTING_UNDO_ENTITY_MISSING,
  POSTING_UNDO_FAILED,
  POSTING_UNDO_REFUSED_CHANGED,
  postingErrorCode,
  recoverablePostingReason
} from './errors'
import type { QboApi } from './qbo-api'
import {
  deletePostedHash,
  findUndoableBatch,
  listEntries,
  markEntryUndone,
  markUndoRefused,
  refreshBatchState
} from './store'

export interface UndoOptions {
  db?: Database.Database
  api: QboApi
  now?: () => string
}

/**
 * Undo the most recent batch that has confirmed, not-yet-undone entries.
 *
 * Throws POSTING_NOTHING_TO_UNDO when there is no such batch, so the handler can map it to a
 * sentence rather than returning an empty result the UI would have to interpret.
 *
 * Never throws for a per-entity problem: a partial undo is a real outcome (some entities void
 * cleanly, others are already paid or already gone) and the user has to see it row by row.
 */
export async function undoLastBatch(options: UndoOptions): Promise<PostingUndoResult> {
  const db = options.db ?? getDatabase()
  const api = options.api
  const now = options.now ?? (() => new Date().toISOString())

  const batch = findUndoableBatch(db)
  if (!batch) throw new Error(POSTING_NOTHING_TO_UNDO)

  const entries = listEntries(db, batch.id).filter(
    (entry) => entry.state === 'confirmed' && entry.undoneAt === null && entry.qboId !== null
  )

  const results: PostingUndoResult['results'] = []

  for (const entry of entries) {
    const qboId = entry.qboId as string
    const entity = entityNameFor(entry.entryType)

    let live: { id: string; syncToken: string } | null
    try {
      live = await api.readEntity(entity, qboId)
    } catch (err) {
      const reason = recoverablePostingReason(err)
      markUndoRefused(db, entry.id, reason, now())
      results.push({ qboId, undone: false, reason })
      continue
    }

    // Already gone from QuickBooks. Clear the ledger so the document is enterable again, and mark
    // the entry undone, because the end state the user asked for is the end state that exists.
    if (live === null) {
      const at = now()
      db.transaction(() => {
        markEntryUndone(db, entry.id, at)
        deletePostedHash(db, entry.fileHash)
      })()
      results.push({
        qboId,
        undone: true,
        reason: recoverablePostingReason(new Error(POSTING_UNDO_ENTITY_MISSING))
      })
      continue
    }

    // The concurrency check. Compare against the token STORED at post time.
    if (live.syncToken !== entry.syncToken) {
      const reason = recoverablePostingReason(new Error(POSTING_UNDO_REFUSED_CHANGED))
      markUndoRefused(db, entry.id, reason, now())
      results.push({ qboId, undone: false, reason })
      continue
    }

    try {
      await api.deleteEntity(entity, qboId, live.syncToken)
    } catch (err) {
      // Map first, then store: a QuickBooks fault body carries the request URL and the realm id,
      // and this string is persisted and read back by posting:batch-detail. An unrecognized
      // failure gets the undo-specific sentence rather than the generic send one, because "nothing
      // was changed in QuickBooks" is the wrong thing to say about a delete that may have half run.
      const code = postingErrorCode(err)
      const reason = recoverablePostingReason(new Error(code ?? POSTING_UNDO_FAILED))
      markUndoRefused(db, entry.id, reason, now())
      results.push({ qboId, undone: false, reason })
      continue
    }

    const at = now()
    db.transaction(() => {
      markEntryUndone(db, entry.id, at)
      deletePostedHash(db, entry.fileHash)
    })()
    results.push({ qboId, undone: true, reason: null })
  }

  refreshBatchState(db, batch.id, now())
  return { batchId: batch.id, results }
}
