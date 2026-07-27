// test/recon-similarity.test.ts
//
// The reconciliation scorer (src/main/recon/similarity.ts): normalization, Jaro-Winkler, the soft
// token overlap, and the four properties the rest of Phase 5 is allowed to assume.
//
// WHY PROPERTIES AND NOT JUST EXAMPLES. The thresholds in match.ts are numbers compared against
// this function's output, and every one of them silently stops working if the function can return
// NaN, a value above 1, or a different answer depending on which argument came first. None of those
// failures would throw: an asymmetric scorer just quietly matches a bill differently than it
// matches the same bill from the other side of the comparison, and a NaN loses every comparison so
// the record simply never appears. The cross product below is exhaustive over a corpus built from
// the real sandbox names plus deliberately hostile inputs.

import { describe, expect, it } from 'vitest'
import {
  CHARACTER_WEIGHT,
  jaroWinkler,
  LEGAL_SUFFIX_TOKENS,
  nameTokens,
  normalizeName,
  similarity,
  TOKEN_MATCH_FLOOR,
  TOKEN_WEIGHT,
  tokenSetScore
} from '../src/main/recon/similarity'
import { FIXTURE_EXPENSE_ACCOUNTS, FIXTURE_VENDORS } from './helpers/qbo-reference-fixture'

/**
 * The property corpus: every sandbox vendor and account leaf, every vendor as a bill prints it, and
 * a tail of hostile inputs (empty, whitespace, punctuation only, a single character, a very long
 * name, unicode, and a name made entirely of company-form tokens).
 */
const CORPUS: readonly string[] = [
  ...FIXTURE_VENDORS.map((v) => v.name),
  ...FIXTURE_EXPENSE_ACCOUNTS.map((a) => a.shortName),
  ...FIXTURE_EXPENSE_ACCOUNTS.map((a) => a.name),
  'APEX PLUMBING SUPPLY',
  'Brightline Electric',
  'Cedar Lane Landscaping',
  'Quality Craft Tools LLC',
  'Métro Fuel Oil Corp.',
  '',
  '   ',
  '.,-/&',
  'x',
  '7',
  'Company',
  'LLC',
  'a'.repeat(300),
  '   spaced   out   name   '
]

describe('normalizeName', () => {
  it('lowercases, trims and collapses whitespace', () => {
    expect(normalizeName('   APEX   Plumbing   SUPPLY  ')).toBe('apex plumbing supply')
  })

  it('folds punctuation into word breaks', () => {
    expect(normalizeName("Bob's Burger Joint")).toBe('bob s burger joint')
    expect(normalizeName('Metro Fuel Oil Corp.')).toBe('metro fuel oil')
  })

  it('reads & as the word and, so an account written either way is one account', () => {
    expect(normalizeName('Taxes & Licenses')).toBe(normalizeName('Taxes and Licenses'))
  })

  it('strips diacritics rather than treating them as different letters', () => {
    expect(normalizeName('Métro Café')).toBe('metro cafe')
  })

  it('drops company-form tokens from both sides of a comparison', () => {
    for (const token of LEGAL_SUFFIX_TOKENS) {
      expect(normalizeName(`Quality Craft Tools ${token}`)).toBe('quality craft tools')
    }
  })

  it('never empties a name that is nothing but company-form tokens', () => {
    // A business genuinely named 'Company' must keep its token: an empty normalization scores 1.0
    // against every other emptied name, which would match it to anything.
    expect(normalizeName('Company')).toBe('company')
    expect(normalizeName('LLC')).toBe('llc')
  })

  it('returns an empty string for nothing, whitespace, punctuation, null and undefined', () => {
    for (const raw of ['', '    ', '.,-/', null, undefined]) {
      expect(normalizeName(raw)).toBe('')
    }
  })
})

describe('nameTokens', () => {
  it('splits a normalized name into its distinct words, in first-seen order', () => {
    expect(nameTokens('apex plumbing supply')).toEqual(['apex', 'plumbing', 'supply'])
  })

  it('deduplicates, so a repeated word cannot inflate the overlap denominator', () => {
    expect(nameTokens('auto auto parts')).toEqual(['auto', 'parts'])
  })

  it('returns nothing for an empty name', () => {
    expect(nameTokens('')).toEqual([])
  })
})

describe('jaroWinkler', () => {
  it('scores identical strings 1 and disjoint strings 0', () => {
    expect(jaroWinkler('apex', 'apex')).toBe(1)
    expect(jaroWinkler('abc', 'xyz')).toBe(0)
    expect(jaroWinkler('', 'apex')).toBe(0)
  })

  it('matches the published value for the paper example', () => {
    // The canonical MARTHA / MARHTA case: Jaro 0.944..., Winkler 0.961... with a 3-char prefix.
    expect(jaroWinkler('martha', 'marhta')).toBeCloseTo(0.9611, 4)
  })

  it('rewards a shared prefix, because business names are disambiguated by their first word', () => {
    expect(jaroWinkler('brightline', 'brightlink')).toBeGreaterThan(jaroWinkler('rightline', 'rightlink'))
  })

  it('is symmetric for every pair in the corpus', () => {
    for (const a of CORPUS) {
      for (const b of CORPUS) {
        expect(jaroWinkler(a, b)).toBe(jaroWinkler(b, a))
      }
    }
  })
})

describe('tokenSetScore', () => {
  it('is 1 for the same token set and 0 when either side is empty', () => {
    expect(tokenSetScore(['apex', 'plumbing'], ['apex', 'plumbing'])).toBe(1)
    expect(tokenSetScore([], ['apex'])).toBe(0)
    expect(tokenSetScore(['apex'], [])).toBe(0)
  })

  it('is blind to word order', () => {
    expect(tokenSetScore(['apex', 'plumbing'], ['plumbing', 'apex'])).toBe(1)
  })

  it('gives a shared word partial credit rather than a pass', () => {
    // Two three-word names sharing one word: 2 * 1 / (3 + 3).
    const score = tokenSetScore(['apex', 'plumbing', 'supply'], ['cedar', 'lane', 'supply'])
    expect(score).toBeCloseTo(1 / 3, 6)
  })

  it('pairs a plural with its singular instead of counting it as a total miss', () => {
    expect(jaroWinkler('expense', 'expenses')).toBeGreaterThanOrEqual(TOKEN_MATCH_FLOOR)
    expect(tokenSetScore(['office', 'expense'], ['office', 'expenses'])).toBeGreaterThan(0.95)
  })

  it('refuses to pair two unrelated short words', () => {
    expect(jaroWinkler('fuel', 'fees')).toBeLessThan(TOKEN_MATCH_FLOOR)
    expect(tokenSetScore(['fuel'], ['fees'])).toBe(0)
  })

  it('is symmetric even though the pairing is greedy', () => {
    // A naive "best match for each token on the left" pass is NOT symmetric. This is the case that
    // exposes it: three tokens on one side competing for two near-identical tokens on the other.
    const left = ['repair', 'repairs', 'maintenance']
    const right = ['repairs', 'maintenance']
    expect(tokenSetScore(left, right)).toBe(tokenSetScore(right, left))
  })
})

describe('similarity', () => {
  it('weights the two halves as documented', () => {
    expect(TOKEN_WEIGHT + CHARACTER_WEIGHT).toBeCloseTo(1, 10)
  })

  it('scores a name against itself as exactly 1, however it is written', () => {
    expect(similarity('Apex Plumbing Supply', 'apex  plumbing,  supply')).toBe(1)
    expect(similarity('Apex Plumbing Supply', 'Apex Plumbing Supply Co.')).toBe(1)
    expect(similarity('Taxes & Licenses', 'Taxes and Licenses')).toBe(1)
  })

  it('ranks the intended fixture near-misses above every coincidence', () => {
    const nearMiss = similarity('Brightline Electric', 'Brightline Electric Supply')
    const coincidence = similarity('Brightline Electric', 'Ellis Equipment Rental')
    expect(nearMiss).toBeGreaterThan(0.86)
    expect(coincidence).toBeLessThan(0.3)
  })

  it('does not confuse two different companies that share one common word', () => {
    expect(similarity('Apex Plumbing Supply', 'Cedar Lane Landscaping Supply')).toBeLessThan(0.5)
  })

  // --- the four properties -------------------------------------------------

  it('identity: every string scores exactly 1 against itself', () => {
    for (const value of CORPUS) {
      expect(similarity(value, value), `identity for ${JSON.stringify(value)}`).toBe(1)
    }
  })

  it('symmetry: the score never depends on argument order', () => {
    for (const a of CORPUS) {
      for (const b of CORPUS) {
        expect(similarity(a, b), `symmetry for ${JSON.stringify([a, b])}`).toBe(similarity(b, a))
      }
    }
  })

  it('bounded: every score is a finite number in [0, 1]', () => {
    for (const a of CORPUS) {
      for (const b of CORPUS) {
        const score = similarity(a, b)
        expect(Number.isFinite(score), `finite for ${JSON.stringify([a, b])}`).toBe(true)
        expect(Number.isNaN(score)).toBe(false)
        expect(score).toBeGreaterThanOrEqual(0)
        expect(score).toBeLessThanOrEqual(1)
      }
    }
  })

  it('total: null, undefined and non-strings score 0 rather than throwing', () => {
    for (const value of CORPUS) {
      if (value === '' || normalizeName(value) === '') continue
      expect(similarity(null, value)).toBe(0)
      expect(similarity(undefined, value)).toBe(0)
      expect(similarity(value, null)).toBe(0)
    }
    // Two absent names are as identical as this function can tell. match.ts refuses an empty query
    // separately, so an unparsed vendor never reaches a candidate list through this door.
    expect(similarity(null, undefined)).toBe(1)
  })

  it('deterministic: the same pair scores the same on every call', () => {
    for (const a of CORPUS) {
      const first = similarity(a, 'Apex Plumbing Supply')
      for (let i = 0; i < 3; i += 1) {
        expect(similarity(a, 'Apex Plumbing Supply')).toBe(first)
      }
    }
  })
})
