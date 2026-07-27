// src/main/db/migrations/0005_posting.ts
//
// Migration 0005: the Phase 7 posting batches + per-entry audit ledger (POST-01..05, AUDIT-01..04).
//
// ASSIGNED number, not "the next free one" (see migrations/README.md). 0004 belongs to
// QBO-CONNECT's reference cache and is written in a parallel worktree; two files carrying
// version 4 would leave the second silently unapplied, because the runner bumps user_version
// past it after the first.
//
// Two STRICT tables, mirroring the 0002/0003 shape.
//
// posting_entries IS the idempotency guarantee, and three columns carry it:
//
//   request_id  UNIQUE, NOT NULL. The QuickBooks `requestid` idempotency key. It is generated and
//               COMMITTED TO DISK BEFORE any network call, which is the whole point: if the app
//               crashes between the insert and the response, the re-send finds the same key and
//               QuickBooks replays the original response instead of creating a second bill. A key
//               minted at request time would be lost in exactly the window it exists to cover.
//               UNIQUE so a bug that reused one key across two different entries fails loudly at
//               the database rather than quietly collapsing two bills into one.
//
//   state       'pending' | 'sent' | 'confirmed' | 'failed'. 'sent' and 'confirmed' are
//               deliberately distinct: 'sent' means the create was dispatched and the outcome is
//               UNKNOWN (the crash window), 'confirmed' means an Id and SyncToken came back.
//               Only 'confirmed' may write posted_file_hashes. Collapsing the two would let a
//               socket timeout mark a document posted that never landed, or (worse) let a retry
//               post it twice.
//
//   UNIQUE (batch_id, file_hash)
//               One entry per document per batch. This is what makes "re-send the same batch"
//               resume rather than duplicate: the re-send finds the existing row (and its
//               request_id) instead of appending a second one.
//
// posting_batches is the batch header the History screen lists. `state` is descriptive only:
// whether a batch can be RESUMED is computed from its entries (any pending/sent/failed), never
// read off this column, so a stale header can never authorize a duplicate post.
//
// Storage-type rules, same as every table before it:
//   - Money is INTEGER cents, never REAL. This is a financial tool and a float loses cents.
//   - No BOOLEAN columns: STRICT has no such type and better-sqlite3 will not bind a JS boolean.
//     The undo state is recorded as a nullable timestamp (undone_at), which is both a flag and
//     the audit fact.
//   - NO SECRET MATERIAL. realm_id is the QuickBooks COMPANY id, not a credential: it identifies
//     which company an entry was posted to, which is exactly what an audit row must record.
//     Tokens live in the OS keychain and never touch SQLite.
//   - `error` holds the RENDERER-SAFE mapped copy, never a raw QuickBooks response body. An
//     Intuit error message is assembled from the provider's response and routinely embeds the
//     request URL and the realm id, so it is mapped before it is stored, not after it is read.
//
// The three indexes cover the three real access paths: entries of a batch (detail + resume),
// entries for a document (the ledger cross-check), and the vendor/date window the duplicate
// warning scans.

import type Database from 'better-sqlite3'

export const migration0005 = {
  version: 5,
  up(db: Database.Database): void {
    db.exec(
      `CREATE TABLE IF NOT EXISTS posting_batches (
         id           TEXT PRIMARY KEY,   -- opaque batch handle (uuid), never interpolated into SQL
         created_at   TEXT NOT NULL,      -- ISO timestamp
         updated_at   TEXT NOT NULL,      -- ISO timestamp, touched by every send and undo pass
         realm_id     TEXT NOT NULL,      -- QuickBooks company id (NOT a credential)
         state        TEXT NOT NULL,      -- 'open' | 'complete' | 'partially-undone' | 'undone'
         entry_count  INTEGER NOT NULL
       ) STRICT;`
    )

    db.exec(
      `CREATE TABLE IF NOT EXISTS posting_entries (
         id                     INTEGER PRIMARY KEY,
         batch_id               TEXT NOT NULL,
         position               INTEGER NOT NULL,   -- send order, so progress is deterministic
         file_hash              TEXT NOT NULL,      -- the Phase 2 SHA-256 join key
         filename               TEXT,               -- denormalized so a report prints offline
         entry_type             TEXT NOT NULL,      -- 'bill' | 'expense'
         request_id             TEXT NOT NULL UNIQUE, -- idempotency key, written BEFORE any call
         state                  TEXT NOT NULL,      -- 'pending' | 'sent' | 'confirmed' | 'failed'
         qbo_id                 TEXT,
         sync_token             TEXT,               -- optimistic-concurrency token, needed by undo
         error                  TEXT,               -- mapped renderer-safe copy, never raw API text
         vendor_id              TEXT NOT NULL,
         vendor_name            TEXT,               -- denormalized at post time
         category_account_id    TEXT NOT NULL,
         category_account_name  TEXT,
         paid_from_account_id   TEXT,               -- expense rows only
         paid_from_account_name TEXT,
         txn_date               TEXT NOT NULL,      -- ISO 'YYYY-MM-DD'
         due_date               TEXT,               -- bills only
         ref_number             TEXT,               -- QuickBooks DocNumber (max 21 chars)
         memo                   TEXT,
         amount_cents           INTEGER NOT NULL,   -- integer cents, never REAL
         realm_id               TEXT NOT NULL,
         created_at             TEXT NOT NULL,
         updated_at             TEXT NOT NULL,
         sent_at                TEXT,
         confirmed_at           TEXT,
         undone_at              TEXT,               -- set when the entity was removed by undo
         undo_reason            TEXT,               -- plain-language reason an undo was refused
         UNIQUE (batch_id, file_hash)
       ) STRICT;`
    )

    db.exec(
      `CREATE INDEX IF NOT EXISTS posting_entries_batch_idx
         ON posting_entries (batch_id, position);`
    )
    db.exec(
      `CREATE INDEX IF NOT EXISTS posting_entries_file_hash_idx
         ON posting_entries (file_hash);`
    )
    // The duplicate-warning scan: same vendor, same amount, within a few days.
    db.exec(
      `CREATE INDEX IF NOT EXISTS posting_entries_vendor_date_idx
         ON posting_entries (vendor_id, txn_date);`
    )
  }
}
