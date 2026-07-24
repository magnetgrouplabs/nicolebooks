---
phase: 02-ingestion-and-dedupe
plan: 02
subsystem: ingestion
tags: [dedupe, sha256, better-sqlite3, ledger-read-only, react, scan, design-b]

# Dependency graph
requires:
  - phase: 02-ingestion-and-dedupe
    plan: 01
    provides: runScan orchestrator with the 02-02 SLICE seam, migration0002 posted_file_hashes STRICT ledger, ScanFile/ScanResult contract with duplicate-* statuses, Bills-screen results surface with STATUS_VARIANT/STATUS_LABEL maps
provides:
  - read-only posted-ledger dedupe check (checkPostedHash) — prepared SELECT, bound hash, Design B (Phase 2 never writes)
  - scan within-scan collapse (D-10) + posted-ledger exclusion (D-08/09) filling the SLICE 2 seam
  - Bills-screen duplicate flags (already-entered / duplicate-in-this-scan) + renderer-only include-anyway override
affects: [02-03 not-ready skip (layers onto the same runScan pipeline), 07 posting (owns the posted_file_hashes write this slice only reads)]

# Tech tracking
tech-stack:
  added: []  # no new dependencies (Node crypto + existing better-sqlite3/react)
  patterns:
    - "read-only repository module (ledger.ts) mirrors settings.ts prepared-statement read (WHERE hash = ?), db handle injectable with getDatabase() default"
    - "compute-all-hashes-first then group-by-hash (02-RESEARCH Pitfall 5): whole-batch within-scan collapse, not streaming"
    - "ledger precedence: a posted hash marks EVERY matching entry duplicate-excluded, outranking duplicate-in-batch"
    - "renderer-only override via a Set<string> keyed by filename+hash — no window.api write (Phase 2 ends at loaded-for-processing)"

key-files:
  created:
    - src/main/ingestion/ledger.ts
    - test/ingestion-ledger.test.ts
  modified:
    - src/main/ingestion/scan.ts
    - src/renderer/src/screens/BillsScreen.tsx
    - test/ingestion-scan.test.ts

key-decisions:
  - "Design B held exactly: ledger.ts runs a single SELECT and nothing else; grep confirms posted_file_hashes appears in src/ only as the migration CREATE and the ledger SELECT — zero INSERT/UPDATE/DELETE. Phase 2 cannot corrupt the posted ledger (T-02-07)."
  - "On a ledger hit, ALL entries sharing that hash become duplicate-excluded (not just the first), so a posted file never comes back loaded even when duplicated within the same scan (precedence over duplicate-in-batch)."
  - "checkPostedHash signature is (db = getDatabase(), hash): db-first to match the plan's test call convention, defaulted so production callers get the singleton and tests inject a temp DB."
  - "Bills-screen include-anyway is renderer-only local state (includedOverrides Set); Phase 2 ends at loaded-for-processing so no persistence/IPC write is introduced (D-09/D-14)."

patterns-established:
  - "duplicate-in-batch reads as a benign secondary badge (a copy is already loaded); duplicate-excluded reads destructive (a caught already-posted bill) with its posted date surfaced"
  - "a fresh scan resets includedOverrides so stale overrides never leak across batches"

requirements-completed: [ING-04]

# Metrics
duration: 4min
completed: 2026-07-24
---

# Phase 2 Plan 02: Duplicate Catch Summary

**Exact-file deduplication on the scan slice: a read-only posted-ledger check (`checkPostedHash`) flags already-posted files as `duplicate-excluded` with their posted date and excludes them by default, byte-identical copies within one scan collapse to `duplicate-in-batch`, and the Bills screen renders both with a one-click renderer-only include-anyway override — closing SC3 (re-dropping an already-entered file creates no duplicate work) under Design B (Phase 2 never writes the ledger).**

## Performance

- **Duration:** ~4 min
- **Started:** 2026-07-24T15:50:30Z
- **Completed:** 2026-07-24T15:54:43Z
- **Tasks:** 3
- **Files modified:** 5 (2 created, 3 modified)

## Accomplishments

- **Read-only ledger check** (`src/main/ingestion/ledger.ts`): `checkPostedHash(db, hash)` runs a single prepared `SELECT posted_at, original_filename FROM posted_file_hashes WHERE hash = ?`, binds the hash via `?` (never interpolated, T-02-06), and returns `{ postedAt, originalFilename }` on a hit or `undefined` on a miss. Design B: no INSERT/UPDATE/DELETE anywhere in the module.
- **Scan dedupe wiring** (`src/main/ingestion/scan.ts`, SLICE 2 seam): after every supported file is hashed (compute-all-first, Pitfall 5), the batch is grouped by hash — the first entry per group stays `loaded`, later byte-identical copies become `duplicate-in-batch` (D-10). Then each distinct hash is checked against the ledger; a hit marks **every** entry with that hash `duplicate-excluded` with `postedAt` (precedence over `duplicate-in-batch`, D-08/09). `summary.duplicates` now counts `duplicate-excluded + duplicate-in-batch`.
- **Bills-screen duplicate surface** (`src/renderer/src/screens/BillsScreen.tsx`): a `duplicate-excluded` row shows a destructive "Already entered on {postedAt}" badge, is excluded from the batch by default, and carries a ghost/sm "Include anyway" control that toggles the file into the batch via a local `includedOverrides` Set (keyed by filename+hash) — renderer-only, no `window.api` write. A `duplicate-in-batch` row shows a quiet secondary "Duplicate in this scan" badge. The summary pluralizes duplicates and a batch-count line reflects loaded + included overrides.

## Task Commits

Each task was committed atomically:

1. **Task 1: Failing ledger dedupe + within-scan collapse specs (RED)** - `c5692a9` (test)
2. **Task 2: Read-only ledger module + scan dedupe wiring (GREEN)** - `f5e1ebb` (feat)
3. **Task 3: Bills-screen duplicate flags + include-anyway override** - `d98675f` (feat)

_TDD note: this plan's config has `tdd_mode: false`; Task 2 carries `tdd="true"` and was driven RED (Task 1) -> GREEN, but committed as a single per-task commit rather than split test/feat commits (matching 02-01's convention)._

## Files Created/Modified

- `src/main/ingestion/ledger.ts` (created) - `checkPostedHash` read-only posted-ledger check; prepared `WHERE hash = ?`, header documents Design B (Phase 7 owns the write).
- `test/ingestion-ledger.test.ts` (created) - temp `better-sqlite3` DB; asserts hit -> `{postedAt, originalFilename}`, miss -> `undefined`, and the SQL-metacharacter hash -> `undefined` (T-02-06 binding proof).
- `src/main/ingestion/scan.ts` (modified) - filled the SLICE 2 seam: resolve the db handle once, within-scan collapse by hash, per-distinct-hash ledger check with excluded-over-in-batch precedence, recomputed `summary.duplicates`.
- `src/renderer/src/screens/BillsScreen.tsx` (modified) - duplicate-excluded/duplicate-in-batch rendering, include-anyway override in local state, pluralized summary + batch-count line, `duplicate-in-batch` badge variant softened to `secondary`.
- `test/ingestion-scan.test.ts` (modified) - added within-scan collapse, ledger dedupe, precedence, pending-reload, and summary-count cases (with a test-side `insertPosted` helper simulating a Phase-7 post).

## Decisions Made

- **Design B held exactly.** `ledger.ts` is SELECT-only; `grep -rn "posted_file_hashes" src/` shows the table name only in the migration (CREATE) and the ledger (SELECT). Phase 2 has no write path to the posted ledger (T-02-07 mitigated structurally).
- **A ledger hit excludes the whole hash group.** Rather than only re-flagging the first copy, the ledger pass sets every entry with a matching hash to `duplicate-excluded`. This guarantees a posted file is never `loaded`, even when it also appears twice in the scan, and is the literal reading of the plan's "set every entry with that hash to duplicate-excluded."
- **Override is renderer-only.** Include-anyway mutates a `Set<string>` state hook keyed by filename+hash; it does not persist or write through IPC, because Phase 2's boundary is "loaded for processing" (the actual batch consumption is downstream). A fresh scan clears the overrides.

## Deviations from Plan

None - plan executed exactly as written. All three tasks and their acceptance criteria were met without auto-fixes.

## Authentication Gates

None - this plan touches no external service.

## Issues Encountered

- None. RED (Task 1) failed on the expected missing `ledger.ts` import plus the four unimplemented scan dedupe assertions; GREEN (Task 2) turned both suites and the full unit suite (62 tests) green; Task 3 kept typecheck and the unit suite green.

## Known Stubs

None. The `not-ready-skipped` status still appears in the Bills-screen `STATUS_VARIANT`/`STATUS_LABEL` maps but is not emitted by this slice — it is the exhaustive-over-the-union mapping that plan 02-03 will exercise, not placeholder data flowing to the UI.

## Threat Flags

None. This slice introduces no new network endpoint, auth path, or trust-boundary surface beyond the plan's `<threat_model>` (the ledger read is the single new SQLite touch and is a bound prepared statement).

## Verification Evidence

- `npx vitest run test/ingestion-ledger.test.ts test/ingestion-scan.test.ts` - 10 passed (2 files).
- `npm run test:unit` - 62 passed (9 files), no Slice-1 regression.
- `npm run typecheck` - clean (exit 0).
- Design B grep: `posted_file_hashes` in `src/` only as the migration CREATE and the ledger SELECT; zero INSERT/UPDATE/DELETE in `ledger.ts`.
- Manual gate (deferred to the end-of-phase human checkpoint): drop an already-posted file (or a Phase-7-simulated ledger row) plus two identical copies, Scan now, confirm the posted file shows "Already entered on ..." excluded by default and Include anyway re-adds it, and one copy shows "Duplicate in this scan."

## Next Phase Readiness

- The SLICE 2 seam is now filled; plan 02-03 layers the materialization/stability gate onto the same `runScan` pipeline at the SLICE 3 seam (before the byte read), and the Bills screen already maps the `not-ready-skipped` status it will emit.
- ING-04 (SHA-256 dedupe check, excluded-by-default with override) is fully delivered and marked complete. ING-03 remains pending (its not-materialized half is owned by 02-03).

## Self-Check: PASSED

- All 5 spot-checked files (2 created, 3 modified) exist on disk.
- All three task commit hashes (`c5692a9`, `f5e1ebb`, `d98675f`) are present in git history.

---
*Phase: 02-ingestion-and-dedupe*
*Completed: 2026-07-24*
