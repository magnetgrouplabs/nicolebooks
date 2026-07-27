// src/main/db/migrations/0003_parsed_results.ts
//
// Migration 0003: the Phase 3 parsed-results cache (decisions D-17/D-24, PARSE-05).
//
// Creates ONE STRICT table, parsed_results, mirroring the 0001_init / 0002_dedupe pattern.
// This table IS the PARSE-05 guarantee: a reload, a crash, or a re-scan finds the row for a
// file's bytes and returns it instead of re-calling (and re-paying for) the vision model.
//
// `file_hash TEXT PRIMARY KEY` is the Phase 2 SHA-256 and gives both the uniqueness
// constraint and the O(log n) cache lookup, exactly like posted_file_hashes.hash. The key is
// the hash ALONE, never hash+model (RESEARCH Pitfall 7 / D-14): the `model` column records
// which model produced the row, so switching models in Settings never silently invalidates
// the cache and re-charges the user. `schema_version` is the deliberate escape hatch — a
// prompt or schema bump can force a re-parse that a model switch alone must not.
//
// Storage-type rules baked into the DDL:
//   - Money is INTEGER cents (RESEARCH Pitfall 4). A REAL column would lose cents to float
//     rounding, and this is a financial tool. total_cents is NOT NULL (D-09: total is the one
//     required amount); subtotal_cents/tax_cents are genuinely nullable, because a
//     tax-included receipt with no subtotal line is normal, not an error (D-10).
//   - Per-field confidence, the validation flags and the raw model reply are TEXT JSON blobs
//     (D-24 sub-decisions 5a-A / 5b-A). Phase 6 reads the whole row, so nothing needs to be
//     SQL-queryable inside them.
//   - `truncated` (the D-21 over-10-page flag) is an INTEGER 0/1, NOT a BOOLEAN. STRICT tables
//     accept only INTEGER/REAL/TEXT/BLOB/ANY, and better-sqlite3 refuses to bind a JS boolean
//     (RESEARCH Pitfall 8), so the 0/1 <-> boolean coercion lives in cache.ts.
//
// NO SECRET MATERIAL EVER LANDS HERE (D-05/D-12, threat T-03-01). `base_url_host` is the HOST
// only — never the path, never a query string, never the API key. The key lives in the OS
// keychain via the Phase 1 secret store and is never written to SQLite. `raw_response` holds
// bill business data (the model's reply about the document), not credentials.

import type Database from 'better-sqlite3'

export const migration0003 = {
  version: 3,
  up(db: Database.Database): void {
    db.exec(
      `CREATE TABLE IF NOT EXISTS parsed_results (
         file_hash          TEXT PRIMARY KEY,   -- Phase 2 SHA-256 (the cache key, D-14)
         original_filename  TEXT NOT NULL,      -- provenance for the Bills status list
         route              TEXT NOT NULL,      -- 'native' | 'image-only' (which path ran)
         page_count         INTEGER NOT NULL,
         model              TEXT NOT NULL,      -- never silently recharge on a model switch (D-14)
         base_url_host      TEXT,               -- host ONLY, NEVER the key (D-05)
         vendor             TEXT,
         invoice_number     TEXT,
         invoice_date       TEXT,               -- ISO 'YYYY-MM-DD' after the Zod normalize
         due_date           TEXT,
         subtotal_cents     INTEGER,            -- nullable (D-10)
         tax_cents          INTEGER,            -- nullable (D-10)
         total_cents        INTEGER NOT NULL,   -- required (D-09)
         currency           TEXT,
         suggested_category TEXT,               -- rough model guess; Phase 5 reconciles it
         field_confidence   TEXT NOT NULL,      -- JSON: per-field 'high'|'low'|'flagged' (5a-A)
         validation_flags   TEXT,               -- JSON: which deterministic checks failed (D-12)
         raw_response       TEXT,               -- nullable; the reply verbatim, for audit (5b-A)
         parsed_at          TEXT NOT NULL,      -- ISO timestamp
         schema_version     INTEGER NOT NULL,   -- a prompt/schema bump can force a re-parse
         truncated          INTEGER NOT NULL DEFAULT 0 -- D-21 page cap, 0/1 (STRICT has no BOOLEAN)
       ) STRICT;`
    )
  }
}
