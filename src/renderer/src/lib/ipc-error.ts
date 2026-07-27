// src/renderer/src/lib/ipc-error.ts
//
// Unwrap the sentence main actually meant to send.
//
// THE BUG THIS EXISTS TO FIX, found by the live drill. Every main-side handler in this app maps its
// failures to plain recoverable copy before rejecting, precisely so the user never meets raw error
// text. But Electron does not reject with that Error: `ipcRenderer.invoke` rejects with a NEW error
// whose message is
//
//     Error invoking remote method 'qbo:create-vendor': Error: A vendor with this name already
//     exists in QuickBooks. Pick it from the list instead.
//
// So every screen that forwarded main's message verbatim (which is the right instinct, and what the
// send flow, the undo flow, and the Settings QuickBooks card all do) was showing the channel name
// and the word Error twice in front of the sentence. It is the sort of defect no unit test can see,
// because the wrapper is added by the IPC transport rather than by any code either side owns.
//
// Two layers are stripped, in order:
//   1. Electron's invoke wrapper, including the channel name. The channel is an internal identifier
//      and naming it at the user tells them nothing they can act on.
//   2. The serialized error NAME ('Error: ', 'TypeError: '), which is what Electron puts in front of
//      the message when it re-materializes the rejection.
//
// Whatever is left is main's own sentence, or something main never intended to send, which the
// caller then decides about (see isReadableSentence in review/send.ts).

/** Electron's wrapper, e.g. "Error invoking remote method 'posting:send': ". */
const INVOKE_WRAPPER = /^Error invoking remote method '[^']*':\s*/

/** The serialized error name Electron prefixes the original message with. */
const ERROR_NAME = /^[A-Za-z]*Error:\s*/

/**
 * The message main meant, with Electron's IPC wrapping removed.
 *
 * Returns '' for a rejection that carried nothing readable, so every caller keeps its own decision
 * about what to show instead. It never invents copy: the wording belongs to the module that knows
 * what went wrong.
 */
export function ipcErrorMessage(err: unknown): string {
  if (!(err instanceof Error)) return ''
  return err.message.replace(INVOKE_WRAPPER, '').replace(ERROR_NAME, '').trim()
}
