// src/main/ipc/trusted-sender.ts
//
// Sender-validation gate for every ipcMain.handle handler (threat T-01-03, tampering).
//
// The renderer is untrusted. Before a handler Zod-parses a payload or touches SQLite,
// safeStorage, or nativeTheme, it calls assertTrustedSender(event) so a frame that is not
// our own renderer is rejected up front. This is a single-window app, so the ONLY
// legitimate sender is this app's renderer frame: in dev electron-vite serves it from
// ELECTRON_RENDERER_URL (http://localhost:PORT), and in a packaged build it is loaded from
// a local file:// URL (loadFile). Anything else (a remote origin, a missing or unparseable
// frame URL) throws and the invoke rejects in the renderer before any privileged action.
//
// Source: electronjs.org security checklist, "Validate the sender of all IPC messages"
// (host-allowlist via a real URL parser), adapted to this single-window app.

import type { IpcMainInvokeEvent } from 'electron'

/** Reject any IPC invoke that did not originate from this app's own renderer frame. */
export function assertTrustedSender(event: IpcMainInvokeEvent): void {
  const frame = event.senderFrame
  if (!frame) {
    throw new Error('UNTRUSTED_SENDER')
  }

  let parsed: URL
  try {
    parsed = new URL(frame.url)
  } catch {
    throw new Error('UNTRUSTED_SENDER')
  }

  // Packaged build: the renderer is local file content loaded via loadFile, always trusted.
  if (parsed.protocol === 'file:') {
    return
  }

  // Dev: electron-vite serves the renderer from ELECTRON_RENDERER_URL. Only that exact
  // origin is accepted; a stray http(s) origin is rejected.
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl && parsed.origin === new URL(devUrl).origin) {
    return
  }

  throw new Error('UNTRUSTED_SENDER')
}
