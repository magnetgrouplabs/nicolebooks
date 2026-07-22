---
phase: 01-foundation
plan: 02
subsystem: ipc-boundary
tags: [electron, ipc, contextBridge, preload, sandbox, zod, typescript, ipc-security, vitest]

# Dependency graph
requires:
  - 01-01 hardened electron-vite scaffold (main/preload/renderer split, sandbox-safe preload target, zod dependency, vitest harness)
provides:
  - Shared IPC contract (src/shared/ipc-contract.ts): seven channel-name constants plus payload and return types for settings, secrets, theme; zero Electron or Node imports so both sides import it
  - Zod payload schemas (src/shared/schemas.ts): SettingsSetSchema, SettingsKeySchema, SecretSetSchema, SecretKeySchema with min/max length bounds
  - Sandbox-safe preload bridge (src/preload/index.ts): contextBridge exposes only named settings/secrets/theme methods, exports type Api = typeof api
  - Renderer Window augmentation (src/renderer/src/env.d.ts): window.api typed from the preload-exported Api
  - SC4 payload-validation unit suite (test/ipc-contract.test.ts): 23 accept/reject and channel-name-stability tests
affects: [01-05 Zod-gated IPC handlers, 01-06 renderer app shell and secret-store health round trip, all Phase 2-8 renderer-to-main calls]

# Tech tracking
tech-stack:
  added: []
  patterns: [typed IPC contract as single source of truth, sandbox-safe named-method contextBridge, Zod payload gate with length bounds, composite TS project reference for cross-process types]

key-files:
  created: [src/shared/ipc-contract.ts, src/shared/schemas.ts, src/renderer/src/env.d.ts, test/ipc-contract.test.ts]
  modified: [src/preload/index.ts, tsconfig.node.json, tsconfig.web.json]

key-decisions:
  - "Fixed a pre-existing project-wide typecheck breakage from 01-01: TypeScript 7.0.2 removed the baseUrl option, so tsc --build failed before any of this plan's work; migrated the path maps to relative form so the typed boundary this plan establishes is actually enforceable"
  - "Annotated the preload api object with the shared IpcApi interface (const api: IpcApi) so the exposed surface provably conforms to the contract, then re-exported export type Api = typeof api for the renderer, keeping a single source of truth"
  - "To let the renderer typecheck consume the preload type across the process split, added a web-to-node TS project reference and switched the node project to declaration-only emit into a gitignored temp dir (a referenced composite project may not disable emit)"
  - "Preload imports the contract by relative path (../shared/ipc-contract), not the @shared alias, because the preload vite/esbuild target has no alias configured and must bundle the contract into the single CJS artifact"
  - "PLAT-02 and PLAT-01 advanced, not completed: this plan defines the secrets channel and its schema (PLAT-02) and the SC4 typed boundary, but the working secret store (OS keychain) arrives in 01-04/01-05 and the cross-OS run is the 01-07/01-08 gate"

requirements-completed: []

# Metrics
duration: 9min
completed: 2026-07-22
---

# Phase 1 Plan 02: Typed IPC Trust Boundary Summary

**The entire IPC trust boundary defined once, interface-first: a shared channel contract and Zod payload schemas, a sandbox-safe preload that exposes only named window.api methods (never raw ipcRenderer), a renderer Window augmentation derived from the preload type, and a 23-test suite proving malformed payloads are rejected and channel names are pinned.**

## Performance

- **Duration:** 9 min
- **Started:** 2026-07-22T20:00:49Z
- **Completed:** 2026-07-22T20:10:03Z
- **Tasks:** 3
- **Files:** 4 created, 3 modified

## Accomplishments

- Established the SC4 boundary shape in one auditable place: `src/shared/ipc-contract.ts` declares the seven channel-name constants (settings:get, settings:set, secrets:set, secrets:get, secrets:delete, theme:get, theme:changed) plus the payload and return types for every method, with zero Electron or Node imports so both the sandboxed preload and the future main handlers import the same file.
- Bounded every IPC payload with Zod (`src/shared/schemas.ts`): SettingsSetSchema, SettingsKeySchema, SecretSetSchema, SecretKeySchema, with key min 1 max 128, settings value max 4096, secret value max 8192. These bounds are the T-01-03 tampering mitigation and will be parsed at the handler in 01-05.
- Authored the sandbox-safe preload bridge (`src/preload/index.ts`) using only electron built-ins plus the dependency-free contract: it exposes exactly the named settings/secrets/theme methods through contextBridge, never ipcRenderer and never a generic invoke (T-01-02 mitigation), and re-exports `type Api = typeof api`.
- Wired the renderer Window augmentation (`src/renderer/src/env.d.ts`) so `window.api` is typed from the preload-exported Api, giving the renderer full type-safety over the boundary without importing electron.
- Proved payload validation with a 23-test Vitest suite (`test/ipc-contract.test.ts`): every schema accepts a valid payload and rejects empty key, oversized key, oversized value, wrong type, and missing field; the seven channel constants are pinned against silent renames; split value ceilings (a 5000-char value is rejected by settings but accepted by secrets) ensure the .max() bounds are actually exercised.

## Task Commits

Each task was committed atomically:

1. **Task 1: Shared IPC contract and Zod schemas** - `4405440` (feat)
2. **Task 2: Sandbox-safe preload bridge and renderer Window augmentation** - `3cc9234` (feat)
3. **Task 3: IPC contract unit tests (SC4 payload validation)** - `9e0251e` (test)

**Supporting fix (deviation):** tsconfig baseUrl migration committed separately as `c28f03b` (chore).
**Plan metadata:** committed separately with SUMMARY, STATE, ROADMAP.

## Contract Reference (import these verbatim in 01-05 and 01-06)

Channel-name constants (`Channels` in `src/shared/ipc-contract.ts`):

| Constant | String value | Group |
|----------|--------------|-------|
| `Channels.settingsGet` | `settings:get` | settings |
| `Channels.settingsSet` | `settings:set` | settings |
| `Channels.secretsSet` | `secrets:set` | secrets |
| `Channels.secretsGet` | `secrets:get` | secrets |
| `Channels.secretsDelete` | `secrets:delete` | secrets |
| `Channels.themeGet` | `theme:get` | theme |
| `Channels.themeChanged` | `theme:changed` | theme (main-to-renderer broadcast) |

Zod schemas (`src/shared/schemas.ts`), to be parsed at each handler in 01-05:

| Schema | Shape | Bounds |
|--------|-------|--------|
| `SettingsSetSchema` | `{ key, value }` | key 1-128, value max 4096 |
| `SettingsKeySchema` | bare string | 1-128 |
| `SecretSetSchema` | `{ key, value }` | key 1-128, value max 8192 |
| `SecretKeySchema` | bare string | 1-128 |

Types (`src/shared/ipc-contract.ts`): `Api`, `SettingsApi`, `SecretsApi`, `ThemeApi`, `SettingsSetPayload`, `SecretSetPayload`, `ChannelName`. The preload re-exports `Api` (identical shape) for the renderer.

## Files Created/Modified

- `src/shared/ipc-contract.ts` (created) - Single source of truth for the boundary: `Channels` constants and per-method payload/return types. No runtime Electron or Node imports (imported by both the sandboxed preload and the main handlers).
- `src/shared/schemas.ts` (created) - Zod schemas gating each channel payload with min/max length bounds (the T-01-03 input-validation control).
- `src/renderer/src/env.d.ts` (created) - Augments `Window` with `api: Api` using the preload-exported type; includes the vite/client types reference.
- `test/ipc-contract.test.ts` (created) - 23 unit tests: per-schema accept/reject matrix, split value-ceiling checks, and channel-name stability.
- `src/preload/index.ts` (modified) - Replaced the 01-01 placeholder with the real sandbox-safe bridge: named settings/secrets/theme methods, `export type Api = typeof api`, no raw ipcRenderer or invoke exposed.
- `tsconfig.node.json` (modified) - Removed the removed `baseUrl` option and made paths relative; switched to `emitDeclarationOnly` with an `outDir` under `node_modules/.tmp` so it can be a valid reference target for the renderer project.
- `tsconfig.web.json` (modified) - Removed `baseUrl` and made paths relative; added a project reference to the node project so `env.d.ts` can consume the preload type under `tsc --build`.

## Decisions Made

- Kept the contract free of any Electron or Node import so the same file is safe to bundle into the sandboxed preload; the runtime concern (contextBridge/ipcRenderer) lives only in the preload.
- Annotated `const api: IpcApi` and then `export type Api = typeof api` so the exposed surface is checked against the shared contract at compile time while the renderer still derives its Window type from the preload.
- Chose declaration-only emit for the node TS project (into a gitignored temp dir) over restructuring the tsconfig split, because it is the standard way to make a composite project a valid reference target and keeps the app build (electron-vite) completely untouched.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Pre-existing project-wide typecheck was broken by TypeScript 7 removing baseUrl**
- **Found during:** Task 1 (verifying the shared files typecheck)
- **Issue:** `tsconfig.node.json` and `tsconfig.web.json` (authored in 01-01) set `baseUrl`, which TypeScript 7.0.2 removed. `tsc --build` (the project `typecheck` script) failed with TS5102/TS5090 before any of this plan's code, so the shared files could not be typechecked against the real project config, and Task 1's typecheck acceptance criterion was unverifiable.
- **Fix:** Removed `baseUrl` from both configs and made the `paths` values relative (`./src/...`) per the compiler guidance. This restores `tsc --build` (exit 0) and makes the typed boundary this plan establishes actually enforceable.
- **Files modified:** tsconfig.node.json, tsconfig.web.json
- **Verification:** `npx tsc --build` exits 0.
- **Committed in:** `c28f03b`

**2. [Rule 3 - Blocking] Renderer could not consume the preload type across the process split under tsc --build**
- **Found during:** Task 2 (env.d.ts importing the preload Api type)
- **Issue:** `env.d.ts` (web project) imports `Api` from `../../preload` (node project). Without a project reference, `tsc --build` raised TS6307 (the transitively imported `ipc-contract.ts` is not in the web project's file list); adding the reference then raised TS6310 (a referenced composite project may not disable emit).
- **Fix:** Added `references: [{ path: ./tsconfig.node.json }]` to `tsconfig.web.json` and switched the node project from `noEmit` to `emitDeclarationOnly` with `outDir: ./node_modules/.tmp/dts-node` (gitignored). The renderer now consumes the preload's declaration types cleanly. This preserves the plan's intended chain (env.d.ts derives from the preload-exported Api).
- **Files modified:** tsconfig.web.json, tsconfig.node.json
- **Verification:** `npx tsc --build` exits 0; the emitted declarations land only under `node_modules/.tmp` and are not tracked.
- **Committed in:** `3cc9234` (with Task 2)

---

**Total deviations:** 2 auto-fixed (both blocking, both TypeScript build-config issues). No scope creep and no weakening of the security posture: the preload still exposes only named methods, contextIsolation/sandbox/nodeIntegration remain as set in 01-01, and no secret material enters the contract layer (threat T-01-05: accept).

## Issues Encountered

- None beyond the two config deviations above. The build, typecheck, and unit suite are all green.

## Verification Results

- `npx tsc --build` - exit 0 (main, preload, shared, and renderer projects typecheck).
- `npm run build` (electron-vite) - exit 0; `out/preload/index.js` is a single CJS file (~3.3 kB) with exactly one `exposeInMainWorld` and no raw ipcRenderer or invoke on the exposed object.
- `npx vitest run` - 23 tests passed (1 file).
- Source grep gate: preload matches `exposeInMainWorld` and does not contain a bare `invoke:` on the exposed object.

## Requirements

- **PLAT-02 (secrets in OS keychain, never in repo or logs):** advanced, not completed. This plan defines the `secrets` channel group (set/get/delete), its Zod schemas, and the sandbox-safe bridge for it. The working secret store (safeStorage, OS keychain) and its Zod-gated handler arrive in 01-04 and 01-05, so PLAT-02 is intentionally not marked complete here.
- **PLAT-01 (runs on both Windows and Mac):** advanced only as part of the SC4 typed boundary; it is fully satisfied at the 01-07/01-08 cross-OS gate and is not marked complete here.

## User Setup Required

None. No external service configuration in this plan (QuickBooks and AI credentials arrive in Phases 3 and 4).

## Next Phase Readiness

- 01-05 (Zod-gated IPC handlers) can import `Channels` and the four schemas verbatim from `src/shared` and register `ipcMain.handle` for each channel, running `assertTrustedSender(event)` then `Schema.parse(raw)` before the privileged call.
- 01-06 (renderer app shell) can call `window.api.secrets.set('canary','ok')` then `.get('canary')` for the health round trip with full types, and subscribe to theme via `window.api.theme.onChange`.
- Carried note for downstream: the main-side handlers do not exist yet, so a live `window.api.*` call currently rejects (no registered handler). That is expected and lands in 01-05.

## Self-Check: PASSED

- All 5 plan files verified present on disk (src/shared/ipc-contract.ts, src/shared/schemas.ts, src/preload/index.ts, src/renderer/src/env.d.ts, test/ipc-contract.test.ts).
- All 4 commits verified in git history (c28f03b, 4405440, 3cc9234, 9e0251e).
