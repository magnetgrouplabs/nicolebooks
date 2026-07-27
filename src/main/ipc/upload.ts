// src/main/ipc/upload.ts
//
// upload channel group: start / stop / status, plus the upload:received broadcast, and the
// ingestion:pick-files native "Add files" picker.
//
// STUB MODULE (finish sprint, SEAMS). Every channel below is registered with its real gates --
// assertTrustedSender first, then the Zod payload gate -- and then rejects with the fixed
// NOT_IMPLEMENTED copy. INGEST-UX owns this file: replace the notImplemented() call in each
// handler with the real body and leave the gates and the error table in place.
//
// ingestion:pick-files lives HERE, not in ingestion.ts, on purpose. ingestion.ts is a shipped
// Phase 2 module that four parallel agents would otherwise have to touch; keeping the new picker
// in the module INGEST-UX owns means the sprint never needs a shared-file edit. Its channel name
// still reads `ingestion:` because it belongs to the ingestion surface from the renderer's side.
//
// Every handler runs assertTrustedSender(event) as its FIRST statement, then Zod-parses. All four
// channels are payload-free, so each parses `raw ?? {}` against a strict-empty schema: the preload
// invokes them with no argument, and parsing a bare `raw` would reject every real call (that is
// exactly the defect that shipped ingestion:scan permanently-rejecting for a whole phase).
//
// PATH AND NETWORK BOUNDARY (T-02-02, carried from Phase 2): the renderer supplies no path, no
// port, and no host. The picker dialog opens main-side and copies into the managed inbox; the
// upload server binds main-side and is LAN-only. The upload:received broadcast carries file NAMES
// only, never paths. Nothing in this file logs.

import { BrowserWindow, ipcMain } from 'electron'
import { Channels, type UploadReceived } from '../../shared/ipc-contract'
import {
  IngestionPickFilesSchema,
  UploadStartSchema,
  UploadStatusSchema,
  UploadStopSchema
} from '../../shared/schemas'
import { assertTrustedSender } from './trusted-sender'

/**
 * Stable internal code for a channel whose real body has not landed yet. It is a CODE, not copy:
 * it never reaches the renderer, it is mapped through the table below exactly like a real failure.
 */
export const NOT_IMPLEMENTED = 'NOT_IMPLEMENTED'

/**
 * Opaque failure codes mapped to plain, recoverable user copy (the ai.ts CONNECTION_ERROR_COPY
 * shape). Anything not in this table falls back to the generic message: a bind or filesystem error
 * carries a port, a path, or a host and its text is NOT safe to forward.
 *
 * INGEST-UX: add your codes here. Do not forward raw error text.
 */
const UPLOAD_ERROR_COPY: Readonly<Record<string, string>> = {
  [NOT_IMPLEMENTED]: 'This feature is still being built.'
}

const GENERIC_UPLOAD_ERROR = 'Could not start phone upload just now. Please try again.'

/** Map any thrown value to a fixed recoverable message. Never returns raw error text or a stack. */
function recoverableReason(err: unknown): string {
  const code = err instanceof Error ? err.message : ''
  return UPLOAD_ERROR_COPY[code] ?? GENERIC_UPLOAD_ERROR
}

/** Reject with the mapped NOT_IMPLEMENTED copy. Replace the call site, not this helper. */
function notImplemented(): never {
  throw new Error(recoverableReason(new Error(NOT_IMPLEMENTED)))
}

/**
 * Announce newly received phone uploads to every window (the theme.ts pattern, not the parse.ts
 * sender-narrowed one): an upload arrives from the phone, not from an invoke, so there is no
 * originating window to narrow to. Main-initiated, so there is no sender to validate, and the
 * payload carries file names only.
 */
export function broadcastUploadReceived(received: UploadReceived): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue
    win.webContents.send(Channels.uploadReceived, received)
  }
}

/** Register the upload + pick-files channel handlers. Call after app 'ready'. */
export function registerUploadIpc(): void {
  ipcMain.handle(Channels.ingestionPickFiles, (event, raw) => {
    assertTrustedSender(event)
    IngestionPickFilesSchema.parse(raw ?? {})
    return notImplemented()
  })

  ipcMain.handle(Channels.uploadStart, (event, raw) => {
    assertTrustedSender(event)
    UploadStartSchema.parse(raw ?? {})
    return notImplemented()
  })

  ipcMain.handle(Channels.uploadStop, (event, raw) => {
    assertTrustedSender(event)
    UploadStopSchema.parse(raw ?? {})
    return notImplemented()
  })

  ipcMain.handle(Channels.uploadStatus, (event, raw) => {
    assertTrustedSender(event)
    UploadStatusSchema.parse(raw ?? {})
    return notImplemented()
  })
}
