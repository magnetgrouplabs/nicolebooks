// src/main/parse/validate.ts
//
// The deterministic validation gate over the vision model's output (PARSE-04, decisions
// D-10 and D-12). Everything this module consumes is UNTRUSTED text: a bill photo can carry
// prompt-injection, and vision-model number OCR is a known weak spot, so the model is never
// asked to do arithmetic or unit conversion. It returns the raw printed strings and this
// module re-derives every number locally (threats T-03-04, T-03-04b).
//
// Three guarantees, in order of importance:
//   1. Money becomes INTEGER cents, computed with digit-string math. Float dollars are never
//      used anywhere in the pipeline: 19.99 * 100 === 1998.9999999999998 (RESEARCH Pitfall 4).
//   2. Dates become ISO 'YYYY-MM-DD'. An unparseable date is FLAGGED, never thrown and never
//      guessed; an ABSENT date is not an error at all, because every optional field is
//      genuinely nullable by design (D-09 — forcing fields required causes hallucinated fills).
//   3. subtotal + tax = total is cross-checked ONLY when both operands are present (D-10:
//      tax-included receipts and receipts with no separate tax line are normal, not errors),
//      within a two-cent tolerance so per-line tax rounding does not false-alarm (D-12).
//
// Nothing here rejects a bill and nothing silently auto-corrects one — flag-and-keep (D-12).
// Every emitted flag is a STRING: the STRICT parsed_results table has no BOOLEAN type and a
// JS boolean bind throws (RESEARCH Pitfall 8). The `flagged` field on normalizeDate's return
// and arithmeticOk's boolean are internal computation signals; neither is ever persisted.
//
// A pure, dependency-free module in the src/main/ingestion/hash.ts convention: no Electron,
// no network, no state, directly unit-testable (test/parse-validate.test.ts).

import type { ParsedFields } from '../../shared/ipc-contract'
import type { Bill } from '../../shared/schemas'

/**
 * Cents of slack allowed on subtotal + tax = total. Vendors compute tax per line and round
 * each line, so a legitimate invoice can miss the sum by a cent or two; flagging those would
 * train the reviewer to ignore the flag, which is worse than not having one (D-12).
 */
export const ROUNDING_TOLERANCE = 2

/**
 * The single arithmetic flag. It condemns all three money fields at once (any one of the
 * three could be the wrong number), so confidence.ts maps it specially rather than through
 * the generic '<check>:<field>' rule the other flags follow.
 */
export const ARITHMETIC_FLAG = 'arithmetic:subtotal+tax!=total'

/** Month names, index 0 = January. Shared with confidence.ts so date grounding and date
 *  parsing can never drift apart on spelling. */
export const MONTH_NAMES = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december'
] as const

/** What validateBill returns: the coerced field set plus the names of the checks that failed. */
export interface ValidatedBill {
  fields: ParsedFields
  validationFlags: string[]
}

/**
 * Coerce a raw printed money string to INTEGER cents, or null when it carries no number.
 *
 * Returning null (never 0) for unreadable input is load-bearing: a total that reads "N/A"
 * must surface as a flagged, empty amount, never as a confident $0.00 bill posted to
 * QuickBooks.
 *
 * Sign handling is equally load-bearing and is read from the RAW string (see the block comment
 * inside): a credit memo whose sign is dropped becomes a charge of the same size, and because a
 * consistently flipped bill still satisfies subtotal + tax = total, no downstream check catches it.
 *
 * Separator handling, in order:
 *   - Both '.' and ',' present -> the RIGHTMOST one is the decimal point. This reads both
 *     '1,234.10' and the European '1.234,56' correctly.
 *   - A lone separator that repeats -> grouping ('1,234,567', '1.234.567').
 *   - A lone COMMA followed by exactly three digits -> grouping ('1,234' -> $1,234.00).
 *   - Any other lone separator -> the decimal point ('12,00' -> $12.00, '5.00' -> $5.00).
 *
 * The one deliberately US-biased case is a lone dot followed by three digits: '1.234' reads
 * as $1.23 (three decimal places, truncated), not as the European $1,234.00. This app targets
 * a US service business on QuickBooks Online US, and any genuinely European amount prints its
 * decimal comma too, which the both-separators rule above already handles.
 */
export function toCents(raw: string | null): number | null {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (trimmed === '') return null

  // A credit or refund prints its sign in one of five conventions, and the currency symbol or ISO
  // code frequently sits BETWEEN the sign and the digits. So the sign is read from the raw string
  // here, before the symbol strip below; reading it after (or reading only the first character)
  // loses every form except a bare leading minus and silently turns a credit into a charge:
  //
  //   -45.00   $-45.00   USD -45.00   45.00-   (45.00)   ($45.00)   $1,234.10 CR
  //
  // 'CR' is the accounting credit marker. A 'DR' (debit) suffix is a positive amount and is
  // deliberately NOT matched, and 'CR' inside a longer word ('CREDIT MEMO') is not the marker.
  const parenthesised = /^\(.*\)$/.test(trimmed)
  const trailingMinus = /-\s*$/.test(trimmed)
  const creditSuffix = /\bcr\b\.?\s*$/i.test(trimmed)
  // A minus anywhere ahead of the digits: covers both '-45.00' and '$-45.00' / 'USD -45.00'.
  const minusBeforeDigits = /-[^0-9]*[0-9]/.test(trimmed)
  const negative = parenthesised || trailingMinus || creditSuffix || minusBeforeDigits

  // Drop currency symbols, ISO codes, spaces and stray punctuation; keep only the number. A
  // trailing separator is sentence punctuation, never a decimal point with nothing after it
  // ('45.00 CR.' -> '45.00'), and leaving it in would read the REAL decimal point as grouping
  // and inflate the amount 100x.
  const numeric = trimmed.replace(/[^0-9.,]/g, '').replace(/[.,]+$/, '')
  if (!/[0-9]/.test(numeric)) return null

  const lastDot = numeric.lastIndexOf('.')
  const lastComma = numeric.lastIndexOf(',')
  let decimalAt = -1
  if (lastDot >= 0 && lastComma >= 0) {
    decimalAt = Math.max(lastDot, lastComma)
  } else if (lastDot >= 0 || lastComma >= 0) {
    const only = Math.max(lastDot, lastComma)
    const separator = numeric[only]
    const repeats = numeric.split(separator).length - 1 > 1
    const groupedComma = separator === ',' && numeric.length - only - 1 === 3
    decimalAt = repeats || groupedComma ? -1 : only
  }

  const wholeDigits = (decimalAt >= 0 ? numeric.slice(0, decimalAt) : numeric).replace(/[^0-9]/g, '')
  const fractionDigits = (decimalAt >= 0 ? numeric.slice(decimalAt + 1) : '').replace(/[^0-9]/g, '')

  // Digit-string math, read once. Never `dollars * 100`: that is the float trap this whole
  // module exists to avoid. Extra printed precision is truncated, never rounded up, so the
  // stored amount can never exceed what the document actually shows.
  const centsDigits = `${wholeDigits === '' ? '0' : wholeDigits}${`${fractionDigits}00`.slice(0, 2)}`
  const cents = Number(centsDigits)
  if (!Number.isSafeInteger(cents)) return null
  return negative ? -cents : cents
}

/**
 * Normalize a printed or ISO date to ISO 'YYYY-MM-DD'.
 *
 * Returns `flagged: true` only when a NON-EMPTY value could not be read — an absent date is
 * absent, not an error (D-09). Never throws, and never falls back to `new Date(string)`,
 * whose parsing of non-ISO input is implementation-defined and timezone-shifted.
 *
 * Numeric dates are read month-first (US convention) unless the first component is greater
 * than 12, in which case it can only be a day.
 */
export function normalizeDate(raw: string | null): { iso: string | null; flagged: boolean } {
  if (typeof raw !== 'string') return { iso: null, flagged: false }
  const trimmed = raw.trim()
  if (trimmed === '') return { iso: null, flagged: false }
  const iso = parseDate(trimmed)
  return iso === null ? { iso: null, flagged: true } : { iso, flagged: false }
}

/**
 * The subtotal + tax = total cross-check.
 *
 * Returns null for NOT APPLICABLE — the caller must not flag that case (D-10). A null operand
 * means the document simply had no separate subtotal or tax line, which is the norm on
 * tax-included receipts. A null total means the total itself was unreadable and is already
 * flagged on its own; running the check anyway would emit a second, misleading flag.
 */
export function arithmeticOk(
  sub: number | null,
  tax: number | null,
  total: number | null
): boolean | null {
  if (sub === null || tax === null || total === null) return null
  return Math.abs(sub + tax - total) <= ROUNDING_TOLERANCE
}

/**
 * Run the whole gate over one BillSchema-shaped model output.
 *
 * The shape gate (BillSchema) runs upstream in extract-fields.ts; this is the COERCION and
 * CROSS-CHECK gate. It is written to be un-throwable anyway — a missing payload degrades to a
 * fully flagged empty bill rather than a crash, the same guard class as the `parse(raw ?? {})`
 * finding in 03-02.
 */
export function validateBill(bill: Bill): ValidatedBill {
  const raw = (bill ?? {}) as Partial<Record<keyof Bill, unknown>>
  const validationFlags: string[] = []

  const vendor = (asString(raw.vendor) ?? '').trim()
  if (vendor === '') validationFlags.push('missing:vendor')

  const invoiceDate = normalizeDate(asString(raw.invoice_date))
  if (invoiceDate.flagged) validationFlags.push('date:invoiceDate')
  const dueDate = normalizeDate(asString(raw.due_date))
  if (dueDate.flagged) validationFlags.push('date:dueDate')

  const subtotalRaw = asString(raw.subtotal)
  const taxRaw = asString(raw.tax)
  const subtotalCents = toCents(subtotalRaw)
  const taxCents = toCents(taxRaw)
  if (isPresent(subtotalRaw) && subtotalCents === null) validationFlags.push('money:subtotalCents')
  if (isPresent(taxRaw) && taxCents === null) validationFlags.push('money:taxCents')

  // The total is the one required amount (D-09), so ANY unreadable value is a failure, not an
  // absence. ParsedFields types it non-null, so an unreadable total records 0 — but only ever
  // alongside its flag, which is what makes the fallback visible instead of silent (D-12).
  const totalCents = toCents(asString(raw.total))
  if (totalCents === null) validationFlags.push('money:totalCents')

  if (arithmeticOk(subtotalCents, taxCents, totalCents) === false) {
    validationFlags.push(ARITHMETIC_FLAG)
  }

  const fields: ParsedFields = {
    vendor,
    invoiceNumber: blankToNull(asString(raw.invoice_number)),
    invoiceDate: invoiceDate.iso,
    dueDate: dueDate.iso,
    subtotalCents,
    taxCents,
    totalCents: totalCents ?? 0,
    currency: blankToNull(asString(raw.currency)),
    suggestedCategory: blankToNull(asString(raw.suggested_category))
  }

  return { fields, validationFlags }
}

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

/** Anything that is not a string is treated as absent, so junk input cannot crash the gate. */
function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

/** Present = the model actually returned something to read (as opposed to a nullable absence). */
function isPresent(value: string | null): boolean {
  return value !== null && value.trim() !== ''
}

/** An optional string that came back empty is an absence, not an empty review cell. */
function blankToNull(value: string | null): string | null {
  const trimmed = value === null ? '' : value.trim()
  return trimmed === '' ? null : trimmed
}

const ISO_DATE = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$/
const NUMERIC_DATE = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/
const MONTH_FIRST_DATE = /^([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/
const DAY_FIRST_DATE = /^(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})$/

function parseDate(value: string): string | null {
  const iso = ISO_DATE.exec(value)
  if (iso) return toIsoDate(Number(iso[1]), Number(iso[2]), Number(iso[3]))

  const numeric = NUMERIC_DATE.exec(value)
  if (numeric) {
    const first = Number(numeric[1])
    const second = Number(numeric[2])
    // Month-first (US) unless the first component cannot possibly be a month.
    const month = first > 12 ? second : first
    const day = first > 12 ? first : second
    return toIsoDate(expandYear(numeric[3]), month, day)
  }

  const monthFirst = MONTH_FIRST_DATE.exec(value)
  if (monthFirst) {
    const month = monthNumber(monthFirst[1])
    return month === null ? null : toIsoDate(Number(monthFirst[3]), month, Number(monthFirst[2]))
  }

  const dayFirst = DAY_FIRST_DATE.exec(value)
  if (dayFirst) {
    const month = monthNumber(dayFirst[2])
    return month === null ? null : toIsoDate(Number(dayFirst[3]), month, Number(dayFirst[1]))
  }

  return null
}

/** A two-digit year on a receipt: 00-69 is this century, 70-99 the previous one. */
function expandYear(value: string): number {
  if (value.length === 4) return Number(value)
  const yy = Number(value)
  return yy <= 69 ? 2000 + yy : 1900 + yy
}

function monthNumber(name: string): number | null {
  const lower = name.toLowerCase()
  const index = MONTH_NAMES.findIndex((m) => m === lower || m.slice(0, 3) === lower)
  return index < 0 ? null : index + 1
}

/**
 * Build the ISO string only if the date actually exists on the calendar. UTC construction
 * keeps the round-trip check independent of the machine's timezone; '2026-02-30' rolls over
 * to March 2 and is therefore rejected rather than silently corrected.
 */
function toIsoDate(year: number, month: number, day: number): string | null {
  if (!Number.isInteger(year) || year < 1000 || year > 9999) return null
  if (!Number.isInteger(month) || month < 1 || month > 12) return null
  if (!Number.isInteger(day) || day < 1 || day > 31) return null
  const utc = new Date(Date.UTC(year, month - 1, day))
  if (
    utc.getUTCFullYear() !== year ||
    utc.getUTCMonth() !== month - 1 ||
    utc.getUTCDate() !== day
  ) {
    return null
  }
  return `${year}-${pad2(month)}-${pad2(day)}`
}

function pad2(value: number): string {
  return value.toString().padStart(2, '0')
}
