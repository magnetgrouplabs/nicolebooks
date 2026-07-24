---
phase: 02-ingestion-and-dedupe
reviewed: 2026-07-24T00:00:00Z
depth: standard
files_reviewed: 25
files_reviewed_list:
  - src/shared/ipc-contract.ts
  - src/shared/schemas.ts
  - src/main/db/migrate.ts
  - src/main/db/migrations/0002_dedupe.ts
  - src/main/ingestion/filetype.ts
  - src/main/ingestion/hash.ts
  - src/main/ingestion/inbox.ts
  - src/main/ingestion/ledger.ts
  - src/main/ingestion/materialization.ts
  - src/main/ingestion/scan.ts
  - src/main/ipc/ingestion.ts
  - src/main/ipc/register.ts
  - src/preload/index.ts
  - src/renderer/src/screens/BillsScreen.tsx
  - src/renderer/src/screens/SettingsScreen.tsx
  - test/ingestion-filetype.test.ts
  - test/ingestion-hash.test.ts
  - test/ingestion-inbox.test.ts
  - test/ingestion-ledger.test.ts
  - test/ingestion-materialization.test.ts
  - test/ingestion-scan.test.ts
  - test/ipc-contract.test.ts
  - test/migrate.test.ts
  - e2e/inbox-picker.spec.ts
  - e2e/ipc-boundary.spec.ts
findings:
  critical: 1
  warning: 4
  info: 3
  total: 8
status: issues_found
---

# Phase 02: Code Review Report

**Reviewed:** 2026-07-24
**Depth:** standard
**Files Reviewed:** 25
**Status:** issues_found

## Summary

This slice builds the read-only ingestion + dedupe pipeline behind the Phase 1 typed IPC trust boundary. The security-critical surfaces the prompt flagged are, on the whole, well built and I could not break them:

- **Trust boundary:** every ingestion handler calls `assertTrustedSender(event)` as its first statement, the preload exposes only named methods (no generic `invoke`), and `scan` takes no renderer payload (`ScanRequestSchema.strict()`), so there is no renderer-supplied path reaching `fs`.
- **SQL / Design B invariant:** all production SQL is parameterized (`WHERE hash = ?`, named-parameter UPSERT). The only interpolation is `PRAGMA user_version = N` with a code-controlled integer. Grep confirms **no** `INSERT/UPDATE/DELETE` against `posted_file_hashes` in `src/` — the "posted-only, read-only in Phase 2" invariant holds.
- **Command construction:** `readWindowsOfflineFlags` uses `execFile` with `shell:false` and an args array, and passes the directory out-of-band via the `NB_SCAN_DIR` env var with `-LiteralPath`. No command/argument injection path.
- **UI copy dashes:** the only em dashes in the renderer are in code comments (exempt per CLAUDE.md); every user-visible string uses plain hyphens. No violation.

The defects that remain are correctness and robustness issues concentrated in the scan pipeline's error handling and one unimplemented cross-OS path. The headline problem: the primary "Scan now" action fails **silently** when anything goes wrong (most plausibly a moved/deleted inbox folder), because the renderer never catches the rejection and the main-side pipeline aborts the whole batch on the first `fs` error. For a single non-technical user whose entire workflow is "click scan," an invisible no-op is a shipping blocker.

## Critical Issues

### CR-01: "Scan now" fails silently — no error handling on the app's primary action

**File:** `src/renderer/src/screens/BillsScreen.tsx:140-150` (and the `void`-invoke at `:182`), with the root cause in `src/main/ingestion/scan.ts:60,106-107`

**Issue:** `BillsScreen.runScan` wraps the scan in `try { ... } finally { setScanning(false) }` with **no `catch`**, and is invoked as `onClick={() => void runScan()}`. If `window.api.ingestion.scan()` rejects, the rejection is discarded (`void`), `result` stays unchanged, and the user sees only the button flicker disabled → enabled. No error message, no toast, no state.

This is not a hypothetical path. `runScan` in the main process performs `readdir(inboxPath, ...)` (`scan.ts:60`) and later `stat`/`sha256File` (`scan.ts:106-107`) with no error isolation. The most common trigger is a **missing inbox folder**: `resolveInboxPath` (`inbox.ts:49-51`) returns the persisted path with `created:false` and never checks it still exists, so if Nicole moves, renames, or deletes the folder (or it lives on an unmounted drive / offline network share), `readdir` throws `ENOENT`, `runScan` rejects, and the whole action vanishes with zero feedback.

**Fix:** Add a `catch` that surfaces an error state, and stop discarding the rejection:
```tsx
const [scanError, setScanError] = useState<string | null>(null)

async function runScan(): Promise<void> {
  setScanning(true)
  setScanError(null)
  try {
    const scan = await window.api.ingestion.scan()
    setResult(scan)
    setIncludedOverrides(new Set())
  } catch (err) {
    setScanError(
      'Could not scan your inbox folder. Make sure the folder still exists, then try again.'
    )
  } finally {
    setScanning(false)
  }
}
// ...and render {scanError && <ErrorBanner>{scanError}</ErrorBanner>}
```
Pair this with WR-01 (make the pipeline resilient to a single bad file) and WR-03 (validate/recreate the inbox path) so the error surface is only for genuinely unrecoverable failures.

## Warnings

### WR-01: Scan pipeline has no per-file error isolation; one transient fs error aborts the whole batch

**File:** `src/main/ingestion/scan.ts:73-109`; `src/main/ingestion/materialization.ts:77-85`

**Issue:** The per-entry loop calls `stat` (`scan.ts:106`), `hashFile` (`:107`), and the injected `settled`/`notMaterialized` gates without a try/catch around each entry. Any single failure — a file removed by cloud sync mid-scan, a permission error, a lock — throws and rejects the **entire** `runScan`, discarding every already-classified file. This directly contradicts the phase's stated principle ("surfaced for re-scan rather than silently dropped"): instead of one file being skipped, the whole scan is lost.

The exposure is worse on macOS: `isNotMaterialized`'s darwin branch (`materialization.ts:77-85`) calls `statFn(fullPath)` with **no** try/catch, whereas the win32 branch (`:87-99`) explicitly catches and load-on-failures. So a file that disappears between `readdir` and the gate crashes the whole scan on darwin but degrades gracefully on win32 — inconsistent handling of the same race.

**Fix:** Wrap the per-entry body in a try/catch that records the offending file (e.g., as `not-ready-skipped` or a new error status) and continues, and mirror the win32 load-on-failure guard in the darwin branch:
```ts
for (const entry of entries) {
  try {
    // ...classify + gate + hash...
  } catch {
    files.push({ filename: entry.name, status: 'not-ready-skipped' })
  }
}
```
```ts
// darwin branch
let st: StatMeta
try { st = await statFn(fullPath) } catch { return false } // load-on-failure, like win32
```

### WR-02: Legacy iCloud `.icloud` sentinel handling is unimplemented; `iCloudSentinelTarget` is dead code

**File:** `src/main/ingestion/filetype.ts:34-44` (unused export) and `src/main/ingestion/scan.ts:24` (does not import it)

**Issue:** `filetype.ts` documents that a `.<name>.icloud` sentinel "is translated to a placeholder signal for `<name>` ... so ... the real file is flagged not-ready rather than silently lost," and ships `iCloudSentinelTarget` plus a unit test for exactly that translation. But `scan.ts` never imports or calls `iCloudSentinelTarget` (grep confirms the only references are the comment and the definition itself). The code contradicts its own contract.

Consequence on the legacy (pre-Sonoma) iCloud eviction model, where the real `bill.pdf` entry is **replaced** by `.bill.pdf.icloud`: `scan.ts` sees only the sentinel. `isJunk` lets it through (the `.icloud` exception at `filetype.ts:24`), then `isSupported` classifies it by its `.icloud` extension as **`unsupported-skipped`** (`filetype.ts:29-32`). The real bill therefore surfaces mislabeled as an "unsupported" `.bill.pdf.icloud` row and is never offered as a not-ready/re-scannable bill. The materialization sibling check at `materialization.ts:83` only helps the modern case where `bill.pdf` still exists as its own directory entry; it cannot fire when only the sentinel is present.

**Fix:** Wire the translation into the scan loop before the junk/support checks: when `iCloudSentinelTarget(name)` returns a non-null target, emit a `not-ready-skipped` result keyed to the *target* filename (and de-duplicate against a real entry of the same name if one also exists), rather than letting the sentinel fall through to `unsupported-skipped`. If legacy iCloud support is intentionally deferred, delete the unused export and its test and remove the misleading contract comment so the code and docs agree.

### WR-03: `resolveInboxPath` trusts a persisted path without checking it still exists

**File:** `src/main/ingestion/inbox.ts:44-58`

**Issue:** When `app_settings.inbox_path` is set, `resolveInboxPath` returns `{ path: row.value, created: false }` (`:49-51`) with no `existsSync`/`stat` check. The default-creation branch (`:52-57`) only runs when the setting is unset. So once a path is persisted, a folder that is later moved, renamed, deleted, or on an unmounted volume is returned as-is, and every downstream consumer (`runScan`'s `readdir`, the Bills/Settings display) inherits a path that no longer resolves — feeding CR-01's silent failure.

**Fix:** Verify the stored path before returning it, and fall back to (re)creating the default or signaling "needs reconfiguration" to the renderer:
```ts
if (row?.value) {
  if (existsSync(row.value)) return { path: row.value, created: false }
  // stored path is gone — recreate default (or surface a "reselect folder" state)
}
```

### WR-04: `SettingsScreen.chooseInbox` swallows errors (same anti-pattern as CR-01)

**File:** `src/renderer/src/screens/SettingsScreen.tsx:39-48` (and the `void`-invoke at `:63`)

**Issue:** `chooseInbox` uses `try { ... } finally { setChoosing(false) }` with no `catch`, invoked via `void chooseInbox()`. If `window.api.ingestion.chooseInbox()` rejects (e.g., the main handler throws before returning), the rejection is unhandled and the user gets no feedback — the "Change inbox folder" button simply does nothing. Lower impact than the scan action, but the same defect and the same fix.

**Fix:** Add a `catch` that sets a small error state (or at minimum logs and shows a non-blocking message), consistent with the CR-01 fix.

## Info

### IN-01: `checkPostedHash` puts a defaulted parameter before a required one

**File:** `src/main/ingestion/ledger.ts:35-38`

**Issue:** The signature is `checkPostedHash(db: Database.Database = getDatabase(), hash: string)`. Because `hash` is required and follows the defaulted `db`, the `= getDatabase()` default is unreachable through any normal call (a caller can never omit `db` while supplying `hash`); every call site passes both explicitly. The default is dead and misleading.

**Fix:** Either make `hash` the first (required) parameter and `db` the trailing optional one, or drop the default and require both explicitly to match the actual call convention in `scan.ts:133`.

### IN-02: Stale scope comments after the ingestion group was added

**File:** `src/preload/index.ts:8-11`; `e2e/ipc-boundary.spec.ts:13-14`

**Issue:** The preload security comment says "We expose ONLY named settings/secrets/theme methods," and the e2e header says "window.api exposes ONLY the three named groups (settings, secrets, theme)." Both predate the fourth `ingestion` group (the e2e assertions were correctly updated at `:50` but the prose was not). Stale security-relevant comments invite future readers to reason about the wrong surface.

**Fix:** Update both comments to include the `ingestion` group.

### IN-03: `readWindowsOfflineFlags` spawns have no timeout

**File:** `src/main/ingestion/materialization.ts:145-154,164-168`

**Issue:** The `execFileAsync('powershell.exe', ...)` and `execFileAsync('attrib', ...)` calls set `maxBuffer` and `windowsHide` but no `timeout`. A hung `powershell.exe` (rare, but possible on a degraded machine) would hang the whole scan with no ceiling, since this runs once synchronously within `runScan`. `isSettled` is bounded; this spawn is not.

**Fix:** Pass a `timeout` (e.g., `timeout: 10_000`) to both `execFileAsync` options; a timeout throw already falls through to the next reader / empty-map load-on-failure path.

---

_Reviewed: 2026-07-24_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
