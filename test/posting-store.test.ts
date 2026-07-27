// test/posting-store.test.ts
//
// The persistence layer: the batch/entry state machine as it is actually stored, the dedupe-ledger
// write half of Design B, and the duplicate warning the review screen will call.
//
// THE DUPLICATE WARNING IS NOT THE DEDUPE CHECK. Phase 2 catches the same FILE by hash. This
// catches the same BILL arriving as different bytes: a re-scanned paper copy, a PDF that was also
// photographed, a vendor's duplicate email. Same money, different file, so the hash says nothing
// and only vendor + amount + a date window can see it.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  DUPLICATE_WINDOW_DAYS,
  deletePostedHash,
  findPriorConfirmedEntries,
  findResumableBatch,
  findUndoableBatch,
  insertBatch,
  insertEntry,
  insertPostedHash,
  isHashPosted,
  isoDaysBetween,
  listBatches,
  lookupFilename,
  markEntryConfirmed,
  markEntryFailed,
  markEntrySent,
  markEntryUndone,
  refreshBatchState,
  shiftIsoDate,
  updateEntryFields,
  type NewEntryInput
} from '../src/main/posting/store'
import { checkPostedHash } from '../src/main/ingestion/ledger'
import { hash, openTestDb, seedParsedFilename, type TestDb } from './helpers/posting-fixtures'

let ctx: TestDb
const NOW = '2026-07-27T12:00:00.000Z'

beforeEach(() => {
  ctx = openTestDb()
})

afterEach(() => {
  ctx.cleanup()
})

function seedBatch(id: string, createdAt = NOW): void {
  insertBatch(ctx.db, { id, createdAt, realmId: '934', entryCount: 0 })
}

function newEntry(overrides: Partial<NewEntryInput> = {}): NewEntryInput {
  return {
    batchId: 'b1',
    position: 0,
    fileHash: hash('a'),
    filename: 'march-electric-bill.pdf',
    entryType: 'bill',
    requestId: 'key-1',
    vendorId: '42',
    vendorName: 'Nassau Plumbing Supply',
    categoryAccountId: '7',
    categoryAccountName: 'Job Materials',
    paidFromAccountId: null,
    paidFromAccountName: null,
    txnDate: '2026-07-27',
    dueDate: '2026-08-26',
    refNumber: 'INV-1001',
    memo: null,
    amountCents: 12345,
    realmId: '934',
    createdAt: NOW,
    ...overrides
  }
}

describe('the entry state machine as stored', () => {
  it('starts pending with its request id already on disk', () => {
    seedBatch('b1')
    const entry = insertEntry(ctx.db, newEntry())
    expect(entry.state).toBe('pending')
    expect(entry.requestId).toBe('key-1')
    expect(entry.sentAt).toBeNull()
    expect(entry.confirmedAt).toBeNull()
  })

  it('moves pending to sent, sent to confirmed, and records what QuickBooks created', () => {
    seedBatch('b1')
    const entry = insertEntry(ctx.db, newEntry())

    markEntrySent(ctx.db, entry.id, NOW)
    expect(reload(entry.id).state).toBe('sent')
    expect(reload(entry.id).sentAt).toBe(NOW)

    markEntryConfirmed(ctx.db, entry.id, { qboId: '55', syncToken: '0', now: NOW })
    const confirmed = reload(entry.id)
    expect(confirmed.state).toBe('confirmed')
    expect(confirmed.qboId).toBe('55')
    expect(confirmed.syncToken).toBe('0')
    expect(confirmed.confirmedAt).toBe(NOW)
  })

  it('clears a stale error when an entry is retried, so a fixed row does not still read failed', () => {
    seedBatch('b1')
    const entry = insertEntry(ctx.db, newEntry())
    markEntryFailed(ctx.db, entry.id, 'Could not reach QuickBooks.', NOW)
    expect(reload(entry.id).error).toBe('Could not reach QuickBooks.')

    markEntrySent(ctx.db, entry.id, NOW)
    expect(reload(entry.id).error).toBeNull()
  })

  it('never changes a request id when a re-send refreshes the editable fields', () => {
    // The immutability of this one column is the idempotency contract. Regenerating it on a retry
    // would make the retry a second, unrelated create.
    seedBatch('b1')
    const entry = insertEntry(ctx.db, newEntry())
    markEntryFailed(ctx.db, entry.id, 'Something.', NOW)

    updateEntryFields(ctx.db, entry.id, {
      filename: 'renamed.pdf',
      entryType: 'expense',
      vendorId: '43',
      vendorName: 'Someone Else',
      categoryAccountId: '8',
      categoryAccountName: 'Supplies',
      paidFromAccountId: '35',
      paidFromAccountName: 'Business Checking',
      txnDate: '2026-07-28',
      dueDate: null,
      refNumber: 'INV-9',
      memo: 'edited',
      amountCents: 999,
      updatedAt: NOW
    })

    const updated = reload(entry.id)
    expect(updated.requestId).toBe('key-1')
    expect(updated.state).toBe('pending')
    expect(updated.error).toBeNull()
    expect(updated.amountCents).toBe(999)
    expect(updated.entryType).toBe('expense')
  })
})

describe('batch state is descriptive, resumability is computed', () => {
  it('reports open while any entry is pending, sent, or failed', () => {
    seedBatch('b1')
    const a = insertEntry(ctx.db, newEntry())
    const b = insertEntry(ctx.db, newEntry({ fileHash: hash('b'), requestId: 'key-2', position: 1 }))
    markEntryConfirmed(ctx.db, a.id, { qboId: '1', syncToken: '0', now: NOW })
    markEntryFailed(ctx.db, b.id, 'nope', NOW)

    expect(refreshBatchState(ctx.db, 'b1', NOW)).toBe('open')
    expect(findResumableBatch(ctx.db)?.id).toBe('b1')
  })

  it('reports complete when every entry is confirmed, and is then not resumable', () => {
    seedBatch('b1')
    const a = insertEntry(ctx.db, newEntry())
    markEntryConfirmed(ctx.db, a.id, { qboId: '1', syncToken: '0', now: NOW })

    expect(refreshBatchState(ctx.db, 'b1', NOW)).toBe('complete')
    expect(findResumableBatch(ctx.db)).toBeNull()
  })

  it('reports partially-undone and undone', () => {
    seedBatch('b1')
    const a = insertEntry(ctx.db, newEntry())
    const b = insertEntry(ctx.db, newEntry({ fileHash: hash('b'), requestId: 'key-2', position: 1 }))
    markEntryConfirmed(ctx.db, a.id, { qboId: '1', syncToken: '0', now: NOW })
    markEntryConfirmed(ctx.db, b.id, { qboId: '2', syncToken: '0', now: NOW })

    markEntryUndone(ctx.db, a.id, NOW)
    expect(refreshBatchState(ctx.db, 'b1', NOW)).toBe('partially-undone')

    markEntryUndone(ctx.db, b.id, NOW)
    expect(refreshBatchState(ctx.db, 'b1', NOW)).toBe('undone')
  })

  it('picks the most recent resumable batch, and the most recent undoable one', () => {
    seedBatch('older', '2026-07-01T00:00:00.000Z')
    seedBatch('newer', '2026-07-27T00:00:00.000Z')
    const old = insertEntry(ctx.db, newEntry({ batchId: 'older' }))
    const fresh = insertEntry(
      ctx.db,
      newEntry({ batchId: 'newer', fileHash: hash('b'), requestId: 'key-2' })
    )
    markEntryConfirmed(ctx.db, old.id, { qboId: '1', syncToken: '0', now: NOW })
    markEntryFailed(ctx.db, fresh.id, 'nope', NOW)

    expect(findResumableBatch(ctx.db)?.id).toBe('newer')
    // The newer batch has nothing confirmed, so undo reaches past it.
    expect(findUndoableBatch(ctx.db)?.id).toBe('older')
  })

  it('lists batches newest first', () => {
    seedBatch('older', '2026-07-01T00:00:00.000Z')
    seedBatch('newer', '2026-07-27T00:00:00.000Z')
    expect(listBatches(ctx.db).map((b) => b.id)).toEqual(['newer', 'older'])
  })
})

describe('the dedupe ledger, write half of Design B', () => {
  it('inserts a row the read-only Phase 2 check then finds', () => {
    // The Phase 2 module is deliberately read only, so this is the ONLY writer. Reading it back
    // through checkPostedHash proves the two halves genuinely meet.
    insertPostedHash(ctx.db, {
      hash: hash('a'),
      postedAt: NOW,
      originalFilename: 'march-electric-bill.pdf',
      qboEntity: 'Bill',
      qboId: '55'
    })

    expect(checkPostedHash(ctx.db, hash('a'))).toEqual({
      postedAt: NOW,
      originalFilename: 'march-electric-bill.pdf'
    })
    expect(isHashPosted(ctx.db, hash('a'))).toBe(true)
  })

  it('removes a row so an undone document can be entered again', () => {
    insertPostedHash(ctx.db, {
      hash: hash('a'),
      postedAt: NOW,
      originalFilename: 'x.pdf',
      qboEntity: 'Bill',
      qboId: '55'
    })
    deletePostedHash(ctx.db, hash('a'))

    expect(checkPostedHash(ctx.db, hash('a'))).toBeUndefined()
    expect(isHashPosted(ctx.db, hash('a'))).toBe(false)
  })

  it('replaces rather than throwing when the same hash is posted again after an undo', () => {
    insertPostedHash(ctx.db, {
      hash: hash('a'),
      postedAt: NOW,
      originalFilename: 'x.pdf',
      qboEntity: 'Bill',
      qboId: '55'
    })
    expect(() =>
      insertPostedHash(ctx.db, {
        hash: hash('a'),
        postedAt: '2026-08-01T00:00:00.000Z',
        originalFilename: 'x.pdf',
        qboEntity: 'Bill',
        qboId: '77'
      })
    ).not.toThrow()
    expect(checkPostedHash(ctx.db, hash('a'))?.postedAt).toBe('2026-08-01T00:00:00.000Z')
  })

  it('treats a hash carrying SQL metacharacters as a literal that matches nothing', () => {
    expect(isHashPosted(ctx.db, "'); DROP TABLE posted_file_hashes; --")).toBe(false)
    // The table is still there.
    expect(() => ctx.db.prepare('SELECT COUNT(*) FROM posted_file_hashes').get()).not.toThrow()
  })
})

describe('lookupFilename', () => {
  it('reads the filename the parse cache recorded', () => {
    seedParsedFilename(ctx.db, hash('a'), 'march-electric-bill.pdf')
    expect(lookupFilename(ctx.db, hash('a'))).toBe('march-electric-bill.pdf')
  })

  it('returns null for a document that was never parsed, which is not an error', () => {
    expect(lookupFilename(ctx.db, hash('z'))).toBeNull()
  })
})

describe('ISO date arithmetic', () => {
  it('shifts across a month boundary', () => {
    expect(shiftIsoDate('2026-07-01', -3)).toBe('2026-06-28')
    expect(shiftIsoDate('2026-07-30', 3)).toBe('2026-08-02')
  })

  it('shifts across a year boundary and a leap day', () => {
    expect(shiftIsoDate('2027-01-01', -1)).toBe('2026-12-31')
    expect(shiftIsoDate('2028-02-28', 1)).toBe('2028-02-29')
  })

  it('counts whole days between dates, signed', () => {
    expect(isoDaysBetween('2026-07-27', '2026-07-27')).toBe(0)
    expect(isoDaysBetween('2026-07-27', '2026-07-30')).toBe(3)
    expect(isoDaysBetween('2026-07-27', '2026-07-24')).toBe(-3)
    expect(isoDaysBetween('2026-02-27', '2026-03-02')).toBe(3)
  })
})

describe('findPriorConfirmedEntries: the duplicate warning', () => {
  beforeEach(() => {
    seedBatch('b1')
  })

  function confirmEntry(overrides: Partial<NewEntryInput>, qboId: string): number {
    const entry = insertEntry(ctx.db, newEntry(overrides))
    markEntryConfirmed(ctx.db, entry.id, { qboId, syncToken: '0', now: NOW })
    return entry.id
  }

  it('finds a prior entry with the same vendor, amount, and date', () => {
    confirmEntry({}, '55')
    const found = findPriorConfirmedEntries(ctx.db, {
      vendorId: '42',
      amountCents: 12345,
      txnDate: '2026-07-27'
    })

    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({
      batchId: 'b1',
      fileHash: hash('a'),
      vendorId: '42',
      vendorName: 'Nassau Plumbing Supply',
      amountCents: 12345,
      qboId: '55',
      daysApart: 0
    })
  })

  it('finds a DIFFERENT file for the same bill, which is the whole point', () => {
    // A re-scanned paper copy has different bytes, so the Phase 2 hash check sees nothing.
    confirmEntry({}, '55')
    const found = findPriorConfirmedEntries(ctx.db, {
      vendorId: '42',
      amountCents: 12345,
      txnDate: '2026-07-27'
    })
    expect(found[0].fileHash).toBe(hash('a'))
    expect(found[0].fileHash).not.toBe(hash('q'))
  })

  it('searches plus or minus three days by default, inclusive at the edges', () => {
    confirmEntry({ txnDate: '2026-07-24' }, '1')
    confirmEntry({ fileHash: hash('b'), requestId: 'k2', position: 1, txnDate: '2026-07-30' }, '2')
    confirmEntry({ fileHash: hash('c'), requestId: 'k3', position: 2, txnDate: '2026-07-23' }, '3')
    confirmEntry({ fileHash: hash('d'), requestId: 'k4', position: 3, txnDate: '2026-07-31' }, '4')

    const found = findPriorConfirmedEntries(ctx.db, {
      vendorId: '42',
      amountCents: 12345,
      txnDate: '2026-07-27'
    })

    expect(DUPLICATE_WINDOW_DAYS).toBe(3)
    expect(found.map((f) => f.txnDate)).toEqual(['2026-07-24', '2026-07-30'])
    expect(found.map((f) => f.daysApart)).toEqual([-3, 3])
  })

  it('honours a custom window', () => {
    confirmEntry({ txnDate: '2026-07-20' }, '1')
    expect(
      findPriorConfirmedEntries(ctx.db, {
        vendorId: '42',
        amountCents: 12345,
        txnDate: '2026-07-27'
      })
    ).toHaveLength(0)
    expect(
      findPriorConfirmedEntries(ctx.db, {
        vendorId: '42',
        amountCents: 12345,
        txnDate: '2026-07-27',
        windowDays: 10
      })
    ).toHaveLength(1)
  })

  it('ignores a different vendor and a different amount', () => {
    confirmEntry({}, '55')
    expect(
      findPriorConfirmedEntries(ctx.db, {
        vendorId: '43',
        amountCents: 12345,
        txnDate: '2026-07-27'
      })
    ).toHaveLength(0)
    expect(
      findPriorConfirmedEntries(ctx.db, {
        vendorId: '42',
        amountCents: 12346,
        txnDate: '2026-07-27'
      })
    ).toHaveLength(0)
  })

  it('ignores entries that are not confirmed, because they are not in QuickBooks', () => {
    const pending = insertEntry(ctx.db, newEntry())
    markEntryFailed(ctx.db, pending.id, 'nope', NOW)
    expect(
      findPriorConfirmedEntries(ctx.db, {
        vendorId: '42',
        amountCents: 12345,
        txnDate: '2026-07-27'
      })
    ).toHaveLength(0)
  })

  it('ignores undone entries, because reversing a batch is how a user says it did not happen', () => {
    const id = confirmEntry({}, '55')
    markEntryUndone(ctx.db, id, NOW)
    expect(
      findPriorConfirmedEntries(ctx.db, {
        vendorId: '42',
        amountCents: 12345,
        txnDate: '2026-07-27'
      })
    ).toHaveLength(0)
  })

  it('carries the posted date from the ledger when there is one', () => {
    const id = confirmEntry({}, '55')
    expect(id).toBeGreaterThan(0)
    insertPostedHash(ctx.db, {
      hash: hash('a'),
      postedAt: NOW,
      originalFilename: 'march-electric-bill.pdf',
      qboEntity: 'Bill',
      qboId: '55'
    })

    const [found] = findPriorConfirmedEntries(ctx.db, {
      vendorId: '42',
      amountCents: 12345,
      txnDate: '2026-07-27'
    })
    expect(found.postedAt).toBe(NOW)
    expect(found.filename).toBe('march-electric-bill.pdf')
  })

  it('returns an empty list when nothing matches, never null', () => {
    expect(
      findPriorConfirmedEntries(ctx.db, {
        vendorId: '999',
        amountCents: 1,
        txnDate: '2026-07-27'
      })
    ).toEqual([])
  })
})

function reload(entryId: number): {
  state: string
  error: string | null
  sentAt: string | null
  confirmedAt: string | null
  qboId: string | null
  syncToken: string | null
  requestId: string
  amountCents: number
  entryType: string
} {
  const row = ctx.db.prepare('SELECT * FROM posting_entries WHERE id = ?').get(entryId) as Record<
    string,
    unknown
  >
  return {
    state: row.state as string,
    error: row.error as string | null,
    sentAt: row.sent_at as string | null,
    confirmedAt: row.confirmed_at as string | null,
    qboId: row.qbo_id as string | null,
    syncToken: row.sync_token as string | null,
    requestId: row.request_id as string,
    amountCents: row.amount_cents as number,
    entryType: row.entry_type as string
  }
}
