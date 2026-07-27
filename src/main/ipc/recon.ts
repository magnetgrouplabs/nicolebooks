// src/main/ipc/recon.ts
//
// recon channel group: recon:match.
//
// STUB MODULE (finish sprint, SEAMS). The channel is registered with its real gates --
// assertTrustedSender first, then the Zod payload gate -- and then rejects with the fixed
// NOT_IMPLEMENTED copy. RECON owns this file: replace the notImplemented() call with the real
// body and leave the gates and the error table in place.
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

import { ipcMain } from 'electron'
import { Channels } from '../../shared/ipc-contract'
import { ReconMatchSchema } from '../../shared/schemas'
import { assertTrustedSender } from './trusted-sender'

/**
 * Stable internal code for a channel whose real body has not landed yet. It is a CODE, not copy:
 * it never reaches the renderer, it is mapped through the table below exactly like a real failure.
 */
export const NOT_IMPLEMENTED = 'NOT_IMPLEMENTED'

/**
 * Opaque failure codes mapped to plain, recoverable user copy (the ai.ts CONNECTION_ERROR_COPY
 * shape). Anything not in this table falls back to the generic message.
 *
 * RECON: add your codes here. Do not forward raw error text.
 */
const RECON_ERROR_COPY: Readonly<Record<string, string>> = {
  [NOT_IMPLEMENTED]: 'This feature is still being built.'
}

const GENERIC_RECON_ERROR = 'Could not match these bills against QuickBooks. Please try again.'

/** Map any thrown value to a fixed recoverable message. Never returns raw error text or a stack. */
function recoverableReason(err: unknown): string {
  const code = err instanceof Error ? err.message : ''
  return RECON_ERROR_COPY[code] ?? GENERIC_RECON_ERROR
}

/** Reject with the mapped NOT_IMPLEMENTED copy. Replace the call site, not this helper. */
function notImplemented(): never {
  throw new Error(recoverableReason(new Error(NOT_IMPLEMENTED)))
}

/** Register the recon channel handlers. Call after app 'ready' (getDatabase needs it). */
export function registerReconIpc(): void {
  ipcMain.handle(Channels.reconMatch, (event, raw) => {
    assertTrustedSender(event)
    ReconMatchSchema.parse(raw)
    return notImplemented()
  })
}
