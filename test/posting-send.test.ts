// test/posting-send.test.ts
//
// The batch send flow, against a real temp SQLite file and the in-memory QuickBooks fake.
//
// This is the suite the phase exists for. Every test below answers one question: can this app
// enter the same bill twice? The headline is "the mid-batch failure drill": break the third of
// five creates, re-send the identical batch, and assert that QuickBooks ended up with FIVE
// entities, not eight.
//
// The fake honours requestid replay semantics, so that assertion is real rather than a
// restatement of the code under test.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { PostingProgress } from '../src/shared/ipc-contract'
import { POSTING_UNAVAILABLE } from '../src/main/posting/errors'
import { prepareBatch, resetPostingInFlight, sendBatch } from '../src/main/posting/send'
import {
  findEntryInBatch,
  listEntries,
  type PostingEntryRecord
} from '../src/main/posting/store'
import type { PostingReference } from '../src/main/posting/reference'
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

/** A reference resolver that answers, so the denormalized-name path is genuinely exercised. */
const REFERENCE: PostingReference = {
  companyName: () => 'Stepdad Service Co',
  vendorName: (id) => (id === '42' ? 'Nassau Plumbing Supply' : null),
  accountName: (id) => (id === '7' ? 'Job Materials' : id === '35' ? 'Business Checking' : null),
  accountType: (id) => (id === '35' ? 'Bank' : id === '36' ? 'Credit Card' : null)
}

function entriesOf(batchId: string): PostingEntryRecord[] {
  return listEntries(ctx.db, batchId)
}

function ledgerRows(): Array<{ hash: string; qbo_entity: string; qbo_id: string }> {
  return ctx.db
    .prepare('SELECT hash, qbo_entity, qbo_id FROM posted_file_hashes ORDER BY hash')
    .all() as Array<{ hash: string; qbo_entity: string; qbo_id: string }>
}

describe('a clean batch', () => {
  it('confirms every row, records what QuickBooks created, and marks the batch complete', async () => {
    const api = new FakeQboApi()
    seedParsedFilename(ctx.db, hash('a'), 'march-electric-bill.pdf')
    const rows = [billRow(), billRow({ fileHash: hash('b'), refNumber: 'INV-1002' })]

    const batchId = await sendBatch(rows, { db: ctx.db, api, reference: REFERENCE })

    const entries = entriesOf(batchId)
    expect(entries).toHaveLength(2)
    expect(entries.map((e) => e.state)).toEqual(['confirmed', 'confirmed'])
    expect(entries.map((e) => e.qboId)).toEqual(['1', '2'])
    expect(entries.every((e) => e.syncToken === '0')).toBe(true)
    expect(entries.every((e) => e.error === null)).toBe(true)
    expect(api.entityCount()).toBe(2)

    const batch = ctx.db.prepare('SELECT state FROM posting_batches WHERE id = ?').get(batchId)
    expect(batch).toEqual({ state: 'complete' })
  })

  it('denormalizes the names and the filename onto the entry, so a report prints offline', () => {
    // Denormalized at post time on purpose: a vendor renamed or made inactive in QuickBooks next
    // month must not change what last month's report says.
    const api = new FakeQboApi()
    seedParsedFilename(ctx.db, hash('a'), 'march-electric-bill.pdf')
    const prepared = prepareBatch([billRow()], { db: ctx.db, api, reference: REFERENCE })

    const [entry] = entriesOf(prepared.batchId)
    expect(entry.vendorName).toBe('Nassau Plumbing Supply')
    expect(entry.categoryAccountName).toBe('Job Materials')
    expect(entry.filename).toBe('march-electric-bill.pdf')
    expect(entry.realmId).toBe(api.realmId)
  })

  it('writes the dedupe ledger only on confirm, which is the write half of Design B', async () => {
    // src/main/ingestion/ledger.ts is READ ONLY and says the mark-sent write belongs to Phase 7.
    // This is that write, and it is the reason the Phase 2 scan can say "already entered on ...".
    const api = new FakeQboApi()
    seedParsedFilename(ctx.db, hash('a'), 'march-electric-bill.pdf')
    expect(ledgerRows()).toHaveLength(0)

    await sendBatch([billRow()], { db: ctx.db, api, reference: REFERENCE })

    expect(ledgerRows()).toEqual([
      { hash: hash('a'), qbo_entity: 'Bill', qbo_id: '1' }
    ])
  })

  it('posts an expense as a Purchase carrying the paying account and the payment type', async () => {
    const api = new FakeQboApi()
    await sendBatch([expenseRow({ paidFromAccountId: '36' })], {
      db: ctx.db,
      api,
      reference: REFERENCE
    })

    const [created] = api.liveEntities()
    expect(created.entity).toBe('Purchase')
    const payload = created.payload as { PaymentType: string; AccountRef: { value: string } }
    expect(payload.PaymentType).toBe('CreditCard') // account 36 is a credit card
    expect(payload.AccountRef.value).toBe('36')
    expect(ledgerRows()[0].qbo_entity).toBe('Purchase')
  })
})

describe('idempotency keys are durable before anything is sent', () => {
  it('persists every entry with its request id BEFORE the first network call', () => {
    // prepareBatch is synchronous and returns before run() is called, so this is literally the
    // state of the disk in the window a crash would hit. A key minted at request time would not
    // exist here, which is the whole failure mode this design removes.
    const api = new FakeQboApi()
    const prepared = prepareBatch([billRow(), billRow({ fileHash: hash('b') })], {
      db: ctx.db,
      api,
      reference: REFERENCE
    })

    const entries = entriesOf(prepared.batchId)
    expect(entries).toHaveLength(2)
    expect(entries.every((e) => e.state === 'pending')).toBe(true)
    expect(entries.every((e) => e.requestId.length > 0)).toBe(true)
    expect(new Set(entries.map((e) => e.requestId)).size).toBe(2)
    // Nothing has been sent.
    expect(api.createAttempts).toHaveLength(0)
  })

  it('survives a close and reopen of the database file', async () => {
    const api = new FakeQboApi()
    const prepared = prepareBatch([billRow()], { db: ctx.db, api, reference: REFERENCE })
    const before = entriesOf(prepared.batchId)[0].requestId
    await prepared.run()

    const reopened = ctx.reopen()
    const after = (
      reopened.prepare('SELECT request_id FROM posting_entries WHERE batch_id = ?').get(prepared.batchId) as
        | { request_id: string }
        | undefined
    )?.request_id
    expect(after).toBe(before)
  })
})

describe('the mid-batch failure drill', () => {
  it('injects a failure at entry 3 of 5, re-sends, and QuickBooks ends up with exactly 5 entities', async () => {
    // The headline guarantee. If this ever goes red, the app can double-enter bills.
    let breakThirdCreate = true
    const api = new FakeQboApi({
      failCreate: (attempt) =>
        breakThirdCreate && attempt.attempt === 3 ? new Error(POSTING_UNAVAILABLE) : null
    })
    const rows = ['a', 'b', 'c', 'd', 'e'].map((char, index) =>
      billRow({ fileHash: hash(char), refNumber: `INV-100${index}` })
    )

    const firstBatchId = await sendBatch(rows, { db: ctx.db, api, reference: REFERENCE })
    const firstPass = entriesOf(firstBatchId)
    expect(firstPass.map((e) => e.state)).toEqual([
      'confirmed',
      'confirmed',
      'failed',
      'confirmed',
      'confirmed'
    ])
    expect(api.entityCount()).toBe(4)
    const keysBefore = firstPass.map((e) => e.requestId)

    // The user fixes nothing and simply presses Send again, which is what actually happens.
    breakThirdCreate = false
    const secondBatchId = await sendBatch(rows, { db: ctx.db, api, reference: REFERENCE })

    expect(secondBatchId).toBe(firstBatchId) // resumed, not a new batch
    const secondPass = entriesOf(secondBatchId)
    expect(secondPass.map((e) => e.state)).toEqual([
      'confirmed',
      'confirmed',
      'confirmed',
      'confirmed',
      'confirmed'
    ])
    // FIVE entities, not eight. The four that already succeeded were never sent again.
    expect(api.entityCount()).toBe(5)
    expect(api.liveEntities()).toHaveLength(5)
    // Exactly one extra create attempt: the row that failed.
    expect(api.createAttempts).toHaveLength(6)
    // And every key is the one that was written to disk the first time.
    expect(secondPass.map((e) => e.requestId)).toEqual(keysBefore)
    expect(ledgerRows()).toHaveLength(5)
  })

  it('replays the same request id after a crash between the create and the confirm', async () => {
    // The genuinely dangerous window: QuickBooks created the bill and the process died before we
    // wrote down that it had. The entry is left in 'sent' with no id, and the ledger has no row.
    const api = new FakeQboApi()
    const batchId = await sendBatch([billRow()], { db: ctx.db, api, reference: REFERENCE })
    expect(api.entityCount()).toBe(1)

    // Rewind the disk to the instant before markEntryConfirmed ran.
    ctx.db
      .prepare(
        "UPDATE posting_entries SET state = 'sent', qbo_id = NULL, sync_token = NULL WHERE batch_id = ?"
      )
      .run(batchId)
    ctx.db.prepare('DELETE FROM posted_file_hashes').run()

    const resumedId = await sendBatch([billRow()], { db: ctx.db, api, reference: REFERENCE })

    expect(resumedId).toBe(batchId)
    const [entry] = entriesOf(batchId)
    expect(entry.state).toBe('confirmed')
    expect(entry.qboId).toBe('1') // the ORIGINAL entity, returned by the replay
    // Two attempts, ONE entity. That is the requestid contract doing its job.
    expect(api.createAttempts).toHaveLength(2)
    expect(api.createAttempts[1].requestId).toBe(api.createAttempts[0].requestId)
    expect(api.entityCount()).toBe(1)
    expect(ledgerRows()).toHaveLength(1)
  })

  it('never re-sends a confirmed entry, so a re-send of a finished batch is a no-op', async () => {
    const api = new FakeQboApi({
      failCreate: (attempt) => (attempt.attempt === 2 ? new Error(POSTING_UNAVAILABLE) : null)
    })
    const rows = [billRow(), billRow({ fileHash: hash('b') })]
    const batchId = await sendBatch(rows, { db: ctx.db, api, reference: REFERENCE })
    expect(entriesOf(batchId).map((e) => e.state)).toEqual(['confirmed', 'failed'])

    // Second pass: the confirmed row must not produce another attempt, even though it is in the
    // send. Only the failed one is retried (and fails again, since attempt 3 is fine but the fake
    // only breaks attempt 2 -> this one succeeds).
    await sendBatch(rows, { db: ctx.db, api, reference: REFERENCE })
    expect(api.createAttempts).toHaveLength(3)
    expect(api.createAttempts.map((a) => a.requestId)).toEqual([
      api.createAttempts[0].requestId,
      api.createAttempts[1].requestId,
      api.createAttempts[1].requestId // the retry reuses the failed entry's key
    ])
    expect(api.entityCount()).toBe(2)
  })
})

describe('a row failing never stops the batch', () => {
  it('marks the failed row and keeps going', async () => {
    const api = new FakeQboApi({
      failCreate: (attempt) => (attempt.attempt === 2 ? new Error(POSTING_UNAVAILABLE) : null)
    })
    const rows = [billRow(), billRow({ fileHash: hash('b') }), billRow({ fileHash: hash('c') })]

    const batchId = await sendBatch(rows, { db: ctx.db, api, reference: REFERENCE })

    const entries = entriesOf(batchId)
    expect(entries.map((e) => e.state)).toEqual(['confirmed', 'failed', 'confirmed'])
    // The batch is still open, because there is work left to retry.
    expect(ctx.db.prepare('SELECT state FROM posting_batches WHERE id = ?').get(batchId)).toEqual({
      state: 'open'
    })
    // Nineteen good rows are not stranded by one bad one.
    expect(ledgerRows()).toHaveLength(2)
  })

  it('stores mapped copy on the failed entry, never the raw provider text', async () => {
    // The stored string is read back later by posting:batch-detail, so an unmapped message would
    // be a leak with a delay. This one carries a URL and a realm id, exactly like a real fault.
    const api = new FakeQboApi({
      failCreate: () =>
        new Error(
          'Error 400 at https://sandbox-quickbooks.api.intuit.com/v3/company/9341457604445280/bill: invalid AccountRef'
        )
    })

    const batchId = await sendBatch([billRow()], { db: ctx.db, api, reference: REFERENCE })

    const [entry] = entriesOf(batchId)
    expect(entry.state).toBe('failed')
    expect(entry.error).not.toBeNull()
    expect(entry.error).not.toContain('quickbooks.api.intuit.com')
    expect(entry.error).not.toContain('9341457604445280')
    expect(entry.error).not.toMatch(/[–—]/) // house rule: no em dashes or en dashes
    expect(entry.error).toContain('Please try again')
  })

  it('fails a row whose payload cannot be built, without sending anything for it', async () => {
    // A negative amount cannot reach here through the IPC schema, but the builder is the last
    // guard and a row that cannot be built must fail as a ROW, not as a batch. Corrupting the
    // persisted entry between prepare and run is how a stored row that is no longer postable
    // (a schema change, a hand-edited database) would actually present.
    const api = new FakeQboApi()
    const prepared = prepareBatch([billRow(), billRow({ fileHash: hash('b') })], {
      db: ctx.db,
      api,
      reference: REFERENCE
    })
    ctx.db.prepare('UPDATE posting_entries SET amount_cents = -5 WHERE position = 1').run()

    await prepared.run()

    const entries = entriesOf(prepared.batchId)
    expect(entries[0].state).toBe('confirmed')
    expect(entries[1].state).toBe('failed')
    expect(entries[1].error).toContain('negative')
    // Only the first row was ever dispatched: a payload that cannot be built never left.
    expect(api.createAttempts).toHaveLength(1)
    expect(entries[1].sentAt).toBeNull()
  })
})

describe('the cross-batch ledger guard', () => {
  it('refuses a document that some earlier batch already posted', async () => {
    const api = new FakeQboApi()
    ctx.db
      .prepare(
        `INSERT INTO posted_file_hashes (hash, posted_at, original_filename, qbo_entity, qbo_id)
         VALUES (?, '2026-07-01T00:00:00.000Z', 'already.pdf', 'Bill', '99')`
      )
      .run(hash('a'))

    const batchId = await sendBatch([billRow()], { db: ctx.db, api, reference: REFERENCE })

    const [entry] = entriesOf(batchId)
    expect(entry.state).toBe('failed')
    expect(entry.error).toContain('already entered in QuickBooks')
    // Nothing was sent: the ledger outranks whatever the review grid believed.
    expect(api.createAttempts).toHaveLength(0)
  })
})

describe('batch validation refuses the whole batch before anything is written', () => {
  it('refuses an expense with no account that paid it', () => {
    const api = new FakeQboApi()
    expect(() =>
      prepareBatch([expenseRow({ paidFromAccountId: null })], { db: ctx.db, api })
    ).toThrow('POSTING_EXPENSE_NEEDS_ACCOUNT')
    expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM posting_batches').get()).toEqual({ n: 0 })
  })

  it('refuses a bill that names an account that paid it (the row is on the wrong toggle)', () => {
    const api = new FakeQboApi()
    expect(() => prepareBatch([billRow({ paidFromAccountId: '35' })], { db: ctx.db, api })).toThrow(
      'POSTING_BILL_HAS_PAID_FROM'
    )
    expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM posting_batches').get()).toEqual({ n: 0 })
  })

  it('refuses the same document twice in one send', () => {
    const api = new FakeQboApi()
    expect(() => prepareBatch([billRow(), billRow()], { db: ctx.db, api })).toThrow(
      'POSTING_DUPLICATE_ROWS'
    )
  })
})

describe('one batch at a time', () => {
  it('refuses a second send while one is in flight', () => {
    const api = new FakeQboApi()
    prepareBatch([billRow()], { db: ctx.db, api, reference: REFERENCE })
    expect(() => prepareBatch([billRow({ fileHash: hash('z') })], { db: ctx.db, api })).toThrow(
      'POSTING_BATCH_IN_FLIGHT'
    )
  })

  it('releases the guard when the run finishes', async () => {
    const api = new FakeQboApi()
    const prepared = prepareBatch([billRow()], { db: ctx.db, api, reference: REFERENCE })
    await prepared.run()
    expect(() =>
      prepareBatch([billRow({ fileHash: hash('z') })], { db: ctx.db, api, reference: REFERENCE })
    ).not.toThrow()
  })
})

describe('progress broadcast', () => {
  it('reports each entry moving to sent and then settling, and ends with a null current', async () => {
    const api = new FakeQboApi({
      failCreate: (attempt) => (attempt.attempt === 2 ? new Error(POSTING_UNAVAILABLE) : null)
    })
    const seen: PostingProgress[] = []
    const rows = [billRow(), billRow({ fileHash: hash('b') })]

    const batchId = await sendBatch(rows, {
      db: ctx.db,
      api,
      reference: REFERENCE,
      onProgress: (p) => seen.push(p)
    })

    expect(seen.every((p) => p.batchId === batchId && p.total === 2)).toBe(true)
    expect(seen.map((p) => p.current?.state ?? null)).toEqual([
      'sent',
      'confirmed',
      'sent',
      'failed',
      null
    ])
    expect(seen.at(-1)).toEqual({ batchId, done: 2, total: 2, current: null })
  })

  it('reports an already-confirmed entry as confirmed without sending it again', async () => {
    const api = new FakeQboApi()
    await sendBatch([billRow()], { db: ctx.db, api, reference: REFERENCE })
    // Force the batch to stay resumable so the next send joins it rather than opening a new one.
    ctx.db
      .prepare(
        `INSERT INTO posting_entries
           (batch_id, position, file_hash, entry_type, request_id, state, vendor_id,
            category_account_id, txn_date, amount_cents, realm_id, created_at, updated_at)
         SELECT batch_id, 1, ?, 'bill', 'held-key', 'failed', '42', '7', '2026-07-27', 100, realm_id,
                created_at, updated_at
           FROM posting_entries LIMIT 1`
      )
      .run(hash('z'))

    const seen: PostingProgress[] = []
    await sendBatch([billRow()], {
      db: ctx.db,
      api,
      reference: REFERENCE,
      onProgress: (p) => seen.push(p)
    })

    expect(seen.map((p) => p.current?.state ?? null)).toEqual(['confirmed', null])
    expect(api.createAttempts).toHaveLength(1)
  })
})

describe('resume targeting', () => {
  it('opens a NEW batch when no row in the send belongs to the open one', async () => {
    const api = new FakeQboApi({
      failCreate: (attempt) => (attempt.attempt === 1 ? new Error(POSTING_UNAVAILABLE) : null)
    })
    const first = await sendBatch([billRow()], { db: ctx.db, api, reference: REFERENCE })
    expect(entriesOf(first)[0].state).toBe('failed')

    // A completely different document. Joining the open batch would be wrong: these are unrelated
    // sends and the history has to show them as such.
    const second = await sendBatch([billRow({ fileHash: hash('z') })], {
      db: ctx.db,
      api,
      reference: REFERENCE
    })
    expect(second).not.toBe(first)
    expect(entriesOf(second)).toHaveLength(1)
  })

  it('appends genuinely new rows to a resumed batch', async () => {
    const api = new FakeQboApi({
      failCreate: (attempt) => (attempt.attempt === 1 ? new Error(POSTING_UNAVAILABLE) : null)
    })
    const first = await sendBatch([billRow()], { db: ctx.db, api, reference: REFERENCE })

    const resumed = await sendBatch([billRow(), billRow({ fileHash: hash('b') })], {
      db: ctx.db,
      api,
      reference: REFERENCE
    })

    expect(resumed).toBe(first)
    const entries = entriesOf(first)
    expect(entries).toHaveLength(2)
    expect(entries.map((e) => e.position)).toEqual([0, 1])
    expect(entries.every((e) => e.state === 'confirmed')).toBe(true)
    expect(findEntryInBatch(ctx.db, first, hash('b'))?.requestId).toBeTruthy()
  })
})
