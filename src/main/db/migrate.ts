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

export type Migration = { version: number; up: (db: Database.Database) => void }

// The code-controlled migration list. Append 0002, 0003, ... in later phases; never
// renumber an existing entry (user_version is a forward-only ratchet).
const migrations: Migration[] = [migration0001]

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
