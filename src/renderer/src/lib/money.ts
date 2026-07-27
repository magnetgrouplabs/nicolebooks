// src/renderer/src/lib/money.ts
//
// The renderer's money rules, in one place, because Phase 6 is where a user types an amount and
// Phase 7 posts it to somebody's books.
//
// ONE RULE, ENFORCED BY CONSTRUCTION: this file never multiplies or divides by 100. Integer cents
// travel from the deterministic parse gate all the way to QuickBooks, and the two places a float
// could sneak in are display (cents / 100) and entry (Number(text) * 100). Both are done with
// STRING math here instead:
//
//   Number('1336.57') * 100  ===  133656.99999999999   <- loses a cent, silently
//   Number('1336' + '57')    ===  133657               <- exact, for every amount this app posts
//
// PostingRowSchema refuses a non-integer amountCents at the IPC boundary, so a float would not
// reach QuickBooks. It would do something worse: turn a legitimate bill into a rejected batch the
// user cannot explain.

/** Render integer cents as printed money: 133600 -> '$1,336.00'. String math only. */
export function formatCents(cents: number): string {
  const negative = cents < 0
  const digits = Math.abs(cents).toString().padStart(3, '0')
  const whole = digits.slice(0, -2).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return `${negative ? '-' : ''}$${whole}.${digits.slice(-2)}`
}

/**
 * Render integer cents as the text an editable amount field starts with: 133600 -> '1336.00'.
 *
 * No currency symbol and no thousands separators, because this value goes into an input the user
 * will edit: a field pre-filled with '$1,336.00' invites a partial delete that leaves '$1,36.00'.
 * parseMoneyToCents accepts both shapes anyway, so nothing is lost by keeping the seed plain.
 */
export function centsToInput(cents: number): string {
  const negative = cents < 0
  const digits = Math.abs(cents).toString().padStart(3, '0')
  return `${negative ? '-' : ''}${digits.slice(0, -2)}.${digits.slice(-2)}`
}

/**
 * Read what the user typed as integer cents, or null when it is not a usable amount.
 *
 * Accepts what people actually type or paste off a bill: '1336', '1336.5', '1,336.00', '$1,336.00'.
 * Refuses everything else, INCLUDING three decimal places: a bill reading '1336.567' is a document
 * this app does not understand, and rounding it silently is how a cent goes missing with nobody
 * able to say where. Refuses a negative too, because PostingRowSchema requires a positive amount
 * (a credit memo is not something this app posts) and telling the user here is kinder than telling
 * them mid-batch.
 *
 * Returns null rather than throwing: this runs on every keystroke, and a half-typed amount is a
 * normal state, not an error.
 */
export function parseMoneyToCents(input: string): number | null {
  const cleaned = input.trim().replace(/^\$/, '').replace(/,/g, '').trim()
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(cleaned)
  if (!match) return null
  const fraction = (match[2] ?? '').padEnd(2, '0')
  // Concatenation, not multiplication. See the note at the top of this file.
  const cents = Number(`${match[1]}${fraction}`)
  return Number.isSafeInteger(cents) ? cents : null
}

/** Sum integer cents. A loop over integers, so the total is exact by construction. */
export function sumCents(values: readonly number[]): number {
  let total = 0
  for (const value of values) total += value
  return total
}
