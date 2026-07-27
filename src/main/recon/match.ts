// src/main/recon/match.ts
//
// Candidate ranking and the confidence tiers (RECON-01, RECON-02, RECON-03).
//
// NOTHING IS EVER CREATED HERE. This module ranks records that already exist in the connected
// QuickBooks company and nothing else; there is no code path in it, or anywhere else in
// src/main/recon/, that creates a vendor or an account. That is RECON-03 made structural rather
// than promised: an unmatched bill comes back with confidence 'none' and an empty selection, and
// the only thing that can fill that cell is a person choosing from the dropdown. A silent create is
// not guarded against, it is absent.
//
// WHAT THE THREE TIERS MEAN, because they are a promise to the person reviewing:
//
//   'auto'      the app is willing to be judged on this. Pre-selected, not highlighted. Reserved
//               for a near-perfect score that also beats its runner-up clearly, so a name with a
//               plausible twin in the chart of accounts can never land here.
//   'suggested' the app has a best guess worth showing, pre-selected but flagged for a look.
//   'none'      nothing plausible. The cell starts empty. Any candidates returned are alternatives
//               to browse, not an answer.
//
// THE MARGIN RULE IS THE LOAD-BEARING ONE. A score alone cannot tell 'certain' from 'ambiguous':
// the QuickBooks sandbox contains 'Equipment Rental' TWICE under different parents, so a bill that
// says "Equipment Rental" scores a perfect 1.0 against two different accounts. Requiring a clear
// gap over the runner-up turns that from a coin flip pre-selected as fact into a 'suggested' pair
// the user picks between. The same rule catches 'Maintenance and Repair' vs 'Maintenance and
// Repairs', which are two real, different accounts in the same company.
//
// CANDIDATE NAMES DISAMBIGUATE, MATCH TEXT DOES NOT. For an account, the text matched against is
// the LEAF ('Job Materials'), because that is what a bill prints; the name shown in the dropdown is
// the fully qualified path ('Job Expenses:Job Materials'), because two leaves can be identical and
// a list offering the same word twice is unusable. Those are two different fields on the same
// record, which is why MatchOption carries both.
//
// Pure and dependency-free, like src/main/parse/confidence.ts: the caller supplies the option
// lists, so this module never reads the database and its whole behaviour is reproducible from its
// arguments. Thresholds are tuned against test-fixtures/MANIFEST.md and pinned in
// test/recon-match.test.ts.

import type { MatchCandidate, MatchResult } from '../../shared/ipc-contract'
import { similarity } from './similarity'

/**
 * Below this a record is not a plausible alternative and is not shown at all.
 *
 * It exists so an unknown vendor comes back with an EMPTY dropdown rather than with the five
 * least-bad names in the company. 'Quality Craft Tools LLC' is the fixture that proves it: every
 * sandbox vendor scores under this floor against it, so the review row offers nothing and the user
 * is asked to decide, which is exactly the RECON-03 behaviour.
 */
export const CANDIDATE_FLOOR = 0.45

/**
 * At or above this the best candidate is worth pre-selecting as 'suggested'.
 *
 * 0.62 sits in the wide empty band the fixture corpus leaves between real matches and coincidences.
 * Every correct match in the corpus scores 0.87 or better ('Brightline Electric' reaches its vendor
 * at 0.87, 'Cedar Lane Landscaping' at 0.90, everything else exactly 1.0), while the unknown vendor
 * 'Quality Craft Tools LLC' reaches only 0.28 against its best wrong answer. No best-candidate score
 * in the corpus lands between 0.29 and 0.86, so the exact value is not delicately balanced.
 */
export const SUGGEST_FLOOR = 0.62

/** At or above this a match is near-perfect. Paired with AUTO_MARGIN, never used alone. */
export const AUTO_SCORE = 0.95

/**
 * How far the best candidate must beat the runner-up to be trusted without a look.
 *
 * 0.1 is what makes the duplicate 'Equipment Rental' accounts (a 1.0 tie) come back 'suggested'
 * rather than 'auto'. A tie has a margin of exactly 0, and any two accounts close enough to be
 * confused with each other sit well inside this gap.
 */
export const AUTO_MARGIN = 0.1

/** How many ranked alternatives travel back to the review grid. */
export const MAX_CANDIDATES = 5

/** Decimal places the emitted score is rounded to, so the tier is explainable from what the UI shows. */
const SCORE_PRECISION = 4

/**
 * One record the query may resolve to.
 *
 * `matchText` is what the query is compared against (a vendor's display name, or an account's LEAF
 * name); `name` is what the user reads and picks from (a vendor's display name, or an account's
 * fully qualified path). They differ for exactly one reason, and it is the sub-account case.
 */
export interface MatchOption {
  id: string
  name: string
  matchText: string
  active: boolean
}

/**
 * The answer for a cell with nothing to match against, and the answer on a parse miss.
 *
 * A function rather than a shared constant on purpose: a batch produces one of these per empty
 * cell, and handing every row the same object (with the same `candidates` array) would let one
 * row's edit downstream appear in every other row.
 */
export function noMatch(): MatchResult {
  return { selectedId: null, selectedName: null, confidence: 'none', candidates: [] }
}

/**
 * Rank `options` against `query` and decide how much to trust the winner.
 *
 * Inactive options are dropped before scoring: a vendor deleted upstream is still resolvable by id
 * (so an already-posted entry keeps its name) but must never be offered as a new choice.
 *
 * An empty or missing query short-circuits to 'none' rather than scoring: similarity() treats two
 * empty names as identical, and letting an unparsed vendor through that door would pre-select the
 * first blank-named record in the company.
 */
export function matchAgainst(
  query: string | null | undefined,
  options: readonly MatchOption[]
): MatchResult {
  if (typeof query !== 'string' || query.trim() === '') return noMatch()

  const scored: MatchCandidate[] = []
  for (const option of options) {
    if (!option.active) continue
    const score = round(similarity(query, option.matchText))
    if (score < CANDIDATE_FLOOR) continue
    scored.push({ id: option.id, name: option.name, score })
  }

  // Deterministic total order: score first, then the displayed name, then the id. Two accounts
  // that tie on score must come back in the same order on every run, or the review grid would
  // pre-select a different one each time the same batch is matched.
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    if (a.name !== b.name) return a.name < b.name ? -1 : 1
    if (a.id === b.id) return 0
    return a.id < b.id ? -1 : 1
  })

  const candidates = scored.slice(0, MAX_CANDIDATES)
  const best = candidates[0]
  if (!best || best.score < SUGGEST_FLOOR) {
    // Alternatives are still returned so the dropdown has somewhere to start, but nothing is
    // selected: 'none' means the app is not answering, not that it has no opinion at all.
    return { selectedId: null, selectedName: null, confidence: 'none', candidates }
  }

  const runnerUp = candidates[1]
  const clear = runnerUp === undefined || best.score - runnerUp.score >= AUTO_MARGIN
  return {
    selectedId: best.id,
    selectedName: best.name,
    confidence: best.score >= AUTO_SCORE && clear ? 'auto' : 'suggested',
    candidates
  }
}

/** Round to SCORE_PRECISION so an emitted score and the tier it produced always agree. */
function round(score: number): number {
  const factor = 10 ** SCORE_PRECISION
  return Math.round(score * factor) / factor
}
