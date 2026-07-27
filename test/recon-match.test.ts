// test/recon-match.test.ts
//
// The acceptance suite for reconciliation, driven straight off test-fixtures/MANIFEST.md against a
// fixture copy of the sandbox reference data (test/helpers/qbo-reference-fixture.ts). No database,
// no network, no live sandbox: the corpus's ground truth is the assertion.
//
// The corpus was built to contain one of each thing that can go wrong, and every one of them is an
// acceptance case below:
//
//   exact          four vendors whose printed name is the QuickBooks name. Must be 'auto', because
//                  making a person confirm an exact match nine times a week is how a review screen
//                  becomes a rubber stamp.
//   near-miss      two vendors whose printed name drops a trailing word ('Brightline Electric' for
//                  'Brightline Electric Supply'). Must be at least 'suggested': pre-selected, but
//                  flagged, because "the same company with a shorter name" and "a different company
//                  with a similar name" are indistinguishable from the document alone.
//   unknown        'Quality Craft Tools LLC', which has no QuickBooks vendor and deliberately never
//                  will. Must be 'none' with nothing pre-selected and no deceptive suggestion, and
//                  must NOT cause a vendor to be created. That is RECON-03 in one fixture.
//   ambiguous      'Equipment Rental' is two different accounts (29 and 62) with the same leaf name.
//                  Must be 'suggested' with BOTH offered, never 'auto': a perfect score against two
//                  records is a coin flip, and a coin flip pre-selected as fact is worse than no
//                  answer at all.
//
// Thresholds live in src/main/recon/match.ts and are asserted here by behaviour rather than by
// value, so a future tuning pass is judged on these outcomes rather than on the constants.

import { describe, expect, it } from 'vitest'
import {
  AUTO_MARGIN,
  AUTO_SCORE,
  CANDIDATE_FLOOR,
  MAX_CANDIDATES,
  matchAgainst,
  SUGGEST_FLOOR,
  type MatchOption
} from '../src/main/recon/match'
import {
  FIXTURE_EXPENSE_ACCOUNTS,
  FIXTURE_PAYMENT_ACCOUNTS,
  FIXTURE_VENDORS
} from './helpers/qbo-reference-fixture'

const VENDOR_OPTIONS: MatchOption[] = FIXTURE_VENDORS.map((vendor) => ({
  id: vendor.id,
  name: vendor.name,
  matchText: vendor.name,
  active: vendor.active
}))

/** Category candidates match on the LEAF and display the fully qualified path (see service.ts). */
const CATEGORY_OPTIONS: MatchOption[] = FIXTURE_EXPENSE_ACCOUNTS.map((account) => ({
  id: account.id,
  name: account.name,
  matchText: account.shortName,
  active: account.active
}))

function matchVendor(printed: string) {
  return matchAgainst(printed, VENDOR_OPTIONS)
}

function matchCategory(suggested: string) {
  return matchAgainst(suggested, CATEGORY_OPTIONS)
}

describe('vendor acceptance cases from test-fixtures/MANIFEST.md', () => {
  // Printed name, expected sandbox vendor id, expected tier. The printed names are exactly what the
  // documents show, uppercase receipts included.
  const EXACT: Array<[string, string]> = [
    ['Apex Plumbing Supply', '58'],
    ['Metro Fuel Oil Corp', '60'],
    ['NORTHSIDE AUTO PARTS', '62'],
    ['PINNACLE OFFICE SUPPLIES', '63'],
    ['Brightline Electric Supply', '59']
  ]

  it.each(EXACT)('%s resolves automatically to vendor %s', (printed, expectedId) => {
    const result = matchVendor(printed)
    expect(result.confidence).toBe('auto')
    expect(result.selectedId).toBe(expectedId)
    expect(result.candidates[0].score).toBe(1)
  })

  const NEAR_MISS: Array<[string, string, string]> = [
    ['Brightline Electric', '59', 'Brightline Electric Supply'],
    ['Cedar Lane Landscaping', '61', 'Cedar Lane Landscaping Supply']
  ]

  it.each(NEAR_MISS)(
    '%s is pre-selected against vendor %s but flagged for a look',
    (printed, expectedId, expectedName) => {
      const result = matchVendor(printed)
      expect(result.confidence).toBe('suggested')
      expect(result.selectedId).toBe(expectedId)
      expect(result.selectedName).toBe(expectedName)
      expect(result.candidates[0].score).toBeGreaterThanOrEqual(SUGGEST_FLOOR)
      expect(result.candidates[0].score).toBeLessThan(AUTO_SCORE)
    }
  )

  it('Quality Craft Tools LLC matches nothing and suggests nothing deceptive', () => {
    const result = matchVendor('Quality Craft Tools LLC')

    expect(result.confidence).toBe('none')
    expect(result.selectedId).toBeNull()
    expect(result.selectedName).toBeNull()

    // The six seeded vendors must not turn up wearing a plausible score. Nothing in the company
    // even clears the candidate floor against this name, so the dropdown starts empty and the only
    // thing that can fill the cell is a person choosing (RECON-03).
    expect(result.candidates).toEqual([])
  })

  it('never invents a vendor for an unknown name', () => {
    // The whole surface: matchAgainst can only ever return ids that were handed to it.
    const known = new Set(VENDOR_OPTIONS.map((option) => option.id))
    for (const printed of ['Quality Craft Tools LLC', 'Totally Unheard Of Vendor', 'zzzz']) {
      const result = matchVendor(printed)
      expect(result.selectedId === null || known.has(result.selectedId)).toBe(true)
      for (const candidate of result.candidates) expect(known.has(candidate.id)).toBe(true)
    }
  })

  it('does not pre-select a stock sandbox vendor for any fixture document', () => {
    // MANIFEST.md: none of the 26 stock vendors collide with the six seeded ones, so a match
    // against any of them is a false positive.
    const seeded = new Set(['58', '59', '60', '61', '62', '63'])
    for (const [printed] of [...EXACT, ...NEAR_MISS]) {
      const result = matchVendor(printed)
      expect(seeded.has(result.selectedId as string), `${printed} selected ${result.selectedId}`).toBe(true)
    }
  })
})

describe('category acceptance cases from test-fixtures/MANIFEST.md', () => {
  // Suggested category as the parser reports it, and the expense account MANIFEST.md expects.
  const EXPECTED: Array<[string, string, string]> = [
    ['Job Materials', '63', 'Job Expenses:Job Materials'],
    ['Fuel', '56', 'Automobile:Fuel'],
    ['Supplies', '20', 'Supplies'],
    ['Automobile', '55', 'Automobile'],
    ['Plants and Soil', '66', 'Job Expenses:Job Materials:Plants and Soil'],
    ['Office Expenses', '15', 'Office Expenses']
  ]

  it.each(EXPECTED)('%s resolves automatically to account %s', (suggested, expectedId, expectedName) => {
    const result = matchCategory(suggested)
    expect(result.confidence).toBe('auto')
    expect(result.selectedId).toBe(expectedId)
    expect(result.selectedName).toBe(expectedName)
  })

  it('matches the leaf name but shows the fully qualified path', () => {
    // A bill says 'Job Materials'. QuickBooks calls it 'Job Expenses:Job Materials'. Matching the
    // fully qualified name would penalise every sub-account for the parent it sits under.
    const result = matchCategory('Job Materials')
    expect(result.selectedName).toContain(':')
    expect(result.selectedName?.endsWith('Job Materials')).toBe(true)
  })

  it('the duplicated Equipment Rental leaf comes back suggested with both accounts', () => {
    const result = matchCategory('Equipment Rental')

    expect(result.confidence).toBe('suggested')
    const top = result.candidates.slice(0, 2)
    expect(top.map((candidate) => candidate.id).sort()).toEqual(['29', '62'])
    for (const candidate of top) expect(candidate.score).toBe(1)

    // Both are offered under names a person can tell apart, which is the entire reason the cache
    // carries the fully qualified name alongside the leaf.
    expect(new Set(top.map((candidate) => candidate.name)).size).toBe(2)

    // And the selection is one of the two, never a third account that merely looks similar.
    expect(['29', '62']).toContain(result.selectedId)
  })

  it('two accounts whose names differ by one letter are never auto-selected', () => {
    // 'Maintenance and Repair' (72) and 'Job Expenses:Maintenance and Repairs' (61) are two real,
    // different accounts in the same company. An exact hit on one with the other a hair behind is
    // exactly the case the margin rule exists for.
    const result = matchCategory('Maintenance and Repair')
    expect(result.confidence).toBe('suggested')
    expect(result.candidates[0].score).toBe(1)
    expect(result.candidates[1].score).toBeGreaterThan(AUTO_SCORE - AUTO_MARGIN)
  })

  it('tolerates a singular/plural slip from the parser', () => {
    const result = matchCategory('Office Expense')
    expect(result.selectedId).toBe('15')
    expect(result.confidence).toBe('auto')
  })

  it('never offers a bank or credit card account as a category', () => {
    // RECON-04 is structural: the payment accounts are not in the pool this function reads. The
    // assertion proves the pool split held rather than that a filter was remembered.
    const paymentIds = new Set(FIXTURE_PAYMENT_ACCOUNTS.map((account) => account.id))
    for (const suggested of ['Checking', 'Visa', 'Mastercard', 'Savings', 'Job Materials']) {
      const result = matchCategory(suggested)
      for (const candidate of result.candidates) {
        // Ids collide across entity kinds in QuickBooks, so compare on the NAME a payment account
        // would have had.
        expect(FIXTURE_PAYMENT_ACCOUNTS.some((a) => a.name === candidate.name)).toBe(false)
      }
      expect(paymentIds.size).toBe(4)
    }
  })
})

describe('the confidence tiers', () => {
  const OPTIONS: MatchOption[] = [
    { id: '1', name: 'Apex Plumbing Supply', matchText: 'Apex Plumbing Supply', active: true },
    { id: '2', name: 'Hicks Hardware', matchText: 'Hicks Hardware', active: true }
  ]

  it('auto requires both a near-perfect score and a clear margin', () => {
    const result = matchAgainst('Apex Plumbing Supply', OPTIONS)
    expect(result.confidence).toBe('auto')
    expect(result.candidates[0].score).toBeGreaterThanOrEqual(AUTO_SCORE)
  })

  it('a perfect score with a tied runner-up is suggested, never auto', () => {
    const tied: MatchOption[] = [
      { id: '1', name: 'First:Equipment Rental', matchText: 'Equipment Rental', active: true },
      { id: '2', name: 'Second:Equipment Rental', matchText: 'Equipment Rental', active: true }
    ]
    const result = matchAgainst('Equipment Rental', tied)
    expect(result.confidence).toBe('suggested')
    expect(result.candidates).toHaveLength(2)
  })

  it('a lone near-perfect candidate is auto (there is no runner-up to be confused with)', () => {
    const lone: MatchOption[] = [{ id: '1', name: 'Fuel', matchText: 'Fuel', active: true }]
    expect(matchAgainst('Fuel', lone).confidence).toBe('auto')
  })

  it('none when nothing clears the suggest floor, and the selection stays empty', () => {
    const result = matchAgainst('Zzzz Qqqq', OPTIONS)
    expect(result.confidence).toBe('none')
    expect(result.selectedId).toBeNull()
    expect(result.selectedName).toBeNull()
  })

  it('an empty or missing query never matches anything', () => {
    for (const query of ['', '   ', null, undefined]) {
      const result = matchAgainst(query, OPTIONS)
      expect(result).toEqual({
        selectedId: null,
        selectedName: null,
        confidence: 'none',
        candidates: []
      })
    }
  })
})

describe('the candidate list', () => {
  it('is sorted by score, highest first', () => {
    const result = matchAgainst('Supply', VENDOR_OPTIONS)
    const scores = result.candidates.map((candidate) => candidate.score)
    expect([...scores].sort((a, b) => b - a)).toEqual(scores)
  })

  it('never exceeds MAX_CANDIDATES', () => {
    for (const option of CATEGORY_OPTIONS) {
      expect(matchAgainst(option.matchText, CATEGORY_OPTIONS).candidates.length).toBeLessThanOrEqual(
        MAX_CANDIDATES
      )
    }
  })

  it('drops anything below the candidate floor rather than padding the list', () => {
    for (const candidate of matchAgainst('Apex Plumbing Supply', VENDOR_OPTIONS).candidates) {
      expect(candidate.score).toBeGreaterThanOrEqual(CANDIDATE_FLOOR)
    }
  })

  it('carries a bounded score on every candidate', () => {
    for (const option of [...VENDOR_OPTIONS, ...CATEGORY_OPTIONS]) {
      for (const candidate of matchAgainst(option.matchText, VENDOR_OPTIONS).candidates) {
        expect(Number.isFinite(candidate.score)).toBe(true)
        expect(candidate.score).toBeGreaterThanOrEqual(0)
        expect(candidate.score).toBeLessThanOrEqual(1)
      }
    }
  })

  it('is stable: the same query ranks the same way on every call', () => {
    const first = matchAgainst('Brightline Electric', VENDOR_OPTIONS)
    for (let i = 0; i < 5; i += 1) {
      expect(matchAgainst('Brightline Electric', VENDOR_OPTIONS)).toEqual(first)
    }
  })

  it('is stable when the option list is reordered, so a tie cannot flip between runs', () => {
    const reversed = [...CATEGORY_OPTIONS].reverse()
    expect(matchAgainst('Equipment Rental', reversed)).toEqual(
      matchAgainst('Equipment Rental', CATEGORY_OPTIONS)
    )
  })

  it('ignores inactive records, which stay resolvable by id but are never offered', () => {
    const retired: MatchOption[] = [
      { id: '58', name: 'Apex Plumbing Supply', matchText: 'Apex Plumbing Supply', active: false },
      { id: '39', name: 'Hicks Hardware', matchText: 'Hicks Hardware', active: true }
    ]
    const result = matchAgainst('Apex Plumbing Supply', retired)
    expect(result.confidence).toBe('none')
    expect(result.candidates.some((candidate) => candidate.id === '58')).toBe(false)
  })
})
