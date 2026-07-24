---
phase: 02-ingestion-and-dedupe
verified: 2026-07-24T16:57:13Z
status: human_needed
score: 20/20 must-haves verified (code + automated tests); 1 human-only item outstanding
overrides_applied: 0
mvp_mode_note: "ROADMAP.md sets Mode: mvp for Phase 2, but the ROADMAP Goal field is written as a plain descriptive sentence, not the strict 'As a X, I want to Y, so that Z.' user-story format. gsd-sdk's user-story.validate verb is unavailable (gsd-sdk is broken on this machine; the local gsd-tools.cjs fallback has no user-story command). Rather than refuse verification outright, this report uses the equivalent user story embedded verbatim in all three PLAN files' <objective> sections ('As a non-technical accounts-payable user, I want to drop bills into one flat inbox and load them on a manual scan with already-posted duplicates caught up front, so that I get a clean, non-duplicate batch to process without any folder-naming discipline.') to produce the User Flow Coverage section below. Recommend running /gsd mvp-phase 02 to reformat ROADMAP.md's Goal field for future strict-mode verification if that matters going forward — this is a formatting gap, not an implementation gap."
human_verification:
  - test: "On a real Mac, evict a test file from iCloud Drive (right-click > Remove Download), drop it in the configured NicoleBooks inbox, click Scan now, and confirm it is flagged 'Not downloaded yet, re-scan shortly' without the Finder showing it re-downloading."
    expected: "The file appears under 'Not downloaded yet' in the Bills screen results, is never force-downloaded, and a subsequent scan after it re-materializes loads it normally."
    why_human: "Requires a real macOS machine with a real iCloud Drive sync client to produce a genuine dataless APFS file (size>0, blocks===0). The automated suite only proves this behavior against an injected stat() double (test/ingestion-materialization.test.ts); it cannot fabricate a real cloud-eviction state in this environment."
  - test: "On a real Windows machine with OneDrive, set a test file to 'Free up space' (making it cloud-only/OFFLINE), drop it in the configured NicoleBooks inbox, click Scan now, and confirm it is flagged 'Not downloaded yet, re-scan shortly' without triggering a recall/download."
    expected: "The file appears under 'Not downloaded yet' in the Bills screen results; the Windows attribute read (FILE_ATTRIBUTE_OFFLINE / RECALL_ON_DATA_ACCESS / RECALL_ON_OPEN) correctly identifies it without opening its bytes."
    why_human: "Requires a real Windows machine with a real OneDrive (or similar) sync client to produce genuine OFFLINE/RECALL attribute bits and to exercise the actual powershell.exe/attrib.exe subprocess path. The automated suite only proves the bit-testing logic against an injected readWinFlags() double; it cannot spawn or verify against a real OneDrive placeholder in this environment."
---

# Phase 2: Ingestion and Dedupe Verification Report

**Phase Goal:** The user can drop bill files into one flat inbox folder and load them on a manual scan, with exact duplicates (files already posted to QuickBooks) caught before any processing.
**Verified:** 2026-07-24T16:57:13Z
**Status:** human_needed
**Re-verification:** No — initial verification

## User Flow Coverage (MVP mode)

User story (from all three PLAN `<objective>` blocks, verbatim): *"As a non-technical accounts-payable user, I want to drop bills into one flat inbox and load them on a manual scan with already-posted duplicates caught up front, so that I get a clean, non-duplicate batch to process without any folder-naming discipline."*

| Step | Expected | Evidence | Status |
|------|----------|----------|--------|
| Configure the inbox once, in Settings | A "Change inbox folder" control opens the OS folder picker; the chosen path persists to `app_settings.inbox_path` and is reflected on screen; canceling is a no-op | `src/renderer/src/screens/SettingsScreen.tsx:40-54` (`chooseInbox` handler) + `src/main/ipc/ingestion.ts:26-37` (`ingestion:choose-inbox` handler, `persistInboxPath`) + `e2e/inbox-picker.spec.ts` (passing: stubs the native dialog, asserts the picked path renders, asserts cancel is a no-op) | VERIFIED |
| Drop bills into the flat inbox, no folder-naming discipline | No date-named subfolders required; the scan enumerates one flat directory non-recursively | `src/main/ingestion/scan.ts:60` (`readdir(inboxPath, { withFileTypes: true })`, no recursion) + `src/main/ingestion/filetype.ts` (`SUPPORTED` = pdf/jpg/jpeg/png/heic/heif) | VERIFIED |
| Click "Scan now" on the Bills screen | Supported files load with a status badge; unsupported files are surfaced in a skipped summary, never silently dropped; OS junk never appears | `src/renderer/src/screens/BillsScreen.tsx:141-193` (`runScan` handler + button) + `test/ingestion-scan.test.ts:89-119` (passing: loaded/unsupported/junk/date assertions) | VERIFIED |
| Already-posted duplicates are caught before processing | A file whose SHA-256 is already in `posted_file_hashes` is flagged "Already entered on <date>", excluded from the batch by default, with a one-click "Include anyway" override; byte-identical in-scan copies collapse | `src/main/ingestion/ledger.ts` (`checkPostedHash`) + `src/main/ingestion/scan.ts:134-164` (collapse + ledger precedence) + `src/renderer/src/screens/BillsScreen.tsx:254-272` (duplicate section + `toggleInclude`) + `test/ingestion-scan.test.ts:133-203` (passing: collapse, ledger hit, precedence, pending-reload, summary count) | VERIFIED |
| Outcome: a clean, non-duplicate batch to process, no folder-naming discipline | `batchCount = loadedFiles.length + includedOverrides.size` reflects the exact set the user would carry forward; cloud placeholders/partial writes are excluded from that set until they materialize | `src/renderer/src/screens/BillsScreen.tsx:180` (`batchCount`) + `src/main/ingestion/materialization.ts` + `test/ingestion-scan.test.ts:240-280` (bytes-last, not-ready-skipped) | VERIFIED (code + injected-metadata tests); real-provider cross-OS confirmation is the one deferred human item below |

All five user-flow steps are backed by passing automated tests and readable source, not narrative claims. The only step that cannot be closed out in this environment is the *real* cross-OS cloud-provider behavior underlying the last row (see Human Verification Required).

## Goal Achievement

### Observable Truths

Sourced from ROADMAP.md Success Criteria (the contract) merged with the three PLANs' `must_haves.truths` (dedupe applied where a PLAN truth restates a roadmap SC).

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | SC1: User can drop bill files (PDF/JPEG/PNG/HEIC) into a single flat inbox, configured once in Settings and created by the app, and trigger a manual scan that loads supported files while surfacing skipped unsupported files | VERIFIED | `filetype.ts:10` (`SUPPORTED` set incl. `.pdf/.jpg/.jpeg/.png/.heic/.heif`); `inbox.ts:45-62` (`resolveInboxPath` creates default `Documents/NicoleBooks/Inbox` on first run); `scan.ts:98-101` (unsupported -> `unsupported-skipped`, surfaced not dropped); `BillsScreen.tsx:287-301` (unsupported summary); `test/ingestion-scan.test.ts` passing |
| 2 | SC2: The app assigns the scanned batch the processing date (day of scan) as `batchEntryDate`, not a date parsed from folder names | VERIFIED | `filetype.ts:51-56` (`localDateStamp` uses local date parts, never `toISOString()`); `scan.ts:174`; `test/ingestion-scan.test.ts:117` asserts `batchEntryDate === localDateStamp()` |
| 3 | SC3: SHA-256 per file; exact files already posted to QuickBooks are skipped-and-flagged, excluded by default with a one-click override; re-dropping an already-entered file creates no duplicate work | VERIFIED | `ledger.ts:35-44` (`checkPostedHash`, `WHERE hash = ?`); `scan.ts:152-164` (ledger pass, sets `duplicate-excluded` + `postedAt`); `BillsScreen.tsx:96-113,254-272` (destructive badge + "Include anyway" `toggleInclude`); `test/ingestion-scan.test.ts:150-160` |
| 4 | SC4: The app waits for files to fully materialize before hashing; cloud-sync placeholders and partial writes are not processed as complete | VERIFIED | `materialization.ts` (`isNotMaterialized`, `isSettled`); `scan.ts:110-131` (gates run strictly before `stat`/`hashFile`, wrapped in per-file try/catch); `test/ingestion-scan.test.ts:240-279` (bytes-last spy proof) |
| 5 | User can trigger a scan via a "Scan now" button and see each supported file listed as loaded | VERIFIED | `BillsScreen.tsx:191-193` (button `onClick={() => void runScan()}`); `test/ingestion-scan.test.ts:89-119` |
| 6 | User can (re)point the inbox folder from Settings via "Change inbox folder"; chosen path persists to `app_settings.inbox_path` | VERIFIED | `SettingsScreen.tsx:40-54,64-72`; `ingestion.ts:26-37`; `inbox.ts:30-37` (prepared UPSERT); `e2e/inbox-picker.spec.ts` passing (invocation proof, not just shape) |
| 7 | Unsupported files (.docx, .zip, stray .txt, etc.) are surfaced in a skipped summary listing their names, never silently dropped | VERIFIED | `scan.ts:98-101`; `BillsScreen.tsx:287-301` |
| 8 | OS junk files (.DS_Store, Thumbs.db, desktop.ini, ._*, hidden dotfiles) never appear in the results list | VERIFIED | `filetype.ts:20-26` (`isJunk`); `scan.ts:95` (dropped before any status push); `test/ingestion-filetype.test.ts`, `test/ingestion-scan.test.ts:105` |
| 9 | The renderer performs zero direct fs/db access; the scan runs entirely in the main process behind the ingestion IPC channel group | VERIFIED | `grep -rn "require('fs')\|from 'fs'\|from 'node:fs'" src/renderer` returns nothing; `preload/index.ts:37-41` exposes only 3 named methods; `ingestion.ts` runs all fs/hash/db work main-side |
| 10 | The scan never moves, renames, or deletes any inbox file (read-only) | VERIFIED | `scan.ts` module contains no `rename`/`unlink`/`writeFile`/`copyFile` call (source scan confirms only `readdir`/`stat`/`createReadStream`); `test/ingestion-scan.test.ts:121-126` (mtimes + name set unchanged before/after) |
| 11 | A persistent `posted_file_hashes` STRICT ledger table exists after migration | VERIFIED | `migrations/0002_dedupe.ts:17-30`; `migrate.ts:26` (`[migration0001, migration0002]`); `test/migrate.test.ts:72-89` (table set + columns + `user_version` 2) |
| 12 | Two byte-identical files in one scan collapse: the first is loaded, the later copy is duplicate-in-batch | VERIFIED | `scan.ts:139-150`; `test/ingestion-scan.test.ts:134-148` |
| 13 | `duplicate-excluded` outranks `duplicate-in-batch` when both apply to the same hash | VERIFIED | `scan.ts:155-164` (ledger pass runs after collapse and overwrites status); `test/ingestion-scan.test.ts:162-177` |
| 14 | A pending (never-posted) file re-scanned still loads (Design B: ledger holds posted files only) | VERIFIED | `test/ingestion-scan.test.ts:179-184`; `ledger.ts` header comment + `scan.ts:157` (`if (!posted) continue`) |
| 15 | Phase 2 never writes `posted_file_hashes`: the ledger module runs SELECT only | VERIFIED | `grep -rn "INSERT INTO posted_file_hashes\|UPDATE posted_file_hashes\|DELETE FROM posted_file_hashes" src/` returns nothing (only the migration's `CREATE TABLE` and `ledger.ts`'s `SELECT` reference the table name) |
| 16 | A simulated placeholder (macOS blocks===0, `.icloud` sibling, or Windows OFFLINE/RECALL bit) is flagged not-ready-skipped and NEVER hashed | VERIFIED | `materialization.ts:70-111`; `test/ingestion-materialization.test.ts:30-108`; `test/ingestion-scan.test.ts:263-275` (hash spy never invoked on the flagged file) |
| 17 | A still-being-written file is flagged not-ready-skipped and never hashed | VERIFIED | `materialization.ts:119-131` (`isSettled`); `test/ingestion-materialization.test.ts:120-152` (real-fs growing-file case) |
| 18 | The scan reads no file bytes before the materialization AND stability gates both pass (metadata-first, bytes-last) | VERIFIED | `scan.ts:110-128` (`notMaterialized` then `settled` then `stat`/`hashFile`, in that order, inside one try block) |
| 19 | On total detection failure the scan LOADS rather than false-skipping a real bill | VERIFIED | `materialization.ts:96-108` (Windows: missing map entry or thrown read -> `return false`); `materialization.ts:83-88` (darwin: thrown stat -> `return false`); `test/ingestion-materialization.test.ts:92-108` |
| 20 | Windows attribute reads use `execFile`/`spawn` with an args array and `shell:false` (no command injection) | VERIFIED | `materialization.ts:154-163,173-177` (`execFileAsync` with an args array, `shell: false`, path passed via `NB_SCAN_DIR` env var, never concatenated); no bare `exec(` anywhere in the module |

**Score:** 20/20 truths verified in code + passing automated tests. 1 additional item (real cross-OS provider confirmation) is out of scope for this environment and is routed to Human Verification below — it does not indicate a code defect, since the equivalent logic is independently unit-tested against injected metadata doubles.

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `src/main/ingestion/filetype.ts` | `isJunk`, `isSupported`, `iCloudSentinelTarget`, `localDateStamp` | VERIFIED | All four exported and covered by `test/ingestion-filetype.test.ts` |
| `src/main/ingestion/hash.ts` | `sha256File` streaming SHA-256 | VERIFIED | `createReadStream` + `pipeline`, never `readFileSync`; `test/ingestion-hash.test.ts` |
| `src/main/ingestion/inbox.ts` | `resolveInboxPath`, `persistInboxPath` | VERIFIED | Prepared-statement UPSERT (no interpolation); existence-checks a stale persisted path (WR-03 fix) |
| `src/main/ingestion/scan.ts` | `runScan` orchestrator | VERIFIED | Wires all three slices' seams; per-file try/catch (WR-01 fix); read-only |
| `src/main/ingestion/ledger.ts` | `checkPostedHash` read-only dedupe check | VERIFIED | Single `SELECT ... WHERE hash = ?`; no write statements |
| `src/main/ingestion/materialization.ts` | `isNotMaterialized`, `isSettled`, `readWindowsOfflineFlags` | VERIFIED | All three exported; injection-safe `execFile` usage |
| `src/main/ipc/ingestion.ts` | `registerIngestionIpc` | VERIFIED | `assertTrustedSender` first in every handler; `ScanRequestSchema.parse` before `runScan()` |
| `src/main/db/migrations/0002_dedupe.ts` | `posted_file_hashes` STRICT ledger | VERIFIED | `hash TEXT PRIMARY KEY`, `STRICT` |
| `src/renderer/src/screens/BillsScreen.tsx` | Scan trigger + results surface | VERIFIED | Error banner (CR-01 fix), loaded/duplicate/not-ready/unsupported sections, empty states |
| `src/renderer/src/screens/SettingsScreen.tsx` | "Change inbox folder" control | VERIFIED | Error banner (WR-04 fix); `HealthIndicator` section retained intact |

### Key Link Verification

| From | To | Via | Status | Details |
|------|-----|-----|--------|---------|
| `BillsScreen.tsx` | `window.api.ingestion.scan` | `onClick` handler awaiting `scan()` | WIRED | `BillsScreen.tsx:141-159` |
| `SettingsScreen.tsx` | `window.api.ingestion.chooseInbox` | `onClick` handler; chooseInbox -> `ingestion:choose-inbox` -> `persistInboxPath` -> `app_settings.inbox_path` | WIRED | `SettingsScreen.tsx:40-54`; confirmed end-to-end by `e2e/inbox-picker.spec.ts` (passing) |
| `src/main/ipc/ingestion.ts` | `runScan` | `ipcMain.handle(Channels.ingestionScan)` after `assertTrustedSender` + `ScanRequestSchema.parse` | WIRED | `ingestion.ts:39-43` |
| `src/main/db/migrate.ts` | `migration0002` | `migrations` array | WIRED | `migrate.ts:26` |
| `src/main/ingestion/scan.ts` | `src/main/ingestion/ledger.ts` | group batch by hash then `checkPostedHash(hash)` | WIRED | `scan.ts:142-164` |
| `src/main/ingestion/ledger.ts` | `posted_file_hashes` | prepared statement `WHERE hash = ?` | WIRED | `ledger.ts:40` |
| `BillsScreen.tsx` | duplicate override | include-anyway toggle in local batch state | WIRED | `BillsScreen.tsx:161-169` (`toggleInclude`, `includedOverrides` Set) |
| `src/main/ingestion/scan.ts` | `src/main/ingestion/materialization.ts` | `isNotMaterialized` then `isSettled` BEFORE `sha256File` | WIRED | `scan.ts:110-128` |
| `src/main/ingestion/materialization.ts` | `child_process` | `execFile` with an args array, `shell:false` | WIRED | `materialization.ts:154-163,173-177` |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
|----------|---------------|--------|---------------------|--------|
| `BillsScreen.tsx` `result` | `ScanResult` from `window.api.ingestion.scan()` | `runScan()` in main, backed by real `readdir`/`stat`/SHA-256 over the actual configured inbox directory (no static/mocked return) | Yes | FLOWING |
| `BillsScreen.tsx` `inboxPath` | `resolveInbox()` on mount | `resolveInboxPath()` reads `app_settings` via a real prepared SELECT, falls back to a real `mkdirSync` default | Yes | FLOWING |
| `SettingsScreen.tsx` `inboxPath` | same `resolveInbox()` | same as above | Yes | FLOWING |
| `duplicate-excluded` badge `postedAt` | `checkPostedHash` result | Real `SELECT` against `posted_file_hashes`; hit/miss driven by actual table contents, not a hardcoded value | Yes | FLOWING |

No hardcoded-empty-return or hollow-prop patterns found in the ingestion pipeline; every renderer-visible value traces to a real IPC round trip into main-process fs/DB work.

### Behavioral Spot-Checks

Runnable-code checks were executed directly (not narrated) rather than via ad hoc curl/CLI probes, since this is an Electron desktop app whose "runnable entry point" is the Playwright `_electron` harness the phase itself ships.

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| Full unit suite (all ingestion modules) | `npm run test:unit` | 76 passed (10 files) | PASS |
| Type safety across the IPC boundary + renderer | `npm run typecheck` | exit 0 | PASS |
| Production build (main/preload/renderer) | `npm run build` | exit 0, all three bundles emitted | PASS |
| Full e2e suite incl. `ipc-boundary` (window.api shape + malformed-payload rejection) and `inbox-picker` (real invocation proof of chooseInbox) | `npm run test:e2e` | 6 passed | PASS |

### Probe Execution

No `scripts/*/tests/probe-*.sh` files exist in this repository and neither PLAN nor SUMMARY references a probe script for this phase. Step 7c: SKIPPED (no runnable probe scripts declared or found).

### Requirements Coverage

| Requirement | Source Plan(s) | Description | Status | Evidence |
|-------------|-----------------|--------------|--------|----------|
| ING-01 | 02-01 | User can drop bill files into a flat inbox and load them on a manual scan, stamped with the processing date | SATISFIED | `scan.ts`, `filetype.ts:localDateStamp`, `BillsScreen.tsx`; `test/ingestion-scan.test.ts` |
| ING-02 | 02-01 | User configures the inbox once in Settings (app creates a default), then triggers a manual "Scan now" | SATISFIED | `inbox.ts`, `SettingsScreen.tsx`, `ingestion.ts`; `e2e/inbox-picker.spec.ts` |
| ING-03 | 02-01 (unsupported-file half) + 02-03 (materialization half) | App skips unsupported/not-materialized files and surfaces them in a summary rather than silently dropping | SATISFIED | `scan.ts` unsupported branch (02-01) + `materialization.ts` + not-ready wiring (02-03); both halves independently tested |
| ING-04 | 02-02 | SHA-256 per document; skip-and-flag exact already-posted files, excluded by default with an override | SATISFIED | `ledger.ts`, `scan.ts` dedupe wiring, `BillsScreen.tsx` include-anyway control; `test/ingestion-ledger.test.ts`, dedupe cases in `test/ingestion-scan.test.ts` |
| ING-05 | 02-01 | App accepts text PDFs, JPEG, PNG, and HEIC | SATISFIED | `filetype.ts:10` `SUPPORTED` set |

No orphaned requirements: REQUIREMENTS.md maps exactly ING-01..ING-05 to Phase 2 (traceability table lines 135-139), and every one of those IDs appears in a PLAN's `requirements:` frontmatter (02-01: ING-01, ING-02, ING-03, ING-05; 02-02: ING-04; 02-03: ING-03). All five are marked `[x]` complete in REQUIREMENTS.md, matching the code-level evidence above.

### Anti-Patterns Found

None blocking. The code-review cycle (`02-REVIEW.md`) found 1 Critical + 4 Warning issues; all five are confirmed fixed in source and committed (`0443aa8` CR-01, `03e884a` WR-01, `87b7469` WR-02, `b06bb5c` WR-03, `0dc2fbc` WR-04) — verified directly by reading the current file contents, not by trusting the review or SUMMARY text:

- CR-01 (silent scan failure): `BillsScreen.tsx:144-159` now has a `catch` that sets `scanError` and renders a `role="alert"` banner. Confirmed fixed.
- WR-01 (whole-batch abort on one bad file): `scan.ts:110-131` wraps each entry in try/catch, recording `not-ready-skipped` on any throw; the darwin `stat` branch in `materialization.ts:83-88` now load-on-failures like the win32 branch. Confirmed fixed.
- WR-02 (dead `iCloudSentinelTarget`): `scan.ts:86-92` now imports and calls it, translating a `.<name>.icloud` sentinel to a `not-ready-skipped` row keyed to the real filename, with a de-dup guard against a coexisting real file. Confirmed fixed and covered by `test/ingestion-scan.test.ts:208-234`.
- WR-03 (stale persisted inbox path trusted blindly): `inbox.ts:53` now `existsSync`-checks the persisted path before returning it, falling back to recreate the default. Confirmed fixed.
- WR-04 (SettingsScreen swallows chooseInbox errors): `SettingsScreen.tsx:47-50` now has a `catch` setting `chooseError`, rendered as a `role="alert"` banner. Confirmed fixed.

Three Info-severity findings remain open by design (not goal-blocking, per the review's own severity classification and the task context):
- IN-01: `checkPostedHash(db = getDatabase(), hash)` has a dead default (the default is unreachable because `hash` is required and trails it). Cosmetic; every call site passes both args explicitly (confirmed at `scan.ts:156`).
- IN-02: `preload/index.ts:9` and stray prose still say "ONLY named settings/secrets/theme methods" without mentioning the `ingestion` group the code otherwise correctly exposes and tests (`e2e/ipc-boundary.spec.ts:46` already asserts all four groups). Stale comment only, not a behavior bug.
- IN-03: `readWindowsOfflineFlags`'s `execFileAsync` calls have no `timeout` option, so a hung `powershell.exe`/`attrib` on a degraded machine could stall a scan indefinitely. Confirmed still absent in `materialization.ts:154-177`. Low-likelihood, not observed in this environment, and not required for the phase goal.

No debt markers (`TBD`/`FIXME`/`XXX`) found in any ingestion source file. No `TODO`/`HACK`/`PLACEHOLDER`/"coming soon" strings found outside of legitimate "placeholder" domain terminology (cloud-sync placeholder files, which is the correct technical term for this feature, not a code stub).

### Human Verification Required

### 1. macOS real-provider materialization probe

**Test:** On a real Mac with iCloud Drive enabled, evict a test bill file (right-click > Remove Download in Finder), drop it into the configured `NicoleBooks/Inbox` folder, click "Scan now" on the Bills screen.
**Expected:** The file is flagged "Not downloaded yet, re-scan shortly" and the app never forces it to re-download (Finder does not show a download progress indicator triggered by the scan). Re-scanning after it naturally re-materializes loads it normally.
**Why human:** Requires a genuine macOS + iCloud Drive environment to produce a real dataless APFS file (`size>0, blocks===0`). This machine cannot fabricate that filesystem state; the automated suite proves the bit-testing logic only against an injected `stat()` double.

### 2. Windows real-provider materialization probe

**Test:** On a real Windows machine with OneDrive, set a test bill file to "Free up space" (cloud-only), drop it into the configured `NicoleBooks\Inbox` folder, click "Scan now".
**Expected:** The file is flagged "Not downloaded yet, re-scan shortly"; the batched `powershell.exe`/`attrib` attribute read correctly identifies the OFFLINE/RECALL bits without recalling the file's bytes.
**Why human:** Requires a genuine Windows + OneDrive environment to produce real `FILE_ATTRIBUTE_OFFLINE`/`RECALL_ON_DATA_ACCESS`/`RECALL_ON_OPEN` bits and to exercise the actual subprocess spawn path end-to-end. The automated suite proves the bit-testing logic only against an injected `readWinFlags()` double.

### Gaps Summary

No code-level gaps. Every observable truth derived from ROADMAP.md's four Success Criteria and the three PLANs' `must_haves` is backed by source code that was read directly (not summarized) and by an automated test that was actually re-run in this session (`npm run typecheck` exit 0, `npm run test:unit` 76/76 passed across 10 files, `npm run build` exit 0, `npm run test:e2e` 6/6 passed). The prior code review's Critical and Warning findings were independently confirmed fixed by reading the current file contents and matching them against the specific commit hashes in git history — not by trusting `02-REVIEW.md` or the SUMMARY files' claims. The Design B "Phase 2 never writes `posted_file_hashes`" invariant was independently re-verified by grep, not merely cited from the SUMMARY.

The only reason this phase is not `passed` is that two behaviors (real macOS iCloud eviction and real Windows OneDrive offline-attribute detection) depend on cloud-sync provider state that cannot be produced or observed in this sandboxed environment. Both are already deliberately isolated behind dependency-injected metadata readers specifically so the *logic* could be unit-tested without real cloud infrastructure — that logic is fully verified. What remains is confirming the real-world thresholds (A1/A2 from 02-RESEARCH) hold on Anthony's actual deployment machines, which is a one-time environment-specific confirmation, not an implementation gap.

---

_Verified: 2026-07-24T16:57:13Z_
_Verifier: Claude (gsd-verifier)_
