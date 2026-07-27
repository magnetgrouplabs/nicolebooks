// src/main/ipc/qbo.ts
//
// qbo channel group: status / connect / disconnect / sync-reference / get-reference, plus the
// qbo:status-changed broadcast.
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
//
// THE REAUTH SEAM. Exactly one place in the app decides that a connection has gone bad: the catch
// in run() below. Any operation that ends in QBO_REAUTH_REQUIRED (a refresh that came back
// invalid_grant) flips the stored state to 'expired' and broadcasts, so every open window switches
// to the one-click Reconnect without the individual call sites each having to remember. That is
// deliberately NOT done inside tokens.ts: a token module that wrote app_settings would have to
// import the database, and the failure would then be recorded from three different call paths.

import { BrowserWindow, ipcMain, shell } from 'electron'
import { Channels, type QboStatus } from '../../shared/ipc-contract'
import {
  QboConnectSchema,
  QboDisconnectSchema,
  QboGetReferenceSchema,
  QboStatusSchema,
  QboSyncReferenceSchema
} from '../../shared/schemas'
import {
  QBO_AUTH_CANCELED,
  QBO_AUTH_IN_PROGRESS,
  QBO_AUTH_STATE_MISMATCH,
  QBO_AUTH_TIMEOUT,
  QBO_CALLBACK_PORT_BUSY,
  QBO_CLIENT_CREDENTIALS_MISSING,
  QBO_NOT_CONNECTED,
  QBO_REAUTH_REQUIRED,
  QBO_REQUEST_FAILED,
  QBO_SECRET_STORE_UNAVAILABLE,
  QBO_SYNC_FAILED,
  QBO_TOKEN_EXCHANGE_FAILED,
  QBO_TOKEN_REFRESH_FAILED
} from '../qbo/errors'
import {
  connect,
  disconnect,
  getReference,
  markConnectionExpired,
  readStatus,
  syncReference,
  type QboServiceDeps
} from '../qbo/service'
import { assertTrustedSender } from './trusted-sender'

/**
 * Stable internal code for a channel whose real body has not landed yet. It is a CODE, not copy:
 * it never reaches the renderer, it is mapped through the table below exactly like a real failure
 * code from the QuickBooks client.
 *
 * Kept after the real bodies landed because the seam suite pins that this module maps a code to a
 * sentence rather than forwarding it, and an unused-but-mapped code is the cheapest possible proof.
 */
export const NOT_IMPLEMENTED = 'NOT_IMPLEMENTED'

/**
 * Opaque failure codes mapped to plain, recoverable user copy (the ai.ts CONNECTION_ERROR_COPY
 * shape). Anything not in this table falls back to the generic message: an unrecognized error came
 * from the SDK or the network and its text is NOT safe to forward.
 *
 * Every sentence here says what the person can DO next, and none of them contains an em dash or an
 * en dash (house rule for user-facing text). None of them names a host, a port, a realm id, or a
 * credential, which is the whole reason this table exists rather than a passthrough.
 */
const QBO_ERROR_COPY: Readonly<Record<string, string>> = {
  [NOT_IMPLEMENTED]: 'This feature is still being built.',
  [QBO_CLIENT_CREDENTIALS_MISSING]:
    'Add your QuickBooks app client id and client secret in Settings, then connect again.',
  [QBO_SECRET_STORE_UNAVAILABLE]:
    'This computer would not let NicoleBooks store the QuickBooks connection securely, so nothing was saved. Try again, and if it keeps happening sign out and back in to this computer.',
  [QBO_NOT_CONNECTED]: 'Connect to QuickBooks first, then try again.',
  [QBO_REAUTH_REQUIRED]:
    'Your QuickBooks connection needs to be renewed. Choose Reconnect to sign in again.',
  [QBO_TOKEN_REFRESH_FAILED]:
    'Could not refresh your QuickBooks connection just now. Check your internet connection, then try again.',
  [QBO_TOKEN_EXCHANGE_FAILED]:
    'QuickBooks would not complete the sign in. Check the client id and client secret in Settings, then try again.',
  [QBO_CALLBACK_PORT_BUSY]:
    'Another program on this computer is using the port NicoleBooks needs to finish signing in. Close it, or restart the computer, then try again.',
  [QBO_AUTH_CANCELED]: 'The QuickBooks sign in was closed before it finished. Try connecting again.',
  [QBO_AUTH_TIMEOUT]: 'The QuickBooks sign in took too long, so it was stopped. Try connecting again.',
  [QBO_AUTH_STATE_MISMATCH]:
    'That QuickBooks sign in could not be verified, so it was stopped. Start the connection again from Settings.',
  [QBO_AUTH_IN_PROGRESS]:
    'A QuickBooks sign in is already open. Finish it in your browser, or close that tab and try again.',
  [QBO_REQUEST_FAILED]:
    'Could not reach QuickBooks just now. Check your internet connection, then try again.',
  [QBO_SYNC_FAILED]:
    'Could not read your QuickBooks lists just now. Check your internet connection, then choose Sync now again.'
}

const GENERIC_QBO_ERROR =
  'Could not reach QuickBooks just now. Check your internet connection, then try again.'

/** Map any thrown value to a fixed recoverable message. Never returns raw error text or a stack. */
function recoverableReason(err: unknown): string {
  const code = err instanceof Error ? err.message : ''
  return QBO_ERROR_COPY[code] ?? GENERIC_QBO_ERROR
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

/**
 * Run one operation behind the shared failure discipline: flip to 'expired' and broadcast when the
 * authorization is dead, and re-throw everything as mapped copy so no raw error text can escape.
 *
 * Exported for the unit spec, which drives the mapping without an IPC bus.
 */
export async function runQboOperation<T>(
  operation: () => Promise<T> | T,
  deps: QboServiceDeps = {}
): Promise<T> {
  try {
    return await operation()
  } catch (err) {
    if (err instanceof Error && err.message === QBO_REAUTH_REQUIRED) {
      markConnectionExpired(deps)
      broadcastQboStatus(readStatus(deps))
    }
    throw new Error(recoverableReason(err))
  }
}

/** Register the qbo channel handlers. Call after app 'ready' (the token store needs it). */
export function registerQboIpc(): void {
  ipcMain.handle(Channels.qboStatus, async (event, raw) => {
    assertTrustedSender(event)
    QboStatusSchema.parse(raw ?? {})
    return runQboOperation(() => readStatus())
  })

  // Resolves only once the browser round trip finishes, which is why the contract types it as
  // "one call both starts and reports the connection": the renderer awaits a single promise and
  // renders the resulting status, with no polling and no second channel to keep in step.
  ipcMain.handle(Channels.qboConnect, async (event, raw) => {
    assertTrustedSender(event)
    QboConnectSchema.parse(raw ?? {})
    const status = await runQboOperation(() =>
      // shell.openExternal is injected rather than imported by the OAuth module, so that module
      // stays free of Electron and its unit spec can drive a real loopback server.
      connect({ openExternal: (url) => shell.openExternal(url) })
    )
    broadcastQboStatus(status)
    return status
  })

  ipcMain.handle(Channels.qboDisconnect, async (event, raw) => {
    assertTrustedSender(event)
    QboDisconnectSchema.parse(raw ?? {})
    const status = await runQboOperation(() => disconnect())
    broadcastQboStatus(status)
    return status
  })

  // A sync changes lastSyncAt, which the connection card displays, so it broadcasts the new status
  // alongside returning the counts.
  ipcMain.handle(Channels.qboSyncReference, async (event, raw) => {
    assertTrustedSender(event)
    QboSyncReferenceSchema.parse(raw ?? {})
    const result = await runQboOperation(() => syncReference())
    broadcastQboStatus(readStatus())
    return result
  })

  ipcMain.handle(Channels.qboGetReference, async (event, raw) => {
    assertTrustedSender(event)
    QboGetReferenceSchema.parse(raw ?? {})
    return runQboOperation(() => getReference())
  })
}
