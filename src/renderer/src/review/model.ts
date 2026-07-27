// src/renderer/src/review/model.ts
//
// The review screen as pure data: seed -> match -> edit -> resolved row -> posting payload.
//
// Everything that decides WHAT GETS SENT lives here rather than in the components, because this is
// the layer where a mistake costs money and a component is not a thing you can prove. The rules
// below are each one exported function with one job, so the spec can pin the rule instead of
// pinning a rendered string that a design pass will move.
//
// THE THREE-LAYER SHAPE, and why it is three layers rather than one useState of finished rows:
//
//   SEED   what the app knows: the file, its parse, the batch date. Recomputed freely.
//   MATCH  what reconciliation suggested. An overlay on the seed, so it can arrive late (recon runs
//          after parse) or never (the channel can reject) without disturbing anything.
//   EDIT   what the USER changed. A sparse overlay, so it survives every re-seed and every late
//          match. A single flat state of finished rows would lose a correction the moment a
//          re-parse, a rescan, or a slow recon response landed on top of it, which is the one bug
//          this screen absolutely cannot have.
//
// resolveRow() collapses the three in that order, user last, and is where the cross-field rules
// live (a bill has no paid-from account and an expense has no due date), so those invariants hold
// for every row by construction rather than by every caller remembering.
//
// MONEY IS INTEGER CENTS. The editable amount is kept as TEXT while the user types (a half-typed
// '13.' is a normal state, not an error) and converted with string math in lib/money.ts. Nothing
// here multiplies or divides by 100.

import { centsToInput, formatCents, parseMoneyToCents, sumCents } from '@/lib/money'
import { isFlagged } from './parsed-fields'
import type {
  DuplicateProbe,
  DuplicateWarning,
  FileMatch,
  MatchCandidate,
  MatchConfidence,
  ParseFileResult,
  ParsedFields,
  PostingEntryState,
  PostingEntryType,
  PostingRow,
  ScanFile,
  ScanFileStatus
} from '@shared/ipc-contract'

/** ISO 'YYYY-MM-DD', the only date shape QuickBooks accepts and the only one stored here. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

/** The QuickBooks DocNumber limit, mirrored from PostingRowSchema so the UI says it first. */
export const REF_NUMBER_MAX = 21

/**
 * The QuickBooks DisplayName limit, mirrored from QboCreateVendorSchema for the same reason
 * REF_NUMBER_MAX is mirrored: the screen should refuse a name that is too long while the user is
 * still typing it, not after a click that reaches Intuit and comes back rejected.
 */
export const VENDOR_NAME_MAX = 100

/**
 * The amount bounds, mirrored from PostingRowSchema (`.int().positive().max(99999999999)`).
 *
 * Mirrored rather than imported because the schema is a Zod object, not a set of numbers, and a
 * renderer that imported it would still have to restate the bounds to phrase them as advice. What
 * matters is that they are the SAME bounds, and that this file says out loud why:
 *
 * A ZERO AMOUNT IS THE CASE THAT MATTERS, and it is not hypothetical. src/main/parse/validate.ts
 * records an unreadable total as 0 cents alongside its flag, deliberately, so the fallback is
 * visible instead of silent. That row arrives here with amountText '0.00', which parses cleanly to
 * the integer 0. A gate that only asked "did it parse" would call that row complete, hand it to
 * posting:send, and have the WHOLE BATCH refused by a schema bound the user never saw. The document
 * the deterministic gate is proudest of catching would become the batch nobody could send.
 *
 * The ceiling is the same argument from the other end: a fat-fingered extra digit is refused here,
 * where it names the row, rather than at the IPC boundary, where it names nothing.
 */
export const MIN_AMOUNT_CENTS = 1
export const MAX_AMOUNT_CENTS = 99999999999

/** The Phase 2 file hash length. A row without one cannot be sent, matched, or deduped. */
const FILE_HASH_LENGTH = 64

/** Is this an amount posting:send would actually accept? */
function isPostableAmount(cents: number | null): cents is number {
  return cents !== null && cents >= MIN_AMOUNT_CENTS && cents <= MAX_AMOUNT_CENTS
}

/**
 * One row's starting point, before the user touches anything.
 *
 * `parse` is carried whole rather than picked apart because the row renders the document's own
 * claim beside the editable value, and the flags are part of that claim.
 */
export interface ReviewSeed {
  fileHash: string
  filename: string
  scanStatus: ScanFileStatus
  parse?: ParseFileResult
  parsed?: ParsedFields
  entryType: PostingEntryType
  vendorId: string | null
  vendorConfidence: MatchConfidence | null
  vendorCandidates: MatchCandidate[]
  categoryAccountId: string | null
  categoryConfidence: MatchConfidence | null
  categoryCandidates: MatchCandidate[]
  /** Editable text, not cents: this is what an input's value starts as. */
  amountText: string
  txnDate: string
  dueDate: string
  refNumber: string
  included: boolean
}

/**
 * What the user changed. Sparse ON PURPOSE: `undefined` means "not touched" and therefore "take the
 * seed", while `null` on vendorId means "the user cleared it". Collapsing those two into one value
 * would make a late recon match silently overwrite a deliberate clear.
 */
export interface ReviewEdit {
  entryType?: PostingEntryType
  vendorId?: string | null
  categoryAccountId?: string | null
  paidFromAccountId?: string | null
  amountText?: string
  txnDate?: string
  dueDate?: string
  refNumber?: string
  included?: boolean
}

/** A row as the grid renders it and as toPostingRows reads it. */
export interface ReviewRow {
  fileHash: string
  filename: string
  scanStatus: ScanFileStatus
  parse?: ParseFileResult
  parsed?: ParsedFields
  entryType: PostingEntryType
  vendorId: string | null
  vendorConfidence: MatchConfidence | null
  vendorCandidates: MatchCandidate[]
  categoryAccountId: string | null
  categoryConfidence: MatchConfidence | null
  categoryCandidates: MatchCandidate[]
  paidFromAccountId: string | null
  amountText: string
  /** null while the text is not a usable amount. Integer cents otherwise, never a float. */
  amountCents: number | null
  txnDate: string
  dueDate: string
  refNumber: string
  included: boolean
}

/**
 * Should this row start in the batch?
 *
 * A parse-failed row starts OUT: there is nothing to send. Starting it on would put a permanently
 * incomplete row in the batch and disable the Send button until the user found and unticked it,
 * which reads as the app being broken rather than as one document being unreadable. The user can
 * still tick it and type the fields in by hand, which is why it is a row at all.
 *
 * A duplicate-excluded row starts IN, and that is not a contradiction of Phase 2's default-off
 * rule: an already-entered file only reaches the review table at all once the user has clicked
 * "Include anyway", so being here IS the opt-in. The default-off half of that rule lives one layer
 * up, in BillsScreen's reviewableFiles, which keeps such a file out of the table until then.
 * Ticking a box the user just ticked by another name would be the confusing version.
 */
export function defaultIncluded(file: ScanFile, parse?: ParseFileResult): boolean {
  if (parse?.status === 'parse-failed') return false
  return file.status === 'loaded' || file.status === 'duplicate-excluded'
}

/**
 * Build one row's seed from the scan and the parse.
 *
 * The entry date defaults to the BATCH PROCESSING DATE, not to the invoice date on the document.
 * That is the date the user chose by scanning today, it is what Phase 2 already showed them, and
 * an invoice date read off a photo is exactly the value most likely to be wrong. It stays editable,
 * and the document's own date is printed right above the field, so overriding it is one glance.
 */
export function seedRow(
  file: ScanFile,
  batchEntryDate: string,
  parse?: ParseFileResult
): ReviewSeed {
  const parsed = parse?.status === 'parse-failed' ? undefined : parse?.fields
  return {
    fileHash: file.hash ?? '',
    filename: file.filename,
    scanStatus: file.status,
    parse,
    parsed,
    // Bill is the default because it is the safe one: a Bill needs nothing a parsed document does
    // not already give us, while an Expense needs a paid-from account the document never states.
    entryType: 'bill',
    vendorId: null,
    vendorConfidence: null,
    vendorCandidates: [],
    categoryAccountId: null,
    categoryConfidence: null,
    categoryCandidates: [],
    amountText: typeof parsed?.totalCents === 'number' ? centsToInput(parsed.totalCents) : '',
    txnDate: batchEntryDate,
    dueDate: parsed?.dueDate ?? '',
    refNumber: parsed?.invoiceNumber ?? '',
    included: defaultIncluded(file, parse)
  }
}

/**
 * Seed every reviewable row, in scan order, skipping anything that cannot be one.
 *
 * A file with no hash is skipped because the hash is the join key to the parse cache, to recon, and
 * to the posting ledger; a row without one cannot be sent, matched, or deduped. A REPEATED hash is
 * skipped too: a byte-identical copy inside one scan is the same document, and two rows for it
 * would be refused whole by assertPostableRows at the moment of sending, after the user had already
 * filled both in.
 */
export function seedRows(
  files: readonly ScanFile[],
  batchEntryDate: string,
  parseResults: Readonly<Record<string, ParseFileResult>>
): ReviewSeed[] {
  const seeds: ReviewSeed[] = []
  const seen = new Set<string>()
  for (const file of files) {
    const hash = file.hash
    if (typeof hash !== 'string' || hash === '' || seen.has(hash)) continue
    seen.add(hash)
    seeds.push(seedRow(file, batchEntryDate, parseResults[hash]))
  }
  return seeds
}

/**
 * Lay reconciliation's answer over the seeds.
 *
 * The three tiers are rendered differently and therefore have to survive as data:
 *   'auto'      pre-selected, no marker. The match was confident and saying so would be noise.
 *   'suggested' pre-selected WITH a marker, so the user knows to glance at it.
 *   'none'      left empty with a marker, because an empty cell with no explanation reads as a bug.
 *
 * A row recon said nothing about keeps confidence null, which is a fourth, quieter state: recon did
 * not run, or it rejected. That row is plain manual selection with no marker at all, which is the
 * correct degradation. An error wall would be the wrong one: nothing is broken, the app just has no
 * suggestion to offer.
 */
export function applyMatches(
  seeds: readonly ReviewSeed[],
  matches: Readonly<Record<string, FileMatch>>
): ReviewSeed[] {
  return seeds.map((seed) => {
    const match = matches[seed.fileHash]
    if (!match) return seed
    return {
      ...seed,
      vendorId: match.vendor.confidence === 'none' ? null : match.vendor.selectedId,
      vendorConfidence: match.vendor.confidence,
      vendorCandidates: match.vendor.candidates ?? [],
      categoryAccountId: match.category.confidence === 'none' ? null : match.category.selectedId,
      categoryConfidence: match.category.confidence,
      categoryCandidates: match.category.candidates ?? []
    }
  })
}

/**
 * Collapse seed + edit into the row the grid renders and the sender reads. The user wins.
 *
 * The two cross-field rules live here so they hold for every row without any caller remembering:
 *
 *   A BILL HAS NO PAID-FROM ACCOUNT. A Bill is unpaid by definition, and main refuses the batch
 *   whole if one carries a paid-from account. Clearing it on resolve (rather than on the toggle's
 *   click handler) means it is also cleared for a row the user toggled to Expense, filled in, and
 *   toggled back, which is the exact sequence a click handler forgets.
 *
 *   AN EXPENSE HAS NO DUE DATE. Money that already left an account is not due later, and carrying a
 *   stale due date into a Purchase would put a date on the entry that means nothing.
 *
 * Both are reversible: the edit is preserved, so toggling back to Expense restores the account the
 * user picked instead of making them find it again.
 *
 * A vendor or category the user chose themselves drops its confidence marker. Once the human has
 * decided, "suggested match" is no longer true, and leaving the marker up would keep asking for a
 * decision that has been made.
 */
export function resolveRow(seed: ReviewSeed, edit: ReviewEdit = {}): ReviewRow {
  const entryType = edit.entryType ?? seed.entryType
  const vendorTouched = edit.vendorId !== undefined
  const categoryTouched = edit.categoryAccountId !== undefined
  const amountText = edit.amountText ?? seed.amountText

  return {
    fileHash: seed.fileHash,
    filename: seed.filename,
    scanStatus: seed.scanStatus,
    parse: seed.parse,
    parsed: seed.parsed,
    entryType,
    vendorId: vendorTouched ? (edit.vendorId ?? null) : seed.vendorId,
    vendorConfidence: vendorTouched ? null : seed.vendorConfidence,
    vendorCandidates: seed.vendorCandidates,
    categoryAccountId: categoryTouched ? (edit.categoryAccountId ?? null) : seed.categoryAccountId,
    categoryConfidence: categoryTouched ? null : seed.categoryConfidence,
    categoryCandidates: seed.categoryCandidates,
    paidFromAccountId: entryType === 'bill' ? null : (edit.paidFromAccountId ?? null),
    amountText,
    amountCents: parseMoneyToCents(amountText),
    txnDate: edit.txnDate ?? seed.txnDate,
    dueDate: entryType === 'expense' ? '' : (edit.dueDate ?? seed.dueDate),
    refNumber: edit.refNumber ?? seed.refNumber,
    included: edit.included ?? seed.included
  }
}

/** Resolve a whole grid. Rows keep scan order, which is the order the user saw them scanned. */
export function resolveRows(
  seeds: readonly ReviewSeed[],
  edits: Readonly<Record<string, ReviewEdit>>
): ReviewRow[] {
  return seeds.map((seed) => resolveRow(seed, edits[seed.fileHash]))
}

/**
 * The ONE thing this row still needs, in words a non-technical user can act on, or null when it is
 * ready. First gap only: a list of five problems on one row is a wall, and fixing the first
 * usually reveals whether the rest were real.
 *
 * Order is "what would confuse you first if it were missing", not schema order.
 */
export function rowGap(row: ReviewRow): string | null {
  if (row.vendorId === null || row.vendorId === '') return 'pick a vendor'
  if (row.categoryAccountId === null || row.categoryAccountId === '') return 'pick a category'
  if (row.amountCents === null) return 'enter an amount like 1336.00'
  // The unreadable-total case: a flagged 0 parses perfectly well and is not a bill.
  if (row.amountCents < MIN_AMOUNT_CENTS) return 'enter an amount greater than zero'
  if (row.amountCents > MAX_AMOUNT_CENTS) return 'check this amount, it looks far too large'
  if (!ISO_DATE.test(row.txnDate)) return 'pick an entry date'
  if (row.entryType === 'expense' && (row.paidFromAccountId === null || row.paidFromAccountId === ''))
    return 'pick the account that paid it'
  if (row.entryType === 'bill' && row.dueDate !== '' && !ISO_DATE.test(row.dueDate))
    return 'fix the due date'
  if (row.refNumber.length > REF_NUMBER_MAX)
    return `shorten the reference number to ${REF_NUMBER_MAX} characters or fewer`
  return null
}

/**
 * Should the amount field be marked as wrong?
 *
 * An EMPTY field is not wrong, it is unfinished, and marking every untouched row red on arrival
 * would make the screen look like a list of errors before the user has done anything. Everything
 * else that posting:send would refuse is marked: text, three decimal places, a negative, a zero
 * (the flagged unreadable-total case), and an absurd figure.
 */
export function amountFieldInvalid(row: ReviewRow): boolean {
  if (row.amountText.trim() === '') return false
  return !isPostableAmount(row.amountCents)
}

/** Is this row complete enough to send? */
export function isRowComplete(row: ReviewRow): boolean {
  return rowGap(row) === null
}

/** The rows that will actually be sent: included, in scan order. */
export function includedRows(rows: readonly ReviewRow[]): ReviewRow[] {
  return rows.filter((row) => row.included)
}

/**
 * Whether Send is available, and if not, the plain sentence that says why.
 *
 * The sentence names the FILE, because "one row is incomplete" in a list of twelve is a scavenger
 * hunt. Everything the gate refuses, main's assertPostableRows would also refuse, but it would
 * refuse the WHOLE BATCH after the user pressed the button, and a rejected batch is a much worse
 * way to learn that one amount did not parse.
 */
export function sendGate(rows: readonly ReviewRow[]): { canSend: boolean; reason: string | null } {
  const chosen = includedRows(rows)
  if (chosen.length === 0) {
    return { canSend: false, reason: 'Tick at least one bill to send it to QuickBooks.' }
  }

  const incomplete = chosen.filter((row) => !isRowComplete(row))
  if (incomplete.length > 0) {
    const first = incomplete[0]
    const gap = rowGap(first)
    const rest =
      incomplete.length === 1
        ? ''
        : ` Then ${incomplete.length - 1} more ${incomplete.length - 1 === 1 ? 'row needs' : 'rows need'} something too.`
    return { canSend: false, reason: `On ${first.filename}, ${gap}.${rest}` }
  }

  return { canSend: true, reason: null }
}

/** What the footer counts: how many rows, of which kinds, for how much money. */
export interface BatchTotals {
  rows: number
  bills: number
  expenses: number
  totalCents: number
}

/**
 * Count and total the INCLUDED rows only.
 *
 * A total that swept in excluded rows would tell the user they are about to enter money they are
 * not, on the one number they will check before pressing the button. Rows whose amount does not
 * parse contribute nothing rather than a zero, and the Send gate refuses the batch anyway.
 */
export function batchTotals(rows: readonly ReviewRow[]): BatchTotals {
  const chosen = includedRows(rows)
  return {
    rows: chosen.length,
    bills: chosen.filter((row) => row.entryType === 'bill').length,
    expenses: chosen.filter((row) => row.entryType === 'expense').length,
    totalCents: sumCents(
      chosen.map((row) => row.amountCents).filter((cents): cents is number => cents !== null)
    )
  }
}

/** The footer line: what is selected and what it comes to. */
export function batchSummaryLine(rows: readonly ReviewRow[]): string {
  const totals = batchTotals(rows)
  if (totals.rows === 0) return 'Nothing selected yet.'
  const noun = totals.rows === 1 ? 'bill' : 'bills'
  return `${totals.rows} ${noun} selected, ${formatCents(totals.totalCents)} in total`
}

/**
 * The confirmation sentence, which states exactly what pressing the button does.
 *
 * It names the split, because Bill and Expense are two different things in QuickBooks and a
 * mis-toggled row is the mistake this screen exists to catch. A confirmation that said only "Send 5
 * entries?" would confirm nothing the user did not already know.
 */
export function sendConfirmBody(rows: readonly ReviewRow[]): string {
  const totals = batchTotals(rows)
  const entries = `${totals.rows} ${totals.rows === 1 ? 'entry' : 'entries'}`
  const parts: string[] = []
  if (totals.bills > 0) parts.push(`${totals.bills} ${totals.bills === 1 ? 'bill' : 'bills'}`)
  if (totals.expenses > 0) {
    parts.push(`${totals.expenses} ${totals.expenses === 1 ? 'expense' : 'expenses'}`)
  }
  const split = parts.length === 0 ? '' : ` as ${parts.join(' and ')}`
  return `Send ${entries} to QuickBooks${split}, ${formatCents(totals.totalCents)} in total.`
}

/**
 * The approved rows as the posting payload, in scan order.
 *
 * Only included AND complete rows are assembled: an incomplete row cannot reach here because the
 * Send gate refuses first, and building it anyway would hand main a payload it rejects whole.
 * Empty strings become null, because the contract says null and '' would fail the schema's
 * .min(1) bounds on refNumber.
 */
export function toPostingRows(rows: readonly ReviewRow[]): PostingRow[] {
  const payload: PostingRow[] = []
  for (const row of rows) {
    if (!row.included) continue
    // The same bounds PostingRowSchema enforces, checked again here rather than trusted from the
    // gate: this function is what actually crosses the boundary, and a row that fails a schema
    // bound does not fail alone. posting:send rejects the WHOLE batch, and the Zod message is not
    // recoverable copy, so the user would meet a rejected batch with no sentence attached.
    if (!isPostableAmount(row.amountCents)) continue
    if (row.fileHash.length !== FILE_HASH_LENGTH) continue
    if (row.vendorId === null || row.categoryAccountId === null) continue
    payload.push({
      fileHash: row.fileHash,
      entryType: row.entryType,
      vendorId: row.vendorId,
      categoryAccountId: row.categoryAccountId,
      paidFromAccountId: row.entryType === 'expense' ? row.paidFromAccountId : null,
      txnDate: row.txnDate,
      dueDate: row.entryType === 'bill' && row.dueDate !== '' ? row.dueDate : null,
      refNumber: row.refNumber.trim() === '' ? null : row.refNumber.trim(),
      amountCents: row.amountCents,
      memo: null
    })
  }
  return payload
}

/**
 * The rows worth asking about: vendor, amount, and date all set.
 *
 * A probe on a half-filled row would query a vendor against an amount the user has not finished
 * typing, and warn about a bill that is not the one being entered. Inclusion is NOT a condition: a
 * user about to tick a row deserves the warning before they tick it, not after.
 *
 * The amount bounds are the same ones posting:send enforces, and skipping an out-of-range row here
 * is what keeps ONE bad row from silencing the whole batch. PostingCheckDuplicatesSchema validates
 * the probe ARRAY, so a single zero-amount probe (the flagged unreadable-total case again) rejects
 * every probe beside it, and the renderer's catch then clears the warnings for rows that had
 * perfectly good ones. A missing warning is invisible, which is the worst way for this to fail.
 */
export function duplicateProbes(rows: readonly ReviewRow[]): DuplicateProbe[] {
  const probes: DuplicateProbe[] = []
  for (const row of rows) {
    if (row.vendorId === null || row.vendorId === '') continue
    if (!isPostableAmount(row.amountCents)) continue
    if (row.fileHash === '') continue
    if (!ISO_DATE.test(row.txnDate)) continue
    probes.push({
      rowKey: row.fileHash,
      vendorId: row.vendorId,
      amountCents: row.amountCents,
      txnDate: row.txnDate
    })
  }
  return probes
}

/**
 * The warning line for a row that matches something already in QuickBooks.
 *
 * It says WHEN, because "this might be a duplicate" with no date is unfalsifiable: the user cannot
 * check it, so they learn to click past it. The ledger's posted-at timestamp is preferred over the
 * entry's transaction date, because "when did I send this" is the question a person can actually
 * answer from memory. It never blocks: the user is the one who knows whether the vendor billed
 * twice.
 */
export function duplicateNoticeLine(warnings: readonly DuplicateWarning[]): string | null {
  if (warnings.length === 0) return null
  const first = warnings[0]
  const when = (first.postedAt ?? first.txnDate).slice(0, 10)
  if (warnings.length === 1) return `Looks like this was already sent on ${when}.`
  return `Looks like this was already sent ${warnings.length} times, first on ${when}.`
}

/**
 * Does this row want the user's eyes? The predicate behind the "needs attention" filter.
 *
 * Four reasons, and the filter deliberately unions them rather than offering four filters: the
 * question a user asks is "what still needs me", not "which of these four categories".
 */
export function needsAttention(row: ReviewRow, duplicateCount = 0, busy = false): boolean {
  if (row.parse?.status === 'parse-failed') return true
  if (isFlagged(row.parse)) return true
  // Mid-parse every row is legitimately incomplete, so counting that as needing attention would put
  // the whole batch behind the filter and tell the user all of it needs them, seconds before it
  // does not. The other three reasons are true whether or not the reading has finished.
  if (!busy && row.included && !isRowComplete(row)) return true
  if (duplicateCount > 0) return true
  return false
}

/**
 * Untick every row QuickBooks CONFIRMED, leaving exactly the failures ticked.
 *
 * A batch where three of five went in leaves the user in a specific place: two entries still need
 * sending and three are already in the books. Leaving all five ticked would offer a second send of
 * entries that already exist. Main's ledger guard would refuse each of those (POSTING_ALREADY_
 * ENTERED), so nothing would double-post, but the honest place to prevent it is the box the user is
 * looking at, not an error they meet afterwards.
 *
 * Only 'confirmed' unticks. A row that is 'sent' but not confirmed is one whose outcome is not
 * known, and unticking it would tell the user it is in QuickBooks when the whole point of keeping
 * those states separate is that nobody knows yet.
 */
export function untickConfirmedRows(
  edits: Readonly<Record<string, ReviewEdit>>,
  states: Readonly<Record<string, PostingEntryState>>
): Record<string, ReviewEdit> {
  const next = { ...edits }
  for (const [fileHash, state] of Object.entries(states)) {
    if (state !== 'confirmed') continue
    next[fileHash] = { ...next[fileHash], included: false }
  }
  return next
}

/** The rows the "needs attention" filter keeps. */
export function attentionRows(
  rows: readonly ReviewRow[],
  duplicates: Readonly<Record<string, DuplicateWarning[]>>,
  busy = false
): ReviewRow[] {
  return rows.filter((row) => needsAttention(row, duplicates[row.fileHash]?.length ?? 0, busy))
}
