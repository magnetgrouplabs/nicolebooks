// test/helpers/posting-fixtures.ts
//
// Shared scaffolding for the posting suite: a real migrated SQLite file on a temp path, and a
// well-formed approved review row to mutate per assertion.
//
// A real file rather than :memory: for the same reason test/migrate.test.ts uses one: the engine's
// guarantees are about what survives a crash, and a database that only ever existed in a process
// cannot demonstrate that.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { migrate } from '../../src/main/db/migrate'
import type { PostingRow } from '../../src/shared/ipc-contract'

export interface TestDb {
  db: Database.Database
  path: string
  /** Close the handle and remove the temp directory. Windows will not unlink an open file. */
  cleanup: () => void
  /** Close and reopen the same file, proving durability across a process restart. */
  reopen: () => Database.Database
}

export function openTestDb(): TestDb {
  const dir = mkdtempSync(join(tmpdir(), 'nb-posting-'))
  const path = join(dir, 'app.db')
  const opened: Database.Database[] = []

  const open = (): Database.Database => {
    const handle = new Database(path)
    migrate(handle)
    opened.push(handle)
    return handle
  }

  const db = open()

  return {
    db,
    path,
    reopen: () => {
      for (const handle of opened.splice(0)) {
        try {
          handle.close()
        } catch {
          /* already closed */
        }
      }
      return open()
    },
    cleanup: () => {
      for (const handle of opened.splice(0)) {
        try {
          handle.close()
        } catch {
          /* already closed */
        }
      }
      rmSync(dir, { recursive: true, force: true })
    }
  }
}

/** A 64-char lowercase SHA-256 hex hash built from a single character, for readable fixtures. */
export function hash(char: string): string {
  return char.repeat(64)
}

/** A well-formed approved bill row. Spread and override per assertion. */
export function billRow(overrides: Partial<PostingRow> = {}): PostingRow {
  return {
    fileHash: hash('a'),
    entryType: 'bill',
    vendorId: '42',
    categoryAccountId: '7',
    paidFromAccountId: null,
    txnDate: '2026-07-27',
    dueDate: '2026-08-26',
    refNumber: 'INV-1001',
    amountCents: 12345,
    memo: null,
    ...overrides
  }
}

/** A well-formed approved expense row (already paid, so it names the account that paid it). */
export function expenseRow(overrides: Partial<PostingRow> = {}): PostingRow {
  return {
    ...billRow(),
    entryType: 'expense',
    paidFromAccountId: '35',
    dueDate: null,
    ...overrides
  }
}

/** Seed a parsed_results row so the engine can denormalize a filename onto the entry. */
export function seedParsedFilename(
  db: Database.Database,
  fileHash: string,
  filename: string
): void {
  db.prepare(
    `INSERT OR REPLACE INTO parsed_results
       (file_hash, original_filename, route, page_count, model, total_cents, field_confidence,
        parsed_at, schema_version, truncated)
     VALUES (?, ?, 'native', 1, 'test-model', 12345, '{}', '2026-07-27T00:00:00.000Z', 1, 0)`
  ).run(fileHash, filename)
}
