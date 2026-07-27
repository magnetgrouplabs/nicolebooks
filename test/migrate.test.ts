// test/migrate.test.ts
//
// SC3 unit coverage for the forward-only SQLite migration runner (decisions D-13/D-15,
// threat T-01-06). Runs against a real better-sqlite3 handle opened on a temp file (not
// :memory:) so the persistence-across-reopen behavior is genuinely exercised.
//
// Behaviors covered:
//   1. a fresh database reports user_version 0, and after migrate() it reports LATEST_VERSION
//   2. after migrate() the app_settings table exists with columns key and value
//   3. running migrate() a second time is a no-op and does not throw (idempotent)
//   4. the shipped feature tables are all present — per D-15 each feature table is added by its
//      owning phase's migration; Phase 2 owns the dedupe ledger posted_file_hashes
//      (migration0002) and Phase 3 owns the parsed-results cache (migration0003)
//
// FINISH SPRINT: the version and table assertions were EXACT constants until 0004 (QBO-CONNECT)
// and 0005 (POSTING-ENGINE) started landing from parallel worktrees. Pinning "user_version is 3"
// and "the table set is exactly these three" would have made every downstream migration a
// merge-conflict in this file, for no coverage: what these assertions are actually for is that
// the runner APPLIES what it is given and stays idempotent. The per-migration structure is pinned
// by the owning phase's own spec (see test/posting-migration.test.ts).
//   5. posted_file_hashes exposes the dedupe-ledger columns
//   6. parsed_results exposes the 21 D-24 columns, is STRICT, declares no BOOLEAN column
//      (RESEARCH Pitfall 8), and keys on file_hash (the Phase 2 SHA-256, D-14)
//   6b. qbo_reference is STRICT, keys on (realm_id, entity_kind, entity_id) so one company's
//      reference data can never overwrite another's and a Vendor id cannot collide with an Item
//      id, and stores its active flag as an INTEGER (migration0004)
//   7. an EXISTING database already at user_version 2 upgrades forward without losing
//      its Phase 1/2 data — the forward-only ratchet applied to a real upgrade, not just to
//      a fresh install
//   8. a value written to app_settings survives closing and reopening the same file
//
// The runner and migrations are pure (no electron import), so this suite imports them
// directly and never touches app.getPath.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { LATEST_VERSION, migrate } from '../src/main/db/migrate'
import { migration0001 } from '../src/main/db/migrations/0001_init'
import { migration0002 } from '../src/main/db/migrations/0002_dedupe'

let dir: string
let dbPath: string
const opened: Database.Database[] = []

/**
 * Open a handle on the temp file and register it for teardown. Windows will not unlink a file
 * that still has an open handle, so a failed assertion before an explicit close() used to
 * cascade into a second, misleading EBUSY failure from the afterEach rmSync.
 */
function openDb(): Database.Database {
  const db = new Database(dbPath)
  opened.push(db)
  return db
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nb-migrate-'))
  dbPath = join(dir, 'app.db')
})

afterEach(() => {
  for (const db of opened.splice(0)) {
    try {
      db.close()
    } catch {
      /* already closed by the test body */
    }
  }
  rmSync(dir, { recursive: true, force: true })
})

function columnNames(db: Database.Database, table: string): string[] {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  return rows.map((r) => r.name)
}

/** The exact D-24 column list for parsed_results, in DDL order (20 columns + the D-21 flag). */
const PARSED_RESULTS_COLUMNS = [
  'file_hash',
  'original_filename',
  'route',
  'page_count',
  'model',
  'base_url_host',
  'vendor',
  'invoice_number',
  'invoice_date',
  'due_date',
  'subtotal_cents',
  'tax_cents',
  'total_cents',
  'currency',
  'suggested_category',
  'field_confidence',
  'validation_flags',
  'raw_response',
  'parsed_at',
  'schema_version',
  'truncated'
]

describe('migrate()', () => {
  it('advances user_version from 0 to the latest migration on a fresh database', () => {
    const db = openDb()
    expect(db.pragma('user_version', { simple: true })).toBe(0)
    migrate(db)
    expect(db.pragma('user_version', { simple: true })).toBe(LATEST_VERSION)
    expect(LATEST_VERSION).toBeGreaterThanOrEqual(3)
    db.close()
  })

  it('creates the app_settings table with key and value columns', () => {
    const db = openDb()
    migrate(db)
    const cols = columnNames(db, 'app_settings')
    expect(cols).toContain('key')
    expect(cols).toContain('value')
    db.close()
  })

  it('is idempotent: a second migrate() is a no-op and does not throw', () => {
    const db = openDb()
    migrate(db)
    expect(() => migrate(db)).not.toThrow()
    expect(db.pragma('user_version', { simple: true })).toBe(LATEST_VERSION)
    db.close()
  })

  it('creates the owning-phase feature tables (D-15), in migration order', () => {
    // D-15: each feature table is added by its owning phase's migration. Phase 1 owns
    // app_settings (migration0001); Phase 2 owns the dedupe ledger posted_file_hashes
    // (migration0002); Phase 3 owns the parsed-results cache (migration0003, D-17/D-24).
    // Later phases add their own and assert their own structure in their own spec.
    const db = openDb()
    migrate(db)
    const tables = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
        .all() as Array<{ name: string }>
    ).map((t) => t.name)
    expect(tables.slice(0, 3)).toEqual(['app_settings', 'posted_file_hashes', 'parsed_results'])
    db.close()
  })

  it('creates qbo_reference realm scoped, STRICT, with an INTEGER active flag (migration0004)', () => {
    // The composite key is the load-bearing part. realm_id first means one company's reference
    // data can never overwrite another's, and entity_kind in the key means Vendor 58 and Item 58
    // stay separate records: QuickBooks numbers each entity type independently, so a key of
    // (realm, id) alone would silently collapse them.
    const db = openDb()
    migrate(db)

    expect(columnNames(db, 'qbo_reference')).toEqual([
      'realm_id',
      'entity_kind',
      'entity_id',
      'name',
      'active',
      'account_type',
      'account_sub_type',
      'synced_at'
    ])

    const info = db.prepare('PRAGMA table_info(qbo_reference)').all() as Array<{
      name: string
      type: string
      notnull: number
      pk: number
    }>
    const keyColumns = info
      .filter((c) => c.pk > 0)
      .sort((a, b) => a.pk - b.pk)
      .map((c) => c.name)
    expect(keyColumns).toEqual(['realm_id', 'entity_kind', 'entity_id'])

    // STRICT has no BOOLEAN type and better-sqlite3 will not bind a JS boolean (Pitfall 8), so the
    // active flag has to be an INTEGER 0/1 with the coercion in qbo/reference.ts.
    const byName = new Map(info.map((c) => [c.name, c]))
    expect(byName.get('active')?.type).toBe('INTEGER')
    expect(byName.get('active')?.notnull).toBe(1)
    // Account type only applies to accounts, so it must stay nullable for vendors and items.
    expect(byName.get('account_type')?.notnull).toBe(0)
    expect(byName.get('account_sub_type')?.notnull).toBe(0)

    const row = db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'qbo_reference'")
      .get() as { sql: string }
    expect(row.sql).toMatch(/\)\s*STRICT\s*$/)

    for (const type of info.map((c) => c.type.toUpperCase())) {
      expect(['INTEGER', 'REAL', 'TEXT', 'BLOB', 'ANY']).toContain(type)
    }

    db.close()
  })

  it('never lets a token or a client secret reach SQLite through the qbo cache (D-05/D-12)', () => {
    // A structural check, not a behavioural one: the reference cache stores names, ids, and types.
    // A column that could plausibly hold a credential would be the leak, so the column list is
    // asserted above and this asserts the intent that no column is named for one.
    const db = openDb()
    migrate(db)
    const columns = columnNames(db, 'qbo_reference').join(' ')
    expect(columns).not.toMatch(/token|secret|client_id|password/i)
    db.close()
  })

  it('creates posted_file_hashes with the dedupe-ledger columns (migration0002)', () => {
    const db = openDb()
    migrate(db)
    const cols = columnNames(db, 'posted_file_hashes')
    expect(cols).toEqual(['hash', 'posted_at', 'original_filename', 'qbo_entity', 'qbo_id'])
    db.close()
  })

  it('creates parsed_results with exactly the D-24 columns plus the D-21 truncated flag (migration0003)', () => {
    const db = openDb()
    migrate(db)
    expect(columnNames(db, 'parsed_results')).toEqual(PARSED_RESULTS_COLUMNS)
    db.close()
  })

  it('keys parsed_results on file_hash and declares the storage types D-24 requires', () => {
    // file_hash is the Phase 2 SHA-256 and the cache key (D-14): PRIMARY KEY gives both the
    // uniqueness constraint and the O(log n) lookup, the same idiom as posted_file_hashes.hash.
    // Money is INTEGER cents (RESEARCH Pitfall 4 — a REAL column would lose cents), the JSON
    // blobs are TEXT (5a-A), and the D-21 truncated flag is an INTEGER 0/1.
    const db = openDb()
    migrate(db)
    const info = db.prepare('PRAGMA table_info(parsed_results)').all() as Array<{
      name: string
      type: string
      notnull: number
      pk: number
    }>
    const byName = new Map(info.map((c) => [c.name, c]))

    expect(byName.get('file_hash')?.pk).toBe(1)
    expect(byName.get('file_hash')?.type).toBe('TEXT')
    // Exactly one primary-key column: the hash alone, never hash+model (RESEARCH Pitfall 7).
    expect(info.filter((c) => c.pk > 0).map((c) => c.name)).toEqual(['file_hash'])

    for (const money of ['subtotal_cents', 'tax_cents', 'total_cents']) {
      expect(byName.get(money)?.type).toBe('INTEGER')
    }
    expect(byName.get('page_count')?.type).toBe('INTEGER')
    expect(byName.get('schema_version')?.type).toBe('INTEGER')
    expect(byName.get('truncated')?.type).toBe('INTEGER')
    for (const json of ['field_confidence', 'validation_flags', 'raw_response']) {
      expect(byName.get(json)?.type).toBe('TEXT')
    }

    // D-09/D-24: total is required, the two other money columns are genuinely nullable.
    expect(byName.get('total_cents')?.notnull).toBe(1)
    expect(byName.get('subtotal_cents')?.notnull).toBe(0)
    expect(byName.get('tax_cents')?.notnull).toBe(0)

    db.close()
  })

  it('declares parsed_results STRICT with no BOOLEAN column (RESEARCH Pitfall 8)', () => {
    // STRICT tables accept only INTEGER/REAL/TEXT/BLOB/ANY, so a BOOLEAN-typed column would
    // make the CREATE TABLE itself fail. Assert against the DECLARED types from table_info
    // rather than the DDL text — sqlite_master.sql keeps the source comments, and the DDL
    // comments legitimately mention the word this rule is about.
    const db = openDb()
    migrate(db)
    const row = db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'parsed_results'")
      .get() as { sql: string }
    expect(row.sql).toMatch(/\)\s*STRICT\s*$/)

    const types = (
      db.prepare('PRAGMA table_info(parsed_results)').all() as Array<{ type: string }>
    ).map((c) => c.type.toUpperCase())
    expect(types).not.toContain('BOOLEAN')
    for (const type of types) {
      expect(['INTEGER', 'REAL', 'TEXT', 'BLOB', 'ANY']).toContain(type)
    }
    db.close()
  })

<<<<<<< HEAD
  it('upgrades an existing database already at user_version 2 forward to 4 without data loss', () => {
    // The real upgrade path for an installed copy: Phases 1-2 already ran, so app_settings and
    // posted_file_hashes exist with live rows and user_version is 2. migrate() must apply the
    // pending migrations in order (forward-only ratchet) and leave the existing rows untouched.
=======
  it('upgrades an existing database already at user_version 2 forward without data loss', () => {
    // The real upgrade path for an installed copy: Phases 1-2 already ran, so app_settings and
    // posted_file_hashes exist with live rows and user_version is 2. migrate() must apply every
    // migration ABOVE 2 (forward-only ratchet) and leave the existing rows untouched.
>>>>>>> worktree-agent-afedfec54831a4be4
    const first = openDb()
    try {
      migration0001.up(first)
      migration0002.up(first)
      first.pragma('user_version = 2')
      first.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?)').run('ai-model', 'gpt-4o')
      first
        .prepare(
          'INSERT INTO posted_file_hashes (hash, posted_at, original_filename) VALUES (?, ?, ?)'
        )
        .run('c'.repeat(64), '2026-07-20T14:03:00.000Z', 'march-electric-bill.pdf')
    } finally {
      // try/finally so a failed assertion still releases the Windows file lock and the
      // afterEach rmSync does not cascade into a second, misleading failure.
      first.close()
    }

    const second = openDb()
    try {
      expect(second.pragma('user_version', { simple: true })).toBe(2)
      expect(() => migrate(second)).not.toThrow()
<<<<<<< HEAD
      expect(second.pragma('user_version', { simple: true })).toBe(4)
=======
      expect(second.pragma('user_version', { simple: true })).toBe(LATEST_VERSION)
>>>>>>> worktree-agent-afedfec54831a4be4
      expect(columnNames(second, 'parsed_results')).toEqual(PARSED_RESULTS_COLUMNS)

      // Pre-existing data survived the upgrade.
      const setting = second.prepare('SELECT value FROM app_settings WHERE key = ?').get('ai-model')
      expect(setting).toEqual({ value: 'gpt-4o' })
      const posted = second
        .prepare('SELECT original_filename FROM posted_file_hashes WHERE hash = ?')
        .get('c'.repeat(64))
      expect(posted).toEqual({ original_filename: 'march-electric-bill.pdf' })
    } finally {
      second.close()
    }
  })

  it('persists an app_settings value across a close and reopen of the same file', () => {
    const first = openDb()
    migrate(first)
    first
      .prepare('INSERT INTO app_settings (key, value) VALUES (?, ?)')
      .run('last-folder', '/bills/2026-07')
    first.close()

    const second = openDb()
    // Re-running migrate on the reopened file must remain a no-op (already at the latest version).
    migrate(second)
    const row = second.prepare('SELECT value FROM app_settings WHERE key = ?').get('last-folder') as
      | { value: string }
      | undefined
    expect(row?.value).toBe('/bills/2026-07')
    second.close()
  })
})
