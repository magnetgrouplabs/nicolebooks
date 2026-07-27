// test/review-send.test.ts
//
// EXACTLY WHAT CROSSES THE BOUNDARY when the user presses Send.
//
// This is the moment the app touches somebody's books, so the assertion is on the literal argument
// handed to posting.send, field by field, not on a count or a shape. Everything downstream of that
// call (idempotency keys, per-entry state, the ledger write) is Phase 7's and is already covered;
// what is covered here is that Phase 7 receives what the user approved and nothing else.
//
// The four things a wrong payload would cost, all pinned below:
//   * an excluded row that goes anyway          -> money entered that the user declined
//   * a paid-from account on a bill             -> assertPostableRows refuses the WHOLE batch
//   * a float amount                            -> PostingRowSchema refuses at the IPC gate
//   * an empty string where null belongs        -> the same, on refNumber's .min(1) bound

import { describe, expect, it, vi } from 'vitest'
import {
  GENERIC_SEND_ERROR,
  NOTHING_TO_SEND,
  sendReviewBatch
} from '../src/renderer/src/review/send'
import { resolveRow, seedRow, type ReviewEdit, type ReviewSeed } from '../src/renderer/src/review/model'
import type { ParseFileResult, ParsedFields, PostingRow, ScanFile } from '../src/shared/ipc-contract'

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

function parse(overrides: Partial<ParseFileResult> = {}): ParseFileResult {
  return {
    filename: 'nassau-plumbing-0417.pdf',
    hash: HASH_A,
    status: 'parsed',
    fields: fields(),
    confidence: {},
    validationFlags: [],
    ...overrides
  }
}

const FILE: ScanFile = {
  filename: 'nassau-plumbing-0417.pdf',
  status: 'loaded',
  hash: HASH_A,
  sizeBytes: 2048
}

function seed(overrides: Partial<ReviewSeed> = {}): ReviewSeed {
  return {
    ...seedRow(FILE, BATCH_DATE, parse()),
    vendorId: '42',
    categoryAccountId: '7',
    ...overrides
  }
}

function row(seedOverrides: Partial<ReviewSeed> = {}, edit: ReviewEdit = {}) {
  return resolveRow(seed(seedOverrides), edit)
}

/** A sender that records what it was handed and resolves with a batch id. */
function fakeSend(): { send: (rows: PostingRow[]) => Promise<{ batchId: string }>; calls: PostingRow[][] } {
  const calls: PostingRow[][] = []
  return {
    calls,
    send: async (rows) => {
      calls.push(rows)
      return { batchId: 'batch-1' }
    }
  }
}

describe('the exact rows handed to posting.send', () => {
  it('sends one complete bill, field for field', async () => {
    const sender = fakeSend()
    const outcome = await sendReviewBatch([row()], sender.send)

    expect(outcome).toEqual({
      ok: true,
      batchId: 'batch-1',
      sent: [
        {
          fileHash: HASH_A,
          entryType: 'bill',
          vendorId: '42',
          categoryAccountId: '7',
          paidFromAccountId: null,
          txnDate: '2026-07-27',
          dueDate: '2026-08-14',
          refNumber: 'INV-2026-0417',
          amountCents: 133600,
          memo: null
        }
      ]
    })
    expect(sender.calls).toHaveLength(1)
    expect(sender.calls[0]).toEqual(outcome.ok && outcome.sent)
  })

  it('sends an expense with the account that paid it and no due date', async () => {
    const sender = fakeSend()
    await sendReviewBatch([row({}, { entryType: 'expense', paidFromAccountId: '35' })], sender.send)

    expect(sender.calls[0]).toEqual([
      {
        fileHash: HASH_A,
        entryType: 'expense',
        vendorId: '42',
        categoryAccountId: '7',
        paidFromAccountId: '35',
        txnDate: '2026-07-27',
        dueDate: null,
        refNumber: 'INV-2026-0417',
        amountCents: 133600,
        memo: null
      }
    ])
  })

  it('never puts a paid-from account on a bill, which would be refused WHOLE', async () => {
    // assertPostableRows throws POSTING_BILL_HAS_PAID_FROM and rejects every row in the batch.
    const sender = fakeSend()
    await sendReviewBatch([row({}, { entryType: 'bill', paidFromAccountId: '35' })], sender.send)
    expect(sender.calls[0][0].paidFromAccountId).toBeNull()
  })

  it('leaves out the rows the user excluded', async () => {
    const sender = fakeSend()
    await sendReviewBatch(
      [row(), row({ fileHash: HASH_B }, { included: false })],
      sender.send
    )
    expect(sender.calls[0].map((posting) => posting.fileHash)).toEqual([HASH_A])
  })

  it('keeps review order, so the batch reads the way it was checked', async () => {
    const sender = fakeSend()
    await sendReviewBatch([row(), row({ fileHash: HASH_B })], sender.send)
    expect(sender.calls[0].map((posting) => posting.fileHash)).toEqual([HASH_A, HASH_B])
  })

  it('sends integer cents for an amount floating-point multiplication would ruin', async () => {
    const sender = fakeSend()
    await sendReviewBatch([row({}, { amountText: '8.29' })], sender.send)
    expect(sender.calls[0][0].amountCents).toBe(829)
    expect(Number.isInteger(sender.calls[0][0].amountCents)).toBe(true)
  })

  it('sends the user amount, not the parsed one', async () => {
    const sender = fakeSend()
    await sendReviewBatch([row({}, { amountText: '20.00' })], sender.send)
    expect(sender.calls[0][0].amountCents).toBe(2000)
  })

  it('sends null, not an empty string, for a reference number nobody filled in', async () => {
    const sender = fakeSend()
    await sendReviewBatch([row({}, { refNumber: '  ' })], sender.send)
    expect(sender.calls[0][0].refNumber).toBeNull()
  })
})

describe('a send that does not happen', () => {
  it('never calls the channel when nothing is ticked', async () => {
    const sender = fakeSend()
    const outcome = await sendReviewBatch([row({}, { included: false })], sender.send)
    expect(sender.calls).toHaveLength(0)
    expect(outcome).toEqual({ ok: false, error: NOTHING_TO_SEND })
  })

  it('never calls the channel for an incomplete row', async () => {
    const sender = fakeSend()
    await sendReviewBatch([row({ vendorId: null })], sender.send)
    expect(sender.calls).toHaveLength(0)
  })
})

describe('a send that fails', () => {
  it('forwards the sentence main already wrote, VERBATIM', async () => {
    // Main knows things this component does not: whether the connection is missing, whether a batch
    // is in flight, whether QuickBooks refused the entry. Re-wording it would replace a specific
    // instruction with a vaguer one.
    const notConnected =
      'NicoleBooks is not connected to QuickBooks yet. Connect on the Settings screen, then send this batch again.'
    const outcome = await sendReviewBatch([row()], vi.fn().mockRejectedValue(new Error(notConnected)))
    expect(outcome).toEqual({ ok: false, error: notConnected })
  })

  it('never puts a schema dump on screen', async () => {
    // The Zod payload gate runs BEFORE the handler's try block (so a malformed payload never
    // reaches the privileged work), which means a schema rejection crosses the bridge unmapped, and
    // in Zod 4 that message is the whole issue array as JSON. The model gate mirrors every schema
    // bound so this should be unreachable; it is guarded anyway, because "should be unreachable" is
    // exactly the claim that stops being true.
    const zodish =
      '[\n  {\n    "code": "too_small",\n    "minimum": 0,\n    "path": ["rows", 0, "amountCents"]\n  }\n]'
    const outcome = await sendReviewBatch([row()], vi.fn().mockRejectedValue(new Error(zodish)))
    expect(outcome).toEqual({ ok: false, error: GENERIC_SEND_ERROR })
  })

  it('still forwards a real sentence that happens to mention a code word', async () => {
    const sentence = 'QuickBooks would not accept this entry. Check the vendor, then send it again.'
    expect(await sendReviewBatch([row()], vi.fn().mockRejectedValue(new Error(sentence)))).toEqual({
      ok: false,
      error: sentence
    })
  })

  it('never sends a zero amount, which would have the batch refused whole', async () => {
    // parseMoneyToCents('0.00') is the integer 0, not null: an unreadable total is recorded as 0
    // by the deterministic gate, on purpose, and PostingRowSchema requires a POSITIVE amount.
    const sender = fakeSend()
    const outcome = await sendReviewBatch([row({}, { amountText: '0.00' })], sender.send)
    expect(sender.calls).toHaveLength(0)
    expect(outcome.ok).toBe(false)
  })

  it('falls back only when the rejection said nothing at all', async () => {
    expect(await sendReviewBatch([row()], vi.fn().mockRejectedValue(new Error('')))).toEqual({
      ok: false,
      error: GENERIC_SEND_ERROR
    })
    expect(await sendReviewBatch([row()], vi.fn().mockRejectedValue('a bare string'))).toEqual({
      ok: false,
      error: GENERIC_SEND_ERROR
    })
  })

  it('states that nothing was changed, because that is the fact the user needs', async () => {
    expect(GENERIC_SEND_ERROR).toContain('Nothing was changed in QuickBooks')
    expect(GENERIC_SEND_ERROR).not.toMatch(/[—–]/)
    expect(NOTHING_TO_SEND).not.toMatch(/[—–]/)
  })
})
