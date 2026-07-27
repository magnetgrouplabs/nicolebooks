// src/main/posting/rows.ts
//
// The cross-field rules that PostingRowSchema deliberately does not encode.
//
// SEAMS left the bill-vs-expense rule out of src/shared/schemas.ts on purpose: only this module
// depends on it, so it belongs beside the code that depends on it rather than in a file four
// agents import. The shape gate (types, bounds, ISO dates, integer cents) still runs first, at the
// IPC boundary; what is left is the handful of rules that need to look at more than one field.
//
// These throw the OPAQUE CODES from errors.ts, which the handler maps to copy. A batch that fails
// any of them is rejected whole, before a single row is persisted and long before a network call:
// a half-postable batch is a batch the user has to reason about, and the only thing worse than
// refusing to send is sending some of it.

import type { PostingRow } from '../../shared/ipc-contract'
import {
  POSTING_BILL_HAS_PAID_FROM,
  POSTING_DUPLICATE_ROWS,
  POSTING_EXPENSE_NEEDS_ACCOUNT
} from './errors'

/**
 * Refuse a batch that cannot be posted as written.
 *
 * Three rules:
 *   1. An EXPENSE must name the account that paid it. A Purchase records money that already left
 *      an account, so "which account" is not optional; QuickBooks would reject it mid-batch and
 *      the user would be left guessing which row broke.
 *   2. A BILL must not name one. A Bill is unpaid by definition, and a paid-from account on it
 *      means the row is on the wrong side of the toggle, which is a real mis-click and produces a
 *      real accounting error (an expense recorded as a payable, so the money looks unspent).
 *   3. No document appears twice. The same file hash twice in one send is the review grid asking
 *      to post the same document twice, and the UNIQUE (batch_id, file_hash) index would refuse
 *      the second insert anyway. Catching it here turns a database constraint into a sentence.
 */
export function assertPostableRows(rows: readonly PostingRow[]): void {
  const seen = new Set<string>()
  for (const row of rows) {
    if (seen.has(row.fileHash)) throw new Error(POSTING_DUPLICATE_ROWS)
    seen.add(row.fileHash)

    if (row.entryType === 'expense' && (row.paidFromAccountId === null || row.paidFromAccountId === '')) {
      throw new Error(POSTING_EXPENSE_NEEDS_ACCOUNT)
    }
    if (row.entryType === 'bill' && row.paidFromAccountId !== null) {
      throw new Error(POSTING_BILL_HAS_PAID_FROM)
    }
  }
}
