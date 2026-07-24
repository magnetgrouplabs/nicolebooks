// src/main/ipc/ingestion.ts
//
// ingestion channel group: resolve-inbox / choose-inbox / scan (D-15, threats T-02-01/02).
//
// Every handler runs assertTrustedSender(event) as its FIRST statement (mirrors settings.ts /
// theme.ts), so a frame that is not this app's own renderer is rejected before any fs/DB/dialog
// work. The scan handler additionally Zod-parses the (empty) payload with ScanRequestSchema
// before running: scan takes NO renderer-supplied path, the inbox is read server-side, which
// removes the path-injection surface (T-02-02). All fs/hash/db runs here in main, never in the
// renderer.

import { ipcMain, dialog, BrowserWindow } from 'electron'
import { Channels } from '../../shared/ipc-contract'
import { ScanRequestSchema } from '../../shared/schemas'
import { assertTrustedSender } from './trusted-sender'
import { runScan } from '../ingestion/scan'
import { resolveInboxPath, persistInboxPath } from '../ingestion/inbox'

/** Register the ingestion channel handlers. Call after app 'ready' (getDatabase needs it). */
export function registerIngestionIpc(): void {
  ipcMain.handle(Channels.ingestionResolveInbox, (event) => {
    assertTrustedSender(event)
    return resolveInboxPath() // reads app_settings, creates + persists the default if unset
  })

  ipcMain.handle(Channels.ingestionChooseInbox, async (event) => {
    assertTrustedSender(event)
    // Parent the dialog to the sender window when resolvable; both overloads route through
    // dialog.showOpenDialog so the e2e's main-process stub intercepts either branch.
    const win = BrowserWindow.fromWebContents(event.sender)
    const res = win
      ? await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] })
      : await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })
    if (res.canceled || res.filePaths.length === 0) return { canceled: true as const }
    persistInboxPath(res.filePaths[0]) // prepared-statement UPSERT; never interpolated (T-02-03)
    return { canceled: false as const, path: res.filePaths[0] }
  })

  ipcMain.handle(Channels.ingestionScan, async (event, raw) => {
    assertTrustedSender(event)
    ScanRequestSchema.parse(raw) // rejects any payload before any privileged work (T-02-02)
    return runScan() // resolves the inbox path server-side; no renderer path reaches fs
  })
}
