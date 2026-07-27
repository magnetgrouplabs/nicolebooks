// src/main/db/migrate.ts
//
// Forward-only SQLite migration runner keyed on PRAGMA user_version (RESEARCH Pattern 6,
// decisions D-13/D-15).
//
// On startup the runner reads the database's current user_version, selects every code
// defined migration whose version is greater, and applies them in ascending order inside a
// single transaction. After each up() it bumps user_version to that migration's integer, so
// a re-run with nothing pending is a no-op (idempotent).
//
// Security (threat T-01-06, tampering): the table statement uses better-sqlite3's exec API
// with no interpolation. The ONLY interpolated SQL in the whole runner is
// `PRAGMA user_version = N`, where N is an integer taken solely from the code-controlled
// migration list below, never from renderer input (a PRAGMA value cannot be a bound
// parameter). That single interpolation is therefore not attacker reachable.

import type Database from 'better-sqlite3'
import { migration0001 } from './migrations/0001_init'
import { migration0002 } from './migrations/0002_dedupe'
import { migration0003 } from './migrations/0003_parsed_results'
import { migration0005 } from './migrations/0005_posting'

export type Migration = { version: number; up: (db: Database.Database) => void }

// The code-controlled migration list. Append 0004, ... in later phases; never renumber an
// existing entry (user_version is a forward-only ratchet). 0002 adds the Phase 2 dedupe
// ledger posted_file_hashes; 0003 adds the Phase 3 parsed-results cache.
//
// RESERVED FOR THE FINISH SPRINT (SEAMS). Two agents write migrations in parallel worktrees, so
// the numbers are assigned up front rather than raced for. Taking the "next free" number by
// looking at this list would give both agents 0004 and produce two files with version: 4, of
// which the runner would silently apply only the first (the second's version is no longer
// greater than user_version). Use YOUR number, not the next free one:
//   0004 -- qbo reference cache (vendors, expense accounts, payment accounts, items). QBO-CONNECT.
//   0005 -- posting batches + per-entry audit ledger. POSTING-ENGINE.
// Any migration beyond 0005 needs a number assigned by Fable. Add the import above, append the
// entry here in ascending order, and follow the 0002/0003 shape: one STRICT table, integer cents
// for money, INTEGER 0/1 for booleans (STRICT has no BOOLEAN and better-sqlite3 will not bind a
// JS boolean), and never any secret material.
//
// 0005 (posting_batches + posting_entries) has landed. 0004 arrives from QBO-CONNECT's worktree
// and slots in ahead of it: the list is FILTERED AND SORTED by version at run time, so a database
// that took 0005 before 0004 existed would skip 0004 forever. That is a merge-time concern for
// exactly one machine (a dev who ran this branch before the merge) and is fixed by deleting the
// local app.db; a shipped install has never seen either number.
const migrations: Migration[] = [migration0001, migration0002, migration0003, migration0005]

/**
 * The highest version this build knows how to apply, so a spec can assert "migrate() advanced the
 * database to the latest" without hard-coding a number that every new migration has to edit.
 */
export const LATEST_VERSION = migrations.reduce((max, m) => Math.max(max, m.version), 0)

export function migrate(db: Database.Database): void {
  const current = db.pragma('user_version', { simple: true }) as number
  const pending = migrations
    .filter((m) => m.version > current)
    .sort((a, b) => a.version - b.version)

  const run = db.transaction((list: Migration[]) => {
    for (const m of list) {
      m.up(db)
      // N is a code-controlled integer from the list above, never renderer input (T-01-06).
      db.pragma(`user_version = ${m.version}`)
    }
  })

  run(pending)
}
