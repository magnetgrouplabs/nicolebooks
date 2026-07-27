// src/main/ipc/posting.ts
//
// posting channel group: send / batches / batch-detail / undo-last / summary, plus the
// posting:progress broadcast.
//
// Every handler runs assertTrustedSender(event) as its FIRST statement, then Zod-parses, then does
// the privileged work. Mixed payload discipline in this group, and the difference matters:
//   - send / batch-detail / summary carry a REAL payload, so a bare `Schema.parse(raw)` is correct.
//   - batches / undo-last are payload-free, so they parse `raw ?? {}` against a strict-empty
//     schema. The preload invokes those with no argument, so a bare parse would reject every real
//     call (the ingestion:scan defect) while the strict gate still refuses smuggled input.
//
// UNDO IS DELIBERATELY PAYLOAD-FREE: "the last batch" is resolved server-side. Accepting a batch id
// would turn a one-step undo into "void any batch you can name", a far larger destructive surface
// than the UI offers.
//
// ERROR COPY: the raw error is never forwarded. A QuickBooks API error message is assembled from
// the provider's response body and routinely embeds the request URL and the realm id, so it is
// mapped to fixed copy before it can ride out to the renderer. The table lives in
// ../posting/errors.ts rather than here, because a per-entry failure is PERSISTED and read back
// later by posting:batch-detail: the mapping has to happen before the write, not at this boundary
// only. Nothing here logs.
//
// SEND RETURNS EARLY BY DESIGN. The handler persists the batch and all of its idempotency keys
// (synchronously, inside one transaction), returns the batch id, and lets the sends run behind the
// posting:progress broadcast. Closing the window therefore cannot lose a batch: the entries are
// already durable and posting:batch-detail reads the outcome afterwards.

import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { Channels, type PostingProgress } from '../../shared/ipc-contract'
import {
  PostingBatchDetailSchema,
  PostingBatchesSchema,
  PostingSendSchema,
  PostingSummarySchema,
  PostingUndoLastSchema
} from '../../shared/schemas'
import { getDatabase } from '../db/connection'
import { recoverablePostingReason } from '../posting/errors'
import { resolveQboApi } from '../posting/qbo-api'
import { prepareBatch } from '../posting/send'
import { batchDetailResult, batchesResult, summaryResult } from '../posting/summary'
import { undoLastBatch } from '../posting/undo'
import { assertTrustedSender } from './trusted-sender'

/**
 * Forward posting progress to the window that started the batch.
 *
 * Narrowed to the sender window for the same reason parse.ts narrows its own: a second window
 * watching a batch it did not start would see a counter it cannot explain. The destroyed-window
 * check matters because a batch OUTLIVES a window close by design, and a send is exactly the
 * operation you do not want to crash halfway through.
 */
export function progressBroadcaster(event: IpcMainInvokeEvent): (progress: PostingProgress) => void {
  const win = BrowserWindow.fromWebContents(event.sender)
  return (progress: PostingProgress) => {
    if (!win || win.isDestroyed()) return
    win.webContents.send(Channels.postingProgress, progress)
  }
}

/** Register the posting channel handlers. Call after app 'ready' (getDatabase needs it). */
export function registerPostingIpc(): void {
  ipcMain.handle(Channels.postingSend, async (event, raw) => {
    assertTrustedSender(event)
    const { rows } = PostingSendSchema.parse(raw)
    const onProgress = progressBroadcaster(event)
    try {
      const api = await resolveQboApi()
      // Synchronous: when this returns, every entry and every idempotency key is on disk.
      const prepared = prepareBatch(rows, { api, onProgress })
      // Deliberately NOT awaited. run() never rejects (per-entry failures are recorded on their
      // entries), so there is no unhandled rejection to swallow and no outcome to lose.
      void prepared.run()
      return { batchId: prepared.batchId }
    } catch (err) {
      throw new Error(recoverablePostingReason(err))
    }
  })

  ipcMain.handle(Channels.postingBatches, (event, raw) => {
    assertTrustedSender(event)
    PostingBatchesSchema.parse(raw ?? {})
    try {
      return batchesResult(getDatabase())
    } catch (err) {
      throw new Error(recoverablePostingReason(err))
    }
  })

  ipcMain.handle(Channels.postingBatchDetail, (event, raw) => {
    assertTrustedSender(event)
    const { batchId } = PostingBatchDetailSchema.parse(raw)
    try {
      return batchDetailResult(getDatabase(), batchId)
    } catch (err) {
      throw new Error(recoverablePostingReason(err))
    }
  })

  ipcMain.handle(Channels.postingUndoLast, async (event, raw) => {
    assertTrustedSender(event)
    PostingUndoLastSchema.parse(raw ?? {})
    try {
      const api = await resolveQboApi()
      return await undoLastBatch({ api })
    } catch (err) {
      throw new Error(recoverablePostingReason(err))
    }
  })

  ipcMain.handle(Channels.postingSummary, (event, raw) => {
    assertTrustedSender(event)
    const { batchId } = PostingSummarySchema.parse(raw)
    try {
      return summaryResult(getDatabase(), batchId)
    } catch (err) {
      throw new Error(recoverablePostingReason(err))
    }
  })
}
