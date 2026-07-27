// src/main/recon/similarity.ts
//
// The name similarity scorer behind reconciliation (RECON-01, RECON-02). Pure, dependency-free,
// deterministic: the same two strings always produce the same number, on every machine, forever.
// That matters because the number decides whether a bill is pre-selected against a vendor without
// the user looking, and a score that drifted between runs would make a wrong pre-selection
// impossible to reproduce and therefore impossible to fix.
//
// WHY NOT A LIBRARY. The whole scorer is under 200 lines and its behaviour is the product decision,
// not an implementation detail. Vendoring it here means the thresholds in match.ts can be tuned
// against the fixture corpus and pinned by tests, rather than moving underneath us on a dependency
// bump. It also keeps a financial tool's match logic auditable in one file.
//
// THE TWO SIGNALS, AND WHY NEITHER IS ENOUGH ALONE.
//
//   Token overlap answers "are these the same words?". It is what makes 'Brightline Electric' and
//   'Brightline Electric Supply' close (two shared words out of three), and it is blind to word
//   ORDER, which is what makes 'Fuel Oil Metro Corp' still resolve. On its own it is too coarse:
//   counted strictly, 'Supplies' and 'Supply' share no token at all, and two names that share one
//   common word out of two ('Apex Supply' vs 'Pinnacle Supply') look half alike when they are
//   different companies.
//
//   Jaro-Winkler answers "are these spelled the same?", character by character, with extra credit
//   for a common prefix (business names are overwhelmingly disambiguated by their first word). On
//   its own it is too generous with long strings that merely start alike, and it has no notion of a
//   word at all.
//
// The blend is 0.55 token / 0.45 character. Token overlap leads because a bill prints a business
// NAME, and the failure this scorer must avoid is matching two different companies that happen to
// share a spelling neighbourhood. The character half is what rescues plurals, punctuation, OCR slips
// and the missing-trailing-word case.
//
// TOKENS MATCH SOFTLY. Two tokens count as the same word when they are spelled nearly identically
// (Jaro-Winkler at or above TOKEN_MATCH_FLOOR), so 'expenses'/'expense' and 'materials'/'material'
// pair up instead of counting as a total miss. The pairing is a greedy maximum-weight matching over
// a symmetric ordering, so similarity(a, b) === similarity(b, a) exactly, which test/recon-
// similarity.test.ts asserts as a property.

/**
 * Weight on the token-overlap half of the blend. Token overlap leads because a shared WORD is
 * stronger evidence of the same business than a shared spelling neighbourhood.
 */
export const TOKEN_WEIGHT = 0.55

/** Weight on the character half of the blend. TOKEN_WEIGHT + CHARACTER_WEIGHT === 1. */
export const CHARACTER_WEIGHT = 0.45

/**
 * How alike two tokens must be spelled to count as the same word.
 *
 * 0.88 admits the pairs that are the same word written differently: 'expense'/'expenses' (0.98),
 * 'material'/'materials' (0.98), 'supply'/'supplies' (0.89), 'tools'/'tool' (0.96). It rejects
 * unrelated short words such as 'fuel'/'fees' (0.67).
 *
 * It does let a few genuinely different short words pair ('travel'/'gravel' is 0.89), which is
 * acceptable because a single soft pair cannot carry a whole name over the match.ts floor on its
 * own: in a multi-word name it contributes a fraction of one half of the blend, and in a one-word
 * name the character half would score the resemblance just as high with no token pairing at all.
 */
export const TOKEN_MATCH_FLOOR = 0.88

/** Winkler prefix scaling factor and cap, the values from the original paper. */
const PREFIX_SCALE = 0.1
const PREFIX_LIMIT = 4

/** Jaro score below which the Winkler prefix bonus is not applied (the paper's boost threshold). */
const BOOST_FLOOR = 0.7

/**
 * Company-form tokens dropped during normalization.
 *
 * A bill prints 'Quality Craft Tools LLC' and QuickBooks holds 'Quality Craft Tools'; the suffix is
 * a legal form, not part of the identity, and leaving it in penalises exactly the pair that should
 * match. Dropping it is safe in one direction and not the other, which is why it is dropped from
 * BOTH sides rather than special-cased.
 *
 * 'co' is the risky entry (a real word in some names), so stripping never empties a name: see
 * normalizeName.
 */
export const LEGAL_SUFFIX_TOKENS: ReadonlySet<string> = new Set([
  'llc',
  'lc',
  'llp',
  'lp',
  'plc',
  'pllc',
  'pc',
  'inc',
  'incorporated',
  'corp',
  'corporation',
  'co',
  'company',
  'ltd',
  'limited'
])

/**
 * Reduce a printed or stored name to its comparable core.
 *
 * The steps, in order, each undoing one way the same business is written differently:
 *   1. Unicode decomposition, so 'Café' and 'Cafe' are one name.
 *   2. Lowercase.
 *   3. '&' becomes 'and', because 'Taxes & Licenses' and 'Taxes and Licenses' are the same account.
 *   4. Every other non-alphanumeric becomes a space, which folds punctuation, hyphens, apostrophes
 *      ("Bob's" -> 'bob s') and the '.' inside 'L.L.C.' into word breaks.
 *   5. Whitespace collapses and trims.
 *   6. Trailing company-form tokens drop.
 *
 * Step 6 never returns an empty string: a business genuinely named 'Company' keeps its token,
 * because an empty normalization would score 1.0 against every other emptied name.
 */
export function normalizeName(raw: string | null | undefined): string {
  if (typeof raw !== 'string') return ''
  const folded = raw
    .normalize('NFKD')
    .replace(/\p{M}/gu, '') // combining marks left behind by NFKD, so 'Cafe' === 'Café'
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
  if (folded === '') return ''

  const tokens = folded.split(' ')
  const kept = tokens.filter((token) => !LEGAL_SUFFIX_TOKENS.has(token))
  return kept.length > 0 ? kept.join(' ') : tokens.join(' ')
}

/**
 * The distinct words of a normalized name, in first-seen order.
 *
 * Deduplicated so a repeated word ('Auto Auto Parts') cannot inflate the overlap denominator, and
 * so the greedy pairing below can key its used-token bookkeeping on the token text itself.
 */
export function nameTokens(normalized: string): string[] {
  if (normalized === '') return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const token of normalized.split(' ')) {
    if (token === '' || seen.has(token)) continue
    seen.add(token)
    out.push(token)
  }
  return out
}

/**
 * Jaro-Winkler similarity, 0..1, symmetric.
 *
 * Jaro counts characters that appear in both strings within a sliding window (so a transposition is
 * a half-miss rather than two misses), and Winkler adds a bonus for a shared prefix. Identical
 * strings score exactly 1 and a pair with nothing in common scores exactly 0, both by construction
 * rather than by rounding.
 */
export function jaroWinkler(a: string, b: string): number {
  if (a === b) return 1
  if (a === '' || b === '') return 0

  const window = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1)
  const aMatched = new Array<boolean>(a.length).fill(false)
  const bMatched = new Array<boolean>(b.length).fill(false)

  let matches = 0
  for (let i = 0; i < a.length; i += 1) {
    const from = Math.max(0, i - window)
    const to = Math.min(b.length - 1, i + window)
    for (let j = from; j <= to; j += 1) {
      if (bMatched[j] || a[i] !== b[j]) continue
      aMatched[i] = true
      bMatched[j] = true
      matches += 1
      break
    }
  }
  if (matches === 0) return 0

  // Transpositions: matched characters that occur in a different relative order.
  let transpositions = 0
  let k = 0
  for (let i = 0; i < a.length; i += 1) {
    if (!aMatched[i]) continue
    while (!bMatched[k]) k += 1
    if (a[i] !== b[k]) transpositions += 1
    k += 1
  }

  const half = transpositions / 2
  const jaro = (matches / a.length + matches / b.length + (matches - half) / matches) / 3
  if (jaro < BOOST_FLOOR) return jaro

  let prefix = 0
  while (prefix < PREFIX_LIMIT && prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) {
    prefix += 1
  }
  return jaro + prefix * PREFIX_SCALE * (1 - jaro)
}

/**
 * Soft token-set overlap: Dice's coefficient over a greedy maximum-weight pairing, where a pair
 * contributes its spelling similarity rather than a flat 1.
 *
 * SYMMETRY IS BY CONSTRUCTION, not by convention. The candidate pairs are generated from both
 * lists and sorted on a key that is invariant when the two lists swap places (weight, then the two
 * token texts in sorted order), so the greedy pass accepts exactly the same pairs either way.
 * A naive "for each token in a, take its best in b" pass is NOT symmetric, and an asymmetric
 * matcher produces a different answer depending on which side of the comparison a name sits on.
 */
export function tokenSetScore(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 || b.length === 0) return 0

  const pairs: Array<{ weight: number; left: string; right: string }> = []
  for (const left of a) {
    for (const right of b) {
      const weight = left === right ? 1 : jaroWinkler(left, right)
      if (weight >= TOKEN_MATCH_FLOOR) pairs.push({ weight, left, right })
    }
  }

  pairs.sort((x, y) => {
    if (y.weight !== x.weight) return y.weight - x.weight
    const xLow = x.left < x.right ? x.left : x.right
    const yLow = y.left < y.right ? y.left : y.right
    if (xLow !== yLow) return xLow < yLow ? -1 : 1
    const xHigh = x.left < x.right ? x.right : x.left
    const yHigh = y.left < y.right ? y.right : y.left
    if (xHigh === yHigh) return 0
    return xHigh < yHigh ? -1 : 1
  })

  const usedLeft = new Set<string>()
  const usedRight = new Set<string>()
  let overlap = 0
  for (const pair of pairs) {
    if (usedLeft.has(pair.left) || usedRight.has(pair.right)) continue
    usedLeft.add(pair.left)
    usedRight.add(pair.right)
    overlap += pair.weight
  }

  return (2 * overlap) / (a.length + b.length)
}

/**
 * How alike two names are, 0..1, higher is better. This is the single number match.ts thresholds.
 *
 * Guaranteed properties (pinned as properties in test/recon-similarity.test.ts):
 *   identity   similarity(x, x) === 1 for every x, including '' and names that differ only in
 *              case, punctuation or company form
 *   symmetry   similarity(x, y) === similarity(y, x) exactly
 *   bounded    always a finite number in [0, 1], never NaN, for any input including null
 */
export function similarity(a: string | null | undefined, b: string | null | undefined): number {
  const left = normalizeName(a)
  const right = normalizeName(b)

  // Covers the both-empty case too, deliberately: two names that normalize to nothing are as
  // identical as this scorer can tell. match.ts refuses to match on an empty query separately, so
  // an unparsed vendor never reaches a candidate list through this door.
  if (left === right) return 1
  if (left === '' || right === '') return 0

  const token = tokenSetScore(nameTokens(left), nameTokens(right))
  const character = jaroWinkler(left, right)
  const blended = TOKEN_WEIGHT * token + CHARACTER_WEIGHT * character

  // Clamped rather than trusted: floating point can land a hair outside the range, and a score
  // above 1 would silently defeat the auto threshold in match.ts.
  if (!Number.isFinite(blended)) return 0
  return Math.min(1, Math.max(0, blended))
}
