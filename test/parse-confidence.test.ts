// test/parse-confidence.test.ts
//
// Wave-0 (RED) unit spec for the deterministic-weighted confidence scorer (plan 03-03,
// PARSE-04, decisions D-11 / D-12 / D-22). Until src/main/parse/confidence.ts exists this
// file fails to import — the correct Wave-0 state.
//
// The load-bearing rule (D-11): the model's SELF-REPORTED confidence is advisory only and
// is never the gate. Verbalized LLM confidence is poorly calibrated and overconfident, so
// trusting it would green-light exactly the hallucinated total this pipeline exists to
// catch. Grounding (does the value appear verbatim in the source text?), format/parse
// success and the arithmetic cross-check decide the flag; the self-report is consulted only
// for a field with no source anchor at all — in practice the category guess.
//
// Coverage:
//   1. computeConfidence precedence ladder: a failed deterministic check -> 'flagged' EVEN
//      at a high model self-report; a second-pass disagreement -> 'low'; a verbatim-grounded
//      value -> 'high'; an unanchored value -> the advisory self-report, else 'low'.
//   2. Grounding is boundary-safe: a tax of $8.00 must not certify itself by matching inside
//      the total '$108.00'. That false ground would hide the single most common OCR error.
//   3. agreementFlags (D-22): image-only documents get a second cross-call at temperature 0
//      and a mismatch on any key field (total, subtotal, tax, invoice date, invoice number)
//      becomes a low-confidence flag. Native PDFs pass no second result — verbatim-text
//      grounding already covers them — and must compute nothing.
//
// Nothing here rejects or corrects a value: flag-and-keep (D-12) throughout.

import { describe, expect, it } from 'vitest'
import { AGREEMENT_PREFIX, agreementFlags, computeConfidence } from '../src/main/parse/confidence'
import { ARITHMETIC_FLAG } from '../src/main/parse/validate'
import type { ParsedFields } from '../src/shared/ipc-contract'

/** A validated field set; overrides shape each case. */
function fields(overrides: Partial<ParsedFields> = {}): ParsedFields {
  return {
    vendor: 'Acme Supply Co',
    invoiceNumber: 'INV-1042',
    invoiceDate: '2026-07-24',
    dueDate: null,
    subtotalCents: 10000,
    taxCents: 800,
    totalCents: 10800,
    currency: 'USD',
    suggestedCategory: 'Job Materials',
    ...overrides
  }
}

/** The kind of embedded text the native-PDF (belt-and-suspenders, D-06) route supplies. */
const SOURCE_TEXT = [
  'ACME SUPPLY CO',
  'Invoice INV-1042',
  'Date 07/24/2026',
  'Subtotal 100.00',
  'Tax 8.00',
  'Total $108.00'
].join('\n')

describe('computeConfidence — grounding', () => {
  it('marks a value that appears verbatim in the source text high', () => {
    const c = computeConfidence(fields(), SOURCE_TEXT, [])
    expect(c.vendor).toBe('high')
    expect(c.invoiceNumber).toBe('high')
  })

  it('grounds a normalized date against its printed form', () => {
    // The gate stored '2026-07-24'; the document prints '07/24/2026'. Same value.
    expect(computeConfidence(fields(), SOURCE_TEXT, []).invoiceDate).toBe('high')
  })

  it('grounds integer cents against the printed money string', () => {
    const c = computeConfidence(fields(), SOURCE_TEXT, [])
    expect(c.totalCents).toBe('high')
    expect(c.subtotalCents).toBe('high')
  })

  it('does not let a smaller amount ground itself inside a larger one', () => {
    // '8.00' occurs inside '$108.00'. A boundary-blind match would certify a tax value
    // that never appeared on the document as its own line.
    const c = computeConfidence(
      fields({ taxCents: 800 }),
      'Subtotal 100.00\nTotal $108.00', // no standalone 8.00 anywhere
      []
    )
    expect(c.taxCents).not.toBe('high')
  })

  it('ignores case and whitespace differences when grounding', () => {
    const c = computeConfidence(fields({ vendor: 'Acme   Supply Co' }), SOURCE_TEXT, [])
    expect(c.vendor).toBe('high')
  })

  it('never grounds the suggested category, even when the word appears in the document', () => {
    // The category is a QuickBooks-classification GUESS, not a transcription; a coincidental
    // substring must not certify it (D-11 — this is the field the self-report exists for).
    const c = computeConfidence(
      fields({ suggestedCategory: 'Job Materials' }),
      `${SOURCE_TEXT}\nJob Materials`,
      []
    )
    expect(c.suggestedCategory).not.toBe('high')
  })

  it('falls back to the advisory model self-report for an unanchored field', () => {
    const high = computeConfidence(fields(), SOURCE_TEXT, [], { suggestedCategory: 'high' })
    expect(high.suggestedCategory).toBe('high')
    const low = computeConfidence(fields(), SOURCE_TEXT, [], { suggestedCategory: 'low' })
    expect(low.suggestedCategory).toBe('low')
  })

  it('defaults an unanchored, unreported field to low', () => {
    expect(computeConfidence(fields(), SOURCE_TEXT, []).suggestedCategory).toBe('low')
  })

  it('grades every non-null field and omits the ones with nothing to grade', () => {
    const c = computeConfidence(fields({ dueDate: null }), SOURCE_TEXT, [])
    expect(c.dueDate).toBeUndefined()
    expect(Object.keys(c)).toContain('vendor')
  })

  it('yields low, not high, for an image-only document with no embedded text', () => {
    // No text layer means no grounding is possible; D-22 agreement supplies the extra signal.
    const c = computeConfidence(fields(), '', [])
    expect(c.vendor).toBe('low')
    expect(c.totalCents).toBe('low')
  })
})

describe('computeConfidence — deterministic checks outrank the model (D-11/D-12)', () => {
  it('flags a field that failed the arithmetic cross-check even at high model self-confidence', () => {
    const c = computeConfidence(fields({ totalCents: 10900 }), SOURCE_TEXT, [ARITHMETIC_FLAG], {
      totalCents: 'high',
      subtotalCents: 'high',
      taxCents: 'high'
    })
    expect(c.totalCents).toBe('flagged')
    expect(c.subtotalCents).toBe('flagged')
    expect(c.taxCents).toBe('flagged')
  })

  it('flags a field named by a validation flag even when it is grounded verbatim', () => {
    const c = computeConfidence(fields(), SOURCE_TEXT, ['date:invoiceDate'], {
      invoiceDate: 'high'
    })
    expect(c.invoiceDate).toBe('flagged')
  })

  it('leaves unrelated fields alone when one field is flagged', () => {
    const c = computeConfidence(fields(), SOURCE_TEXT, ['date:invoiceDate'])
    expect(c.vendor).toBe('high')
  })

  it('records a second-pass disagreement as low rather than as a failed check', () => {
    // A cross-call mismatch means "uncertain", not "provably wrong" (D-22 -> low-confidence).
    const c = computeConfidence(fields(), '', [`${AGREEMENT_PREFIX}totalCents`], {
      totalCents: 'high'
    })
    expect(c.totalCents).toBe('low')
  })

  it('ignores an unrecognized flag instead of throwing', () => {
    const run = (): ReturnType<typeof computeConfidence> =>
      computeConfidence(fields(), SOURCE_TEXT, ['something:unmapped', 'malformed'])
    expect(run).not.toThrow()
    expect(run().vendor).toBe('high')
  })

  it('tolerates missing optional arguments', () => {
    // Same guard class as the 03-02 `parse(raw ?? {})` finding.
    const run = (): ReturnType<typeof computeConfidence> =>
      computeConfidence(fields(), null, undefined as unknown as string[])
    expect(run).not.toThrow()
    expect(run().vendor).toBe('low')
  })
})

describe('agreementFlags — second-pass cross-call check (D-22)', () => {
  it('computes nothing for the native-PDF path, which passes no second result', () => {
    expect(agreementFlags(fields())).toEqual([])
    expect(agreementFlags(fields(), undefined)).toEqual([])
    expect(agreementFlags(fields(), null)).toEqual([])
  })

  it('flags nothing when the two passes agree', () => {
    expect(agreementFlags(fields(), fields())).toEqual([])
  })

  it('flags a numeric mismatch on each key money field', () => {
    expect(agreementFlags(fields(), fields({ totalCents: 10900 }))).toEqual([
      `${AGREEMENT_PREFIX}totalCents`
    ])
    expect(agreementFlags(fields(), fields({ subtotalCents: 9900 }))).toEqual([
      `${AGREEMENT_PREFIX}subtotalCents`
    ])
    expect(agreementFlags(fields(), fields({ taxCents: 900 }))).toEqual([
      `${AGREEMENT_PREFIX}taxCents`
    ])
  })

  it('flags a string mismatch on the invoice date and invoice number', () => {
    expect(agreementFlags(fields(), fields({ invoiceDate: '2026-07-25' }))).toEqual([
      `${AGREEMENT_PREFIX}invoiceDate`
    ])
    expect(agreementFlags(fields(), fields({ invoiceNumber: 'INV-1043' }))).toEqual([
      `${AGREEMENT_PREFIX}invoiceNumber`
    ])
  })

  it('treats one pass finding a value and the other finding none as a disagreement', () => {
    expect(agreementFlags(fields(), fields({ taxCents: null }))).toEqual([
      `${AGREEMENT_PREFIX}taxCents`
    ])
  })

  it('does not flag a pure formatting difference in the invoice number', () => {
    expect(agreementFlags(fields(), fields({ invoiceNumber: ' inv-1042 ' }))).toEqual([])
  })

  it('does not compare the vendor or the category guess', () => {
    // Only the five key fields named in D-22; a vendor spelling difference between two
    // vision passes is expected noise, not a confidence signal.
    expect(
      agreementFlags(fields(), fields({ vendor: 'ACME SUPPLY', suggestedCategory: 'Supplies' }))
    ).toEqual([])
  })

  it('reports every mismatching field', () => {
    const flags = agreementFlags(fields(), fields({ totalCents: 1, invoiceNumber: 'X' }))
    expect(flags).toHaveLength(2)
    expect(flags).toContain(`${AGREEMENT_PREFIX}totalCents`)
    expect(flags).toContain(`${AGREEMENT_PREFIX}invoiceNumber`)
  })

  it('emits flags that computeConfidence maps back onto their field', () => {
    // The whole point of the vocabulary: the pipeline merges these into validationFlags.
    const flags = agreementFlags(fields(), fields({ totalCents: 10900 }))
    expect(computeConfidence(fields(), '', flags).totalCents).toBe('low')
  })
})
