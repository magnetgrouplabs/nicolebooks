// test/bills-row-status.test.ts
//
// The two pure functions behind the rebuilt Bills row: per-field flag attribution
// (flaggedFields) and the single status chip (statusChip).
//
// The load-bearing case here is the UNATTRIBUTED FLAG. ARITHMETIC_FLAG is literally the string
// 'arithmetic:subtotal+tax!=total', and the part after its colon is NOT a ParsedFields key --
// src/main/parse/confidence.ts special-cases it and condemns all three money fields together.
// A naive `split(':')` per-field mapping in the renderer would drop it silently, which is exactly
// the WR-10 failure ("a displayed money value must never appear without its flag") wearing a
// per-field costume. So the rule under test is: any flag the renderer cannot attribute to a known
// field condemns all three money fields. Since totalCents is always displayed, that guarantees a
// non-empty flag set always produces at least one visible marker.
//
// The property at the bottom, isFlagged(parse) === (flaggedFields(parse).size > 0), IS WR-10 in
// one line. Both functions are pure, so this file needs no rendering; the rendering half of the
// same guarantee lives in test/bills-parse-flags.test.ts.

import { describe, expect, it } from 'vitest'
import { flaggedFields, isFlagged, statusChip } from '../src/renderer/src/screens/BillsScreen'
import type { ParseFileResult, ParsedFields, ScanFile } from '../src/shared/ipc-contract'

const HASH = 'a'.repeat(64)
const MONEY = ['subtotalCents', 'taxCents', 'totalCents']

function fields(overrides: Partial<ParsedFields> = {}): ParsedFields {
  return {
    vendor: 'Nassau Plumbing Supply',
    invoiceNumber: 'INV-2026-0417',
    invoiceDate: '2026-07-14',
    dueDate: null,
    subtotalCents: 123410,
    taxCents: 10190,
    totalCents: 133600,
    currency: 'USD',
    suggestedCategory: 'Job Materials',
    ...overrides
  }
}

function parseResult(overrides: Partial<ParseFileResult> = {}): ParseFileResult {
  return {
    filename: 'nassau-plumbing-0417.pdf',
    hash: HASH,
    status: 'parsed',
    fields: fields(),
    confidence: { vendor: 'high', totalCents: 'high' },
    validationFlags: [],
    ...overrides
  }
}

function scanFile(overrides: Partial<ScanFile> = {}): ScanFile {
  return {
    filename: 'nassau-plumbing-0417.pdf',
    status: 'loaded',
    hash: HASH,
    sizeBytes: 2048,
    ...overrides
  }
}

function sorted(set: Set<string>): string[] {
  return [...set].sort()
}

describe('flaggedFields attributes each failed check to its own field', () => {
  it('returns an empty set when there is nothing to flag', () => {
    expect(sorted(flaggedFields(undefined))).toEqual([])
    expect(sorted(flaggedFields(parseResult()))).toEqual([])
    expect(
      sorted(flaggedFields(parseResult({ confidence: undefined, validationFlags: undefined })))
    ).toEqual([])
  })

  it('reads a flagged confidence level as a flag on that field', () => {
    expect(sorted(flaggedFields(parseResult({ confidence: { totalCents: 'flagged' } })))).toEqual([
      'totalCents'
    ])
  })

  it('does not surface low confidence, which every image-only field lands at by design', () => {
    expect(sorted(flaggedFields(parseResult({ confidence: { totalCents: 'low' } })))).toEqual([])
  })

  it('reads a validation flag even when the confidence blob is gone entirely', () => {
    // A cached row whose confidence JSON degraded to {} must not lose its flag.
    const parse = parseResult({ confidence: undefined, validationFlags: ['money:taxCents'] })
    expect(sorted(flaggedFields(parse))).toEqual(['taxCents'])
  })

  it('treats a D-22 agreement disagreement as a flag, never weakening it', () => {
    const parse = parseResult({ validationFlags: ['agreement:totalCents'] })
    expect(sorted(flaggedFields(parse))).toEqual(['totalCents'])
  })

  it('unions the flag list and the confidence map', () => {
    const parse = parseResult({
      confidence: { vendor: 'flagged' },
      validationFlags: ['date:invoiceDate']
    })
    expect(sorted(flaggedFields(parse))).toEqual(['invoiceDate', 'vendor'])
  })

  // The trap. Four shapes the renderer cannot attribute, all of which must condemn the money.
  const unattributed: Array<{ name: string; parse: ParseFileResult }> = [
    {
      name: 'the arithmetic flag, whose suffix is not a field name',
      parse: parseResult({ validationFlags: ['arithmetic:subtotal+tax!=total'] })
    },
    { name: 'a flag with no colon at all', parse: parseResult({ validationFlags: ['weird'] }) },
    {
      name: 'a future flag naming a field this build does not know',
      parse: parseResult({ validationFlags: ['future:somethingNew'] })
    },
    {
      name: 'a flagged confidence entry under an unknown key',
      parse: parseResult({ confidence: { somethingNew: 'flagged' } })
    }
  ]

  for (const { name, parse } of unattributed) {
    it(`condemns all three money fields for ${name}`, () => {
      expect(sorted(flaggedFields(parse))).toEqual([...MONEY].sort())
    })
  }
})

// Every shape the property below is proven over. Flagged and clean cases both, because the
// equivalence has to hold in both directions.
const PROPERTY_FIXTURES: Array<{ name: string; parse?: ParseFileResult }> = [
  { name: 'no parse result at all', parse: undefined },
  { name: 'a clean parse', parse: parseResult() },
  { name: 'clean with only low confidence', parse: parseResult({ confidence: { taxCents: 'low' } }) },
  {
    name: 'no confidence and no flags',
    parse: parseResult({ confidence: undefined, validationFlags: undefined })
  },
  { name: 'a flagged total', parse: parseResult({ confidence: { totalCents: 'flagged' } }) },
  { name: 'a money flag', parse: parseResult({ validationFlags: ['money:totalCents'] }) },
  { name: 'a date flag', parse: parseResult({ validationFlags: ['date:invoiceDate'] }) },
  { name: 'an agreement flag', parse: parseResult({ validationFlags: ['agreement:taxCents'] }) },
  {
    name: 'the arithmetic flag',
    parse: parseResult({ validationFlags: ['arithmetic:subtotal+tax!=total'] })
  },
  { name: 'a colonless flag', parse: parseResult({ validationFlags: ['weird'] }) },
  { name: 'an unknown-field flag', parse: parseResult({ validationFlags: ['future:somethingNew'] }) },
  {
    name: 'a flagged confidence under an unknown key',
    parse: parseResult({ confidence: { somethingNew: 'flagged' } })
  },
  { name: 'a cached row carrying its stored flag', parse: parseResult({ status: 'cached', validationFlags: ['money:totalCents'] }) },
  {
    name: 'a parse-failed row',
    parse: { filename: 'x.pdf', hash: HASH, status: 'parse-failed', error: 'Could not read it.' }
  }
]

describe('flaggedFields and isFlagged agree, which is WR-10 in one line', () => {
  for (const { name, parse } of PROPERTY_FIXTURES) {
    it(`holds for ${name}`, () => {
      expect(isFlagged(parse)).toBe(flaggedFields(parse).size > 0)
    })
  }
})

describe('statusChip resolves one chip by first match on the precedence table', () => {
  it('1. an already-posted duplicate that knows its posted date', () => {
    const file = scanFile({ status: 'duplicate-excluded', postedAt: '2026-05-02' })
    expect(statusChip(file)).toEqual({
      label: 'Already entered on 2026-05-02',
      variant: 'destructive'
    })
  })

  it('2. an already-posted duplicate with no posted date', () => {
    expect(statusChip(scanFile({ status: 'duplicate-excluded' }))).toEqual({
      label: 'Already entered',
      variant: 'destructive'
    })
  })

  it('3. a within-scan copy', () => {
    expect(statusChip(scanFile({ status: 'duplicate-in-batch' }))).toEqual({
      label: 'Duplicate in this scan',
      variant: 'secondary'
    })
  })

  it('4. a cloud placeholder that has not finished downloading', () => {
    expect(statusChip(scanFile({ status: 'not-ready-skipped' }))).toEqual({
      label: 'Not downloaded yet, re-scan shortly',
      variant: 'outline'
    })
  })

  it('5. an unsupported file type', () => {
    expect(statusChip(scanFile({ status: 'unsupported-skipped' }))).toEqual({
      label: 'Unsupported',
      variant: 'outline'
    })
  })

  it('6. a file the model could not read', () => {
    const parse = parseResult({ status: 'parse-failed', fields: undefined })
    expect(statusChip(scanFile(), parse)).toEqual({
      label: 'Could not read',
      variant: 'destructive'
    })
  })

  it('7. a parsed file with a failed deterministic check', () => {
    const parse = parseResult({ validationFlags: ['money:totalCents'] })
    expect(statusChip(scanFile(), parse)).toEqual({ label: 'Needs review', variant: 'destructive' })
  })

  it('8. a clean cache hit', () => {
    expect(statusChip(scanFile(), parseResult({ status: 'cached' }))).toEqual({
      label: 'Already read',
      variant: 'secondary'
    })
  })

  it('9. a clean fresh parse', () => {
    expect(statusChip(scanFile(), parseResult())).toEqual({
      label: 'Ready to review',
      variant: 'default'
    })
  })

  it('10. a loaded file that has not been read yet', () => {
    expect(statusChip(scanFile())).toEqual({ label: 'Loaded', variant: 'secondary' })
  })
})

describe('statusChip ordering is load-bearing, not incidental', () => {
  it('a duplicate warning is never overwritten by a parse verdict', () => {
    // Losing a "this was already entered in QuickBooks" warning is the worse failure, so the
    // file status wins even when a parse result exists and is flagged.
    const file = scanFile({ status: 'duplicate-excluded' })
    const parse = parseResult({ validationFlags: ['money:totalCents'] })
    expect(statusChip(file, parse)).toEqual({ label: 'Already entered', variant: 'destructive' })
  })

  it('a failed read outranks its own leftover flags', () => {
    const parse = parseResult({
      status: 'parse-failed',
      fields: undefined,
      validationFlags: ['money:totalCents']
    })
    expect(statusChip(scanFile(), parse)).toEqual({
      label: 'Could not read',
      variant: 'destructive'
    })
  })

  it('needs review outranks the cache-hit signal', () => {
    // A flagged bill wearing a calm "Already read" chip is the chip-level WR-10 failure. The
    // cache hit is a cost fact, already reported in the batch summary line.
    const parse = parseResult({ status: 'cached', confidence: { totalCents: 'flagged' } })
    expect(statusChip(scanFile(), parse)).toEqual({ label: 'Needs review', variant: 'destructive' })
  })
})

describe('chip copy is plain text', () => {
  it('no label contains an em dash or an en dash', () => {
    const cases: Array<[ScanFile, ParseFileResult | undefined]> = [
      [scanFile({ status: 'duplicate-excluded', postedAt: '2026-05-02' }), undefined],
      [scanFile({ status: 'duplicate-excluded' }), undefined],
      [scanFile({ status: 'duplicate-in-batch' }), undefined],
      [scanFile({ status: 'not-ready-skipped' }), undefined],
      [scanFile({ status: 'unsupported-skipped' }), undefined],
      [scanFile(), parseResult({ status: 'parse-failed', fields: undefined })],
      [scanFile(), parseResult({ validationFlags: ['money:totalCents'] })],
      [scanFile(), parseResult({ status: 'cached' })],
      [scanFile(), parseResult()],
      [scanFile(), undefined]
    ]
    for (const [file, parse] of cases) {
      expect(statusChip(file, parse).label).not.toMatch(/[\u2014\u2013]/)
    }
  })
})
