---
phase: 01-foundation
plan: 05
subsystem: ipc-handlers
tags: [electron, ipc, ipcMain, sender-validation, zod, safeStorage, sqlite, nativeTheme, security]

# Dependency graph
requires:
  - phase: 01-02
    provides: shared IPC contract (Channels) and Zod schemas (SettingsSetSchema, SettingsKeySchema, SecretSetSchema, SecretKeySchema)
  - phase: 01-04
    provides: getDatabase() SQLite singleton with migrate(db), and safeStorage secretStore.set/get/delete/available
  - phase: 01-01
    provides: hardened BrowserWindow bootstrap (sandbox, contextIsolation, nodeIntegration:false, navigation guards, single-instance lock)
provides:
  - "assertTrustedSender(event) gate rejecting any invoke not from the app's own renderer frame (src/main/ipc/trusted-sender.ts)"
  - "settings:get/set handlers over app_settings using prepared statements and an ON CONFLICT UPSERT"
  - "secrets:set/get/delete handlers delegating to secretStore, returning null when the store is unavailable"
  - "theme:get returning nativeTheme.shouldUseDarkColors plus a theme:changed broadcast on OS appearance changes"
  - "registerIpc() aggregator wired into the main bootstrap after app.whenReady() and window creation"
  - "Ready-time ordering: getDatabase()+migrate(db) before the window, registerIpc() after it"
affects: [01-06, phase-02, phase-03, phase-04]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Every ipcMain.handle runs assertTrustedSender(event) then Schema.parse(raw) before any privileged action (SC4/T-01-03)"
    - "Sender validation by frame-origin allowlist: file:// (packaged) or the exact ELECTRON_RENDERER_URL origin (dev)"
    - "Handlers reuse the single-sourced ipc-contract channel constants and shared Zod schemas, never redefining either"
    - "Graceful-null on secret-store unavailable instead of a raw stack trace to the renderer"

key-files:
  created:
    - src/main/ipc/trusted-sender.ts
    - src/main/ipc/settings.ts
    - src/main/ipc/secrets.ts
    - src/main/ipc/theme.ts
    - src/main/ipc/register.ts
  modified:
    - src/main/index.ts

key-decisions:
  - "assertTrustedSender validates the sender frame by origin: file:// is trusted (packaged loadFile), otherwise the frame origin must equal the ELECTRON_RENDERER_URL origin (dev); a missing or unparseable frame URL is rejected. This is the standard Electron sender-validation control adapted to a single-window app, without coupling the helper to a concrete window id"
  - "Placed assertTrustedSender in its own module (src/main/ipc/trusted-sender.ts) so all three handler groups share one gate; each handler file imports and calls it, keeping the T-01-03 control single-sourced"
  - "secrets handlers guard on secretStore.available() and return null when the OS keychain backend is unavailable, so the renderer never receives a raw SECRET_STORE_UNAVAILABLE stack trace (T-01-05 error-handling control)"
  - "Ready-time ordering: getDatabase()+migrate(db) run before createWindow() so app_settings exists before the renderer can call settings; registerIpc() runs after the window so safeStorage and handlers initialize post-ready (RESEARCH Pitfall 3). migrate(db) is called explicitly even though getDatabase migrates lazily, to make the ready-time schema guarantee unambiguous (idempotent no-op)"

requirements-completed: [PLAT-01, PLAT-02]

# Metrics
duration: 3min
completed: 2026-07-22
---

# Phase 01 Plan 05: Zod-Gated, Sender-Validated IPC Handlers Summary

**The renderer's window.api now reaches live main-process handlers: every settings, secrets, and theme invoke is sender-validated then Zod-parsed before it touches SQLite, safeStorage, or nativeTheme, and the OS dark preference broadcasts to the renderer. This closes the SC4 functional boundary and the PLAT-02 secret path.**

## Performance

- **Duration:** 3 min
- **Started:** 2026-07-22T20:50:00Z
- **Completed:** 2026-07-22T20:53:15Z
- **Tasks:** 2
- **Files:** 5 created, 1 modified

## Accomplishments

- Authored `assertTrustedSender(event)` (`src/main/ipc/trusted-sender.ts`): the T-01-03 tampering gate every handler runs before parsing a payload or acting. It rejects any invoke whose sender frame is missing, has an unparseable URL, or does not match the app's own renderer origin (file:// for the packaged loadFile build, or the exact `ELECTRON_RENDERER_URL` origin in dev).
- Implemented `settings:get`/`settings:set` (`src/main/ipc/settings.ts`): both validate the sender, Zod-parse with `SettingsKeySchema`/`SettingsSetSchema`, then read/write `app_settings` through prepared statements. `set` uses `INSERT ... ON CONFLICT(key) DO UPDATE SET value = excluded.value`; there is no string interpolation of key or value into SQL (T-01-06).
- Implemented `secrets:set`/`secrets:get`/`secrets:delete` (`src/main/ipc/secrets.ts`): sender-validated, Zod-parsed with `SecretSetSchema`/`SecretKeySchema`, delegating to `secretStore`. The module never references the SQLite handle (D-12) and never logs secret values (T-01-05); when `secretStore.available()` is false, each handler returns `null` rather than surfacing a raw stack trace to the renderer.
- Implemented `theme:get` plus the `theme:changed` broadcast (`src/main/ipc/theme.ts`): `theme:get` validates the sender then returns `nativeTheme.shouldUseDarkColors`; a `nativeTheme.on('updated')` subscription sends the new `isDark` boolean to every `BrowserWindow`, so the renderer follows OS appearance live.
- Aggregated registration behind `registerIpc()` (`src/main/ipc/register.ts`) and wired the main bootstrap (`src/main/index.ts`): inside `app.whenReady()`, `getDatabase()` + `migrate(db)` run before `createWindow()`, and `registerIpc()` runs after it. The hardened `webPreferences` (contextIsolation, sandbox, nodeIntegration:false, webSecurity), single-instance lock, and navigation guards from 01-01 are untouched.
- Every handler references the `ipc-contract` channel constants (`Channels.settingsGet`, etc.) and the shared Zod schemas verbatim; no channel name or schema is redefined, so the boundary stays single-sourced.

## Contract Reference (for 01-06)

Handlers now registered in main (all sender-validated + Zod-gated):

| Channel | Handler behavior | Return |
|---------|-----------------|--------|
| `settings:get` | `SettingsKeySchema.parse` then prepared SELECT | `string \| null` |
| `settings:set` | `SettingsSetSchema.parse` then UPSERT | `true` |
| `secrets:set` | `SecretSetSchema.parse` then `secretStore.set` | `null` |
| `secrets:get` | `SecretKeySchema.parse` then `secretStore.get` | `string \| null` |
| `secrets:delete` | `SecretKeySchema.parse` then `secretStore.delete` | `null` |
| `theme:get` | returns `nativeTheme.shouldUseDarkColors` | `boolean` |
| `theme:changed` | main-to-renderer broadcast of `isDark` on OS updates | (event) |

The boundary is live: `window.api.secrets.set('canary','ok')` then `.get('canary')` (01-06 HealthIndicator) now round-trips through real handlers, and `window.api.theme.get()` / `onChange` reflect the OS preference.

## Task Commits

Each task was committed atomically:

1. **Task 1: sender-validated, Zod-gated settings/secrets/theme handlers** - `af3a640` (feat)
2. **Task 2: aggregate IPC registration and wire into the main bootstrap** - `0306c93` (feat)

**Plan metadata:** committed separately with SUMMARY, STATE, ROADMAP, REQUIREMENTS.

## Files Created/Modified

- `src/main/ipc/trusted-sender.ts` (created) - `assertTrustedSender(event)`: frame-origin allowlist gate; the single-sourced T-01-03 control every handler runs first.
- `src/main/ipc/settings.ts` (created) - `registerSettingsIpc()`: `settings:get`/`settings:set` over `app_settings` with prepared statements and an ON CONFLICT UPSERT.
- `src/main/ipc/secrets.ts` (created) - `registerSecretsIpc()`: `secrets:set`/`get`/`delete` delegating to `secretStore`, graceful-null when unavailable, no SQLite coupling, no secret logging.
- `src/main/ipc/theme.ts` (created) - `registerThemeIpc()`: `theme:get` plus the `nativeTheme` -> `theme:changed` broadcast.
- `src/main/ipc/register.ts` (created) - `registerIpc()`: single aggregator invoking the three register functions.
- `src/main/index.ts` (modified) - ready path now opens the DB and runs `migrate(db)` before the window and calls `registerIpc()` after; hardened posture unchanged.

## Decisions Made

- Sender validation is by frame origin (file:// or the dev renderer origin) rather than a concrete window-id comparison, so the helper stays decoupled from window construction while still asserting a single trusted renderer; a missing or unparseable frame URL is rejected.
- The `assertTrustedSender` helper lives in its own module so all three handler groups share exactly one gate implementation (single-sourced security control).
- Secret handlers return `null` on `secretStore.available() === false` instead of letting `SECRET_STORE_UNAVAILABLE` propagate, keeping raw stack traces out of the renderer while preserving the safeStorage-only contract.
- `migrate(db)` is called explicitly in the ready path even though `getDatabase()` migrates lazily, to make the "schema present before the window loads" guarantee explicit; it is an idempotent no-op after the singleton's first open.

## Deviations from Plan

None - plan executed exactly as written. Both tasks are `type="auto"`; each was verified (build + source assertions + typecheck + full unit suite) before its atomic commit.

## Threat Model Compliance

- **T-01-03 (Tampering, handlers):** every `ipcMain.handle` calls `assertTrustedSender(event)` then `Schema.parse(raw)` before the privileged action. Verified: the Task 1 source assertion confirms no handler file contains `ipcMain.handle` without `assertTrustedSender`.
- **T-01-05 (Information Disclosure, secrets/settings):** no secret value is passed to any console/logger; the unavailable path returns `null`, not a stack trace.
- **T-01-06 (Tampering, settings SQL):** prepared statements with bound parameters and an ON CONFLICT UPSERT; no key/value interpolation into SQL.
- **T-01-01 (Elevation of Privilege, bootstrap):** the hardened window posture (sandbox:true et al.) is intact; safeStorage and handlers initialize only after `app.whenReady()`.

## Issues Encountered

None. Build, typecheck, and the full unit suite were green at each commit.

## Verification Results

- `npm run build` (electron-vite) - exit 0 (main, preload, renderer all built).
- Task 1 source assertion - `HANDLERS_OK` (no handler file has `ipcMain.handle` without `assertTrustedSender`; no em/en dashes present).
- Task 2 wiring assertion - `WIRING_OK` (index.ts contains `registerIpc`, `migrate`, and `sandbox: true`).
- `npm run typecheck` (`tsc --build`) - exit 0.
- `npx vitest run` - 36 tests passed across 4 files (no regression; the 01-02 and 01-04 suites remain green).

## Requirements

- **PLAT-02 (secrets in OS keychain, never in repo or logs):** the secrets channel now has live handlers routing exclusively through `secretStore` (safeStorage), never SQLite, never logs; the encrypted-at-rest path is functionally closed for the app.
- **PLAT-01 (runs on both Windows and Mac):** the IPC boundary is OS-agnostic (no platform-specific handler code); the cross-OS run remains the 01-07/01-08 gate.

## User Setup Required

None. No external service configuration in this plan (QuickBooks and AI credentials arrive in Phases 3 and 4).

## Next Phase Readiness

- 01-06 (renderer app shell + HealthIndicator) can mount against a live boundary: `window.api.secrets.set/get` round-trips through the real safeStorage handlers, and `window.api.theme.get()` / `onChange` follow the OS preference. Ready-time ordering is confirmed: migrations run before the window, and `registerIpc()` runs after it, so the handlers are live before the renderer's first meaningful paint.
- No blockers.

## Self-Check: PASSED

- All 6 plan files verified present on disk: trusted-sender.ts, settings.ts, secrets.ts, theme.ts, register.ts (created), and index.ts (modified) - all FOUND.
- Both task commits verified in git history: `af3a640`, `0306c93` - both FOUND.
- No unexpected file deletions in either commit; no untracked files left behind.

---
*Phase: 01-foundation*
*Completed: 2026-07-22*
