// src/renderer/src/review/send.ts
//
// The one function that hands a reviewed batch to QuickBooks.
//
// It exists as its own function, taking the sender as an argument, for one reason: this is the
// moment the app touches somebody's books, and "exactly these rows were sent" has to be provable
// without a DOM. A spec passes a fake sender and asserts the payload field by field; nothing about
// that assertion depends on how the button is styled or which component owns the state.
//
// ERROR COPY IS FORWARDED VERBATIM, and that is deliberate. src/main/posting/errors.ts already maps
// every failure to a plain sentence that says what to do ("Connect on the Settings screen, then
// send this batch again"), and it does so with more context than the renderer has: it knows whether
// the connection is missing, whether a batch is already in flight, and whether QuickBooks refused
// the entry. Re-wording it here would replace a specific instruction with a vaguer one. The only
// message this module invents is the fallback for a rejection that arrived with no message at all.

import { ipcErrorMessage } from '@/lib/ipc-error'
import { toPostingRows, type ReviewRow } from './model'
import type { PostingRow, PostingSendResult } from '@shared/ipc-contract'

/** What the screen shows when a send fails without saying anything at all. */
export const GENERIC_SEND_ERROR =
  'Could not send this batch to QuickBooks just now. Nothing was changed in QuickBooks. Please try again.'

/** What the screen shows when a send is attempted with nothing in it (the gate should prevent it). */
export const NOTHING_TO_SEND = 'Tick at least one bill to send it to QuickBooks.'

/** Either the batch handle plus exactly what went, or the sentence to put on screen. */
export type SendOutcome =
  | { ok: true; batchId: string; sent: PostingRow[] }
  | { ok: false; error: string }

/**
 * Is this message something a person can read?
 *
 * Every failure main INTENDS to show is a sentence from the posting error table. But the Zod payload
 * gate runs BEFORE the handler's try block (that is the house pattern, so a malformed payload never
 * reaches the privileged work), which means a schema rejection crosses the bridge unmapped, and in
 * Zod 4 that message is the whole issue array serialized as JSON. Forwarding it verbatim would put
 * a JSON dump in front of the one non-technical user this app exists for.
 *
 * The gate in model.ts mirrors every bound the schema enforces, so this should be unreachable. It is
 * here anyway because "should be unreachable" is exactly the claim that stops being true, and the
 * cost of being wrong is the ugliest screen in the app at the most sensitive moment in it.
 */
function isReadableSentence(message: string): boolean {
  if (message.startsWith('[') || message.startsWith('{')) return false
  return !message.includes('"code"') && !message.includes('invalid_type')
}

/**
 * Assemble the approved rows and send them.
 *
 * `sent` is returned alongside the batch id so the caller can seed its per-row state from the same
 * array that crossed the boundary, rather than re-deriving it from rows the user may have kept
 * editing while the request was in flight.
 */
export async function sendReviewBatch(
  rows: readonly ReviewRow[],
  send: (payload: PostingRow[]) => Promise<PostingSendResult>
): Promise<SendOutcome> {
  const payload = toPostingRows(rows)
  if (payload.length === 0) return { ok: false, error: NOTHING_TO_SEND }

  try {
    const result = await send(payload)
    return { ok: true, batchId: result.batchId, sent: payload }
  } catch (err) {
    // Unwrapped first: Electron rejects an invoke with its OWN error, whose message carries the
    // channel name and the word Error in front of whatever main actually said.
    const message = ipcErrorMessage(err)
    const readable = message.length > 0 && isReadableSentence(message)
    return { ok: false, error: readable ? message : GENERIC_SEND_ERROR }
  }
}
