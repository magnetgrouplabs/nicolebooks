// src/main/ipc/qbo.ts
//
// qbo channel group: status / connect / disconnect / sync-reference / get-reference, plus the
// qbo:status-changed broadcast.
//
// STUB MODULE (finish sprint, SEAMS). Every channel below is registered with its real gates --
// assertTrustedSender first, then the Zod payload gate -- and then rejects with the fixed
// NOT_IMPLEMENTED copy. The seam exists so the review UI can be written against a live bridge
// before the QuickBooks client lands. QBO-CONNECT owns this file: replace the notImplemented()
// call in each handler with the real body and leave the gates and the error table in place.
//
// Every handler runs assertTrustedSender(event) as its FIRST statement (mirroring settings.ts /
// ingestion.ts / ai.ts), then Zod-parses. All five channels are payload-free by design: the
// connection is resolved server-side from the encrypted token store, so there is nothing
// legitimate for the renderer to send. Each parses `raw ?? {}` rather than a bare `raw`, because
// the preload invokes them with no argument at all -- parsing bare `raw` against a strict-empty
// schema is what shipped ingestion:scan permanently-rejecting for a whole phase.
//
// SECRET BOUNDARY (mirrors ai.ts, D-05 / threat T-03-01): no handler here accepts or returns the
// QuickBooks access token, refresh token, or client secret. Those are read main-side only where a
// request is signed. Errors are mapped to fixed, human-readable copy -- the raw error is never
// forwarded, because an OAuth or API error routinely embeds the request URL and can embed a token
// fragment. Nothing in this file logs.

import { BrowserWindow, ipcMain } from 'electron'
import { Channels, type QboStatus } from '../../shared/ipc-contract'
import {
  QboConnectSchema,
  QboDisconnectSchema,
  QboGetReferenceSchema,
  QboStatusSchema,
  QboSyncReferenceSchema
} from '../../shared/schemas'
import { assertTrustedSender } from './trusted-sender'

/**
 * Stable internal code for a channel whose real body has not landed yet. It is a CODE, not copy:
 * it never reaches the renderer, it is mapped through the table below exactly like a real failure
 * code from the QuickBooks client will be.
 */
export const NOT_IMPLEMENTED = 'NOT_IMPLEMENTED'

/**
 * Opaque failure codes mapped to plain, recoverable user copy (the ai.ts CONNECTION_ERROR_COPY
 * shape). Anything not in this table falls back to the generic message: an unrecognized error came
 * from the SDK or the network and its text is NOT safe to forward.
 *
 * QBO-CONNECT: add your client's codes here. Do not forward raw error text.
 */
const QBO_ERROR_COPY: Readonly<Record<string, string>> = {
  [NOT_IMPLEMENTED]: 'This feature is still being built.'
}

const GENERIC_QBO_ERROR =
  'Could not reach QuickBooks just now. Check your internet connection, then try again.'

/** Map any thrown value to a fixed recoverable message. Never returns raw error text or a stack. */
function recoverableReason(err: unknown): string {
  const code = err instanceof Error ? err.message : ''
  return QBO_ERROR_COPY[code] ?? GENERIC_QBO_ERROR
}

/** Reject with the mapped NOT_IMPLEMENTED copy. Replace the call site, not this helper. */
function notImplemented(): never {
  throw new Error(recoverableReason(new Error(NOT_IMPLEMENTED)))
}

/**
 * Broadcast a connection-state change to every window (the theme.ts pattern, not the parse.ts
 * sender-narrowed one): connection state is global to the app, so a second window showing a stale
 * "Not connected" badge would be wrong rather than merely unexplained. Main-initiated, so there is
 * no sender to validate, and QboStatus carries no credential.
 */
export function broadcastQboStatus(status: QboStatus): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue
    win.webContents.send(Channels.qboStatusChanged, status)
  }
}

/** Register the qbo channel handlers. Call after app 'ready' (the token store needs it). */
export function registerQboIpc(): void {
  ipcMain.handle(Channels.qboStatus, (event, raw) => {
    assertTrustedSender(event)
    QboStatusSchema.parse(raw ?? {})
    return notImplemented()
  })

  ipcMain.handle(Channels.qboConnect, (event, raw) => {
    assertTrustedSender(event)
    QboConnectSchema.parse(raw ?? {})
    return notImplemented()
  })

  ipcMain.handle(Channels.qboDisconnect, (event, raw) => {
    assertTrustedSender(event)
    QboDisconnectSchema.parse(raw ?? {})
    return notImplemented()
  })

  ipcMain.handle(Channels.qboSyncReference, (event, raw) => {
    assertTrustedSender(event)
    QboSyncReferenceSchema.parse(raw ?? {})
    return notImplemented()
  })

  ipcMain.handle(Channels.qboGetReference, (event, raw) => {
    assertTrustedSender(event)
    QboGetReferenceSchema.parse(raw ?? {})
    return notImplemented()
  })
}
