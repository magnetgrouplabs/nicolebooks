---
phase: 01-foundation
plan: 07
subsystem: validation-ci
tags: [playwright, electron, e2e, ipc-boundary, secret-store, persistence, theme, ci, cross-os, native-rebuild, preload-fix]

# Dependency graph
requires:
  - phase: 01-01
    provides: Playwright _electron harness (playwright.config.ts, MAIN_ENTRY, launch.spec.ts), better-sqlite3 native rebuild wired as postinstall
  - phase: 01-05
    provides: live sender-validated Zod-gated IPC handlers for settings/secrets/theme, safeStorage secret store writing secrets.enc
  - phase: 01-06
    provides: branded shell DOM (NicoleBooks wordmark, Bills/History/Settings sidebar, Settings HealthIndicator round trip), OS theme mirror in main.tsx
provides:
  - "e2e/secret-roundtrip.spec.ts: SC2 end-to-end keychain round trip on the running app plus the no-leak proof (base64 ciphertext in secrets.enc, no plaintext canary in secrets.enc or app.db)"
  - "e2e/persistence.spec.ts: SC3 relaunch proof (an app_settings value survives a full process restart against the same userData)"
  - "e2e/ipc-boundary.spec.ts: SC4 renderer isolation proof (no window.require/process/module/ipcRenderer, window.api exposes only settings/secrets/theme, malformed payload rejects at the Zod gate)"
  - "e2e/theme.spec.ts: SC1 theme proof (documentElement dark class matches the native OS theme value)"
  - ".github/workflows/ci.yml: cross-OS matrix (windows-latest plus macos-latest) that installs, rebuilds the native module in a distinct step, builds, and runs both suites"
  - "Fix: preload build now externalizes electron so window.api actually loads in the packaged (loadFile) build"
affects: [01-08 human cross-OS checkpoint reproduces these exact commands on real Windows and Mac, all Phase 2-8 renderer features rely on a working window.api in the built app, all future CI runs on this workflow]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Playwright _electron e2e with per-test isolated userData via the Electron --user-data-dir switch (honored: app.getPath('userData') resolves to the passed dir), files inspected after app.close() to avoid open-handle contention"
    - "Cross-OS GitHub Actions matrix (windows-latest plus macos-latest, fail-fast false) with a distinct electron-rebuild step so an ABI/toolchain failure is a named per-OS failure"
    - "Preload must externalize the electron runtime built-in (require('electron')) rather than bundling node_modules/electron; bundling the executable-path shim breaks the sandboxed preload and leaves window.api undefined"

key-files:
  created:
    - e2e/secret-roundtrip.spec.ts
    - e2e/persistence.spec.ts
    - e2e/ipc-boundary.spec.ts
    - e2e/theme.spec.ts
    - .github/workflows/ci.yml
  modified:
    - electron.vite.config.ts

key-decisions:
  - "Drove the e2e assertions through the real window.api bridge from the renderer (page.evaluate) and read privileged on-disk artifacts (secrets.enc, app.db) after closing the app, rather than reaching into the main process, so the specs exercise the true renderer-to-main boundary from outside."
  - "Used the Electron --user-data-dir switch for per-test isolation and asserted (in persistence) that the reported userData resolves into the temp dir, so a silent fallback to the real profile fails loudly instead of passing dishonestly."
  - "Fixed a blocking preload-bundling bug (electron resolved to node_modules/electron/index.js) by marking electron external in the preload build; this restores window.api in the packaged app, which every SC2/SC3/SC4 e2e proof (and the shipped product) depends on."
  - "Omitted a Playwright managed-browser download in CI because _electron launches the app's own bundled Electron/Chromium; windows and macos runners provide a display server so no virtual framebuffer is needed."
  - "Kept the CI native rebuild as an explicit distinct step in addition to the npm ci postinstall rebuild, so an ABI or toolchain failure surfaces as its own visible per-OS failure (PLAT-01, T-01-08)."

requirements-completed: [PLAT-02]

# Metrics
duration: 14min
completed: 2026-07-22
---

# Phase 1 Plan 07: End-to-End Validation Surface and Cross-OS CI Summary

**The automatable half of the Wave 0 validation gate: four Playwright `_electron` specs that prove SC2 (keychain round trip plus no-leak), SC3 (relaunch persistence), SC4 (renderer isolation), and SC1 (theme mirror) on the real running build, plus a windows-latest and macos-latest CI matrix that installs, rebuilds the native module in a distinct step, and runs both suites. Fixing a blocking preload-bundling bug that left `window.api` undefined in the packaged app was required to make any of it pass.**

## Performance

- **Duration:** ~14 min
- **Started:** 2026-07-22T21:15:18Z
- **Completed:** 2026-07-22T21:28:49Z
- **Tasks:** 2 (3 commits: one deviation fix, one test, one CI)
- **Files:** 5 created, 1 modified

## Honest Execution Scope (Windows-only local run)

This plan was executed on Windows. Everything below that is marked "ran locally" was actually observed passing on this Windows machine. The macOS leg of the CI matrix was **authored, not executed here** (this machine cannot run the Mac runner). The Mac reproduction is deferred to CI and to the 01-08 human checkpoint. Nothing Mac-specific is claimed as observed-passing.

- **Ran locally and observed passing (Windows):** `npm run build`, `npx vitest run` (36 tests), `npx playwright test` (all 5 e2e specs including the SC2 keychain round trip via Windows DPAPI), `npm run typecheck`, and the ci.yml YAML parse plus structural checks.
- **Authored but NOT executed here (deferred to CI + 01-08):** the macos-latest leg of the matrix (native rebuild, keychain round trip, persistence, isolation, theme on a real Keychain), and the real-machine "locked/absent login keychain -> unavailable" case.

## Accomplishments

- Authored `e2e/secret-roundtrip.spec.ts`: launches the built app with an isolated temp userData, navigates to Settings, asserts the HealthIndicator resolves to `Secret store: OK` (the live renderer-to-IPC-to-main-to-keychain round trip), drives a distinctive high-entropy canary through `window.api.secrets` and confirms an exact read-back, then after closing the app asserts `secrets.enc` holds base64 ciphertext for that key (never the plaintext) and `app.db` contains no plaintext canary (SC2 plus the no-leak control, threats T-01-04 / T-01-05). Ran locally on Windows: pass.
- Authored `e2e/persistence.spec.ts`: writes an `app_settings` value through `window.api.settings.set` on one launch, closes the app, relaunches against the same userData, and reads the identical value back through `window.api.settings.get` (SC3 relaunch durability of the SQLite seam). It also asserts the `--user-data-dir` switch is actually honored so a silent fallback to the real profile fails loudly. Ran locally on Windows: pass.
- Authored `e2e/ipc-boundary.spec.ts`: from the renderer context asserts `window.require`, `window.process`, `window.module`, and a bare `ipcRenderer` are all undefined; that `window.api` exposes only `settings`/`secrets`/`theme` (and each group only its named methods); and that an over-long key rejects at the Zod-gated main handler (SC4 isolation plus Zod rejection, threats T-01-02 / T-01-03). Ran locally on Windows: pass.
- Authored `e2e/theme.spec.ts`: asserts the `documentElement` `dark` class matches the native OS theme value returned by `window.api.theme.get()`, reading the truth from the same bridge the app uses so it holds on either a light or dark host (SC1 theme). Ran locally on Windows: pass.
- Authored `.github/workflows/ci.yml`: a `windows-latest` plus `macos-latest` matrix (fail-fast false) that checks out, sets up Node at the electron-vite floor (22.x), `npm ci`, an explicit `npx electron-rebuild -f -w better-sqlite3` step, `npm run build`, `npx vitest run`, and `npx playwright test`, with least-privilege `contents: read` and no token or secret anywhere (packaging and signing are Phase 8). YAML parsed and structurally validated locally.
- Fixed a blocking, latent, production-affecting bug: the preload build was bundling the `electron` npm package's executable-path shim (which `require`s `child_process`) instead of the runtime built-in, so the sandboxed preload failed to load and `window.api` was undefined in the packaged app. See Deviations.

## Task Commits

Each task was committed atomically:

1. **Deviation fix (blocking): externalize electron in the preload build** - `a826b2b` (fix)
2. **Task 1: end-to-end specs for the secret round trip, persistence, and renderer isolation** - `06bf110` (test)
3. **Task 2: CI workflow (matrix windows plus macos)** - `ac5ae8c` (ci)

**Plan metadata:** committed separately with SUMMARY, STATE, ROADMAP, REQUIREMENTS.

## Files Created/Modified

- `e2e/secret-roundtrip.spec.ts` (created) - SC2 keychain round trip and the no-leak assertion on the running app.
- `e2e/persistence.spec.ts` (created) - SC3 relaunch persistence proof against a shared isolated userData.
- `e2e/ipc-boundary.spec.ts` (created) - SC4 renderer isolation and Zod-rejection proof.
- `e2e/theme.spec.ts` (created) - SC1 OS theme mirror proof.
- `.github/workflows/ci.yml` (created) - cross-OS matrix rebuild plus both suites, no embedded secret.
- `electron.vite.config.ts` (modified) - preload build now marks `electron` external (deviation fix).

## Decisions Made

- The specs exercise the real boundary from outside: renderer-driven `window.api` calls plus post-close on-disk inspection of `secrets.enc` and `app.db`, rather than reaching into main-process internals.
- Per-test isolation uses the Electron `--user-data-dir` switch (verified honored); the persistence spec asserts the reported userData resolves into the temp dir so a fallback to the real profile cannot pass silently.
- CI runs a distinct `electron-rebuild` step (in addition to the npm ci postinstall rebuild) so an ABI/toolchain failure is a named per-OS failure; no Playwright browser download is included because `_electron` uses the app's own bundled Chromium.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking / Rule 1 - Bug] Preload bundled the electron npm shim instead of the runtime built-in, leaving window.api undefined in the packaged app**
- **Found during:** Task 1 (the first e2e spec, and then even the pre-existing launch.spec, timed out because the built app rendered nothing).
- **Issue:** `electron.vite.config.ts` built the preload with no externalization, so the bundler resolved `import { contextBridge, ipcRenderer } from 'electron'` to `node_modules/electron/index.js` (the executable-path shim that `require`s `child_process`, `fs`, `path`). In the sandboxed preload runtime that `require('child_process')` throws `module not found`, the preload fails to load, and `contextBridge.exposeInMainWorld('api', ...)` never runs. `window.api` was therefore undefined in the renderer, and `main.tsx` boot threw `Cannot read properties of undefined (reading 'theme')` at `window.api.theme.onChange`, so React never mounted and the built app showed an empty body.
- **Why it was latent:** `launch.spec.ts` last passed in 01-01 when `main.tsx` was a placeholder that used no `window.api`; 01-06 wired `window.api` into boot but the built app's launch spec was not re-run, so the broken preload shipped unnoticed. This bug would have broken the entire IPC boundary (and thus the whole app) in every packaged build in Phase 8.
- **Fix:** Set `build.rollupOptions.external: ['electron']` for the preload so the bundle emits `require('electron')`, which the sandboxed preload runtime provides (contextBridge, ipcRenderer). The relative `ipc-contract` import is still bundled inline. The built preload now begins `let electron = require("electron")` and calls `electron.contextBridge.exposeInMainWorld`; the bundle shrank from 3.26 kB to 1.49 kB.
- **Verification:** After the fix, `window.api` is an object in the renderer, React renders the full shell (root HTML ~5450 chars, zero page errors), the previously-broken `launch.spec.ts` passes again, and all four new specs pass. `npm run typecheck` exits 0.
- **Committed in:** `a826b2b`

**Total deviations:** 1 auto-fixed (blocking bug, also a genuine production correctness fix). No architectural change; no security posture weakened (the sandbox-safe single-bundle intent is preserved, and the boundary is now actually functional).

## Cross-OS Reproduction Notes (for the 01-08 checkpoint)

Reproduce these exact commands on Anthony's real Windows and Mac machines. The CI matrix runs the same sequence on `windows-latest` and `macos-latest`.

- **Full suite (both OSes):** `npm ci` (runs the postinstall electron-rebuild), then `npx electron-rebuild -f -w better-sqlite3`, then `npm run build`, then `npx vitest run` (36 unit tests), then `npx playwright test` (5 e2e specs: launch, theme, secret-roundtrip, persistence, ipc-boundary).
- **What ran locally (Windows):** the entire sequence above passed on this Windows machine (DPAPI keychain backend; secret round trip green).
- **Mac-specific to confirm at 01-08:** the better-sqlite3 rebuild on macOS (source compile needs Xcode Command Line Tools, `xcode-select --install`, if no Electron 43 prebuild is available for the Mac arch), the safeStorage round trip against the real login Keychain, and the realistic "unavailable" case (lock or remove the login keychain and confirm the HealthIndicator shows the graceful `Secret store: unavailable` copy). These are the manual-only rows in 01-VALIDATION.md.

## Requirements

- **PLAT-02 (secrets in OS keychain, never in repo or logs):** completed. The `secret-roundtrip` e2e proves, on the real running app, that a value stored through `window.api.secrets` lands as base64 ciphertext in `secrets.enc` and never as plaintext there or in `app.db`; the HealthIndicator round trip is green on Windows (DPAPI). This is the end-to-end confirmation on top of the 01-05 unit coverage.
- **PLAT-01 (App runs on both Windows and Mac):** advanced, NOT completed. This plan completes the automatable half of the cross-OS gate: the Windows leg is observed green locally, and the macos-latest CI leg is authored. The real-machine Mac run (native rebuild, keychain, persistence, isolation, theme) is the load-bearing remainder and is intentionally left to CI plus the 01-08 human checkpoint. PLAT-01 is not marked complete here.

## Known Stubs

None. All four specs assert real behavior on the running build; the CI workflow is complete and valid. No placeholder data or mock sources were introduced.

## Threat Model Compliance

- **T-01-03 (Tampering, IPC boundary):** `ipc-boundary.spec.ts` proves a malformed (over-long) payload rejects at the main handler before any privileged action, and that the renderer cannot reach a raw `ipcRenderer` or Node.
- **T-01-04 (Information Disclosure, secrets.enc):** `secret-roundtrip.spec.ts` proves `secrets.enc` holds only base64 ciphertext and never the plaintext canary.
- **T-01-05 (Information Disclosure, no-leak):** the same spec proves the plaintext canary is absent from `app.db` (secrets never touch SQLite, D-12).
- **T-01-08 (Tampering, native rebuild):** the CI workflow runs an explicit, distinct `electron-rebuild` step on each OS so an ABI/toolchain failure is a visible per-OS failure.
- **T-01-12 (Information Disclosure, CI workflow):** ci.yml references no repository token, signing secret, or credential; least-privilege `contents: read`.

## CLAUDE.md Hard-Rule Compliance

- No em dashes or en dashes appear in any authored file (verified by scan across the four specs, ci.yml, and the config change).
- No personal, owner, or family-member names appear anywhere; no client-facing copy was authored (this plan is test and CI infrastructure only).
- No copy was published to any public channel.

## Verification Results

- `npm run build` (electron-vite) - three artifacts, exit 0; preload now emits `require("electron")`.
- `npx vitest run` - 36 tests passed across 4 files (no regression).
- `npx playwright test` - 5 e2e specs passed (launch, theme, secret-roundtrip, persistence, ipc-boundary) on Windows.
- `npm run typecheck` (`tsc --build`) - exit 0 (the config change is inside the tsconfig.node project; the e2e specs are outside both tsconfig include lists).
- Task 2 verify command (`windows-latest` and `macos-latest` and `electron-rebuild` and `playwright` present, no dashes) - `CI_OK`.
- ci.yml YAML parse (PyYAML) - `YAML_PARSED_OK`; matrix os `[windows-latest, macos-latest]`, 7 steps, triggers push plus pull_request.

## Next Phase Readiness

- Phase 1 now has a complete automatable validation surface: SC1 (launch plus theme), SC2 (keychain round trip plus no-leak), SC3 (relaunch persistence), and SC4 (renderer isolation) all proven on the real running build, plus a cross-OS CI matrix. The remaining Phase 1 work is the 01-08 human cross-OS checkpoint (real Mac and Windows machines: native rebuild, keychain, visual brand fidelity).
- A material correctness fix landed: the packaged app's `window.api` now loads. Every Phase 2 to 8 renderer feature that reaches main through `window.api` depends on this, so the fix unblocks all downstream work as well as Phase 8 packaging.
- No blockers introduced.

## User Setup Required

None for this plan. The 01-08 checkpoint requires Anthony to run the full suite on his real Windows and Mac machines (commands above) and to confirm the keychain "unavailable" case on the Mac.

## Self-Check: PASSED

- All 5 created files plus the 1 modified file verified present on disk.
- All 3 task commits verified in git history: `a826b2b`, `06bf110`, `ac5ae8c`.

---
*Phase: 01-foundation*
*Completed: 2026-07-22*
