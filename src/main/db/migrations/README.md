# Migrations

Forward-only, keyed on `PRAGMA user_version`. The runner is `../migrate.ts`; it applies every
migration whose `version` is greater than the database's current `user_version`, in ascending
order, inside one transaction.

Adding one:

1. Create `NNNN_name.ts` exporting `{ version: N, up(db) { ... } }` (copy `0003_parsed_results.ts`).
2. Import it in `../migrate.ts` and append it to the `migrations` array in ascending order.
3. Add a spec to `test/migrate.test.ts` style coverage if the table carries a rule worth pinning.

Never renumber or edit a shipped migration: `user_version` is a ratchet, so an already-migrated
database will never re-run it.

## Assigned numbers

| Version | File                     | Owner           | Status                                        |
| ------- | ------------------------ | --------------- | --------------------------------------------- |
| 0001    | `0001_init.ts`           | Phase 1         | shipped (`app_settings`)                      |
| 0002    | `0002_dedupe.ts`         | Phase 2         | shipped (`posted_file_hashes`)                |
| 0003    | `0003_parsed_results.ts` | Phase 3         | shipped (`parsed_results`)                    |
| 0004    | reserved                 | QBO-CONNECT     | QuickBooks reference cache (not yet written)  |
| 0005    | `0005_posting.ts`        | POSTING-ENGINE  | shipped (`posting_batches`, `posting_entries`) |

0004 and 0005 are RESERVED, not written. Two finish-sprint agents work in parallel worktrees, so
taking "the next free number" would give both of them 0004: the runner would then apply only the
first file with `version: 4` and silently skip the second, because its version is no longer
greater than `user_version`. Use the number assigned to you. Any migration past 0005 needs a
number assigned by Fable before it is written.

## House rules for a new table

- `STRICT` tables only.
- Money is `INTEGER` cents, never `REAL`.
- Booleans are `INTEGER` 0/1: STRICT has no BOOLEAN type, and better-sqlite3 refuses to bind a JS
  boolean, so the coercion belongs in the data-access module.
- No secret material ever lands in SQLite. Tokens and API keys live in the OS keychain through
  `src/main/secrets/secret-store.ts`. Storing a host is acceptable; storing a credential is not.
