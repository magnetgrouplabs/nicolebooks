// src/main/posting/entity-builders.ts
//
// Pure builders that turn one approved review row into the exact JSON body QuickBooks expects,
// plus the request path that carries the idempotency key.
//
// EVERYTHING HERE IS PURE. No database, no network, no clock, no electron. That is deliberate:
// the shape of a Bill or a Purchase is the single place where a mistake becomes a wrong number in
// somebody's books, so it is the part of this phase that gets the hardest unit tests. Anything
// that needs I/O (the account TYPE that decides the payment method, the vendor NAME the report
// prints) is passed IN as an argument rather than looked up here.
//
// MONEY. centsToDecimalString does integer math only. `cents / 100` is the obvious version and it
// is wrong: 1_00 / 100 is fine, but the moment a value like 8_35 meets a float round trip through
// toFixed you are trusting binary floating point with somebody's cents. Slicing the digit string
// cannot round, cannot drift, and cannot depend on the locale.

import type { PostingEntryType } from '../../shared/ipc-contract'

/**
 * The QuickBooks Accounting API minor version this app pins.
 *
 * Always sending an explicit minorversion is what keeps response shapes stable: without it Intuit
 * serves whichever version is current, and a field can change under a shipped build.
 */
export const QBO_MINOR_VERSION = '75'

/** Which QuickBooks entity a row becomes. Bill = payable later, Purchase = already paid. */
export type QboEntityName = 'Bill' | 'Purchase'

/** The entity name for a review row's type. The one place the mapping is written down. */
export function entityNameFor(entryType: PostingEntryType): QboEntityName {
  return entryType === 'bill' ? 'Bill' : 'Purchase'
}

/** A QuickBooks reference: the id of a record that already exists in the company. */
export interface QboRef {
  value: string
}

/**
 * The single expense line every entry carries. One line, one category account: this app codes a
 * whole bill to one category on purpose (per-line-item splitting is out of scope), so a row that
 * needs two categories is two rows.
 */
export interface QboAccountBasedExpenseLine {
  Amount: string
  DetailType: 'AccountBasedExpenseLineDetail'
  AccountBasedExpenseLineDetail: { AccountRef: QboRef }
  Description?: string
}

/** The Bill create body: an unpaid payable owed to a vendor. */
export interface QboBillPayload {
  VendorRef: QboRef
  TxnDate: string
  DueDate?: string
  DocNumber?: string
  PrivateNote?: string
  Line: QboAccountBasedExpenseLine[]
}

/**
 * The Purchase create body: money that already left an account.
 *
 * The two refs mean different things and swapping them is the classic mistake:
 *   AccountRef  = what PAID (the bank or credit card account the money left)
 *   EntityRef   = who was PAID (the vendor), and it must carry type 'Vendor'
 * The category account lives on the line, exactly as it does on a Bill.
 */
export interface QboPurchasePayload {
  PaymentType: QboPaymentType
  AccountRef: QboRef
  EntityRef: { value: string; type: 'Vendor' }
  TxnDate: string
  DocNumber?: string
  PrivateNote?: string
  Line: QboAccountBasedExpenseLine[]
}

/** The payment methods this app posts. Card spend is 'CreditCard'; everything else is 'Check'. */
export type QboPaymentType = 'CreditCard' | 'Check'

/** The fields a builder needs from an approved review row. A structural subset of PostingRow. */
export interface EntityRowInput {
  entryType: PostingEntryType
  vendorId: string
  categoryAccountId: string
  paidFromAccountId: string | null
  txnDate: string
  dueDate: string | null
  refNumber: string | null
  amountCents: number
  memo: string | null
}

/**
 * Integer cents to the decimal string QuickBooks reads, using integer math ONLY.
 *
 * 0 -> '0.00', 1 -> '0.01', 99 -> '0.99', 100 -> '1.00', 999999999 -> '9999999.99'.
 *
 * Rejects a negative amount rather than emitting one. A negative line is a credit memo or a refund
 * and this app posts neither; letting one through would create an entry that reads as a bill and
 * behaves as a credit. Rejects a non-integer for the same reason the column is INTEGER: a
 * fractional cent means an earlier layer already used a float.
 */
export function centsToDecimalString(cents: number): string {
  if (!Number.isInteger(cents)) throw new Error('POSTING_AMOUNT_NOT_INTEGER')
  if (cents < 0) throw new Error('POSTING_AMOUNT_NEGATIVE')
  // padStart(3) guarantees at least one whole digit plus two decimals, so 0 -> '000' -> '0.00'
  // and 7 -> '007' -> '0.07'. No division, no rounding, no locale.
  const digits = cents.toString().padStart(3, '0')
  return `${digits.slice(0, -2)}.${digits.slice(-2)}`
}

/**
 * Which payment method a Purchase declares, from the paid-from account's QuickBooks AccountType.
 *
 * 'CreditCard' when the account is a credit card, 'Check' for a bank account. An UNKNOWN type also
 * resolves to 'Check', because 'Check' is the neutral outcome: QuickBooks accepts it against a
 * bank account, and being wrong about the method on a card is a cosmetic label, while refusing to
 * post at all would strand the row. The account itself (AccountRef) is what actually determines
 * where the money came from, and that is never guessed.
 */
export function paymentTypeForAccount(accountType: string | null | undefined): QboPaymentType {
  if (typeof accountType !== 'string') return 'Check'
  // Intuit spells it 'Credit Card'; tolerate spacing and casing variants from any cache shape.
  const normalized = accountType.replace(/[\s_-]/g, '').toLowerCase()
  return normalized === 'creditcard' ? 'CreditCard' : 'Check'
}

/** The one expense line, shared by both entity shapes. */
function expenseLine(row: EntityRowInput): QboAccountBasedExpenseLine {
  const line: QboAccountBasedExpenseLine = {
    Amount: centsToDecimalString(row.amountCents),
    DetailType: 'AccountBasedExpenseLineDetail',
    AccountBasedExpenseLineDetail: { AccountRef: { value: row.categoryAccountId } }
  }
  // An empty memo is omitted rather than sent as '': QuickBooks stores the empty string verbatim
  // and it reads as "somebody typed nothing here" in reports.
  if (row.memo !== null && row.memo.trim() !== '') line.Description = row.memo
  return line
}

/**
 * Build the Bill create body.
 *
 * DueDate is omitted when the row has none (QuickBooks then derives it from the vendor's terms,
 * which is the right default; sending null would be a validation error). DocNumber is the user's
 * reference number and is already capped at the QuickBooks 21-character limit by the payload
 * schema, so a value that reaches here is postable.
 */
export function buildBillPayload(row: EntityRowInput): QboBillPayload {
  if (row.entryType !== 'bill') throw new Error('POSTING_WRONG_BUILDER')
  const payload: QboBillPayload = {
    VendorRef: { value: row.vendorId },
    TxnDate: row.txnDate,
    Line: [expenseLine(row)]
  }
  if (row.dueDate !== null) payload.DueDate = row.dueDate
  if (row.refNumber !== null && row.refNumber !== '') payload.DocNumber = row.refNumber
  if (row.memo !== null && row.memo.trim() !== '') payload.PrivateNote = row.memo
  return payload
}

/**
 * Build the Purchase create body.
 *
 * paidFromAccountId is REQUIRED here and throws when absent: a Purchase records money that already
 * left an account, so an expense with no account to leave is not a thing QuickBooks can store. The
 * IPC schema rejects it first; this throw is the structural backstop for any future caller.
 *
 * A Purchase carries no DueDate by design: it is already paid.
 */
export function buildPurchasePayload(
  row: EntityRowInput,
  paidFromAccountType: string | null
): QboPurchasePayload {
  if (row.entryType !== 'expense') throw new Error('POSTING_WRONG_BUILDER')
  if (row.paidFromAccountId === null || row.paidFromAccountId === '') {
    throw new Error('POSTING_EXPENSE_NEEDS_ACCOUNT')
  }
  const payload: QboPurchasePayload = {
    PaymentType: paymentTypeForAccount(paidFromAccountType),
    AccountRef: { value: row.paidFromAccountId },
    EntityRef: { value: row.vendorId, type: 'Vendor' },
    TxnDate: row.txnDate,
    Line: [expenseLine(row)]
  }
  if (row.refNumber !== null && row.refNumber !== '') payload.DocNumber = row.refNumber
  if (row.memo !== null && row.memo.trim() !== '') payload.PrivateNote = row.memo
  return payload
}

/**
 * The create path for one entity, carrying the idempotency key.
 *
 * Intuit's contract is a `requestid` QUERY PARAMETER on the create request, not a header and not a
 * body field: replaying the same requestid returns the ORIGINAL response and creates nothing. That
 * is the entire reason a crash mid-batch is survivable, so the key is built into the URL here (one
 * pure, testable function) rather than assembled at three call sites in the HTTP client.
 *
 * Both the realm id and the key are percent-encoded. Neither is renderer-supplied today, but a
 * path built by string concatenation is exactly the kind of thing that stops being safe the day
 * somebody adds a new caller.
 */
export function createEntityPath(
  realmId: string,
  entity: QboEntityName,
  requestId: string,
  minorVersion: string = QBO_MINOR_VERSION
): string {
  const resource = entity.toLowerCase()
  const params = new URLSearchParams({ minorversion: minorVersion, requestid: requestId })
  return `/v3/company/${encodeURIComponent(realmId)}/${resource}?${params.toString()}`
}

/** The read path for one entity by id. Used by undo to re-check the live SyncToken. */
export function readEntityPath(
  realmId: string,
  entity: QboEntityName,
  id: string,
  minorVersion: string = QBO_MINOR_VERSION
): string {
  const resource = entity.toLowerCase()
  const params = new URLSearchParams({ minorversion: minorVersion })
  return `/v3/company/${encodeURIComponent(realmId)}/${resource}/${encodeURIComponent(id)}?${params.toString()}`
}

/**
 * The delete path for one entity.
 *
 * QuickBooks deletes are a POST to the entity collection with `?operation=delete` and a body
 * carrying the Id plus the CURRENT SyncToken. The SyncToken in that body is the concurrency check:
 * if the entity changed since we read it, QuickBooks refuses. Undo re-reads first anyway, so this
 * is the second of two guards, not the only one.
 */
export function deleteEntityPath(
  realmId: string,
  entity: QboEntityName,
  minorVersion: string = QBO_MINOR_VERSION
): string {
  const resource = entity.toLowerCase()
  const params = new URLSearchParams({ minorversion: minorVersion, operation: 'delete' })
  return `/v3/company/${encodeURIComponent(realmId)}/${resource}?${params.toString()}`
}
