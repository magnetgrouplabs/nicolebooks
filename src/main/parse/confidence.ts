// src/main/parse/confidence.ts
//
// The deterministic-weighted per-field confidence scorer (PARSE-04, decisions D-11, D-12,
// D-22). Companion to validate.ts: that module decides what FAILED, this one decides what
// each field is WORTH.
//
// The rule that makes this module load-bearing (D-11): the model's self-reported confidence
// is ADVISORY ONLY and is never the gate. Verbalized LLM confidence is poorly calibrated and
// systematically overconfident, so scoring on it would green-light exactly the hallucinated
// or prompt-injected total the pipeline exists to catch (threat T-03-04). What decides the
// flag is deterministic evidence: grounding (does the value appear verbatim in the document's
// own text?), format/parse success, and the arithmetic cross-check.
//
// Precedence ladder, highest first:
//   1. A failed deterministic check      -> 'flagged'  (regardless of any self-report)
//   2. A second-pass disagreement (D-22) -> 'low'      (uncertain, not provably wrong)
//   3. Value appears verbatim in source  -> 'high'
//   4. The advisory model self-report    -> as reported
//   5. Nothing to go on                  -> 'low'
//
// Consequence worth stating: on an image-only document there is no embedded text, so nothing
// grounds and every non-flagged field lands at 'low'. That is the honest answer — grounding is
// unavailable — and it is exactly why D-22 adds the second cross-call on that route.
//
// Nothing here rejects or corrects a value (flag-and-keep, D-12). A pure, dependency-free
// module in the src/main/ingestion/hash.ts convention; unit-tested in test/parse-confidence.test.ts.

import type { FieldConfidence, ParsedFields } from '../../shared/ipc-contract'
import { ARITHMETIC_FLAG, MONTH_NAMES } from './validate'

/**
 * Prefix for the D-22 second-pass disagreement flags. Distinct from validate.ts's check
 * prefixes because it carries a weaker verdict: two passes disagreeing means "uncertain",
 * while a failed arithmetic or date check means "provably inconsistent".
 */
export const AGREEMENT_PREFIX = 'agreement:'

/**
 * The model's own per-field confidence, keyed by ParsedFields field name. Optional and
 * advisory: it is consulted only for a field with no source anchor at all — in practice the
 * suggested category, which is a QuickBooks-classification guess with nothing in the document
 * to match against (D-11).
 */
export type ModelSelfReport = Record<string, 'high' | 'low'>

/** Every field the scorer grades, in ParsedFields declaration order. */
const PARSED_FIELD_KEYS = [
  'vendor',
  'invoiceNumber',
  'invoiceDate',
  'dueDate',
  'subtotalCents',
  'taxCents',
  'totalCents',
  'currency',
  'suggestedCategory'
] as const satisfies readonly (keyof ParsedFields)[]

const PARSED_FIELD_KEY_SET: ReadonlySet<string> = new Set<string>(PARSED_FIELD_KEYS)

/** The three fields the single arithmetic flag condemns together — any one could be wrong. */
const MONEY_FIELDS = ['subtotalCents', 'taxCents', 'totalCents'] as const

/** The five key fields D-22 compares across the two image-only passes. */
const AGREEMENT_FIELDS = [
  'totalCents',
  'subtotalCents',
  'taxCents',
  'invoiceDate',
  'invoiceNumber'
] as const

type AgreementField = (typeof AGREEMENT_FIELDS)[number]

/**
 * Score every field of one validated bill.
 *
 * @param fields           the coerced field set from validateBill
 * @param sourceText       the document's embedded text on the native-PDF route (D-06); empty
 *                         or null on the image-only route, where no grounding is possible
 * @param validationFlags  the flags from validateBill, plus any agreementFlags the pipeline merged in
 * @param modelSelfReport  advisory only, never the gate (D-11)
 *
 * Fields with nothing to grade (a legitimately absent nullable value) are omitted from the
 * result rather than graded 'low', so Phase 6 does not badge an empty cell. A flagged field is
 * always present, even when its value is null, because the flag itself is the thing to show.
 */
export function computeConfidence(
  fields: ParsedFields,
  sourceText: string | null,
  validationFlags: readonly string[],
  modelSelfReport?: ModelSelfReport
): FieldConfidence {
  const values = (fields ?? {}) as Partial<ParsedFields>
  const haystack = normalizeText(typeof sourceText === 'string' ? sourceText : '')
  const selfReport = modelSelfReport ?? {}

  const failed = new Set<string>()
  const disagreed = new Set<string>()
  for (const flag of validationFlags ?? []) {
    if (typeof flag !== 'string') continue
    if (flag === ARITHMETIC_FLAG) {
      for (const key of MONEY_FIELDS) failed.add(key)
      continue
    }
    const separator = flag.indexOf(':')
    if (separator < 0) continue
    const field = flag.slice(separator + 1)
    if (!PARSED_FIELD_KEY_SET.has(field)) continue // an unmapped flag is ignored, never fatal
    if (flag.slice(0, separator + 1) === AGREEMENT_PREFIX) disagreed.add(field)
    else failed.add(field)
  }

  const confidence: FieldConfidence = {}
  for (const key of PARSED_FIELD_KEYS) {
    if (failed.has(key)) {
      confidence[key] = 'flagged' // rung 1: outranks grounding AND the model's own opinion
      continue
    }
    const value = values[key]
    if (value === null || value === undefined) continue // nothing extracted, nothing to grade
    if (disagreed.has(key)) {
      confidence[key] = 'low' // rung 2
      continue
    }
    confidence[key] = isGrounded(key, value, haystack)
      ? 'high' // rung 3
      : (selfReport[key] ?? 'low') // rungs 4 and 5
  }
  return confidence
}

/**
 * The D-22 second-pass cross-call agreement check, scoped to image-only documents.
 *
 * Native PDFs pass no `second` result — their verbatim-text grounding already covers them —
 * and must therefore compute nothing. Both passes run at temperature 0, so a disagreement on
 * a key field is real evidence of an unstable read, not sampling noise.
 *
 * Comparison happens on the VALIDATED values (integer cents, ISO dates), not the raw printed
 * strings, so a formatting difference between the two calls ('$108.00' vs '108.00') can never
 * masquerade as a disagreement.
 */
export function agreementFlags(primary: ParsedFields, second?: ParsedFields | null): string[] {
  if (second === null || second === undefined) return []
  const a = (primary ?? {}) as Partial<ParsedFields>
  const b = second as Partial<ParsedFields>
  const flags: string[] = []
  for (const key of AGREEMENT_FIELDS) {
    if (!sameValue(a[key] ?? null, b[key] ?? null)) flags.push(`${AGREEMENT_PREFIX}${key}`)
  }
  return flags
}

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

type AgreementValue = ParsedFields[AgreementField] | null

/** One pass finding a value where the other found none IS a disagreement worth flagging. */
function sameValue(a: AgreementValue, b: AgreementValue): boolean {
  if (a === null || b === null) return a === b
  if (typeof a === 'number' || typeof b === 'number') return a === b
  return normalizeText(a) === normalizeText(b) // OCR case/spacing noise is not a disagreement
}

/** Lowercase and collapse runs of whitespace, so layout differences never break a match. */
function normalizeText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').trim()
}

function isGrounded(key: keyof ParsedFields, value: string | number, haystack: string): boolean {
  if (haystack === '') return false
  switch (key) {
    case 'suggestedCategory':
      // Never grounded. The category is a classification GUESS about how Nicole books this
      // vendor, not a transcription of anything printed, so a coincidental substring hit
      // ("Fuel" inside "Fuel Surcharge") must not certify it. This is precisely the field the
      // advisory self-report exists for (D-11).
      return false
    case 'subtotalCents':
    case 'taxCents':
    case 'totalCents':
      return typeof value === 'number' && groundsMoney(haystack, value)
    case 'invoiceDate':
    case 'dueDate':
      return typeof value === 'string' && dateVariants(value).some((v) => containsToken(haystack, v))
    case 'vendor':
      // A multi-word business name is distinctive enough that a plain containment check is safe.
      return typeof value === 'string' && haystack.includes(normalizeText(value))
    default:
      return typeof value === 'string' && containsToken(haystack, normalizeText(value))
  }
}

/**
 * Substring match with numeric boundaries on both sides.
 *
 * Without this, a tax of $8.00 would "ground" itself inside the total '$108.00' and earn a
 * confident 'high' for a line that never appeared on the document — hiding the single most
 * common number-OCR error this scorer is meant to catch.
 */
function containsToken(haystack: string, needle: string): boolean {
  if (needle === '') return false
  let from = 0
  for (;;) {
    const at = haystack.indexOf(needle, from)
    if (at < 0) return false
    const before = at === 0 ? '' : haystack[at - 1]
    const after = haystack[at + needle.length] ?? ''
    if (!/[0-9.,]/.test(before) && !/[0-9]/.test(after)) return true
    from = at + 1
  }
}

/**
 * Ground an integer-cents amount against the document text, SIGN INCLUDED.
 *
 * The digits matching is not enough. A document printing '-450.00' must not certify a positive
 * 45000, and a document printing '450.00' must not certify a negative one — that is exactly the
 * "wrong number the pipeline then certifies" failure: a sign error survives the arithmetic
 * cross-check (a consistently flipped bill still balances) and grounding is the only layer left
 * that can see it.
 */
function groundsMoney(haystack: string, cents: number): boolean {
  const wantNegative = cents < 0
  for (const variant of moneyVariants(cents)) {
    if (variant === '') continue
    let from = 0
    for (;;) {
      const at = haystack.indexOf(variant, from)
      if (at < 0) break
      const end = at + variant.length
      const before = at === 0 ? '' : haystack[at - 1]
      const after = haystack[end] ?? ''
      // The same numeric-boundary rule containsToken applies, so 8.00 still cannot ground
      // itself inside 108.00.
      if (!/[0-9.,]/.test(before) && !/[0-9]/.test(after)) {
        if (printedNegative(haystack, at, end) === wantNegative) return true
      }
      from = at + 1
    }
  }
  return false
}

/**
 * Does the document print THIS occurrence as a credit? Reads the four conventions toCents
 * accepts: a leading minus (with an optional currency symbol between), accounting parentheses,
 * a trailing minus, and a trailing CR marker.
 */
function printedNegative(haystack: string, at: number, end: number): boolean {
  const lead = haystack.slice(Math.max(0, at - 8), at)
  if (/[-(][^0-9a-z]{0,4}$/i.test(lead)) return true
  const trail = haystack.slice(end, end + 6)
  return /^\s*(-|\)|cr\b)/i.test(trail)
}

/** How integer cents could have been printed, in both separator conventions. */
function moneyVariants(cents: number): string[] {
  const digits = Math.abs(cents).toString().padStart(3, '0') // string math, never cents / 100
  const whole = digits.slice(0, -2)
  const fraction = digits.slice(-2)
  const commaGrouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  const dotGrouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, '.')
  return [
    `${whole}.${fraction}`,
    `${commaGrouped}.${fraction}`,
    `${whole},${fraction}`,
    `${dotGrouped},${fraction}`
  ]
}

/**
 * How an ISO date could have been printed. The gate normalizes to '2026-07-24' but the
 * document says '07/24/2026', so grounding a date means grounding its printed form.
 */
function dateVariants(iso: string): string[] {
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)
  if (!parts) return [normalizeText(iso)]
  const [, year, month, day] = parts
  const shortYear = year.slice(2)
  const bareMonth = String(Number(month))
  const bareDay = String(Number(day))
  const longName = MONTH_NAMES[Number(month) - 1]
  const shortName = longName.slice(0, 3)
  return [
    iso,
    `${month}/${day}/${year}`,
    `${bareMonth}/${bareDay}/${year}`,
    `${month}-${day}-${year}`,
    `${month}.${day}.${year}`,
    `${month}/${day}/${shortYear}`,
    `${longName} ${bareDay}, ${year}`,
    `${longName} ${bareDay} ${year}`,
    `${shortName} ${bareDay}, ${year}`,
    `${shortName} ${bareDay} ${year}`,
    `${bareDay} ${shortName} ${year}`,
    `${bareDay} ${longName} ${year}`
  ]
}
