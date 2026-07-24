// test/ingestion-ledger.test.ts
//
// Wave-0 (RED) unit spec for the read-only posted-ledger dedupe check (ING-04, D-08/D-09,
// threat T-02-06). Mirrors the migrate.test.ts temp better-sqlite3 lifecycle: a real DB on a
// temp file (not :memory:), migrated so posted_file_hashes exists (proves migration0002 too).
// A single posted row is inserted directly as test-side setup, simulating the Phase-7 post
// write that Phase 2 itself never performs (Design B: Phase 2 is read-only on this table).
// Until src/main/ingestion/ledger.ts exists this file fails to import (RED), the correct state.
//
// Coverage:
//   - hit  -> { postedAt, originalFilename } (the posted date is present).
//   - miss -> undefined (the caller treats the file as loaded).
//   - SQL-metacharacter hash -> undefined, proving the hash is bound via ? and never
//     interpolated (T-02-06): the injection payload matches no row rather than being executed.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { migrate } from '../src/main/db/migrate'
import { checkPostedHash } from '../src/main/ingestion/ledger'

let dir: string
let db: Database.Database

const KNOWN_HASH = 'a'.repeat(64)
const POSTED_AT = '2026-07-20T14:03:00.000Z'
const ORIGINAL_FILENAME = 'march-electric-bill.pdf'

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nb-ledger-'))
  const dbPath = join(dir, 'app.db')
  db = new Database(dbPath)
  migrate(db)
  // Simulate a Phase-7 post: insert one posted-ledger row directly. This is test-side setup
  // only; no Phase 2 code path writes posted_file_hashes (Design B, verified by grep in 02-02).
  db.prepare(
    'INSERT INTO posted_file_hashes (hash, posted_at, original_filename) VALUES (?, ?, ?)'
  ).run(KNOWN_HASH, POSTED_AT, ORIGINAL_FILENAME)
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('checkPostedHash (read-only posted-ledger dedupe check)', () => {
  it('returns the posted date and original filename on a ledger hit', () => {
    expect(checkPostedHash(db, KNOWN_HASH)).toEqual({
      postedAt: POSTED_AT,
      originalFilename: ORIGINAL_FILENAME
    })
  })

  it('returns undefined on a miss so the caller treats the file as loaded', () => {
    expect(checkPostedHash(db, 'b'.repeat(64))).toBeUndefined()
  })

  it('binds the hash via ? and never interpolates (SQL-metacharacter hash is a miss, T-02-06)', () => {
    // A classic injection payload. With a bound parameter it is treated as a literal hash
    // value that matches no row, so the result is undefined — the OR is never evaluated as SQL.
    expect(checkPostedHash(db, "x' OR '1'='1")).toBeUndefined()
  })
})
