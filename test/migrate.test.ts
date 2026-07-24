// test/migrate.test.ts
//
// SC3 unit coverage for the forward-only SQLite migration runner (decisions D-13/D-15,
// threat T-01-06). Runs against a real better-sqlite3 handle opened on a temp file (not
// :memory:) so the persistence-across-reopen behavior is genuinely exercised.
//
// Behaviors covered:
//   1. a fresh database reports user_version 0, and after migrate() it reports 2 (both
//      migration0001 and the Phase 2 migration0002 apply)
//   2. after migrate() the app_settings table exists with columns key and value
//   3. running migrate() a second time is a no-op and does not throw (idempotent)
//   4. the table set is exactly ['app_settings', 'posted_file_hashes'] — per D-15 each
//      feature table is added by its owning phase's migration; Phase 2 owns the dedupe
//      ledger posted_file_hashes (migration0002)
//   5. posted_file_hashes exposes the dedupe-ledger columns
//   6. a value written to app_settings survives closing and reopening the same file
//
// The runner and migrations are pure (no electron import), so this suite imports them
// directly and never touches app.getPath.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { migrate } from '../src/main/db/migrate'

let dir: string
let dbPath: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nb-migrate-'))
  dbPath = join(dir, 'app.db')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function columnNames(db: Database.Database, table: string): string[] {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  return rows.map((r) => r.name)
}

describe('migrate()', () => {
  it('advances user_version from 0 to 2 on a fresh database', () => {
    const db = new Database(dbPath)
    expect(db.pragma('user_version', { simple: true })).toBe(0)
    migrate(db)
    // migration0001 (app_settings) + migration0002 (posted_file_hashes) both apply.
    expect(db.pragma('user_version', { simple: true })).toBe(2)
    db.close()
  })

  it('creates the app_settings table with key and value columns', () => {
    const db = new Database(dbPath)
    migrate(db)
    const cols = columnNames(db, 'app_settings')
    expect(cols).toContain('key')
    expect(cols).toContain('value')
    db.close()
  })

  it('is idempotent: a second migrate() is a no-op and does not throw', () => {
    const db = new Database(dbPath)
    migrate(db)
    expect(() => migrate(db)).not.toThrow()
    expect(db.pragma('user_version', { simple: true })).toBe(2)
    db.close()
  })

  it('creates exactly the owning-phase feature tables (D-15): app_settings + posted_file_hashes', () => {
    // D-15: each feature table is added by its owning phase's migration. Phase 1 owns
    // app_settings (migration0001); Phase 2 owns the dedupe ledger posted_file_hashes
    // (migration0002). Order is by creation (migration version order).
    const db = new Database(dbPath)
    migrate(db)
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all() as Array<{ name: string }>
    expect(tables.map((t) => t.name)).toEqual(['app_settings', 'posted_file_hashes'])
    db.close()
  })

  it('creates posted_file_hashes with the dedupe-ledger columns (migration0002)', () => {
    const db = new Database(dbPath)
    migrate(db)
    const cols = columnNames(db, 'posted_file_hashes')
    expect(cols).toEqual(['hash', 'posted_at', 'original_filename', 'qbo_entity', 'qbo_id'])
    db.close()
  })

  it('persists an app_settings value across a close and reopen of the same file', () => {
    const first = new Database(dbPath)
    migrate(first)
    first
      .prepare('INSERT INTO app_settings (key, value) VALUES (?, ?)')
      .run('last-folder', '/bills/2026-07')
    first.close()

    const second = new Database(dbPath)
    // Re-running migrate on the reopened file must remain a no-op (already at version 1).
    migrate(second)
    const row = second.prepare('SELECT value FROM app_settings WHERE key = ?').get('last-folder') as
      | { value: string }
      | undefined
    expect(row?.value).toBe('/bills/2026-07')
    second.close()
  })
})
