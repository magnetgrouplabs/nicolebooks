// src/main/posting/errors.ts
//
// The posting group's opaque failure codes and the plain-language copy each one maps to.
//
// WHY THE TABLE LIVES HERE AND NOT ONLY AT THE IPC BOUNDARY. The house pattern (ai.ts) maps a code
// to copy in the handler, because that is the last moment before a message crosses to the
// renderer. Posting has a second exit: a per-entry failure is PERSISTED in posting_entries.error
// and read back later by posting:batch-detail, long after the handler that produced it returned.
// A raw message stored on disk is a leak with a delay, so the mapping has to happen before the
// write, which means one shared table rather than one per exit. src/main/ipc/posting.ts imports it.
//
// WHAT AN UNMAPPED ERROR IS. A QuickBooks error message is assembled from the provider's response
// body and routinely embeds the request URL and the realm id; a fetch failure carries a host; a
// better-sqlite3 error carries a file path. Every one of those is unsafe to forward, so the
// fallback is generic BY DEFAULT and a code has to be added deliberately to escape it.
//
// HOUSE RULE: no em dashes and no en dashes in any string below. These are user-facing sentences.

/** Codes thrown internally by the posting modules. Never rendered; always mapped first. */
export const POSTING_NOT_CONNECTED = 'POSTING_NOT_CONNECTED'
export const POSTING_BATCH_IN_FLIGHT = 'POSTING_BATCH_IN_FLIGHT'
export const POSTING_EXPENSE_NEEDS_ACCOUNT = 'POSTING_EXPENSE_NEEDS_ACCOUNT'
export const POSTING_BILL_HAS_PAID_FROM = 'POSTING_BILL_HAS_PAID_FROM'
export const POSTING_DUPLICATE_ROWS = 'POSTING_DUPLICATE_ROWS'
export const POSTING_ALREADY_ENTERED = 'POSTING_ALREADY_ENTERED'
export const POSTING_REJECTED = 'POSTING_REJECTED'
export const POSTING_UNAVAILABLE = 'POSTING_UNAVAILABLE'
export const POSTING_AMOUNT_NEGATIVE = 'POSTING_AMOUNT_NEGATIVE'
export const POSTING_AMOUNT_NOT_INTEGER = 'POSTING_AMOUNT_NOT_INTEGER'
export const POSTING_WRONG_BUILDER = 'POSTING_WRONG_BUILDER'
export const POSTING_BATCH_NOT_FOUND = 'POSTING_BATCH_NOT_FOUND'
export const POSTING_NOTHING_TO_UNDO = 'POSTING_NOTHING_TO_UNDO'
export const POSTING_UNDO_REFUSED_CHANGED = 'POSTING_UNDO_REFUSED_CHANGED'
export const POSTING_UNDO_ENTITY_MISSING = 'POSTING_UNDO_ENTITY_MISSING'
export const POSTING_UNDO_FAILED = 'POSTING_UNDO_FAILED'

/**
 * Code to copy. Every sentence says what happened AND what the user can do next, because the only
 * person who ever reads these is the one non-technical user this app exists for.
 */
export const POSTING_ERROR_COPY: Readonly<Record<string, string>> = {
  [POSTING_NOT_CONNECTED]:
    'NicoleBooks is not connected to QuickBooks yet. Connect on the Settings screen, then send this batch again.',
  [POSTING_BATCH_IN_FLIGHT]:
    'A batch is already being sent to QuickBooks. Wait for it to finish, then try again.',
  [POSTING_EXPENSE_NEEDS_ACCOUNT]:
    'This expense does not say which account paid it. Pick the bank or credit card account on the review screen, then send again.',
  [POSTING_BILL_HAS_PAID_FROM]:
    'This bill names an account that paid it, which only an expense can do. Switch the row to Expense, or clear the paid from account, then send again.',
  [POSTING_DUPLICATE_ROWS]:
    'The same document appears more than once in this batch. Remove the extra copy, then send again.',
  [POSTING_ALREADY_ENTERED]:
    'This document was already entered in QuickBooks, so it was not sent again.',
  [POSTING_REJECTED]:
    'QuickBooks would not accept this entry. Check the vendor, the category, and the amount on the review screen, then send it again.',
  [POSTING_UNAVAILABLE]:
    'Could not reach QuickBooks. Check your internet connection, then send this batch again.',
  [POSTING_AMOUNT_NEGATIVE]:
    'This amount is negative. NicoleBooks enters bills and expenses only, so enter a credit directly in QuickBooks.',
  [POSTING_AMOUNT_NOT_INTEGER]:
    'This amount could not be read as a whole number of cents. Retype it on the review screen, then send again.',
  [POSTING_WRONG_BUILDER]:
    'That entry could not be prepared for QuickBooks. Check whether it is a bill or an expense, then send again.',
  [POSTING_BATCH_NOT_FOUND]: 'That batch is no longer in your history.',
  [POSTING_NOTHING_TO_UNDO]:
    'There is nothing to undo. No batch has been sent to QuickBooks yet.',
  [POSTING_UNDO_REFUSED_CHANGED]:
    'This entry was changed in QuickBooks after NicoleBooks sent it, so it was left alone. Open it in QuickBooks and remove it there if you still want it gone.',
  [POSTING_UNDO_ENTITY_MISSING]:
    'This entry is no longer in QuickBooks. It looks like it was already deleted there, so nothing was changed.',
  [POSTING_UNDO_FAILED]:
    'QuickBooks would not remove this entry. Open it in QuickBooks and delete it there.'
}

/**
 * The fallback for anything unmapped. It states the safe fact (this row did not go in) rather than
 * guessing at a cause, because the alternative is forwarding provider text.
 */
export const GENERIC_POSTING_ERROR =
  'Could not send this entry to QuickBooks just now. Nothing was changed in QuickBooks. Please try again.'

/** Map any thrown value to fixed recoverable copy. Never returns raw error text or a stack. */
export function recoverablePostingReason(err: unknown): string {
  const code = err instanceof Error ? err.message : ''
  return POSTING_ERROR_COPY[code] ?? GENERIC_POSTING_ERROR
}

/** The code carried by a thrown value, when it is one this module knows. Otherwise null. */
export function postingErrorCode(err: unknown): string | null {
  const code = err instanceof Error ? err.message : ''
  return code in POSTING_ERROR_COPY ? code : null
}
