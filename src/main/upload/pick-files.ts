// src/main/upload/pick-files.ts
//
// The native "Add files" picker: open the OS open-file dialog, COPY what was chosen into the
// managed inbox, and report what landed.
//
// COPY, NEVER MOVE. The user picked a bill out of Downloads or off a USB stick; taking it away from
// where they left it would be a destructive side effect of a button labelled "Add files". The
// inbox is a working queue that the scan reads and the user can empty, so it holds its own copy.
//
// THE RENDERER NEVER LEARNS A PATH. The dialog opens here in main, the inbox is resolved here from
// app_settings, and the result carries counts and FILE NAMES only. That keeps the T-02-02
// path-injection guard exactly as ingestion:scan left it: there is still no code path where a
// renderer-supplied string reaches the filesystem.
//
// CROSS-PLATFORM: only `openFile`, `multiSelections`, `filters`, `title` and `buttonLabel` are
// used, all of which behave on both Windows and macOS. Notably absent is `createDirectory`, which
// is macOS-only, and any of the Windows-only flags. The `filters` list is a HINT on both platforms
// (macOS greys non-matching files out, Windows offers a dropdown, and on both a determined user can
// still type a name), so every returned path is screened again against the shipped extension list
// rather than trusted because the dialog was configured.

import type { BrowserWindow } from 'electron'
import { dialog } from 'electron'
import { basename } from 'node:path'
import type { PickFilesResult } from '../../shared/ipc-contract'
import { resolveInboxPath } from '../ingestion/inbox'
import { copyIntoInbox, isSupportedName, sanitizeFilename } from './filename'

/** Opaque failure code; src/main/ipc/upload.ts maps it to copy. */
export const PICK_FILES_FAILED = 'PICK_FILES_FAILED'

/** The extensions offered in the dialog. Mirrors the SUPPORTED set in ingestion/filetype.ts. */
export const PICKER_EXTENSIONS = ['pdf', 'jpg', 'jpeg', 'png', 'heic', 'heif'] as const

/** Narrowed shape of the dialog result, so a spec can substitute one without an Electron runtime. */
export interface OpenDialogOutcome {
  canceled: boolean
  filePaths: string[]
}

export interface PickFilesDeps {
  inboxPath?: string
  showOpenDialog?: (win: BrowserWindow | null) => Promise<OpenDialogOutcome>
}

/** The real dialog. Parented to the sender window when one is resolvable, so it is modal to the app. */
async function showRealDialog(win: BrowserWindow | null): Promise<OpenDialogOutcome> {
  const options = {
    title: 'Add bills to NicoleBooks',
    buttonLabel: 'Add',
    properties: ['openFile', 'multiSelections'] as Array<'openFile' | 'multiSelections'>,
    filters: [{ name: 'Bills and receipts', extensions: [...PICKER_EXTENSIONS] }]
  }
  // Both overloads route through dialog.showOpenDialog, so an e2e main-process stub intercepts
  // either branch (the ingestion:choose-inbox handler does the same).
  return win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
}

/**
 * Open the picker and copy the chosen documents into the inbox.
 *
 * A cancel is `{ added: 0, skipped: [] }`, not an error: the user changing their mind is a normal
 * outcome and must not raise an alert on the Bills screen.
 *
 * A per-file copy failure is recorded in `skipped` rather than aborting, so one locked or vanished
 * file cannot discard the nine that copied fine beside it.
 */
export async function pickFilesIntoInbox(
  win: BrowserWindow | null,
  deps: PickFilesDeps = {}
): Promise<PickFilesResult> {
  const show = deps.showOpenDialog ?? showRealDialog
  const chosen = await show(win)
  if (chosen.canceled || chosen.filePaths.length === 0) return { added: 0, skipped: [] }

  const inboxPath = deps.inboxPath ?? resolveInboxPath().path
  let added = 0
  const skipped: string[] = []

  for (const sourcePath of chosen.filePaths) {
    const name = sanitizeFilename(basename(sourcePath))
    if (!isSupportedName(name)) {
      skipped.push(name)
      continue
    }
    try {
      await copyIntoInbox(inboxPath, sourcePath, name)
      added += 1
    } catch {
      skipped.push(name)
    }
  }

  return { added, skipped }
}
