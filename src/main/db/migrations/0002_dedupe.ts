// src/main/db/migrations/0002_dedupe.ts
//
// Migration 0002: the Phase 2 dedupe-hash ledger (decisions D-08/D-16, ING-04).
//
// Creates ONE STRICT table, posted_file_hashes, mirroring the 0001_init STRICT pattern. This
// ledger is POSTED-ONLY (Design B, the RESEARCH-recommended split, D-08): a row exists here
// iff that exact file was posted to QuickBooks. Phase 2 is strictly READ-ONLY on this table
// (the dedupe check `SELECT ... WHERE hash = ?` arrives in plan 02-02); the row-insert that
// marks a hash sent is a Phase 7 responsibility. No Phase 2 code path writes this table.
//
// `hash TEXT PRIMARY KEY` gives both the uniqueness constraint and an O(log n) lookup for the
// dedupe check. posted_at/original_filename are the post-time provenance Phase 7 fills; the
// nullable qbo_entity/qbo_id record which QuickBooks entity the file became.

import type Database from 'better-sqlite3'

export const migration0002 = {
  version: 2,
  up(db: Database.Database): void {
    db.exec(
      `CREATE TABLE IF NOT EXISTS posted_file_hashes (
         hash              TEXT PRIMARY KEY,
         posted_at         TEXT NOT NULL,
         original_filename TEXT NOT NULL,
         qbo_entity        TEXT,
         qbo_id            TEXT
       ) STRICT;`
    )
  }
}
