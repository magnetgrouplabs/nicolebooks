// test/parse-validate.test.ts
//
// Wave-0 (RED) unit spec for the deterministic validation gate (plan 03-03, PARSE-04,
// decisions D-10 / D-12). Until src/main/parse/validate.ts exists this file fails to
// import — the correct Wave-0 state.
//
// Why this module is the authority: everything it consumes is UNTRUSTED model output
// (threat T-03-04 / T-03-04b). The vision model is never asked to do arithmetic or unit
// conversion — it returns the raw printed strings and this gate re-derives integer cents,
// re-parses dates, and cross-checks subtotal + tax = total locally. A hallucinated or
// prompt-injected total therefore gets flagged no matter how confident the model sounds.
//
// Coverage:
//   1. toCents — string -> INTEGER cents via digit-string math, never float dollars
//      (RESEARCH Pitfall 4: 19.99 * 100 === 1998.9999999999998). Grouping separators,
//      currency symbols, comma-decimal and dot-decimal locales, and garbage -> null.
//   2. normalizeDate — printed and ISO forms -> ISO 'YYYY-MM-DD'; an unparseable value
//      returns null AND reports flagged, never throws; an absent (null) date is NOT an
//      error, because every optional field is genuinely nullable by design (D-09).
//   3. validateBill — the whole gate: coercion into ParsedFields plus the arithmetic
//      cross-check, which runs ONLY when both operands are present (D-10: tax-included
//      receipts and receipts with no separate tax line are normal, not errors) and
//      tolerates a couple of cents of per-line tax rounding (D-12).
//
// Flag-and-keep (D-12) is asserted throughout: nothing here rejects a bill, nothing
// silently auto-corrects, and every emitted flag is a STRING (RESEARCH Pitfall 8 — the
// STRICT parsed_results table has no BOOLEAN type).

import { describe, expect, it } from 'vitest'
import {
  ARITHMETIC_FLAG,
  ROUNDING_TOLERANCE,
  normalizeDate,
  toCents,
  validateBill
} from '../src/main/parse/validate'
import type { Bill } from '../src/shared/schemas'

/** A BillSchema-shaped model output with only the two non-null-required fields set (D-09). */
function bill(overrides: Partial<Bill> = {}): Bill {
  return {
    vendor: 'Acme Supply Co',
    invoice_number: null,
    invoice_date: null,
    due_date: null,
    subtotal: null,
    tax: null,
    total: '0.00',
    currency: null,
    suggested_category: null,
    ...overrides
  }
}

describe('toCents', () => {
  it('coerces the plan-pinned reference strings', () => {
    expect(toCents('1,234.10')).toBe(123410)
    expect(toCents('5.00')).toBe(500)
    expect(toCents('$12')).toBe(1200)
    expect(toCents('12,00')).toBe(1200) // comma used as the decimal separator
    expect(toCents(null)).toBeNull()
  })

  it('always returns an integer, never a float', () => {
    // The float trap this module exists to avoid: 19.99 * 100 === 1998.9999999999998
    // and 0.07 * 100 === 7.000000000000001. Digit-string math has no such error.
    expect(toCents('19.99')).toBe(1999)
    expect(toCents('0.07')).toBe(7)
    for (const raw of ['1,234.10', '5.00', '$12', '19.99', '0.07', '-5.50']) {
      expect(Number.isInteger(toCents(raw))).toBe(true)
    }
  })

  it('strips currency symbols, spaces and thousands separators', () => {
    expect(toCents('$1,234,567.89')).toBe(123456789)
    expect(toCents('USD 42.50')).toBe(4250)
    expect(toCents('  108.00  ')).toBe(10800)
  })

  it('reads a comma-decimal (European) amount without inflating it 1000x', () => {
    expect(toCents('1.234,56')).toBe(123456)
  })

  it('treats a lone comma followed by exactly three digits as grouping', () => {
    expect(toCents('1,234')).toBe(123400)
  })

  it('treats a repeated separator as grouping in either convention', () => {
    expect(toCents('1,234,567')).toBe(123456700)
    expect(toCents('1.234.567')).toBe(123456700)
  })

  it('reads a lone dot as the decimal point, US-first', () => {
    // The one deliberately US-biased case, pinned here so it cannot drift silently:
    // '1.234' is $1.23 (three decimals, truncated), NOT the European $1,234.00. A genuinely
    // European amount prints its decimal comma too ('1.234,56'), which the both-separators
    // rule reads correctly. See the locale note on toCents in src/main/parse/validate.ts.
    expect(toCents('1.234')).toBe(123)
    expect(toCents('12.5')).toBe(1250)
  })

  it('keeps the sign on a credit/refund amount', () => {
    expect(toCents('-5.50')).toBe(-550)
    expect(toCents('($5.50)')).toBe(-550)
  })

  it('returns null for garbage instead of throwing or silently returning 0', () => {
    // A bill whose total reads "N/A" must be FLAGGED, never recorded as $0.00.
    for (const raw of ['', '   ', 'N/A', 'see attached', '--', '$', '.']) {
      expect(toCents(raw)).toBeNull()
    }
  })

  it('truncates beyond two decimal places rather than inventing precision', () => {
    expect(toCents('19.999')).toBe(1999)
  })
})

describe('normalizeDate', () => {
  it('normalizes a printed US date and an ISO date to the same ISO value', () => {
    expect(normalizeDate('07/24/2026')).toEqual({ iso: '2026-07-24', flagged: false })
    expect(normalizeDate('2026-07-24')).toEqual({ iso: '2026-07-24', flagged: false })
  })

  it('accepts the common printed variants seen on real bills', () => {
    expect(normalizeDate('7/4/2026').iso).toBe('2026-07-04')
    expect(normalizeDate('07-24-2026').iso).toBe('2026-07-24')
    expect(normalizeDate('07/24/26').iso).toBe('2026-07-24')
    expect(normalizeDate('July 24, 2026').iso).toBe('2026-07-24')
    expect(normalizeDate('Jul 24 2026').iso).toBe('2026-07-24')
    expect(normalizeDate('24 Jul 2026').iso).toBe('2026-07-24')
    expect(normalizeDate('2026-07-24T00:00:00Z').iso).toBe('2026-07-24')
  })

  it('reads a day-first date when the first component cannot be a month', () => {
    expect(normalizeDate('24/07/2026').iso).toBe('2026-07-24')
  })

  it('flags an unparseable date instead of throwing', () => {
    expect(() => normalizeDate('sometime last week')).not.toThrow()
    expect(normalizeDate('sometime last week')).toEqual({ iso: null, flagged: true })
    expect(normalizeDate('13/45/2026')).toEqual({ iso: null, flagged: true })
  })

  it('rejects a date that does not exist on the calendar', () => {
    expect(normalizeDate('2026-02-30')).toEqual({ iso: null, flagged: true })
  })

  it('treats an absent date as absent, not as an error', () => {
    // Every optional field is genuinely nullable (D-09); a null due date is normal.
    expect(normalizeDate(null)).toEqual({ iso: null, flagged: false })
  })
})

describe('validateBill — arithmetic cross-check (D-10/D-12)', () => {
  it('passes a bill whose subtotal + tax equals the total', () => {
    const { fields, validationFlags } = validateBill(
      bill({ subtotal: '100.00', tax: '8.00', total: '108.00' })
    )
    expect(fields.subtotalCents).toBe(10000)
    expect(fields.taxCents).toBe(800)
    expect(fields.totalCents).toBe(10800)
    expect(validationFlags).not.toContain(ARITHMETIC_FLAG)
    expect(validationFlags).toEqual([])
  })

  it('flags a total that is a full dollar off', () => {
    const { fields, validationFlags } = validateBill(
      bill({ subtotal: '100.00', tax: '8.00', total: '109.00' })
    )
    expect(validationFlags).toContain(ARITHMETIC_FLAG)
    // flag-and-keep: the model's value survives untouched (D-12, never auto-correct).
    expect(fields.totalCents).toBe(10900)
  })

  it('does NOT flag a one-cent rounding difference', () => {
    const { validationFlags } = validateBill(
      bill({ subtotal: '100.00', tax: '8.01', total: '108.00' })
    )
    expect(validationFlags).not.toContain(ARITHMETIC_FLAG)
  })

  it('holds the tolerance boundary exactly', () => {
    expect(ROUNDING_TOLERANCE).toBe(2)
    // Exactly at the tolerance: still fine.
    const atBoundary = validateBill(bill({ subtotal: '100.00', tax: '8.02', total: '108.00' }))
    expect(atBoundary.validationFlags).not.toContain(ARITHMETIC_FLAG)
    // One cent beyond it: flagged.
    const beyond = validateBill(bill({ subtotal: '100.00', tax: '8.03', total: '108.00' }))
    expect(beyond.validationFlags).toContain(ARITHMETIC_FLAG)
  })

  it('treats a null operand as not-applicable and emits no arithmetic flag (D-10)', () => {
    // A tax-included receipt with no separate subtotal/tax line is normal, not an error.
    const { fields, validationFlags } = validateBill(
      bill({ subtotal: null, tax: null, total: '108.00' })
    )
    expect(fields.subtotalCents).toBeNull()
    expect(fields.taxCents).toBeNull()
    expect(fields.totalCents).toBe(10800)
    expect(validationFlags).toEqual([])
  })

  it('treats a single null operand as not-applicable too', () => {
    expect(
      validateBill(bill({ subtotal: '100.00', tax: null, total: '999.00' })).validationFlags
    ).not.toContain(ARITHMETIC_FLAG)
    expect(
      validateBill(bill({ subtotal: null, tax: '8.00', total: '999.00' })).validationFlags
    ).not.toContain(ARITHMETIC_FLAG)
  })
})

describe('validateBill — coercion into ParsedFields', () => {
  it('maps the model-output snake_case shape onto the shared camelCase field set', () => {
    const { fields } = validateBill(
      bill({
        vendor: '  Acme Supply Co  ',
        invoice_number: 'INV-1042',
        invoice_date: '07/24/2026',
        due_date: '08/23/2026',
        subtotal: '100.00',
        tax: '8.00',
        total: '108.00',
        currency: 'USD',
        suggested_category: 'Job Materials'
      })
    )
    expect(fields).toEqual({
      vendor: 'Acme Supply Co',
      invoiceNumber: 'INV-1042',
      invoiceDate: '2026-07-24',
      dueDate: '2026-08-23',
      subtotalCents: 10000,
      taxCents: 800,
      totalCents: 10800,
      currency: 'USD',
      suggestedCategory: 'Job Materials'
    })
  })

  it('flags an unparseable date, keeps the rest of the bill, and never throws', () => {
    const run = (): ReturnType<typeof validateBill> =>
      validateBill(bill({ invoice_date: 'sometime last week', total: '108.00' }))
    expect(run).not.toThrow()
    const { fields, validationFlags } = run()
    expect(fields.invoiceDate).toBeNull()
    expect(validationFlags).toContain('date:invoiceDate')
    expect(fields.totalCents).toBe(10800) // the rest of the bill survives (D-12)
  })

  it('flags an unparseable total and skips the arithmetic check it cannot run', () => {
    const { fields, validationFlags } = validateBill(
      bill({ subtotal: '100.00', tax: '8.00', total: 'N/A' })
    )
    expect(validationFlags).toContain('money:totalCents')
    expect(validationFlags).not.toContain(ARITHMETIC_FLAG) // no second, misleading flag
    expect(fields.totalCents).toBe(0) // typed non-null; visible only alongside its flag
  })

  it('flags an unparseable subtotal or tax', () => {
    const { fields, validationFlags } = validateBill(
      bill({ subtotal: 'see attached', tax: 'n/a', total: '108.00' })
    )
    expect(validationFlags).toContain('money:subtotalCents')
    expect(validationFlags).toContain('money:taxCents')
    expect(fields.subtotalCents).toBeNull()
    expect(fields.taxCents).toBeNull()
  })

  it('flags a missing vendor', () => {
    expect(validateBill(bill({ vendor: '   ' })).validationFlags).toContain('missing:vendor')
  })

  it('normalizes an empty optional string to null rather than an empty cell', () => {
    const { fields } = validateBill(bill({ invoice_number: '  ', currency: '' }))
    expect(fields.invoiceNumber).toBeNull()
    expect(fields.currency).toBeNull()
  })

  it('emits only string flags — the STRICT table has no BOOLEAN (Pitfall 8)', () => {
    const { validationFlags } = validateBill(
      bill({ subtotal: '100.00', tax: '8.00', total: '109.00', invoice_date: 'nope' })
    )
    expect(validationFlags.length).toBeGreaterThan(0)
    for (const flag of validationFlags) {
      expect(typeof flag).toBe('string')
    }
  })

  it('survives a missing payload instead of throwing on property access', () => {
    // Same class of bug as the 03-02 `Schema.parse(raw ?? {})` finding: a value that can
    // arrive undefined must be guarded, not assumed.
    const run = (): ReturnType<typeof validateBill> =>
      validateBill(undefined as unknown as Bill)
    expect(run).not.toThrow()
    const { fields, validationFlags } = run()
    expect(fields.vendor).toBe('')
    expect(validationFlags).toContain('missing:vendor')
    expect(validationFlags).toContain('money:totalCents')
  })
})
