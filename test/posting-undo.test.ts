// test/posting-undo.test.ts
//
// Undo the last batch, and refuse anything that changed in QuickBooks since it was posted.
//
// The SyncToken drift check is the assertion that matters. SyncToken is QuickBooks' concurrency
// counter and it increments on every edit, so a token that no longer matches the one recorded at
// post time means somebody worked on that entity: an edit, an applied payment, a link to another
// record. Deleting it then would destroy work that was not ours, and the linked records would be
// the collateral. The fake models the bump exactly the way the QuickBooks web UI would.
//
// The second half of undo is the dedupe ledger, and it is the half that is easy to forget:
// reversing the entity without clearing posted_file_hashes leaves the document permanently
// un-enterable, because the Phase 2 scan keeps excluding it as "already entered" for a bill that
// no longer exists.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { POSTING_UNAVAILABLE } from '../src/main/posting/errors'
import { resetPostingInFlight, sendBatch } from '../src/main/posting/send'
import { listEntries } from '../src/main/posting/store'
import { undoLastBatch } from '../src/main/posting/undo'
import { FakeQboApi } from './helpers/fake-qbo-api'
import { billRow, expenseRow, hash, openTestDb, type TestDb } from './helpers/posting-fixtures'

let ctx: TestDb

beforeEach(() => {
  ctx = openTestDb()
  resetPostingInFlight()
})

afterEach(() => {
  resetPostingInFlight()
  ctx.cleanup()
})

function ledgerHashes(): string[] {
  return (
    ctx.db.prepare('SELECT hash FROM posted_file_hashes ORDER BY hash').all() as Array<{
      hash: string
    }>
  ).map((r) => r.hash)
}

describe('undoing a clean batch', () => {
  it('deletes every entity and clears the dedupe ledger so the documents can be entered again', async () => {
    const api = new FakeQboApi()
    const rows = [billRow(), billRow({ fileHash: hash('b') })]
    const batchId = await sendBatch(rows, { db: ctx.db, api })
    expect(ledgerHashes()).toHaveLength(2)

    const result = await undoLastBatch({ db: ctx.db, api })

    expect(result.batchId).toBe(batchId)
    expect(result.results).toEqual([
      { qboId: '1', undone: true, reason: null },
      { qboId: '2', undone: true, reason: null }
    ])
    expect(api.liveEntities()).toHaveLength(0)
    // The ledger is clear, so a re-scan of those same files loads them again.
    expect(ledgerHashes()).toHaveLength(0)
  })

  it('records the undo on each entry and marks the batch undone', async () => {
    const api = new FakeQboApi()
    const batchId = await sendBatch([billRow()], { db: ctx.db, api })

    await undoLastBatch({ db: ctx.db, api })

    const [entry] = listEntries(ctx.db, batchId)
    // The entry stays 'confirmed', because it really was confirmed. undone_at is the audit fact.
    expect(entry.state).toBe('confirmed')
    expect(entry.undoneAt).not.toBeNull()
    expect(entry.undoReason).toBeNull()
    expect(ctx.db.prepare('SELECT state FROM posting_batches WHERE id = ?').get(batchId)).toEqual({
      state: 'undone'
    })
  })

  it('deletes a Purchase as a Purchase, not as a Bill', async () => {
    const api = new FakeQboApi()
    await sendBatch([expenseRow()], { db: ctx.db, api })

    await undoLastBatch({ db: ctx.db, api })

    expect(api.deleteAttempts).toHaveLength(1)
    expect(api.deleteAttempts[0].entity).toBe('Purchase')
  })

  it('re-reads every entity live before deciding, rather than trusting the stored token', async () => {
    const api = new FakeQboApi()
    await sendBatch([billRow(), billRow({ fileHash: hash('b') })], { db: ctx.db, api })

    await undoLastBatch({ db: ctx.db, api })

    expect(api.readAttempts).toHaveLength(2)
    // Every read happens before its delete.
    expect(api.readAttempts.map((r) => r.id)).toEqual(['1', '2'])
  })
})

describe('refusing an entity that changed since it was posted', () => {
  it('leaves an edited entity alone and says why', async () => {
    const api = new FakeQboApi()
    const batchId = await sendBatch([billRow(), billRow({ fileHash: hash('b') })], {
      db: ctx.db,
      api
    })
    // Somebody opens the first bill in QuickBooks and edits it. SyncToken 0 -> 1.
    api.mutateEntity('Bill', '1')

    const result = await undoLastBatch({ db: ctx.db, api })

    expect(result.results[0].undone).toBe(false)
    expect(result.results[0].reason).toContain('changed in QuickBooks')
    expect(result.results[1]).toEqual({ qboId: '2', undone: true, reason: null })
    // The edited entity is still there; the untouched one is gone.
    expect(api.liveEntities().map((e) => e.id)).toEqual(['1'])
    // And it was never even attempted, so the edit cannot have been half applied.
    expect(api.deleteAttempts.map((d) => d.id)).toEqual(['2'])
  })

  it('keeps the refused document in the dedupe ledger, because it is still in QuickBooks', async () => {
    const api = new FakeQboApi()
    await sendBatch([billRow(), billRow({ fileHash: hash('b') })], { db: ctx.db, api })
    api.mutateEntity('Bill', '1')

    await undoLastBatch({ db: ctx.db, api })

    // Only the reversed document leaves the ledger. Clearing both would invite a duplicate entry
    // for the bill that is demonstrably still in the books.
    expect(ledgerHashes()).toEqual([hash('a')])
  })

  it('marks the batch partially undone, which is neither sent nor undone', async () => {
    const api = new FakeQboApi()
    const batchId = await sendBatch([billRow(), billRow({ fileHash: hash('b') })], {
      db: ctx.db,
      api
    })
    api.mutateEntity('Bill', '1')

    await undoLastBatch({ db: ctx.db, api })

    expect(ctx.db.prepare('SELECT state FROM posting_batches WHERE id = ?').get(batchId)).toEqual({
      state: 'partially-undone'
    })
    const [refused] = listEntries(ctx.db, batchId)
    expect(refused.undoneAt).toBeNull()
    expect(refused.undoReason).toContain('changed in QuickBooks')
  })

  it('refuses again on a second undo, rather than eventually letting it through', async () => {
    const api = new FakeQboApi()
    await sendBatch([billRow()], { db: ctx.db, api })
    api.mutateEntity('Bill', '1')

    await undoLastBatch({ db: ctx.db, api })
    const second = await undoLastBatch({ db: ctx.db, api })

    expect(second.results[0].undone).toBe(false)
    expect(api.liveEntities()).toHaveLength(1)
  })
})

describe('an entity that is already gone', () => {
  it('reports it, clears the ledger, and does not treat it as a failure', async () => {
    const api = new FakeQboApi()
    await sendBatch([billRow()], { db: ctx.db, api })
    // Somebody deleted it in QuickBooks before pressing Undo here.
    api.deleteOutOfBand('Bill', '1')

    const result = await undoLastBatch({ db: ctx.db, api })

    expect(result.results[0].undone).toBe(true)
    expect(result.results[0].reason).toContain('no longer in QuickBooks')
    // The end state the user asked for is the end state that exists, so the document becomes
    // enterable again.
    expect(ledgerHashes()).toHaveLength(0)
    expect(api.deleteAttempts).toHaveLength(0)
  })
})

describe('a delete that QuickBooks refuses', () => {
  it('records mapped copy on the entry and leaves the ledger row in place', async () => {
    const api = new FakeQboApi({
      failDelete: () =>
        new Error(
          'Error 400 at https://sandbox-quickbooks.api.intuit.com/v3/company/9341457604445280/bill: linked transaction'
        )
    })
    const batchId = await sendBatch([billRow()], { db: ctx.db, api })

    const result = await undoLastBatch({ db: ctx.db, api })

    expect(result.results[0].undone).toBe(false)
    const reason = result.results[0].reason as string
    expect(reason).not.toContain('quickbooks.api.intuit.com')
    expect(reason).not.toContain('9341457604445280')
    expect(reason).not.toMatch(/[–—]/)
    expect(reason).toContain('delete it there')
    expect(ledgerHashes()).toEqual([hash('a')])
    expect(listEntries(ctx.db, batchId)[0].undoneAt).toBeNull()
  })

  it('maps a known transport failure to its own copy', async () => {
    const api = new FakeQboApi({ failRead: () => new Error(POSTING_UNAVAILABLE) })
    await sendBatch([billRow()], { db: ctx.db, api })

    const result = await undoLastBatch({ db: ctx.db, api })

    expect(result.results[0].undone).toBe(false)
    expect(result.results[0].reason).toContain('Could not reach QuickBooks')
  })
})

describe('which batch undo targets', () => {
  it('targets the most recent batch that has confirmed entries', async () => {
    const api = new FakeQboApi()
    const older = await sendBatch([billRow()], { db: ctx.db, api })
    const newer = await sendBatch([billRow({ fileHash: hash('b') })], { db: ctx.db, api })
    expect(newer).not.toBe(older)

    const result = await undoLastBatch({ db: ctx.db, api })

    expect(result.batchId).toBe(newer)
    // The older batch is untouched: undo is one step, not a rollback of history.
    expect(listEntries(ctx.db, older)[0].undoneAt).toBeNull()
    expect(ledgerHashes()).toEqual([hash('a')])
  })

  it('skips a batch whose entries all failed, because there is nothing in QuickBooks to reverse', async () => {
    const api = new FakeQboApi({
      failCreate: (attempt) => (attempt.attempt === 2 ? new Error(POSTING_UNAVAILABLE) : null)
    })
    const good = await sendBatch([billRow()], { db: ctx.db, api })
    const bad = await sendBatch([billRow({ fileHash: hash('b') })], { db: ctx.db, api })
    expect(listEntries(ctx.db, bad)[0].state).toBe('failed')

    const result = await undoLastBatch({ db: ctx.db, api })

    expect(result.batchId).toBe(good)
  })

  it('refuses with plain copy when nothing has ever been sent', async () => {
    const api = new FakeQboApi()
    await expect(undoLastBatch({ db: ctx.db, api })).rejects.toThrow('POSTING_NOTHING_TO_UNDO')
  })

  it('refuses when every confirmed entry has already been undone', async () => {
    const api = new FakeQboApi()
    await sendBatch([billRow()], { db: ctx.db, api })
    await undoLastBatch({ db: ctx.db, api })

    await expect(undoLastBatch({ db: ctx.db, api })).rejects.toThrow('POSTING_NOTHING_TO_UNDO')
  })
})

describe('re-entering a document after an undo', () => {
  it('lets the same file be posted again, with a fresh idempotency key', async () => {
    // The whole reason undo clears the ledger. The document is genuinely un-entered now, so the
    // Phase 2 scan loads it and a new batch posts it as new work.
    const api = new FakeQboApi()
    const first = await sendBatch([billRow()], { db: ctx.db, api })
    await undoLastBatch({ db: ctx.db, api })
    const firstKey = listEntries(ctx.db, first)[0].requestId

    const second = await sendBatch([billRow()], { db: ctx.db, api })

    expect(second).not.toBe(first)
    const entry = listEntries(ctx.db, second)[0]
    expect(entry.state).toBe('confirmed')
    // A NEW key: replaying the old one would return the entity that was just deleted.
    expect(entry.requestId).not.toBe(firstKey)
    expect(entry.qboId).toBe('2')
    expect(ledgerHashes()).toEqual([hash('a')])
  })
})
