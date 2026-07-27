// src/main/ipc/posting.ts
//
// posting channel group: send / batches / batch-detail / undo-last / summary, plus the
// posting:progress broadcast.
//
// STUB MODULE (finish sprint, SEAMS). Every channel below is registered with its real gates --
// assertTrustedSender first, then the Zod payload gate -- and then rejects with the fixed
// NOT_IMPLEMENTED copy. POSTING-ENGINE owns this file: replace the notImplemented() call in each
// handler with the real body and leave the gates and the error table in place.
//
// Every handler runs assertTrustedSender(event) as its FIRST statement, then Zod-parses, then
// does the privileged work. Mixed payload discipline in this group, and the difference matters:
//   - send / batch-detail / summary carry a REAL payload, so a bare `Schema.parse(raw)` is correct.
//   - batches / undo-last are payload-free, so they parse `raw ?? {}` against a strict-empty
//     schema. The preload invokes those with no argument, so a bare parse would reject every real
//     call (the ingestion:scan defect) while the strict gate still refuses smuggled input.
//
// UNDO IS DELIBERATELY PAYLOAD-FREE: "the last batch" is resolved server-side. Accepting a batch id
// would turn a one-step undo into "void any batch you can name", a far larger destructive surface
// than the UI offers.
//
// ERROR COPY (mirrors ai.ts): the raw error is never forwarded. A QuickBooks API error message is
// assembled from the provider's response body and routinely embeds the request URL and the realm
// id, so it is mapped to fixed copy before it can ride out to the renderer. Nothing here logs.

import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { Channels, type PostingProgress } from '../../shared/ipc-contract'
import {
  PostingBatchDetailSchema,
  PostingBatchesSchema,
  PostingSendSchema,
  PostingSummarySchema,
  PostingUndoLastSchema
} from '../../shared/schemas'
import { assertTrustedSender } from './trusted-sender'

/**
 * Stable internal code for a channel whose real body has not landed yet. It is a CODE, not copy:
 * it never reaches the renderer, it is mapped through the table below exactly like a real failure.
 */
export const NOT_IMPLEMENTED = 'NOT_IMPLEMENTED'

/**
 * Opaque failure codes mapped to plain, recoverable user copy (the ai.ts CONNECTION_ERROR_COPY
 * shape). Anything not in this table falls back to the generic message: an unrecognized error came
 * from the QuickBooks API or the network and its text is NOT safe to forward.
 *
 * POSTING-ENGINE: add your codes here. Do not forward raw error text.
 */
const POSTING_ERROR_COPY: Readonly<Record<string, string>> = {
  [NOT_IMPLEMENTED]: 'This feature is still being built.'
}

const GENERIC_POSTING_ERROR =
  'Could not send these entries to QuickBooks just now. Nothing was changed. Please try again.'

/** Map any thrown value to a fixed recoverable message. Never returns raw error text or a stack. */
function recoverableReason(err: unknown): string {
  const code = err instanceof Error ? err.message : ''
  return POSTING_ERROR_COPY[code] ?? GENERIC_POSTING_ERROR
}

/** Reject with the mapped NOT_IMPLEMENTED copy. Replace the call site, not this helper. */
function notImplemented(): never {
  throw new Error(recoverableReason(new Error(NOT_IMPLEMENTED)))
}

/**
 * Forward posting progress to the window that started the batch.
 *
 * Copied verbatim in shape from parse.ts's progressBroadcaster and narrowed to the sender window
 * for the same reason: a second window watching a batch it did not start would see a counter it
 * cannot explain. The destroyed-window check matters because a batch outlives a window close, and
 * a send is exactly the operation you do not want to crash halfway through.
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
  ipcMain.handle(Channels.postingSend, (event, raw) => {
    assertTrustedSender(event)
    PostingSendSchema.parse(raw)
    return notImplemented()
  })

  ipcMain.handle(Channels.postingBatches, (event, raw) => {
    assertTrustedSender(event)
    PostingBatchesSchema.parse(raw ?? {})
    return notImplemented()
  })

  ipcMain.handle(Channels.postingBatchDetail, (event, raw) => {
    assertTrustedSender(event)
    PostingBatchDetailSchema.parse(raw)
    return notImplemented()
  })

  ipcMain.handle(Channels.postingUndoLast, (event, raw) => {
    assertTrustedSender(event)
    PostingUndoLastSchema.parse(raw ?? {})
    return notImplemented()
  })

  ipcMain.handle(Channels.postingSummary, (event, raw) => {
    assertTrustedSender(event)
    PostingSummarySchema.parse(raw)
    return notImplemented()
  })
}
