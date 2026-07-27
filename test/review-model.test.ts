// test/review-model.test.ts
//
// The rules that decide WHAT GETS SENT to somebody's books.
//
// Every function under test is pure, so this file needs no DOM and no rendering: the rendering half
// of the same guarantees lives in test/review-table.test.ts. What is pinned here is the behaviour a
// design pass must not be able to break by moving a div.
//
// Four properties carry most of the weight:
//
//   MONEY IS NEVER A FLOAT. The classic '1336.57' -> 133656.99999999999 is asserted directly,
//   because PostingRowSchema refuses a non-integer amountCents and the user would meet that as a
//   whole batch rejected for a bill they typed correctly.
//
//   THE USER'S EDIT ALWAYS WINS. Reconciliation can land late and a re-parse can land later. Both
//   overlay the SEED, never the edit, so a correction made at second three survives an answer that
//   arrives at second five. This is the bug the three-layer model exists to prevent.
//
//   A BILL HAS NO PAID-FROM ACCOUNT AND AN EXPENSE HAS NO DUE DATE. Both are enforced on resolve
//   rather than in a click handler, so they also hold for the row a user toggled, filled in, and
//   toggled back, which is the sequence a click handler forgets.
//
//   THE SEND GATE REFUSES WHAT MAIN WOULD REFUSE, FIRST. assertPostableRows rejects a batch WHOLE.
//   Catching the same conditions here means the user fixes one field instead of losing a batch.

import { describe, expect, it } from 'vitest'
import { centsToInput, formatCents, parseMoneyToCents, sumCents } from '../src/renderer/src/lib/money'
import {
  applyMatches,
  attentionRows,
  batchSummaryLine,
  batchTotals,
  defaultIncluded,
  duplicateNoticeLine,
  duplicateProbes,
  includedRows,
  isRowComplete,
  resolveRow,
  resolveRows,
  rowGap,
  seedRow,
  seedRows,
  sendConfirmBody,
  sendGate,
  toPostingRows,
  type ReviewEdit,
  type ReviewSeed
} from '../src/renderer/src/review/model'
import type {
  DuplicateWarning,
  FileMatch,
  ParseFileResult,
  ParsedFields,
  ScanFile
} from '../src/shared/ipc-contract'

const HASH_A = 'a'.repeat(64)
const HASH_B = 'b'.repeat(64)
const BATCH_DATE = '2026-07-27'

function fields(overrides: Partial<ParsedFields> = {}): ParsedFields {
  return {
    vendor: 'Nassau Plumbing Supply',
    invoiceNumber: 'INV-2026-0417',
    invoiceDate: '2026-07-14',
    dueDate: '2026-08-14',
    subtotalCents: 123410,
    taxCents: 10190,
    totalCents: 133600,
    currency: 'USD',
    suggestedCategory: 'Job Materials',
    ...overrides
  }
}

function parsed(overrides: Partial<ParseFileResult> = {}): ParseFileResult {
  return {
    filename: 'nassau-plumbing-0417.pdf',
    hash: HASH_A,
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
    hash: HASH_A,
    sizeBytes: 2048,
    ...overrides
  }
}

function match(overrides: Partial<FileMatch> = {}): FileMatch {
  return {
    vendor: {
      selectedId: '42',
      selectedName: 'Nassau Plumbing Supply',
      confidence: 'auto',
      candidates: [{ id: '42', name: 'Nassau Plumbing Supply', score: 0.98 }]
    },
    category: {
      selectedId: '7',
      selectedName: 'Job Expenses:Job Materials',
      confidence: 'auto',
      candidates: [{ id: '7', name: 'Job Expenses:Job Materials', score: 0.91 }]
    },
    ...overrides
  }
}

/** A seed that is one edit away from being sendable, so each gap can be tested in isolation. */
function readySeed(overrides: Partial<ReviewSeed> = {}): ReviewSeed {
  return {
    ...seedRow(scanFile(), BATCH_DATE, parsed()),
    vendorId: '42',
    categoryAccountId: '7',
    ...overrides
  }
}

function row(seedOverrides: Partial<ReviewSeed> = {}, edit: ReviewEdit = {}): ReturnType<typeof resolveRow> {
  return resolveRow(readySeed(seedOverrides), edit)
}

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

describe('money never becomes a float', () => {
  it.each([
    ['1336', 133600],
    ['1336.00', 133600],
    ['1336.5', 133650],
    ['1336.57', 133657],
    ['1,336.00', 133600],
    ['$1,336.00', 133600],
    ['  1336.00  ', 133600],
    ['0.01', 1],
    ['0', 0]
  ])('reads %s as %i cents', (input, cents) => {
    expect(parseMoneyToCents(input)).toBe(cents)
  })

  it.each([
    ['8.29', 829],
    ['19.99', 1999],
    ['4.35', 435],
    ['2.03', 203]
  ])('is exact for %s, where multiplying by 100 is not', (input, cents) => {
    // The bug this module exists to prevent, in one line: Number('8.29') * 100 is
    // 828.9999999999999, PostingRowSchema refuses it as a non-integer, and the user meets that as
    // a whole batch rejected for an amount they typed correctly.
    expect(Number.isInteger(Number(input) * 100)).toBe(false)
    expect(parseMoneyToCents(input)).toBe(cents)
    expect(Number.isInteger(parseMoneyToCents(input) as number)).toBe(true)
  })

  it.each([
    ['', 'an empty field, which is a normal half-typed state'],
    ['13.', 'a trailing separator'],
    ['abc', 'text'],
    ['1336.567', 'three decimal places, which this app does not silently round'],
    ['-50.00', 'a negative, which is a credit memo and not something this app posts'],
    ['1e5', 'exponent notation'],
    ['$', 'a lone currency symbol']
  ])('refuses %s (%s)', (input) => {
    expect(parseMoneyToCents(input)).toBeNull()
  })

  it.each([
    [0, '$0.00'],
    [1, '$0.01'],
    [133600, '$1,336.00'],
    [123456789, '$1,234,567.89']
  ])('prints %i as %s', (cents, printed) => {
    expect(formatCents(cents)).toBe(printed)
  })

  it('round trips cents through the editable field and back', () => {
    for (const cents of [0, 1, 99, 100, 12345, 133600, 123456789]) {
      expect(parseMoneyToCents(centsToInput(cents))).toBe(cents)
    }
  })

  it('sums integers exactly', () => {
    expect(sumCents([1, 2, 3])).toBe(6)
    expect(sumCents([])).toBe(0)
    expect(sumCents([133657, 10])).toBe(133667)
  })
})

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

describe('seedRow starts a row from the document', () => {
  it('fills the amount, the due date, and the reference from the parse', () => {
    const seed = seedRow(scanFile(), BATCH_DATE, parsed())
    expect(seed.amountText).toBe('1336.00')
    expect(parseMoneyToCents(seed.amountText)).toBe(133600)
    expect(seed.dueDate).toBe('2026-08-14')
    expect(seed.refNumber).toBe('INV-2026-0417')
  })

  it('defaults the entry date to the BATCH date, not to the invoice date on the page', () => {
    // The invoice date read off a photo is exactly the value most likely to be wrong, and the batch
    // date is the one the user chose by scanning today.
    const seed = seedRow(scanFile(), BATCH_DATE, parsed())
    expect(seed.txnDate).toBe(BATCH_DATE)
    expect(seed.txnDate).not.toBe(fields().invoiceDate)
  })

  it('defaults to Bill, the type that needs nothing the document does not have', () => {
    expect(seedRow(scanFile(), BATCH_DATE, parsed()).entryType).toBe('bill')
  })

  it('leaves vendor and category empty until reconciliation or the user fills them', () => {
    const seed = seedRow(scanFile(), BATCH_DATE, parsed())
    expect(seed.vendorId).toBeNull()
    expect(seed.categoryAccountId).toBeNull()
    expect(seed.vendorConfidence).toBeNull()
  })

  it('keeps the parse whole, so the row can print what the document said', () => {
    const parse = parsed({ validationFlags: ['money:totalCents'] })
    expect(seedRow(scanFile(), BATCH_DATE, parse).parse).toBe(parse)
    expect(seedRow(scanFile(), BATCH_DATE, parse).parsed).toEqual(fields())
  })

  it('carries no fields for a failed read, so nothing invented is displayed as parsed', () => {
    const failed: ParseFileResult = {
      filename: 'blurry.jpg',
      hash: HASH_A,
      status: 'parse-failed',
      error: 'Could not read this bill.'
    }
    const seed = seedRow(scanFile(), BATCH_DATE, failed)
    expect(seed.parsed).toBeUndefined()
    expect(seed.amountText).toBe('')
  })

  it('handles a document with no total at all', () => {
    const seed = seedRow(scanFile(), BATCH_DATE, parsed({ fields: fields({ dueDate: null, invoiceNumber: null }) }))
    expect(seed.dueDate).toBe('')
    expect(seed.refNumber).toBe('')
  })
})

describe('defaultIncluded', () => {
  it('puts a loaded, readable document in the batch', () => {
    expect(defaultIncluded(scanFile(), parsed())).toBe(true)
  })

  it('leaves a document the model could not read OUT of the batch', () => {
    // There is nothing to send, and a permanently incomplete row would disable Send until the user
    // hunted it down, which reads as the app being broken.
    const failed: ParseFileResult = { filename: 'x.jpg', hash: HASH_A, status: 'parse-failed' }
    expect(defaultIncluded(scanFile(), failed)).toBe(false)
  })

  it('includes an already-entered duplicate, because reaching this table IS the opt-in', () => {
    // Phase 2's default-off rule is enforced one layer up: such a file is not in the review table
    // at all until the user clicks Include anyway.
    expect(defaultIncluded(scanFile({ status: 'duplicate-excluded' }), parsed())).toBe(true)
  })

  it('never includes a file that was skipped outright', () => {
    expect(defaultIncluded(scanFile({ status: 'unsupported-skipped' }))).toBe(false)
    expect(defaultIncluded(scanFile({ status: 'not-ready-skipped' }))).toBe(false)
    expect(defaultIncluded(scanFile({ status: 'duplicate-in-batch' }))).toBe(false)
  })
})

describe('seedRows', () => {
  it('keeps scan order', () => {
    const files = [scanFile({ filename: 'one.pdf' }), scanFile({ filename: 'two.pdf', hash: HASH_B })]
    expect(seedRows(files, BATCH_DATE, {}).map((seed) => seed.filename)).toEqual([
      'one.pdf',
      'two.pdf'
    ])
  })

  it('skips a file with no hash, because the hash is the join key to everything', () => {
    const files = [scanFile({ filename: 'nohash.pdf', hash: undefined })]
    expect(seedRows(files, BATCH_DATE, {})).toHaveLength(0)
  })

  it('skips a REPEATED hash, which would be the same document twice', () => {
    // assertPostableRows refuses the whole batch for a repeated file hash, and it would do it after
    // the user had filled both rows in.
    const files = [scanFile({ filename: 'one.pdf' }), scanFile({ filename: 'copy.pdf' })]
    expect(seedRows(files, BATCH_DATE, {})).toHaveLength(1)
  })

  it('attaches each file its own parse result by hash', () => {
    const files = [scanFile(), scanFile({ filename: 'two.pdf', hash: HASH_B })]
    const seeds = seedRows(files, BATCH_DATE, {
      [HASH_A]: parsed(),
      [HASH_B]: parsed({ hash: HASH_B, fields: fields({ totalCents: 5000 }) })
    })
    expect(seeds[0].amountText).toBe('1336.00')
    expect(seeds[1].amountText).toBe('50.00')
  })
})

// ---------------------------------------------------------------------------
// Reconciliation prefill
// ---------------------------------------------------------------------------

describe('applyMatches renders the three confidence tiers as three different states', () => {
  const seeds = [seedRow(scanFile(), BATCH_DATE, parsed())]

  it('auto: pre-selected, and marked in no way at all', () => {
    const [seed] = applyMatches(seeds, { [HASH_A]: match() })
    expect(seed.vendorId).toBe('42')
    expect(seed.vendorConfidence).toBe('auto')
    expect(seed.categoryAccountId).toBe('7')
  })

  it('suggested: pre-selected AND carrying the confidence so the row can mark it', () => {
    const suggested = match({
      vendor: { ...match().vendor, confidence: 'suggested' }
    })
    const [seed] = applyMatches(seeds, { [HASH_A]: suggested })
    expect(seed.vendorId).toBe('42')
    expect(seed.vendorConfidence).toBe('suggested')
  })

  it('none: left EMPTY even if a selectedId somehow came back with it', () => {
    // A cell pre-filled from a match the reconciler itself called 'none' would be a guess wearing
    // the same clothes as a confident answer.
    const none = match({
      vendor: { selectedId: '42', selectedName: 'Maybe', confidence: 'none', candidates: [] }
    })
    const [seed] = applyMatches(seeds, { [HASH_A]: none })
    expect(seed.vendorId).toBeNull()
    expect(seed.vendorConfidence).toBe('none')
  })

  it('keeps the ranked candidates, which are what float to the top of the dropdown', () => {
    const ranked = match({
      category: {
        selectedId: '7',
        selectedName: 'Job Expenses:Job Materials',
        confidence: 'suggested',
        candidates: [
          { id: '7', name: 'Job Expenses:Job Materials', score: 0.8 },
          { id: '9', name: 'Job Expenses:Equipment Rental', score: 0.4 }
        ]
      }
    })
    const [seed] = applyMatches(seeds, { [HASH_A]: ranked })
    expect(seed.categoryCandidates.map((candidate) => candidate.id)).toEqual(['7', '9'])
  })

  it('leaves a row recon said nothing about completely unmarked', () => {
    // Recon rejected, or has not answered yet. That is manual selection with no marker, not an
    // error: nothing is broken, the app just has no suggestion to offer.
    const [seed] = applyMatches(seeds, {})
    expect(seed.vendorId).toBeNull()
    expect(seed.vendorConfidence).toBeNull()
    expect(seed.categoryConfidence).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// resolveRow: the user wins, and the cross-field rules hold
// ---------------------------------------------------------------------------

describe('resolveRow lets the user overrule everything', () => {
  it('takes the seed when nothing was edited', () => {
    expect(row().vendorId).toBe('42')
    expect(row().amountText).toBe('1336.00')
  })

  it('takes the edit when there is one', () => {
    expect(row({}, { vendorId: '99' }).vendorId).toBe('99')
    expect(row({}, { amountText: '20.00' }).amountCents).toBe(2000)
  })

  it('distinguishes "not touched" from "cleared on purpose"', () => {
    // undefined means take the seed; null means the user emptied the cell and a late match must
    // not quietly fill it back in.
    expect(row({ vendorId: '42' }, {}).vendorId).toBe('42')
    expect(row({ vendorId: '42' }, { vendorId: null }).vendorId).toBeNull()
  })

  it('drops the confidence marker once the human has decided', () => {
    const seed = readySeed({ vendorConfidence: 'suggested' })
    expect(resolveRow(seed, {}).vendorConfidence).toBe('suggested')
    expect(resolveRow(seed, { vendorId: '99' }).vendorConfidence).toBeNull()
  })
})

describe('the Bill and Expense cross-field rules hold by construction', () => {
  it('a bill has no paid-from account, even when one was picked earlier', () => {
    const resolved = row({}, { entryType: 'bill', paidFromAccountId: '35' })
    expect(resolved.paidFromAccountId).toBeNull()
  })

  it('an expense keeps the account that paid it', () => {
    expect(row({}, { entryType: 'expense', paidFromAccountId: '35' }).paidFromAccountId).toBe('35')
  })

  it('an expense has no due date, because money already gone is not due later', () => {
    expect(row({}, { entryType: 'expense', paidFromAccountId: '35' }).dueDate).toBe('')
  })

  it('toggling to Expense, picking an account, and toggling back CLEARS it', () => {
    // The sequence a click handler forgets, which is why the rule lives on resolve.
    const edit: ReviewEdit = { entryType: 'expense', paidFromAccountId: '35' }
    expect(row({}, edit).paidFromAccountId).toBe('35')
    expect(row({}, { ...edit, entryType: 'bill' }).paidFromAccountId).toBeNull()
  })

  it('toggling back to Expense restores the account instead of making them find it again', () => {
    const edit: ReviewEdit = { entryType: 'bill', paidFromAccountId: '35' }
    expect(row({}, { ...edit, entryType: 'expense' }).paidFromAccountId).toBe('35')
  })

  it('restores the due date when a row goes back to being a Bill', () => {
    const asExpense = row({}, { entryType: 'expense', paidFromAccountId: '35' })
    expect(asExpense.dueDate).toBe('')
    expect(row({}, { entryType: 'bill' }).dueDate).toBe('2026-08-14')
  })
})

// ---------------------------------------------------------------------------
// Completeness and the Send gate
// ---------------------------------------------------------------------------

describe('rowGap names the ONE thing still missing, in words', () => {
  it('is null for a complete bill', () => {
    expect(rowGap(row())).toBeNull()
    expect(isRowComplete(row())).toBe(true)
  })

  it.each([
    [{ vendorId: null } as Partial<ReviewSeed>, {}, 'pick a vendor'],
    [{ categoryAccountId: null } as Partial<ReviewSeed>, {}, 'pick a category'],
    [{}, { amountText: '' }, 'enter an amount like 1336.00'],
    [{}, { amountText: 'about twenty dollars' }, 'enter an amount like 1336.00'],
    [{}, { txnDate: '' }, 'pick an entry date'],
    [{}, { entryType: 'expense' as const }, 'pick the account that paid it'],
    [{}, { dueDate: 'next month' }, 'fix the due date'],
    [{}, { refNumber: 'x'.repeat(22) }, 'shorten the reference number to 21 characters or fewer']
  ])('says %#: %s', (seedOverrides, edit, expected) => {
    expect(rowGap(row(seedOverrides as Partial<ReviewSeed>, edit as ReviewEdit))).toBe(expected)
  })

  it('accepts a reference number exactly at the QuickBooks limit', () => {
    expect(rowGap(row({}, { refNumber: 'x'.repeat(21) }))).toBeNull()
  })

  it('accepts a bill with no due date at all, which is normal', () => {
    expect(rowGap(row({}, { dueDate: '' }))).toBeNull()
  })
})

describe('sendGate', () => {
  it('refuses an empty batch, and says what to do about it', () => {
    const gate = sendGate([row({}, { included: false })])
    expect(gate.canSend).toBe(false)
    expect(gate.reason).toBe('Tick at least one bill to send it to QuickBooks.')
  })

  it('allows a batch where every included row is complete', () => {
    expect(sendGate([row(), row({ fileHash: HASH_B })])).toEqual({ canSend: true, reason: null })
  })

  it('names the FILE and the gap, because "one row is incomplete" is a scavenger hunt', () => {
    const gate = sendGate([row({ vendorId: null })])
    expect(gate.canSend).toBe(false)
    expect(gate.reason).toBe('On nassau-plumbing-0417.pdf, pick a vendor.')
  })

  it('counts the rest rather than listing them all', () => {
    const gate = sendGate([row({ vendorId: null }), row({ fileHash: HASH_B, categoryAccountId: null })])
    expect(gate.reason).toContain('On nassau-plumbing-0417.pdf, pick a vendor.')
    expect(gate.reason).toContain('1 more row needs something too.')
  })

  it('ignores an incomplete row the user EXCLUDED, which is how you get past a bad scan', () => {
    const gate = sendGate([row(), row({ fileHash: HASH_B, vendorId: null }, { included: false })])
    expect(gate.canSend).toBe(true)
  })

  it('refuses an expense with no paid-from account, which main would refuse WHOLE', () => {
    // assertPostableRows throws POSTING_EXPENSE_NEEDS_ACCOUNT and rejects the entire batch.
    const gate = sendGate([row({}, { entryType: 'expense' })])
    expect(gate.canSend).toBe(false)
    expect(gate.reason).toContain('pick the account that paid it')
  })
})

// ---------------------------------------------------------------------------
// The footer, the confirmation, and the payload
// ---------------------------------------------------------------------------

describe('the batch footer counts only what will be sent', () => {
  it('totals the included rows', () => {
    const rows = [row(), row({ fileHash: HASH_B }, { amountText: '10.00' })]
    expect(batchTotals(rows)).toEqual({ rows: 2, bills: 2, expenses: 0, totalCents: 134600 })
  })

  it('leaves excluded rows out of the money, which is the number the user checks', () => {
    const rows = [row(), row({ fileHash: HASH_B }, { amountText: '10.00', included: false })]
    expect(batchTotals(rows).totalCents).toBe(133600)
    expect(includedRows(rows)).toHaveLength(1)
  })

  it('splits bills from expenses', () => {
    const rows = [row(), row({ fileHash: HASH_B }, { entryType: 'expense', paidFromAccountId: '35' })]
    expect(batchTotals(rows)).toMatchObject({ bills: 1, expenses: 1 })
  })

  it('contributes nothing for a row whose amount does not parse', () => {
    expect(batchTotals([row({}, { amountText: 'twenty' })]).totalCents).toBe(0)
  })

  it('reads as a sentence', () => {
    expect(batchSummaryLine([row()])).toBe('1 bill selected, $1,336.00 in total')
    expect(batchSummaryLine([row(), row({ fileHash: HASH_B })])).toBe(
      '2 bills selected, $2,672.00 in total'
    )
    expect(batchSummaryLine([row({}, { included: false })])).toBe('Nothing selected yet.')
  })
})

describe('the confirmation states exactly what pressing the button does', () => {
  it('names the count, the split, and the money', () => {
    const rows = [
      row(),
      row({ fileHash: HASH_B }),
      row({ fileHash: 'c'.repeat(64) }, { entryType: 'expense', paidFromAccountId: '35', amountText: '10.00' })
    ]
    expect(sendConfirmBody(rows)).toBe(
      'Send 3 entries to QuickBooks as 2 bills and 1 expense, $2,682.00 in total.'
    )
  })

  it('uses the singular for one entry', () => {
    expect(sendConfirmBody([row()])).toBe(
      'Send 1 entry to QuickBooks as 1 bill, $1,336.00 in total.'
    )
  })

  it('omits a kind that is not in the batch', () => {
    const expense = row({}, { entryType: 'expense', paidFromAccountId: '35' })
    expect(sendConfirmBody([expense])).toContain('as 1 expense')
    expect(sendConfirmBody([expense])).not.toContain('bill')
  })
})

describe('toPostingRows builds exactly what posting:send accepts', () => {
  it('assembles a bill', () => {
    expect(toPostingRows([row()])).toEqual([
      {
        fileHash: HASH_A,
        entryType: 'bill',
        vendorId: '42',
        categoryAccountId: '7',
        paidFromAccountId: null,
        txnDate: BATCH_DATE,
        dueDate: '2026-08-14',
        refNumber: 'INV-2026-0417',
        amountCents: 133600,
        memo: null
      }
    ])
  })

  it('assembles an expense with its paid-from account and no due date', () => {
    const [assembled] = toPostingRows([
      row({}, { entryType: 'expense', paidFromAccountId: '35' })
    ])
    expect(assembled).toMatchObject({
      entryType: 'expense',
      paidFromAccountId: '35',
      dueDate: null
    })
  })

  it('sends integer cents, never a float, for an amount that would round badly', () => {
    const [assembled] = toPostingRows([row({}, { amountText: '1336.57' })])
    expect(assembled.amountCents).toBe(133657)
    expect(Number.isInteger(assembled.amountCents)).toBe(true)
  })

  it('turns an empty reference number into null, which is what the schema wants', () => {
    expect(toPostingRows([row({}, { refNumber: '   ' })])[0].refNumber).toBeNull()
    expect(toPostingRows([row({}, { refNumber: ' INV-9 ' })])[0].refNumber).toBe('INV-9')
  })

  it('leaves out every row the user excluded', () => {
    const rows = [row(), row({ fileHash: HASH_B }, { included: false })]
    expect(toPostingRows(rows).map((posting) => posting.fileHash)).toEqual([HASH_A])
  })

  it('keeps scan order, so the batch reads in the order the user reviewed it', () => {
    const rows = [row(), row({ fileHash: HASH_B })]
    expect(toPostingRows(rows).map((posting) => posting.fileHash)).toEqual([HASH_A, HASH_B])
  })

  it('never emits an incomplete row, even if a caller skipped the gate', () => {
    expect(toPostingRows([row({ vendorId: null })])).toHaveLength(0)
    expect(toPostingRows([row({}, { amountText: '' })])).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Duplicates and the attention filter
// ---------------------------------------------------------------------------

function warning(overrides: Partial<DuplicateWarning> = {}): DuplicateWarning {
  return {
    batchId: 'batch-1',
    fileHash: HASH_B,
    filename: 'nassau-plumbing-copy.pdf',
    entryType: 'bill',
    qboId: '55',
    vendorId: '42',
    vendorName: 'Nassau Plumbing Supply',
    amountCents: 133600,
    txnDate: '2026-07-25',
    daysApart: -2,
    postedAt: '2026-07-25T14:03:00.000Z',
    ...overrides
  }
}

describe('duplicateProbes only asks about rows worth asking about', () => {
  it('probes a row with a vendor, an amount, and a date', () => {
    expect(duplicateProbes([row()])).toEqual([
      { rowKey: HASH_A, vendorId: '42', amountCents: 133600, txnDate: BATCH_DATE }
    ])
  })

  it('skips a half-filled row, which would warn about a bill that is not being entered', () => {
    expect(duplicateProbes([row({ vendorId: null })])).toHaveLength(0)
    expect(duplicateProbes([row({}, { amountText: '13.' })])).toHaveLength(0)
    expect(duplicateProbes([row({}, { txnDate: '' })])).toHaveLength(0)
  })

  it('probes an EXCLUDED row too, so the warning arrives before the user ticks it', () => {
    expect(duplicateProbes([row({}, { included: false })])).toHaveLength(1)
  })
})

describe('duplicateNoticeLine says when, so the claim is checkable', () => {
  it('is null when there is nothing to say', () => {
    expect(duplicateNoticeLine([])).toBeNull()
  })

  it('names the date it was sent', () => {
    expect(duplicateNoticeLine([warning()])).toBe('Looks like this was already sent on 2026-07-25.')
  })

  it('falls back to the entry date when the ledger row was cleared', () => {
    expect(duplicateNoticeLine([warning({ postedAt: null })])).toBe(
      'Looks like this was already sent on 2026-07-25.'
    )
  })

  it('counts repeats', () => {
    expect(duplicateNoticeLine([warning(), warning({ fileHash: 'c'.repeat(64) })])).toBe(
      'Looks like this was already sent 2 times, first on 2026-07-25.'
    )
  })
})

describe('the needs-attention filter unions every reason a row wants you', () => {
  it('keeps a row with a failed deterministic check', () => {
    const flagged = row({ parse: parsed({ validationFlags: ['money:totalCents'] }) })
    expect(attentionRows([flagged], {})).toHaveLength(1)
  })

  it('keeps a row the model could not read', () => {
    const failed = row({
      parse: { filename: 'x.jpg', hash: HASH_A, status: 'parse-failed', error: 'no' }
    })
    expect(attentionRows([failed], {})).toHaveLength(1)
  })

  it('keeps an included row that is still missing something', () => {
    expect(attentionRows([row({ vendorId: null })], {})).toHaveLength(1)
  })

  it('keeps a row that looks like a duplicate', () => {
    expect(attentionRows([row()], { [HASH_A]: [warning()] })).toHaveLength(1)
  })

  it('drops a clean, complete, included row', () => {
    expect(attentionRows([row()], {})).toHaveLength(0)
  })

  it('drops an EXCLUDED incomplete row, which is not asking for anything', () => {
    expect(attentionRows([row({ vendorId: null }, { included: false })], {})).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// House copy rules
// ---------------------------------------------------------------------------

describe('every sentence this module produces obeys the house copy rules', () => {
  it('uses no em dashes and no en dashes', () => {
    const sentences = [
      batchSummaryLine([row()]),
      batchSummaryLine([]),
      sendConfirmBody([row()]),
      sendGate([]).reason ?? '',
      sendGate([row({ vendorId: null })]).reason ?? '',
      sendGate([row({ vendorId: null }), row({ fileHash: HASH_B, categoryAccountId: null })]).reason ?? '',
      duplicateNoticeLine([warning()]) ?? '',
      duplicateNoticeLine([warning(), warning()]) ?? '',
      rowGap(row({ vendorId: null })) ?? '',
      rowGap(row({ categoryAccountId: null })) ?? '',
      rowGap(row({}, { amountText: '' })) ?? '',
      rowGap(row({}, { txnDate: '' })) ?? '',
      rowGap(row({}, { entryType: 'expense' })) ?? '',
      rowGap(row({}, { refNumber: 'x'.repeat(30) })) ?? ''
    ]
    for (const sentence of sentences) {
      expect(sentence).not.toMatch(/[—–]/)
      expect(sentence.length).toBeGreaterThan(0)
    }
  })
})

// ---------------------------------------------------------------------------
// The property the three-layer model exists for
// ---------------------------------------------------------------------------

describe('a late answer never overwrites what the user already decided', () => {
  it('keeps the user vendor when reconciliation lands afterwards', () => {
    // The real sequence: the row renders, the user picks a vendor at second three, recon answers at
    // second five. A flat state of finished rows would lose the correction here.
    const seeds = [seedRow(scanFile(), BATCH_DATE, parsed())]
    const edits = { [HASH_A]: { vendorId: '99' } }

    const beforeMatch = resolveRows(seeds, edits)
    expect(beforeMatch[0].vendorId).toBe('99')

    const afterMatch = resolveRows(applyMatches(seeds, { [HASH_A]: match() }), edits)
    expect(afterMatch[0].vendorId).toBe('99')
  })

  it('keeps the user amount when a re-parse lands afterwards', () => {
    const edits = { [HASH_A]: { amountText: '20.00' } }
    const reparsed = seedRows([scanFile()], BATCH_DATE, {
      [HASH_A]: parsed({ fields: fields({ totalCents: 999999 }) })
    })
    expect(resolveRows(reparsed, edits)[0].amountCents).toBe(2000)
  })

  it('still shows the DOCUMENT value beside the correction, so nothing is hidden', () => {
    const seeds = seedRows([scanFile()], BATCH_DATE, { [HASH_A]: parsed() })
    const resolved = resolveRows(seeds, { [HASH_A]: { amountText: '20.00' } })
    expect(resolved[0].amountCents).toBe(2000)
    expect(resolved[0].parsed?.totalCents).toBe(133600)
  })
})
