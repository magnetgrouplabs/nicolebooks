// src/main/ipc/register.ts
//
// Single aggregator for all IPC handler registration. The main bootstrap calls registerIpc()
// once, after app.whenReady() and after the window is created, so safeStorage and the
// handlers initialize post-ready (RESEARCH Pitfall 3). Adding a new channel group is a
// one-line change here plus its own register function.

import { registerSettingsIpc } from './settings'
import { registerSecretsIpc } from './secrets'
import { registerThemeIpc } from './theme'
import { registerIngestionIpc } from './ingestion'
import { registerAiIpc } from './ai'
import { registerParseIpc } from './parse'
// Finish-sprint groups (SEAMS). Each is a one-module seam owned by a single agent, registered
// here as stubs so the whole bridge surface exists before any body is written. Wiring them up
// front is what lets the four handler modules be filled in parallel without a shared-file edit.
import { registerQboIpc } from './qbo'
import { registerReconIpc } from './recon'
import { registerPostingIpc } from './posting'
import { registerUploadIpc } from './upload'

/** Register every main-process IPC handler. Call once, after app 'ready' and window create. */
export function registerIpc(): void {
  registerSettingsIpc()
  registerSecretsIpc()
  registerThemeIpc()
  registerIngestionIpc()
  registerAiIpc()
  registerParseIpc()
  registerQboIpc()
  registerReconIpc()
  registerPostingIpc()
  registerUploadIpc()
}
