---
phase: 02-ingestion-and-dedupe
plan: 03
subsystem: ingestion
tags: [materialization, cloud-placeholder, onedrive, icloud, fs-stat, execFile, react, scan, bytes-last]

# Dependency graph
requires:
  - phase: 02-ingestion-and-dedupe
    plan: 01
    provides: runScan orchestrator with the 02-03 SLICE seam, flat non-recursive enumeration, streaming sha256File, ScanFile/ScanResult contract with the not-ready-skipped status + summary.notReady, Bills-screen results surface with STATUS_VARIANT/STATUS_LABEL maps
  - phase: 02-ingestion-and-dedupe
    plan: 02
    provides: within-scan collapse + posted-ledger dedupe filling the SLICE 2 seam (the not-ready gate layers in ahead of it, before the hash)
provides:
  - metadata-first, bytes-last materialization gate on the scan pipeline (isNotMaterialized then isSettled BEFORE sha256File)
  - cross-platform placeholder detection (macOS blocks===0 / .icloud sentinel; Windows OFFLINE/RECALL attribute bits via one batched injection-safe execFile per scan)
  - bounded size+mtime settling poll for partial writes (isSettled)
  - inconclusive-detection load-on-failure fallback (skip only on positive placeholder evidence)
  - Bills-screen not-ready-skipped surfacing + distinct empty states (empty-inbox / all-duplicates / all-skipped)
affects: [03 parse pipeline (loaded files remain its input; not-ready files never enter the batch), 07 posting]

# Tech tracking
tech-stack:
  added: []  # no new dependencies (Node fs.stat/child_process.execFile + OS-bundled powershell.exe/attrib.exe)
  patterns:
    - "metadata-first, bytes-last gate: classify + screen by stat/attribute metadata, open a byte stream only after both gates pass (reading bytes is what forces a placeholder to download)"
    - "injectable cross-OS detection (explicit platform arg + deps.stat / deps.readWinFlags) so both macOS and Windows branches unit-test deterministically on one host, mirroring connection.ts openDatabase injectability"
    - "one batched Windows attribute read per scan (never per file); path passed out-of-band via an env var so a crafted folder/filename can never be parsed as a command"
    - "load-on-total-failure: skip only on positive placeholder evidence, so a real local bill is never false-skipped"

key-files:
  created:
    - src/main/ingestion/materialization.ts
    - test/ingestion-materialization.test.ts
  modified:
    - src/main/ingestion/scan.ts
    - src/renderer/src/screens/BillsScreen.tsx
    - test/ingestion-scan.test.ts

key-decisions:
  - "The materialization + stability gates run BEFORE sha256File for every file (metadata-first, bytes-last). A not-ready file is skipped without ever opening its bytes, so a cloud placeholder is never force-downloaded (T-02-09) and a half-written file is never hashed."
  - "Windows offline/recall attributes are read in ONE batched execFile per scan (args array, shell:false, path via the NB_SCAN_DIR env var — never concatenated into a command string), satisfying T-02-08. macOS is pure Node (fs.stat blocks + .icloud sentinel), no shell-out."
  - "Inconclusive-detection fallback: on total detection failure (Windows attribute read throws or the file is absent from the map) the scan LOADS rather than false-skipping; skipping requires a positive OFFLINE/RECALL bit or blocks===0/.icloud sentinel. Favors 'never false-skip a real bill' over 'never ever download' (02-RESEARCH OQ1)."
  - "not-ready-skipped reads as a calm outline badge (a benign, recoverable state) rather than a destructive error, with the D-11 copy 'Not downloaded yet, re-scan shortly'; the file is surfaced for re-scan, never silently dropped (T-02-10)."

patterns-established:
  - "the placeholder gate is resolved once per scan (resolvePlaceholderGate) and threaded into each file check, so the Windows attribute spawn happens at most once per scan"
  - "a scan that loads nothing still explains why via a distinct EmptyState (all-duplicates vs all-skipped), keeping the detail sections visible so duplicates can still be included and skipped files re-scanned"

requirements-completed: [ING-03]

# Metrics
duration: 9min
completed: 2026-07-24
---

# Phase 2 Plan 03: Materialization Gate Summary

**The metadata-first, bytes-last materialization guard on the scan pipeline: before hashing any file the scan runs two independent metadata-only gates — a cross-platform cloud-placeholder check (macOS `blocks===0` / `.icloud` sentinel; Windows `FILE_ATTRIBUTE_OFFLINE`/`RECALL_ON_DATA_ACCESS`/`RECALL_ON_OPEN` read via one batched, command-injection-safe `execFile` per scan) and a bounded size+mtime settling poll for partial writes — so an online-only placeholder is never force-downloaded and a half-written file is never hashed; failing files are flagged `not-ready-skipped` and surfaced on the Bills screen for re-scan, closing SC4 and the materialization half of ING-03 under a load-on-inconclusive fallback that never false-skips a real bill.**

## Performance

- **Duration:** ~9 min
- **Started:** 2026-07-24T16:05:00Z
- **Completed:** 2026-07-24T16:14:50Z
- **Tasks:** 3 (+1 Rule 1 auto-fix)
- **Files modified:** 5 (2 created, 3 modified)

## Accomplishments

- **`src/main/ingestion/materialization.ts`** (created): `isNotMaterialized` (metadata-only placeholder check — darwin `size>0 && blocks===0` or a `.<name>.icloud` sentinel sibling; win32 any of the OFFLINE/RECALL bits), `isSettled` (bounded two-consecutive-equal size+mtime poll, defaults 750ms x 6), and `readWindowsOfflineFlags` (one batched `execFile` per scan returning a name -> attribute-integer map). All injectable via an explicit `platform` arg + a `deps` object so both OS branches test on one CI host.
- **`src/main/ingestion/scan.ts`** (modified, SLICE 3 seam): each supported file now runs `isNotMaterialized` then `isSettled` BEFORE `sha256File`; a failing gate pushes `not-ready-skipped` and continues without hashing. The Windows attribute map is resolved once per scan (`resolvePlaceholderGate`) and threaded into every check. `summary.notReady` now counts the skipped files.
- **`src/renderer/src/screens/BillsScreen.tsx`** (modified): a `not-ready-skipped` section renders with the D-11 "Not downloaded yet, re-scan shortly" copy (calm outline badge, not an error); the one-line summary already counts it as "not downloaded". Distinct `EmptyState` messaging now covers empty-inbox, all-duplicates, and all-skipped so a scan that loads nothing always explains why (visibility over silence).
- **Command-injection-safe Windows read (T-02-08):** `execFile` with an args array and `shell: false`; the directory path travels out-of-band in the `NB_SCAN_DIR` env var referenced by a static PowerShell script (falls back to `attrib`, then an empty map). No `exec(` anywhere; no path is ever concatenated into a command string.
- **Bytes-last proof:** the scan spec injects a spy hasher and asserts a gate-flagged file's bytes are NEVER read while a real local file in the same inbox still loads with a valid hash.

## Task Commits

Each task was committed atomically:

1. **Task 1: Failing materialization + not-ready scan specs (RED)** - `51169e9` (test)
2. **Task 2: materialization.ts + scan gate wiring (GREEN)** - `aad7809` (feat)
3. **Task 3: Bills-screen not-ready surfacing + empty states** - `465442c` (feat)
4. **Rule 1 auto-fix: remove stray NUL byte in BillsScreen fileKey** - `8b8868c` (fix)

_TDD note: this plan's config has `tdd_mode: false`; Task 2 carries `tdd="true"` and was driven RED (Task 1) -> GREEN, committed as a single per-task commit (matching the 02-01/02-02 convention)._

## Files Created/Modified

- `src/main/ingestion/materialization.ts` (created) - `isNotMaterialized` / `isSettled` / `readWindowsOfflineFlags`; injection-safe batched Windows attribute read; load-on-failure fallback.
- `test/ingestion-materialization.test.ts` (created) - injected macOS `blocks`, `.icloud` sentinel, Windows OFFLINE/RECALL bits, archive-only negative, inconclusive throw/empty fallback, and a real-fs partial-write settling case.
- `src/main/ingestion/scan.ts` (modified) - filled the SLICE 3 seam: placeholder + settling gates before the hash, `resolvePlaceholderGate` batches the Windows read once per scan, `summary.notReady` recomputed; new injectable `ScanDeps` (isNotMaterialized / isSettled / sha256File) for testability.
- `src/renderer/src/screens/BillsScreen.tsx` (modified) - not-ready section, D-11 copy, `notReadyFiles` filter, `noLoadState` all-duplicates/all-skipped EmptyState, empty-inbox copy update.
- `test/ingestion-scan.test.ts` (modified) - a gate-flagged file returns `not-ready-skipped`, is never hashed (spy), appears in `summary.notReady`, while a real local file loads; existing scan calls routed through a fast injected gate for determinism.

## Decisions Made

- **Metadata-first, bytes-last is a correctness requirement, not an optimization.** Reading a placeholder's bytes is exactly what forces the download (Windows recall / macOS materialization), so both gates run on metadata only and `sha256File` runs last. Verified by a source assertion (`isNotMaterialized`/`isSettled` before `sha256File`) and a runtime spy proving a not-ready file's bytes are never read.
- **One batched, injection-safe Windows attribute read per scan.** `readWindowsOfflineFlags` shells out at most once per scan via `execFile` (args array, `shell: false`) with the path in an env var, never `exec` with a concatenated string (Pitfall 4 / T-02-08). Resolved once in `resolvePlaceholderGate` and threaded into each file check.
- **Load on inconclusive detection; skip only on positive evidence.** If the Windows read throws or the file is absent from the attribute map, `isNotMaterialized` returns false (the file loads). This favors never false-skipping a real bill over never downloading, within D-11's spirit that skipped files are always surfaced and re-scannable (closes 02-RESEARCH Open Question 1).
- **not-ready reads calm, not alarming.** The badge is `outline` (a benign, recoverable state) with the D-11 "re-scan shortly" copy; the file is surfaced for re-scan, never silently dropped (T-02-10).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Removed a stray NUL byte in BillsScreen `fileKey`**
- **Found during:** Task 3 (committing BillsScreen.tsx, which git reported as a binary file)
- **Issue:** A prior plan (02-02) left a raw NUL byte where a space belongs in the `fileKey` template literal (`` `${file.filename}\x00${file.hash ?? ''}` ``). It worked at runtime (NUL is a valid JS string char, so tests passed) but corrupted the source-file encoding and made git treat the `.tsx` as binary (0-insertion/0-deletion diffs).
- **Fix:** Replaced the single NUL byte with a normal space; the file is now clean UTF-8 (0 NUL bytes) and the `fileKey` value (`filename + ' ' + hash`) is unchanged in behavior.
- **Files modified:** src/renderer/src/screens/BillsScreen.tsx
- **Verification:** `python` byte scan confirms 0 NUL bytes in the committed blob; `npm run typecheck` exits 0; `npm run test:unit` 73 passed.
- **Committed in:** `8b8868c`

---

**Total deviations:** 1 auto-fixed (1 bug). **Impact on plan:** minimal — a one-byte source-hygiene fix in a file this plan already had to modify; no behavior change and no scope change.

## Authentication Gates

None - this plan touches no external service.

## Issues Encountered

- None beyond the deviation above. RED (Task 1) failed on the expected missing `materialization.ts` import plus the not-ready assertion; GREEN (Task 2) turned both target suites and the full unit suite green; Task 3 kept typecheck and the unit suite green.

## Known Stubs

None. The real cloud-placeholder detection thresholds (A1/A2 — macOS `blocks===0` on a real evicted iCloud file, Windows attribute integers on a real OneDrive online-only file) are validated only by the deferred end-of-phase cross-OS human probe; the automated tests inject metadata/attributes deterministically. This is a documented manual gate, not a stub in the code path.

## Threat Flags

None. This slice adds no new network endpoint, auth path, or renderer-reachable trust boundary. The one new privileged surface (the Windows attribute read) is inside the plan's `<threat_model>` (T-02-08) and is mitigated as designed: `execFile` args array, `shell: false`, path via env var, batched once per scan, no `exec(` anywhere.

## Verification Evidence

- `npx vitest run test/ingestion-materialization.test.ts test/ingestion-scan.test.ts` - 18 passed (2 files).
- `npm run test:unit` - 73 passed (10 files), no Slice-1/2 regression (was 62; +11 new).
- `npm run typecheck` - clean (exit 0).
- Source assertions: `materialization.ts` uses `execFile` + `shell: false` with NO bare `exec(`; `scan.ts` calls `isNotMaterialized` then `isSettled` before `sha256File`; the Windows attribute map is resolved once per scan.
- Manual gate (deferred to the end-of-phase cross-OS human checkpoint, folded into 01-08): on a real Mac right-click "Remove Download" on a test file and confirm it flags `not-ready-skipped` without downloading; on real Windows set a file to "Free up space" in OneDrive and confirm the same. Locks assumptions A1/A2 on the deployment machines.

## Next Phase Readiness

- All three SLICE seams in `runScan` are now filled (01: enumerate/classify/hash; 02: dedupe; 03: materialization). The scan pipeline is complete for Phase 2's "loaded for processing" boundary.
- ING-03 is fully delivered (unsupported half in 02-01, not-materialized half here) and marked complete; ING-01/02/04/05 were completed in 02-01/02-02. All Phase 2 requirements are code-complete.
- Full suite green: 73 unit tests, `npm run typecheck` clean. Phase 2 acceptance stays pending only on the deferred cross-OS human probe (A1/A2) and `/gsd:verify-work 02`.

## Self-Check: PASSED

- Created files exist on disk: `src/main/ingestion/materialization.ts`, `test/ingestion-materialization.test.ts`.
- All four task commit hashes (`51169e9`, `aad7809`, `465442c`, `8b8868c`) are present in git history.

---
*Phase: 02-ingestion-and-dedupe*
*Completed: 2026-07-24*
