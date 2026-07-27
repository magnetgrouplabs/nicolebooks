// test/posting-summary.test.ts
//
// The read side: batch history, batch detail, and the printable report.
//
// The totals assertion is the one that matters. A report gets FILED. A total that swept in failed
// or reversed rows would tell the user they entered money they did not enter, on a piece of paper
// nobody re-checks against QuickBooks.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { POSTING_UNAVAILABLE } from '../src/main/posting/errors'
import type { PostingReference } from '../src/main/posting/reference'
import { resetPostingInFlight, sendBatch } from '../src/main/posting/send'
import { batchDetailResult, batchesResult, summaryResult } from '../src/main/posting/summary'
import { undoLastBatch } from '../src/main/posting/undo'
import { FakeQboApi } from './helpers/fake-qbo-api'
import { billRow, expenseRow, hash, openTestDb, seedParsedFilename, type TestDb } from './helpers/posting-fixtures'

let ctx: TestDb

beforeEach(() => {
  ctx = openTestDb()
  resetPostingInFlight()
})

afterEach(() => {
  resetPostingInFlight()
  ctx.cleanup()
})

const REFERENCE: PostingReference = {
  companyName: () => 'Stepdad Service Co',
  vendorName: (id) => (id === '42' ? 'Nassau Plumbing Supply' : null),
  accountName: (id) => (id === '7' ? 'Job Materials' : id === '35' ? 'Business Checking' : null),
  accountType: () => 'Bank'
}

describe('posting:batches', () => {
  it('lists batches newest first with their counts and state', async () => {
    const api = new FakeQboApi({
      failCreate: (attempt) => (attempt.attempt === 2 ? new Error(POSTING_UNAVAILABLE) : null)
    })
    const first = await sendBatch([billRow()], { db: ctx.db, api, reference: REFERENCE })
    const second = await sendBatch([billRow({ fileHash: hash('b') })], {
      db: ctx.db,
      api,
      reference: REFERENCE
    })

    const { batches } = batchesResult(ctx.db)

    expect(batches.map((b) => b.batchId)).toEqual([second, first])
    expect(batches[0]).toMatchObject({ total: 1, confirmed: 0, failed: 1, undone: 0, state: 'open' })
    expect(batches[1]).toMatchObject({
      total: 1,
      confirmed: 1,
      failed: 0,
      undone: 0,
      state: 'complete'
    })
  })

  it('counts undone separately from confirmed, because they are different facts', async () => {
    // "3 entered, 3 later removed" and "0 entered" are not the same thing, and the history screen
    // has to be able to say which.
    const api = new FakeQboApi()
    await sendBatch([billRow()], { db: ctx.db, api, reference: REFERENCE })
    await undoLastBatch({ db: ctx.db, api })

    const [batch] = batchesResult(ctx.db).batches
    expect(batch).toMatchObject({ confirmed: 1, undone: 1, state: 'undone' })
  })

  it('returns an empty list before anything has ever been sent', () => {
    expect(batchesResult(ctx.db)).toEqual({ batches: [] })
  })
})

describe('posting:batch-detail', () => {
  it('returns the entries in send order with their states and mapped errors', async () => {
    const api = new FakeQboApi({
      failCreate: (attempt) => (attempt.attempt === 2 ? new Error(POSTING_UNAVAILABLE) : null)
    })
    const batchId = await sendBatch([billRow(), billRow({ fileHash: hash('b') })], {
      db: ctx.db,
      api,
      reference: REFERENCE
    })

    const { entries } = batchDetailResult(ctx.db, batchId)

    expect(entries).toHaveLength(2)
    expect(entries[0]).toEqual({
      fileHash: hash('a'),
      // null here because this spec sends rows that were never in the ingestion ledger, which is
      // exactly the case the screen falls back to the hash for.
      filename: null,
      entryType: 'bill',
      qboId: '1',
      syncToken: '0',
      state: 'confirmed',
      error: null,
      undoneAt: null,
      undoReason: null
    })
    expect(entries[1].state).toBe('failed')
    expect(entries[1].error).toContain('Could not reach QuickBooks')
    expect(entries[1].qboId).toBeNull()
  })

  it('carries the undo outcome, including the reason an undo was refused', async () => {
    const api = new FakeQboApi()
    const batchId = await sendBatch([billRow(), billRow({ fileHash: hash('b') })], {
      db: ctx.db,
      api,
      reference: REFERENCE
    })
    api.mutateEntity('Bill', '1')
    await undoLastBatch({ db: ctx.db, api })

    const { entries } = batchDetailResult(ctx.db, batchId)
    expect(entries[0].undoneAt).toBeNull()
    expect(entries[0].undoReason).toContain('changed in QuickBooks')
    expect(entries[1].undoneAt).not.toBeNull()
    expect(entries[1].undoReason).toBeNull()
  })

  it('refuses an unknown batch id with mapped copy', () => {
    expect(() => batchDetailResult(ctx.db, 'no-such-batch')).toThrow('POSTING_BATCH_NOT_FOUND')
  })
})

describe('posting:summary', () => {
  it('assembles a printable report with names, not ids', async () => {
    const api = new FakeQboApi()
    seedParsedFilename(ctx.db, hash('a'), 'march-electric-bill.pdf')
    const batchId = await sendBatch([billRow()], { db: ctx.db, api, reference: REFERENCE })

    const summary = summaryResult(ctx.db, batchId, REFERENCE)

    expect(summary.batchId).toBe(batchId)
    expect(summary.companyName).toBe('Stepdad Service Co')
    expect(summary.realmId).toBe(api.realmId)
    expect(summary.state).toBe('complete')
    expect(summary.lines).toHaveLength(1)
    expect(summary.lines[0]).toMatchObject({
      filename: 'march-electric-bill.pdf',
      vendorName: 'Nassau Plumbing Supply',
      categoryName: 'Job Materials',
      paidFromName: null,
      entryType: 'bill',
      txnDate: '2026-07-27',
      refNumber: 'INV-1001',
      amountCents: 12345,
      state: 'confirmed',
      qboId: '1'
    })
  })

  it('names the paying account on an expense line', async () => {
    const api = new FakeQboApi()
    const batchId = await sendBatch([expenseRow()], { db: ctx.db, api, reference: REFERENCE })
    expect(summaryResult(ctx.db, batchId, REFERENCE).lines[0].paidFromName).toBe(
      'Business Checking'
    )
  })

  it('falls back to the id when a name was never resolved, never to a blank cell', async () => {
    // A blank cell on a printed page reads as "no vendor" instead of "the name was not available",
    // and there is nobody left to ask.
    const api = new FakeQboApi()
    const batchId = await sendBatch([billRow({ vendorId: '999', categoryAccountId: '888' })], {
      db: ctx.db,
      api
    })

    const summary = summaryResult(ctx.db, batchId)
    expect(summary.lines[0].vendorName).toBe('999')
    expect(summary.lines[0].categoryName).toBe('888')
    expect(summary.companyName).toBeNull()
  })

  it('falls back to a short hash when the document was never parsed', async () => {
    const api = new FakeQboApi()
    const batchId = await sendBatch([billRow()], { db: ctx.db, api, reference: REFERENCE })
    expect(summaryResult(ctx.db, batchId, REFERENCE).lines[0].filename).toBe('aaaaaaaaaaaa...')
  })

  it('totals confirmed money only, never failed rows', async () => {
    const api = new FakeQboApi({
      failCreate: (attempt) => (attempt.attempt === 2 ? new Error(POSTING_UNAVAILABLE) : null)
    })
    const batchId = await sendBatch(
      [billRow({ amountCents: 10000 }), billRow({ fileHash: hash('b'), amountCents: 25000 })],
      { db: ctx.db, api, reference: REFERENCE }
    )

    const summary = summaryResult(ctx.db, batchId, REFERENCE)
    expect(summary.totals).toEqual({
      entries: 2,
      confirmed: 1,
      failed: 1,
      undone: 0,
      amountCents: 10000
    })
  })

  it('drops a reversed line out of the money total but keeps it on the report', async () => {
    const api = new FakeQboApi()
    const batchId = await sendBatch(
      [billRow({ amountCents: 10000 }), billRow({ fileHash: hash('b'), amountCents: 25000 })],
      { db: ctx.db, api, reference: REFERENCE }
    )
    api.mutateEntity('Bill', '1') // this one refuses to undo and stays in the books
    await undoLastBatch({ db: ctx.db, api })

    const summary = summaryResult(ctx.db, batchId, REFERENCE)
    expect(summary.totals).toMatchObject({ confirmed: 2, undone: 1, amountCents: 10000 })
    // The reversed line is still printed, carrying when it was reversed.
    expect(summary.lines).toHaveLength(2)
    expect(summary.lines[1].undoneAt).not.toBeNull()
  })

  it('refuses an unknown batch id with mapped copy', () => {
    expect(() => summaryResult(ctx.db, 'no-such-batch')).toThrow('POSTING_BATCH_NOT_FOUND')
  })
})
