// src/renderer/src/review/parsed-fields.tsx
//
// WHAT THE DOCUMENT SAID: the labeled label/value list of parsed fields, plus the flag attribution
// behind it.
//
// Extracted from BillsScreen (quick task 260727-iv0 built it there) because Phase 6 needs it in two
// places at once. The scan row shows it alone; the review row shows it ABOVE the editable controls,
// so correcting a field never hides what was read off the page. That side-by-side is the whole
// trust argument of the review screen: the user can see the document's claim and their correction
// at the same time, and decide which is right.
//
// BillsScreen re-exports flaggedFields and isFlagged, so the two specs that import them from there
// keep working; this file is where they actually live now.

import { cn } from '@/lib/utils'
import { formatCents } from '@/lib/money'
import type { ParseFileResult, ParsedFields } from '@shared/ipc-contract'

/** Every field the row can display, in ParsedFields declaration order. */
export const FIELD_ORDER = [
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

export type ParsedFieldKey = (typeof FIELD_ORDER)[number]

export const FIELD_LABEL: Record<ParsedFieldKey, string> = {
  vendor: 'Vendor',
  invoiceNumber: 'Invoice number',
  invoiceDate: 'Invoice date',
  dueDate: 'Due date',
  subtotalCents: 'Subtotal',
  taxCents: 'Tax',
  totalCents: 'Total',
  currency: 'Currency',
  suggestedCategory: 'Suggested category'
}

/** Membership test for "is this string the name of a field this build knows how to display?" */
const KNOWN_FIELDS: ReadonlySet<string> = new Set<string>(FIELD_ORDER)

/**
 * The three fields an unattributable flag condemns together, mirroring the same constant in
 * src/main/parse/confidence.ts. Any one of the three could be the wrong number.
 */
const MONEY_FIELDS = ['subtotalCents', 'taxCents', 'totalCents'] as const

/**
 * The text to print for one parsed field, or null when the field should be omitted entirely.
 *
 * Omit a null field, EXCEPT when it carries a flag, mirroring what computeConfidence already
 * decided main-side: it drops ungradeable nulls "so Phase 6 does not badge an empty cell" but
 * deliberately keeps a FLAGGED field "even when its value is null, because the flag itself is the
 * thing to show". A cash receipt with no tax line legitimately has taxCents: null and printing
 * "Tax: not found" on every such row is blank noise; but money:taxCents fires only when the
 * document HAD a tax value and it was unreadable, and hiding that row would hide a failed check.
 *
 * vendor and totalCents are the two required fields and are always printed. A total that is not a
 * number (only reachable through a degraded cache blob) prints Not found rather than $0.00,
 * because a confident zero-dollar bill is the precise failure D-12 and WR-10 exist to prevent.
 */
export function fieldValue(
  fields: ParsedFields,
  field: ParsedFieldKey,
  flagged: boolean
): string | null {
  const value = fields[field]
  if (field === 'vendor') {
    const vendor = typeof value === 'string' ? value.trim() : ''
    return vendor === '' ? 'Not found' : vendor
  }
  if (field === 'totalCents') {
    return typeof value === 'number' ? formatCents(value) : 'Not found'
  }
  if (value === null || value === undefined) return flagged ? 'Not found' : null
  if (field === 'subtotalCents' || field === 'taxCents') {
    return typeof value === 'number' ? formatCents(value) : 'Not found'
  }
  // invoiceDate / dueDate print the stored ISO string verbatim: reformatting a date is a display
  // decision and this task is structure only.
  return String(value)
}

/**
 * Did the deterministic gate flag anything about this row?
 *
 * This is what makes D-12's "flag-and-keep" actually kept AND flagged. validate.ts is explicit
 * that an unreadable total is recorded as 0 "but only ever alongside its flag, which is what
 * makes the fallback visible instead of silent" — so a row that renders the VALUE without the
 * flag turns the case that module is proudest of catching (a total reading "N/A" must never
 * become a confident $0.00) into a normal, successfully parsed $0.00 bill on screen.
 */
export function isFlagged(parse?: ParseFileResult): boolean {
  if (!parse) return false
  if ((parse.validationFlags?.length ?? 0) > 0) return true
  return Object.values(parse.confidence ?? {}).some((level) => level === 'flagged')
}

/**
 * WHICH displayed fields carry a failed deterministic check. The per-field half of isFlagged.
 *
 * Three sources, unioned, plus one backstop:
 *   1. a `confidence` entry of 'flagged' under a known field name  -> that field
 *   2. a `validationFlags` entry shaped `prefix:field` whose suffix is a known field name
 *      -> that field (this includes the D-22 `agreement:` flags, which the renderer keeps
 *      treating as flagged even though the main process grades them 'low')
 *   3. ANYTHING ELSE                                               -> UNATTRIBUTED
 *   4. if anything was UNATTRIBUTED, every one of MONEY_FIELDS is flagged
 *
 * Rule 4 is the load-bearing line. ARITHMETIC_FLAG is literally the string
 * 'arithmetic:subtotal+tax!=total', and the part after its colon is NOT a ParsedFields key --
 * confidence.ts special-cases that flag and condemns all three money fields together. A naive
 * `split(':')` mapping here would therefore drop the arithmetic cross-check silently, which is
 * precisely the WR-10 failure ("a displayed money value must never appear without its flag")
 * wearing a per-field costume. Rule 4 handles it correctly by construction, without importing
 * anything from src/main across the process boundary, and it makes every future flag string this
 * build does not recognize degrade toward showing MORE review markers rather than fewer.
 *
 * The consequence worth stating: totalCents is ALWAYS displayed, so rule 4 guarantees that a
 * non-empty flag set always produces at least one visible marker. That, plus the property
 * `isFlagged(parse) === (flaggedFields(parse).size > 0)` pinned in test/bills-row-status.test.ts,
 * is what keeps WR-10 true for every input shape rather than only the ones anticipated here.
 */
export function flaggedFields(parse?: ParseFileResult): Set<string> {
  const flagged = new Set<string>()
  if (!parse) return flagged
  let unattributed = false

  for (const [key, level] of Object.entries(parse.confidence ?? {})) {
    if (level !== 'flagged') continue
    if (KNOWN_FIELDS.has(key)) flagged.add(key)
    else unattributed = true
  }

  for (const flag of parse.validationFlags ?? []) {
    // A cached row's flag list is rehydrated from JSON, so a degraded blob could hand back a
    // non-string. Count it rather than skip it: dropping it is the one outcome WR-10 forbids.
    if (typeof flag !== 'string') {
      unattributed = true
      continue
    }
    const separator = flag.indexOf(':')
    const field = separator < 0 ? '' : flag.slice(separator + 1)
    if (separator >= 0 && KNOWN_FIELDS.has(field)) flagged.add(field)
    else unattributed = true
  }

  if (unattributed) for (const key of MONEY_FIELDS) flagged.add(key)
  return flagged
}

/**
 * Fields whose value is a figure rather than a phrase: money, dates, and the invoice id.
 *
 * They render in the mono face with lining figures so a column of them lines up and a mistyped
 * digit is visible at a glance. Everything else (a vendor, a category, a currency code) is prose
 * and stays in the text face, because setting a company name in monospace is affectation.
 */
const FIGURE_FIELDS: ReadonlySet<string> = new Set<string>([
  'invoiceNumber',
  'invoiceDate',
  'dueDate',
  'subtotalCents',
  'taxCents',
  'totalCents'
])

/**
 * The parsed fields as a definition list.
 *
 * A definition list is the right semantics for label/value pairs, and it is what turns an
 * unreadable "Nassau Plumbing Supply $1,336.00" into data the user can actually check field by
 * field. `flags` is computed ONCE by the caller for the whole row, not per field: a displayed
 * amount always travels with its flag, because displaying the value alone is worse than displaying
 * neither (it reads as a clean, confident parse).
 *
 * DESIGN WAVE, and this is the change that does the most for how the screen reads. The pairs were
 * laid out inline in a wrapping row, which produced a single run-on line: "Vendor Apex Plumbing
 * Supply Invoice number APX-84213 Invoice date 2026-07-23 Subtotal -$135.80 Tax -$11.71". Nine
 * labels and nine values at the same size, in the same weight, with only a colourless 4px gap
 * telling you which was which. Nobody checks a bill that way.
 *
 * It is now a grid of stacked pairs: the label above its value, set as a small tracked cap so it
 * reads as a header rather than as more text, and the value below it in the face its content
 * deserves. Total gets the emphasis, because Total is the number the user is actually here to
 * agree with.
 *
 * The dt/dd pair stays adjacent with a plain text child, which is what three specs match on.
 */
export function ParsedFieldList({
  fields,
  flags
}: {
  fields: ParsedFields
  flags: ReadonlySet<string>
}): React.JSX.Element {
  return (
    <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3 lg:grid-cols-5">
      {FIELD_ORDER.map((field) => {
        const flagged = flags.has(field)
        const value = fieldValue(fields, field, flagged)
        if (value === null) return null
        return (
          <div key={field} className="flex min-w-0 flex-col gap-1">
            <dt className="font-sans text-[0.6875rem] font-semibold tracking-[0.06em] text-muted-foreground uppercase">
              {FIELD_LABEL[field]}
            </dt>
            <dd
              className={cn(
                'font-sans text-sm leading-tight break-words',
                FIGURE_FIELDS.has(field) && 'font-mono',
                field === 'totalCents' && 'text-[0.9375rem] font-semibold',
                flagged ? 'text-destructive' : 'text-card-foreground'
              )}
            >
              {flagged ? `${value} (needs review)` : value}
            </dd>
          </div>
        )
      })}
    </dl>
  )
}
