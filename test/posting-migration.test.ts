// test/posting-migration.test.ts
//
// Migration 0005 (posting_batches + posting_entries), against a real temp SQLite file.
//
// The house rules are asserted structurally rather than by reading the DDL text, because the DDL
// comments legitimately mention the words the rules are about (the same trick test/migrate.test.ts
// uses for parsed_results).
//
// Three of these assertions are load-bearing rather than decorative:
//   * request_id is UNIQUE and NOT NULL. It is the idempotency key. A bug that reused one key
//     across two different entries would otherwise silently collapse two bills into one, and the
//     symptom would be a missing bill nobody notices for a month.
//   * UNIQUE (batch_id, file_hash). One entry per document per batch is what makes a re-send
//     RESUME rather than duplicate.
//   * amount_cents is INTEGER. A REAL column loses cents, and this is a financial tool.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type Database from 'better-sqlite3'
import { openTestDb, type TestDb } from './helpers/posting-fixtures'

let ctx: TestDb

beforeEach(() => {
  ctx = openTestDb()
})

afterEach(() => {
  ctx.cleanup()
})

function columns(db: Database.Database, table: string): Array<{
  name: string
  type: string
  notnull: number
  pk: number
}> {
  return db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
    name: string
    type: string
    notnull: number
    pk: number
  }>
}

const BATCH_COLUMNS = ['id', 'created_at', 'updated_at', 'realm_id', 'state', 'entry_count']

const ENTRY_COLUMNS = [
  'id',
  'batch_id',
  'position',
  'file_hash',
  'filename',
  'entry_type',
  'request_id',
  'state',
  'qbo_id',
  'sync_token',
  'error',
  'vendor_id',
  'vendor_name',
  'category_account_id',
  'category_account_name',
  'paid_from_account_id',
  'paid_from_account_name',
  'txn_date',
  'due_date',
  'ref_number',
  'memo',
  'amount_cents',
  'realm_id',
  'created_at',
  'updated_at',
  'sent_at',
  'confirmed_at',
  'undone_at',
  'undo_reason'
]

describe('migration 0005', () => {
  it('advances user_version to 5', () => {
    expect(ctx.db.pragma('user_version', { simple: true })).toBe(5)
  })

  it('creates posting_batches and posting_entries alongside the earlier phases tables', () => {
    const tables = (
      ctx.db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
        .all() as Array<{ name: string }>
    ).map((t) => t.name)
    expect(tables).toContain('posting_batches')
    expect(tables).toContain('posting_entries')
    // The three shipped tables are untouched by this migration.
    expect(tables).toContain('app_settings')
    expect(tables).toContain('posted_file_hashes')
    expect(tables).toContain('parsed_results')
  })

  it('declares the posting_batches columns', () => {
    expect(columns(ctx.db, 'posting_batches').map((c) => c.name)).toEqual(BATCH_COLUMNS)
  })

  it('declares the posting_entries columns', () => {
    expect(columns(ctx.db, 'posting_entries').map((c) => c.name)).toEqual(ENTRY_COLUMNS)
  })

  it('keeps money as INTEGER cents, never REAL', () => {
    const byName = new Map(columns(ctx.db, 'posting_entries').map((c) => [c.name, c]))
    expect(byName.get('amount_cents')?.type).toBe('INTEGER')
    expect(byName.get('amount_cents')?.notnull).toBe(1)
  })

  it('declares both tables STRICT with only storage types STRICT accepts', () => {
    for (const table of ['posting_batches', 'posting_entries']) {
      const row = ctx.db
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get(table) as { sql: string }
      expect(row.sql).toMatch(/STRICT\s*;?\s*$/)
      for (const column of columns(ctx.db, table)) {
        expect(['INTEGER', 'REAL', 'TEXT', 'BLOB', 'ANY']).toContain(column.type.toUpperCase())
      }
    }
  })

  it('declares no BOOLEAN column: undo state is a nullable timestamp, which is also the audit fact', () => {
    const types = columns(ctx.db, 'posting_entries').map((c) => c.type.toUpperCase())
    expect(types).not.toContain('BOOLEAN')
    expect(columns(ctx.db, 'posting_entries').find((c) => c.name === 'undone_at')?.type).toBe('TEXT')
  })

  it('requires a request_id on every entry', () => {
    const requestId = columns(ctx.db, 'posting_entries').find((c) => c.name === 'request_id')
    expect(requestId?.notnull).toBe(1)
  })

  it('enforces request_id uniqueness, so one key can never cover two different entries', () => {
    seedBatch(ctx.db, 'b1')
    insertRaw(ctx.db, { batchId: 'b1', fileHash: 'a'.repeat(64), requestId: 'shared-key' })
    expect(() =>
      insertRaw(ctx.db, { batchId: 'b1', fileHash: 'b'.repeat(64), requestId: 'shared-key' })
    ).toThrow(/UNIQUE/i)
  })

  it('enforces one entry per document per batch, which is what makes a re-send resume', () => {
    seedBatch(ctx.db, 'b1')
    insertRaw(ctx.db, { batchId: 'b1', fileHash: 'a'.repeat(64), requestId: 'k1' })
    expect(() =>
      insertRaw(ctx.db, { batchId: 'b1', fileHash: 'a'.repeat(64), requestId: 'k2' })
    ).toThrow(/UNIQUE/i)
  })

  it('allows the same document in a DIFFERENT batch, because a corrected re-entry is legitimate', () => {
    seedBatch(ctx.db, 'b1')
    seedBatch(ctx.db, 'b2')
    insertRaw(ctx.db, { batchId: 'b1', fileHash: 'a'.repeat(64), requestId: 'k1' })
    expect(() =>
      insertRaw(ctx.db, { batchId: 'b2', fileHash: 'a'.repeat(64), requestId: 'k2' })
    ).not.toThrow()
  })

  it('indexes the three real access paths', () => {
    const indexes = (
      ctx.db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'posting_entries'")
        .all() as Array<{ name: string }>
    ).map((i) => i.name)
    expect(indexes).toContain('posting_entries_batch_idx')
    expect(indexes).toContain('posting_entries_file_hash_idx')
    expect(indexes).toContain('posting_entries_vendor_date_idx')
  })

  it('is idempotent: reopening the same file re-runs migrate as a no-op', () => {
    seedBatch(ctx.db, 'b1')
    insertRaw(ctx.db, { batchId: 'b1', fileHash: 'a'.repeat(64), requestId: 'k1' })
    const reopened = ctx.reopen()
    expect(reopened.pragma('user_version', { simple: true })).toBe(5)
    const row = reopened.prepare('SELECT request_id FROM posting_entries WHERE batch_id = ?').get('b1')
    expect(row).toEqual({ request_id: 'k1' })
  })
})

function seedBatch(db: Database.Database, id: string): void {
  db.prepare(
    `INSERT INTO posting_batches (id, created_at, updated_at, realm_id, state, entry_count)
     VALUES (?, '2026-07-27T00:00:00.000Z', '2026-07-27T00:00:00.000Z', '934', 'open', 0)`
  ).run(id)
}

function insertRaw(
  db: Database.Database,
  entry: { batchId: string; fileHash: string; requestId: string }
): void {
  db.prepare(
    `INSERT INTO posting_entries
       (batch_id, position, file_hash, entry_type, request_id, state, vendor_id,
        category_account_id, txn_date, amount_cents, realm_id, created_at, updated_at)
     VALUES (?, 0, ?, 'bill', ?, 'pending', '42', '7', '2026-07-27', 12345, '934',
             '2026-07-27T00:00:00.000Z', '2026-07-27T00:00:00.000Z')`
  ).run(entry.batchId, entry.fileHash, entry.requestId)
}
