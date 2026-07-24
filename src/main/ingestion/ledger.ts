// src/main/ingestion/ledger.ts
//
// Read-only posted-ledger dedupe check (ING-04, D-08/D-09, threat T-02-06).
//
// READ-ONLY (Design B, D-08): a row exists in posted_file_hashes iff that exact file was
// posted to QuickBooks. This module runs a single SELECT against it and NOTHING else — Phase 2
// has no insert/update/delete path against this table. The "mark sent" write is owned by
// Phase 7. A pending (never-posted) file re-scanned reloads automatically because no row exists
// for it yet. Mirrors the settings.ts prepared-statement read (WHERE key = ?): the 64-char hex
// hash is bound via ? and NEVER interpolated into SQL, so a hash carrying SQL metacharacters is
// treated as a literal value that matches no row rather than being executed (T-02-06).

import type Database from 'better-sqlite3'
import { getDatabase } from '../db/connection'

/** Post-time provenance returned on a ledger hit (posted date + filename at post time). */
export interface PostedHashRecord {
  postedAt: string
  originalFilename: string
}

/** Raw row shape from the posted_file_hashes SELECT (snake_case as stored). */
interface PostedRow {
  posted_at: string
  original_filename: string
}

/**
 * Check whether an exact file hash is already posted to QuickBooks. Returns the posted date and
 * original filename on a hit, or undefined on a miss (the caller then treats the file as loaded).
 *
 * The db handle is injectable (default: the main-process singleton getDatabase()) so the temp-DB
 * unit test drives it without Electron. Read-only: this prepares and runs a SELECT only.
 */
export function checkPostedHash(
  db: Database.Database = getDatabase(),
  hash: string
): PostedHashRecord | undefined {
  const row = db
    .prepare('SELECT posted_at, original_filename FROM posted_file_hashes WHERE hash = ?')
    .get(hash) as PostedRow | undefined
  if (!row) return undefined
  return { postedAt: row.posted_at, originalFilename: row.original_filename }
}
