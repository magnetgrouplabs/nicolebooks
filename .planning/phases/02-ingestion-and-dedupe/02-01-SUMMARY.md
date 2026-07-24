---
phase: 02-ingestion-and-dedupe
plan: 01
subsystem: ingestion
tags: [electron-ipc, better-sqlite3, sha256, zod, react, scan, dedupe-ledger]

# Dependency graph
requires:
  - phase: 01-foundation
    provides: typed IPC contract + assertTrustedSender gate, Zod schema boundary, better-sqlite3 forward-only migration runner, app_settings table, safeStorage, branded shell (Bills/Settings screens), Button/Badge/EmptyState components, Playwright _electron harness
provides:
  - ingestion IPC channel group (resolve-inbox / choose-inbox / scan) behind the Phase 1 trust boundary
  - posted_file_hashes STRICT dedupe ledger (migration0002; Design B, Phase 2 read-only)
  - pure ingestion modules: filetype classifier, streaming sha256File, inbox resolve/persist
  - runScan walking-path orchestrator (flat, read-only enumerate -> classify -> stream-hash)
  - Bills-screen Scan now button + loaded/unsupported results surface
  - Settings-screen Change inbox folder control (D-01 repoint home)
affects: [02-02 duplicate catch, 02-03 not-ready skip, 03 parse pipeline (loaded files + hash are its input), 07 posting (owns the ledger write)]

# Tech tracking
tech-stack:
  added: []  # no new dependencies (Node crypto/fs + existing better-sqlite3/zod/electron dialog)
  patterns:
    - "metadata-first, bytes-last scan pipeline (classify by name, hash last) — placeholder-safe seam for 02-03"
    - "injectable pure modules (db handle + documentsDir/inboxPath) so main-only logic unit-tests without Electron"
    - "ingestion IPC group mirrors settings.ts: assertTrustedSender FIRST, then Zod-parse, then delegate"
    - "scan takes no renderer payload (ScanRequestSchema strict-empty) — server-side inbox path is the path-injection guard"

key-files:
  created:
    - src/main/ingestion/filetype.ts
    - src/main/ingestion/hash.ts
    - src/main/ingestion/inbox.ts
    - src/main/ingestion/scan.ts
    - src/main/ipc/ingestion.ts
    - src/main/db/migrations/0002_dedupe.ts
    - test/ingestion-filetype.test.ts
    - test/ingestion-hash.test.ts
    - test/ingestion-inbox.test.ts
    - test/ingestion-scan.test.ts
    - e2e/inbox-picker.spec.ts
  modified:
    - src/shared/ipc-contract.ts
    - src/shared/schemas.ts
    - src/main/db/migrate.ts
    - src/main/ipc/register.ts
    - src/preload/index.ts
    - src/renderer/src/screens/BillsScreen.tsx
    - src/renderer/src/screens/SettingsScreen.tsx
    - test/ipc-contract.test.ts
    - test/migrate.test.ts
    - e2e/ipc-boundary.spec.ts

key-decisions:
  - "Design B ledger: posted_file_hashes is posted-only; Phase 2 never writes it (the check is 02-02, the write is Phase 7). Verified: no INSERT INTO posted_file_hashes anywhere in src/."
  - "Marked ING-01/ING-02/ING-05 complete; ING-03 left pending because its not-materialized half is owned by plan 02-03 (this slice only delivers the unsupported-file surfacing half). ING-04 dedupe check is owned by 02-02."
  - "chooseInbox handler branches on window presence instead of passing (BrowserWindow | undefined) to dialog.showOpenDialog, which does not typecheck under the two overloads."

patterns-established:
  - "SLICE seam comments in scan.ts mark exactly where 02-02 (within-scan collapse + ledger check) and 02-03 (materialization + stability gate) layer in"
  - "e2e invocation proof via app.evaluate main-process dialog stub: a UI-visible stub path proves the button actually invoked chooseInbox, not just that the method is exposed"

requirements-completed: [ING-01, ING-02, ING-05]

# Metrics
duration: 12min
completed: 2026-07-24
---

# Phase 2 Plan 01: End-to-End Scan Slice Summary

**Button-to-database-and-back ingestion front door: a read-only flat-inbox scan that classifies by extension, streams a SHA-256 per supported file, stamps the local processing date, and renders loaded/unsupported results behind a new sender-gated ingestion IPC group, plus the migration0002 posted_file_hashes dedupe ledger and a Settings inbox-picker.**

## Performance

- **Duration:** ~12 min
- **Started:** 2026-07-24T15:29:29Z
- **Completed:** 2026-07-24T15:41:43Z
- **Tasks:** 4
- **Files modified:** 21 (11 created, 10 modified)

## Accomplishments

- New `ingestion` IPC channel group (resolve-inbox / choose-inbox / scan), each handler `assertTrustedSender`-first and the scan Zod-gated with a strict-empty payload so no renderer path reaches the filesystem.
- `migration0002` creates the `posted_file_hashes` STRICT ledger (Design B, posted-only): Phase 2 is strictly read-only on it; no code path inserts a row.
- Pure, unit-tested ingestion modules: the extension/junk `filetype` classifier (with the `.icloud` sentinel-before-dotfile ordering), the streaming `sha256File`, and inbox resolve/persist against `app_settings`.
- `runScan` walking-path orchestrator: flat non-recursive enumeration, symlink/junk skip, unsupported surfacing, per-file stream-hash, today's local `batchEntryDate`, and a strictly read-only inbox (asserted by test).
- Bills-screen "Scan now" button with a loaded-results surface and an unsupported-skipped summary; Settings-screen "Change inbox folder" picker that persists the chosen path (D-01), proven end-to-end by an invocation e2e.

## Task Commits

Each task was committed atomically:

1. **Task 1: Wave-0 failing tests + Phase-1 test updates (RED)** - `afde4a3` (test)
2. **Task 2: Contract, ledger migration, and pure ingestion modules (GREEN)** - `736fc67` (feat)
3. **Task 3: Scan orchestrator, ingestion IPC group, preload, Bills scan surface** - `6ac9723` (feat)
4. **Task 4: Settings "Change inbox folder" control + invocation e2e** - `f6c3590` (feat)

_TDD note: this plan's config has `tdd_mode: false`; Tasks 2-4 carry `tdd="true"` and were driven RED (Task 1) -> GREEN, but committed as single per-task commits rather than split test/feat commits._

## Files Created/Modified

- `src/shared/ipc-contract.ts` - Added the three `ingestion:*` channel constants and the `ScanFileStatus` / `ScanFile` / `ScanResult` / `IngestionApi` types; extended `Api`.
- `src/shared/schemas.ts` - Added `ScanRequestSchema = z.object({}).strict()` (path-injection guard).
- `src/main/db/migrations/0002_dedupe.ts` - `posted_file_hashes` STRICT ledger (`hash TEXT PRIMARY KEY`).
- `src/main/db/migrate.ts` - Appended `migration0002` to the migrations array.
- `src/main/ingestion/filetype.ts` - Pure `isJunk` / `isSupported` / `iCloudSentinelTarget` / `localDateStamp`.
- `src/main/ingestion/hash.ts` - Streaming `sha256File` (constant memory, never `readFileSync`).
- `src/main/ingestion/inbox.ts` - `resolveInboxPath` / `persistInboxPath` against `app_settings` (injectable db + documentsDir).
- `src/main/ingestion/scan.ts` - `runScan` orchestrator with 02-02/02-03 seam comments; read-only, no recursion, skips symlinks.
- `src/main/ipc/ingestion.ts` - `registerIngestionIpc`: three sender-gated handlers; scan Zod-parsed before `runScan`.
- `src/main/ipc/register.ts` - Registered the ingestion group.
- `src/preload/index.ts` - Added the `ingestion` object (three thin named invokes; no raw ipcRenderer).
- `src/renderer/src/screens/BillsScreen.tsx` - Scan now button, summary line, batch date, loaded rows with status Badges, unsupported summary.
- `src/renderer/src/screens/SettingsScreen.tsx` - Added an Inbox folder section with a "Change inbox folder" control (kept the Secret store section intact).
- `test/ingestion-*.test.ts` (4 new) - Filetype, hash (known vectors + 5MB streaming), inbox round-trip/default-create, scan (loaded/unsupported/junk/date/read-only).
- `test/ipc-contract.test.ts`, `test/migrate.test.ts` - Extended for the three ingestion channels and the migration0002 reality (user_version 2, `['app_settings','posted_file_hashes']`).
- `e2e/ipc-boundary.spec.ts` - Asserts the ingestion group is exposed with exactly `[chooseInbox, resolveInbox, scan]`.
- `e2e/inbox-picker.spec.ts` (new) - Stubs the main-process dialog and proves the Settings control invokes `chooseInbox` and reflects/ignores the returned path.

## Decisions Made

- **Design B ledger (posted-only).** `posted_file_hashes` exists to be read by 02-02 and written by Phase 7; Phase 2 never inserts. This is the most literal reading of D-08 and the lowest-risk boundary for a financial tool. Confirmed by grep: zero `INSERT INTO posted_file_hashes` in `src/`.
- **Requirement completion is precise, not blanket.** ING-01 (drop + scan + processing-date stamp), ING-02 (configure/repoint inbox in Settings), and ING-05 (accept PDF/JPEG/PNG/HEIC) are fully delivered and marked complete. ING-03 is left pending: this slice delivers only its unsupported-file surfacing half; the not-materialized (cloud placeholder / partial write) half is owned by plan 02-03. ING-04 (dedupe check) is owned by 02-02.
- **`localDateStamp` uses local date parts, never `toISOString()`**, so the batch date cannot slip a day near midnight (D-05).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] dialog.showOpenDialog overload typecheck**
- **Found during:** Task 3 (ingestion IPC group)
- **Issue:** The research/PATTERNS snippet passed `BrowserWindow.fromWebContents(...) ?? undefined` as the first arg to `dialog.showOpenDialog(win, options)`. Under strict TypeScript neither overload accepts `undefined` as the first parameter, so `npm run typecheck` would fail.
- **Fix:** Branch on window presence — call the two-arg overload when a window resolves, else the single-arg overload. Both route through `dialog.showOpenDialog`, so the Task 4 e2e main-process stub still intercepts either branch.
- **Files modified:** src/main/ipc/ingestion.ts
- **Verification:** `npm run typecheck` exits 0; inbox-picker e2e passes (invocation proof holds).
- **Committed in:** 6ac9723 (Task 3 commit)

---

**Total deviations:** 1 auto-fixed (1 blocking).
**Impact on plan:** Minimal. A strict-mode typecheck fix that preserves the researched handler behavior exactly. No scope change.

## Issues Encountered

- None beyond the deviation above. The four RED specs failed on the expected missing-module imports at Task 1 and turned GREEN at Tasks 2-3; the two updated Phase-1 specs and the ipc-boundary/inbox-picker e2e all pass.

## Known Stubs

None. The `STATUS_VARIANT` / `STATUS_LABEL` maps in BillsScreen include the `duplicate-*` and `not-ready-skipped` statuses that this slice never emits; these are exhaustive-over-the-union mappings that plans 02-02 and 02-03 will exercise, not empty/placeholder data flowing to the UI.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Every ingestion seam this phase needs is in place: contract, migration, ingestion modules, IPC handler, preload, inbox-picker control, and the Bills results surface. Plans 02-02 (within-scan collapse + ledger dedupe check) and 02-03 (materialization + stability gate) layer onto `runScan` at the marked seam comments.
- Full suite green: 54 unit tests + 6 e2e tests, `npm run typecheck` clean.
- Deferred (unchanged): the real cloud-placeholder detection thresholds (A1/A2) and the Bills-scan visual flow fold into the end-of-phase cross-OS human gate (owned by 02-03 / the 01-08 checkpoint).

## Self-Check: PASSED

- All 11 spot-checked created files exist on disk.
- All four task commit hashes (`afde4a3`, `736fc67`, `6ac9723`, `f6c3590`) are present in git history.

---
*Phase: 02-ingestion-and-dedupe*
*Completed: 2026-07-24*
