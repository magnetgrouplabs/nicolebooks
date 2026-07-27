// src/main/ipc/parse.ts
//
// parse channel group: parse-batch / reparse, plus the parse:progress broadcast (D-15, D-26,
// threats T-03-01/T-03-02/T-03-03).
//
// Both handlers run assertTrustedSender(event) as their FIRST statement (03-PATTERNS Shared
// Pattern A, mirroring settings.ts / ingestion.ts / ai.ts), then Zod-parse the payload, then do
// the privileged work. Both channels carry a REAL payload from the preload, so a bare
// `Schema.parse(raw)` is correct here — the `parse(raw ?? {})` normalization applies only to
// payload-free channels, where the preload invokes with no argument at all.
//
// PROGRESS (D-26) is a main-initiated broadcast copied from theme.ts's nativeTheme subscription:
// the pipeline emits { done, total, filename, status } per file and this module forwards each to
// the window that asked for the batch. There is no sender to validate on that path, and the
// payload carries only a file name, a status and two counters — never a field value, never a
// credential (T-03-01).
//
// PATH BOUNDARY (T-02-02, carried from Phase 2): the renderer sends file NAMES, never paths. The
// inbox folder is resolved server-side inside the pipeline, which also containment-checks each
// name before opening it.

import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { Channels, type ParseBatchFile, type ParseFileResult, type ParseProgress } from '../../shared/ipc-contract'
import { ParseBatchSchema, ReparseSchema } from '../../shared/schemas'
import { runScan } from '../ingestion/scan'
import { parseBatch } from '../parse/pipeline'
import { assertTrustedSender } from './trusted-sender'

/** Shown when a Retry names a hash that is no longer anywhere in the inbox folder. */
const MISSING_FILE_COPY =
  'That file is no longer in your inbox folder. Put it back, click Scan now, then try again.'

/** Register the parse channel handlers. Call after app 'ready' (getDatabase needs it). */
export function registerParseIpc(): void {
  // D-13/D-26: the renderer fires this on the loaded set right after a scan, as a SEPARATE call
  // rather than from inside ingestion:scan, so progress, per-file isolation and retry each have a
  // seam of their own. The pipeline is cache-first, so a re-scan of unchanged bytes costs nothing.
  ipcMain.handle(Channels.parseBatch, async (event, raw) => {
    assertTrustedSender(event)
    const files = ParseBatchSchema.parse(raw)
    return parseBatch(files, { onProgress: progressBroadcaster(event) })
  })

  // D-14's explicit per-document override, and the D-15 "retry just the failed ones" affordance.
  // The renderer knows only the hash (the contract deliberately carries no path), so the file is
  // located server-side by re-scanning the inbox and matching hashes — the same resolution
  // discipline as ingestion:scan, and it doubles as a check that the file is still present.
  ipcMain.handle(Channels.parseReparse, async (event, raw) => {
    assertTrustedSender(event)
    const { fileHash } = ReparseSchema.parse(raw)
    const emit = progressBroadcaster(event)

    const target = await findInboxFileByHash(fileHash)
    if (!target) {
      const missing: ParseFileResult = {
        filename: '',
        hash: fileHash,
        status: 'parse-failed',
        error: MISSING_FILE_COPY
      }
      emit({ done: 1, total: 1, filename: '', status: 'parse-failed' })
      return missing
    }

    // force: true is what makes this a re-parse rather than a cache read (D-14).
    const batch = await parseBatch([target], { force: true, onProgress: emit })
    return (
      batch.files[0] ?? {
        filename: target.filename,
        hash: fileHash,
        status: 'parse-failed' as const,
        error: MISSING_FILE_COPY
      }
    )
  })
}

/**
 * Forward pipeline progress to the window that asked for the batch.
 *
 * Copied from theme.ts's `win.webContents.send(...)` broadcast, narrowed to the sender window:
 * a second window watching a batch it did not start would see a counter it cannot explain. The
 * destroyed-window check matters because a batch outlives a window close.
 */
function progressBroadcaster(event: IpcMainInvokeEvent): (progress: ParseProgress) => void {
  const win = BrowserWindow.fromWebContents(event.sender)
  return (progress: ParseProgress) => {
    if (!win || win.isDestroyed()) return
    win.webContents.send(Channels.parseProgress, progress)
  }
}

/**
 * Resolve which inbox file a hash refers to, server-side.
 *
 * runScan already enumerates the folder, applies the materialization gate and hashes every ready
 * file, so reusing it is both the cheapest correct answer and the one that cannot introduce a
 * second, differently-guarded filesystem path. A retry is a deliberate single-file user action, so
 * one scan of a folder holding 5-20 documents is an acceptable cost for that guarantee.
 */
async function findInboxFileByHash(fileHash: string): Promise<ParseBatchFile | null> {
  const scan = await runScan()
  const match = scan.files.find((file) => file.hash === fileHash)
  if (!match) return null
  return { filename: match.filename, hash: fileHash, batchEntryDate: scan.batchEntryDate }
}
