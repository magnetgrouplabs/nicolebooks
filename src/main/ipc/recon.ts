// src/main/ipc/recon.ts
//
// recon channel group: recon:match.
//
// The handler runs assertTrustedSender(event) as its FIRST statement, then Zod-parses. This
// channel carries a REAL payload from the preload, so a bare `ReconMatchSchema.parse(raw)` is
// correct here -- the `parse(raw ?? {})` normalization applies only to payload-free channels,
// where the preload invokes with no argument at all.
//
// HASHES ONLY (the payload rule that makes this seam safe): the renderer sends file hashes, never
// the parsed vendor or category text. That text already lives in the main-side parsed_results
// cache, so accepting it here would let a compromised renderer steer a match against text the
// parser never produced, and would duplicate the source of truth for no gain.
//
// NOTHING IS CREATED ON THIS CHANNEL (RECON-03). recon:match ranks records that already exist in
// the connected company and returns that ranking. There is no create path in src/main/recon/, so a
// silent vendor or account create is not guarded against here, it is absent.
//
// ERRORS ARE MAPPED, NEVER FORWARDED (the ai.ts CONNECTION_ERROR_COPY discipline). Everything below
// this handler reads SQLite, and a SQLite failure carries a filesystem path. Only the two codes in
// the table below, and the generic fallback, ever reach the renderer. Nothing here logs.

import { ipcMain } from 'electron'
import { Channels } from '../../shared/ipc-contract'
import { ReconMatchSchema } from '../../shared/schemas'
import { matchBatch, RECON_NOT_CONNECTED, RECON_REFERENCE_EMPTY } from '../recon/service'
import { assertTrustedSender } from './trusted-sender'

/**
 * Stable internal code for a channel whose real body has not landed yet. It is a CODE, not copy:
 * it never reaches the renderer, it is mapped through the table below exactly like a real failure.
 *
 * Kept after the real body landed (the qbo.ts precedent) because the seam suite pins that this
 * module maps a code to a sentence rather than forwarding it, and an unused-but-mapped code is the
 * cheapest possible proof of that.
 */
export const NOT_IMPLEMENTED = 'NOT_IMPLEMENTED'

/**
 * Opaque failure codes mapped to plain, recoverable user copy (the ai.ts CONNECTION_ERROR_COPY
 * shape). Anything not in this table falls back to the generic message.
 *
 * Every sentence says what the person can DO next, and none of them contains an em dash or an en
 * dash (house rule for user-facing text). None names a path, a host, a realm id or a credential.
 */
export const RECON_ERROR_COPY: Readonly<Record<string, string>> = {
  [NOT_IMPLEMENTED]: 'This feature is still being built.',
  [RECON_NOT_CONNECTED]: 'Connect to QuickBooks in Settings first, then try again.',
  [RECON_REFERENCE_EMPTY]:
    'NicoleBooks has no QuickBooks vendors or categories to match against yet. Open Settings, choose Sync now, then try again.'
}

const GENERIC_RECON_ERROR = 'Could not match these bills against QuickBooks. Please try again.'

/** Map any thrown value to a fixed recoverable message. Never returns raw error text or a stack. */
function recoverableReason(err: unknown): string {
  const code = err instanceof Error ? err.message : ''
  return RECON_ERROR_COPY[code] ?? GENERIC_RECON_ERROR
}

/**
 * Run one reconciliation behind the shared failure discipline, so no raw error text can escape.
 *
 * Exported for the unit spec, which drives the mapping without an IPC bus.
 */
export function runReconOperation<T>(operation: () => T): T {
  try {
    return operation()
  } catch (err) {
    throw new Error(recoverableReason(err))
  }
}

/**
 * Register the recon channel handlers. Call after app 'ready' (getDatabase needs it).
 *
 * The body is entirely synchronous (two SQLite reads and a ranking, on a batch of 5-20 documents),
 * but the handler is declared async like every other module here: ipcMain.handle resolves a promise
 * to the renderer either way, and a uniform shape means a future body that needs to await does not
 * change the signature.
 */
export function registerReconIpc(): void {
  ipcMain.handle(Channels.reconMatch, async (event, raw) => {
    assertTrustedSender(event)
    const { fileHashes } = ReconMatchSchema.parse(raw)
    return runReconOperation(() => matchBatch(fileHashes))
  })
}
