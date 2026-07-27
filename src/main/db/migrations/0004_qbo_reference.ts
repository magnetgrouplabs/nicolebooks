// src/main/db/migrations/0004_qbo_reference.ts
//
// Migration 0004: the QuickBooks reference cache (QBO-05). Number ASSIGNED by the sprint plan, not
// taken as "the next free one" (see migrations/README.md for why that distinction matters when two
// agents write migrations in parallel worktrees).
//
// ONE STRICT table, qbo_reference, holding the vendors, accounts, and items the review grid picks
// from. It is a cache of a remote system, so it carries three properties the other tables do not:
//
//   1. REALM SCOPED. realm_id is the first column of the primary key. Reference data belongs to one
//      QuickBooks company, and vendor id 58 in one company is an unrelated record in another.
//      Without the realm in the key, connecting a second company would silently merge two charts of
//      accounts, and the review grid would offer categories that do not exist in the open company.
//      With it, a disconnect can delete exactly one company's rows and reads filter naturally.
//
//   2. KEYED ON (realm, entity_kind, entity_id), NOT (realm, entity_id). QuickBooks numbers each
//      entity type independently, so Vendor 58 and Item 58 both exist and are different records.
//      Leaving the kind out of the key would make one silently overwrite the other.
//
//   3. SOFT DEACTIVATION RATHER THAN DELETION. A sync marks every row for the realm inactive, then
//      upserts what the API returned as active. A vendor deleted or deactivated in QuickBooks
//      therefore stops being offered as a candidate but stays resolvable by id, so an entry already
//      posted against it still renders its name. A hard delete would leave a posted row showing a
//      bare id.
//
// account_type / account_sub_type are what separate a category account (AccountType 'Expense') from
// a "Paid from" account ('Bank' or 'Credit Card'). They are stored rather than derived because the
// review grid filters the two lists differently and must do it offline, from the cache alone.
//
// House rules: STRICT table; booleans are INTEGER 0/1 (STRICT has no BOOLEAN type and better-sqlite3
// refuses to bind a JS boolean, so the coercion lives in qbo/reference.ts); no money column here, so
// no cents rule to apply; and NO SECRET MATERIAL. A realm id is a company identifier the UI
// displays, not a credential. The tokens live in the OS keychain and never reach SQLite (D-05/D-12).

import type Database from 'better-sqlite3'

export const migration0004 = {
  version: 4,
  up(db: Database.Database): void {
    db.exec(
      `CREATE TABLE IF NOT EXISTS qbo_reference (
         realm_id         TEXT NOT NULL,      -- QuickBooks company id (not a credential)
         entity_kind      TEXT NOT NULL,      -- 'vendor' | 'account' | 'item'
         entity_id        TEXT NOT NULL,      -- QuickBooks entity id, opaque string
         name             TEXT NOT NULL,      -- DisplayName / Name, what the user picks from
         active           INTEGER NOT NULL DEFAULT 1, -- 0/1 (STRICT has no BOOLEAN)
         account_type     TEXT,               -- accounts only: 'Expense' | 'Bank' | 'Credit Card'
         account_sub_type TEXT,               -- accounts only, nullable
         synced_at        TEXT NOT NULL,      -- ISO timestamp of the sync that wrote this row
         PRIMARY KEY (realm_id, entity_kind, entity_id)
       ) STRICT;`
    )

    // The review grid reads one kind at a time for the open company, which is exactly this index.
    // The primary key already covers (realm_id, entity_kind, ...) as a prefix, but naming the index
    // makes the access pattern explicit and survives any future key change.
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_qbo_reference_realm_kind
         ON qbo_reference (realm_id, entity_kind);`
    )
  }
}
