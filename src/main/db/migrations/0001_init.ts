// src/main/db/migrations/0001_init.ts
//
// Migration 0001: the minimal Phase 1 schema.
//
// Creates ONLY app_settings, a non-secret key-value table. Schema versioning itself is
// tracked by SQLite's PRAGMA user_version (bumped by the runner in migrate.ts), so no
// separate mirror schema_version table is needed. NO feature tables are created here
// (decision D-15): dedupe hashes, the parsed-results cache, the sent-transaction ledger,
// and the audit log are each added later by their owning phase's own migration.
//
// app_settings is STRICT (rigid per-column typing) and holds plain app state only (window
// size, last-scanned folder, and so on). No secret material ever lands here (decision
// D-12); secrets live encrypted in secrets.enc via the secret store, never in SQLite.

import type Database from 'better-sqlite3'

export const migration0001 = {
  version: 1,
  up(db: Database.Database): void {
    db.exec(
      `CREATE TABLE IF NOT EXISTS app_settings (
         key   TEXT PRIMARY KEY,
         value TEXT NOT NULL
       ) STRICT;`
    )
  }
}
