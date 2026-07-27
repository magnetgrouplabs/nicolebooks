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

/** Register every main-process IPC handler. Call once, after app 'ready' and window create. */
export function registerIpc(): void {
  registerSettingsIpc()
  registerSecretsIpc()
  registerThemeIpc()
  registerIngestionIpc()
  registerAiIpc()
  registerParseIpc()
}
