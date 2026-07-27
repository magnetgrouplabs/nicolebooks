// src/main/ipc/upload.ts
//
// upload channel group: start / stop / status, plus the upload:received broadcast, and the
// ingestion:pick-files native "Add files" picker.
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
// only, never paths. Nothing in this file logs -- the pairing URL is a bearer credential, and a log
// line is the easiest place for one to be read back out.

import { app, BrowserWindow, ipcMain } from 'electron'
import { Channels, type UploadReceived } from '../../shared/ipc-contract'
import {
  IngestionPickFilesSchema,
  UploadStartSchema,
  UploadStatusSchema,
  UploadStopSchema
} from '../../shared/schemas'
import { PICK_FILES_FAILED, pickFilesIntoInbox } from '../upload/pick-files'
import {
  UPLOAD_START_FAILED,
  UPLOAD_STOP_FAILED,
  getUploadStatus,
  startUploadServer,
  stopUploadServer
} from '../upload/server'
import { assertTrustedSender } from './trusted-sender'

/**
 * Opaque failure codes mapped to plain, recoverable user copy (the ai.ts CONNECTION_ERROR_COPY
 * shape). Anything not in this table falls back to the generic message: a bind or filesystem error
 * carries a port, a path, or a host and its text is NOT safe to forward.
 */
const UPLOAD_ERROR_COPY: Readonly<Record<string, string>> = {
  [UPLOAD_START_FAILED]:
    'Could not start phone upload just now. Check that you are connected to a network, then try again.',
  [UPLOAD_STOP_FAILED]: 'Phone upload did not shut down cleanly. Closing NicoleBooks will stop it.',
  [PICK_FILES_FAILED]: 'Could not add those files to your inbox. Please try again.'
}

const GENERIC_UPLOAD_ERROR = 'Could not start phone upload just now. Please try again.'

/** Map any thrown value to a fixed recoverable message. Never returns raw error text or a stack. */
function recoverableReason(err: unknown): string {
  const code = err instanceof Error ? err.message : ''
  return UPLOAD_ERROR_COPY[code] ?? GENERIC_UPLOAD_ERROR
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

/**
 * Guard so the quit hook is attached exactly once, no matter how many times the group is
 * registered (registerIpc runs once in production, but a spec may call it repeatedly).
 */
let quitHookAttached = false

/**
 * Belt and braces on top of the 15 minute idle timer: quitting the app closes the listening socket.
 * 'will-quit' rather than 'before-quit' because it still fires when the quit was triggered by the
 * last window closing, which is the ordinary way this app ends.
 */
function attachQuitHook(): void {
  if (quitHookAttached) return
  quitHookAttached = true
  app.on('will-quit', () => {
    void stopUploadServer().catch(() => {})
  })
}

/** Register the upload + pick-files channel handlers. Call after app 'ready'. */
export function registerUploadIpc(): void {
  attachQuitHook()

  ipcMain.handle(Channels.ingestionPickFiles, async (event, raw) => {
    assertTrustedSender(event)
    IngestionPickFilesSchema.parse(raw ?? {})
    try {
      return await pickFilesIntoInbox(BrowserWindow.fromWebContents(event.sender))
    } catch {
      throw new Error(recoverableReason(new Error(PICK_FILES_FAILED)))
    }
  })

  ipcMain.handle(Channels.uploadStart, async (event, raw) => {
    assertTrustedSender(event)
    UploadStartSchema.parse(raw ?? {})
    try {
      return await startUploadServer({ onReceived: (filenames) => broadcastUploadReceived({ filenames }) })
    } catch (err) {
      throw new Error(recoverableReason(err))
    }
  })

  ipcMain.handle(Channels.uploadStop, async (event, raw) => {
    assertTrustedSender(event)
    UploadStopSchema.parse(raw ?? {})
    try {
      return await stopUploadServer()
    } catch (err) {
      throw new Error(recoverableReason(err))
    }
  })

  ipcMain.handle(Channels.uploadStatus, (event, raw) => {
    assertTrustedSender(event)
    UploadStatusSchema.parse(raw ?? {})
    return getUploadStatus()
  })
}
