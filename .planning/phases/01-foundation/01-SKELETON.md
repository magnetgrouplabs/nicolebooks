# Walking Skeleton - NicoleBooks

**Phase:** 1
**Generated:** 2026-07-22

## Capability Proven End-to-End

A user launches NicoleBooks on Windows or Mac, sees the branded two-process shell (header wordmark, 280px sidebar with Bills/History/Settings, themed to the Magnet Group tokens and following the OS light/dark preference), opens Settings, and sees "Secret store: OK". That single health indicator drives a real round trip: renderer to contextBridge to IPC to main to `safeStorage.encryptString` to `secrets.enc` and back, which simultaneously proves the OS-keychain secret path (SC2) and the typed IPC trust boundary (SC4). A non-secret value written to `app_settings` and read back after an app restart proves local SQLite persistence and migrations (SC3).

## Architectural Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Shell framework | Electron 43.2.0 (main + preload + renderer split) | Locked in CLAUDE.md. Bundled Chromium gives identical render on Windows and Mac; the main process runs the full Node ecosystem (better-sqlite3, safeStorage) natively |
| Build tool | electron-vite 5.0.0 + Vite 8.1.5 | Standard modern Electron+Vite scaffold; one `electron.vite.config.ts` builds all three artifacts; native modules externalized on main, preload emitted as single bundled CJS (sandbox-safe) |
| UI | React 19.2.8 + Tailwind v4 (`@tailwindcss/vite`) + shadcn/ui (base-nova) | Locked. Tailwind v4 CSS-first `@theme` maps cleanly to the vendored Magnet Group tokens; shadcn copy-ins give accessible branded primitives |
| Data layer | better-sqlite3 13.0.1 at `app.getPath('userData')/app.db`; forward-only migrations keyed on `PRAGMA user_version` | Locked. Synchronous transactional API; hand-rolled ~30-line migration runner per Discretion note (no heavy migration dependency) |
| Secret storage | Electron `safeStorage` (OS Keychain / DPAPI); ciphertext in `userData/secrets.enc` with `0o600`; never in SQLite, never in logs | Locked (D-10, D-12). OS-backed key protection; keytar and electron-store are forbidden |
| IPC trust boundary | Single hardened BrowserWindow (`contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, `webSecurity: true`); preload exposes only named `settings` / `secrets` / `theme` methods via `contextBridge`; every handler validates sender and Zod-parses payloads | SC4. Renderer is untrusted; all privilege lives in main behind an allow-listed, runtime-validated boundary |
| Theme source | Vendored `tokens.json` (D-02) authored into renderer `globals.css`; light + dark palettes; OS-driven via `nativeTheme` mirrored to `documentElement.classList` | D-01, D-03. The sibling brand repo is not referenced at build time (absent on a clean machine / CI) |
| Directory layout | `src/main` (privileged), `src/preload` (bridge), `src/shared` (types only, imported by both), `src/renderer/src` (React). Feature tables added per-phase later (D-15) | Establishes the seam every later phase plugs into |
| Test harness | Vitest (main-process units) + Playwright `_electron` (launch / IPC / DB / keychain round trip); CI matrix windows + macos | Greenfield; the load-bearing cross-OS gate for PLAT-01 |

## Stack Touched in Phase 1

- [x] Project scaffold (electron-vite react-ts, Tailwind v4, TypeScript, lint config, Vitest + Playwright test runners)
- [x] Routing - the swappable content region switches between Bills / History / Settings placeholder screens
- [x] Database - real read AND write: `app_settings` UPSERT (write) and SELECT (read), plus a `user_version` migration on first run
- [x] UI - interactive element wired to the API: the Settings "Secret store" health indicator performs a real `window.api.secrets.set` then `.get` round trip on mount
- [x] Local full-stack run - `npm run dev` launches the hardened Electron window on the dev machine; `npx vitest run && npx playwright test` exercises the full stack; documented cross-OS run is the phase gate

## Out of Scope (Deferred to Later Slices)

These are explicitly NOT in the skeleton. This list prevents later phases from re-litigating Phase 1's minimalism.

- Any product feature (folder scan, dedupe, AI parse, QuickBooks connection, reconciliation, review table, posting, audit, undo, reporting) - Phases 2 through 8
- Feature tables (dedupe hashes, parsed-results cache, sent-transaction ledger, audit log) - each added by its owning phase via that phase's own migration (D-15)
- Real secrets (AI key, QuickBooks tokens) - only a non-sensitive canary value flows through the secret store in Phase 1 (D-11); the AI key lands in Phase 3, QuickBooks tokens in Phase 4, both reusing this exact store
- Real connection-status content in the header slot - Phase 1 shows a neutral "Not connected" placeholder; Phase 4 populates it (D-08)
- Packaging, code signing, notarization, and auto-update - Phase 8 (electron-builder / electron-updater are named in the stack for continuity only)
- In-app theme toggle - the window follows the OS preference only; no toggle in v1 (D-03)
- Any network access - Phase 1 loads local content only; navigation and `window.open` are denied

## Subsequent Slice Plan

Each later phase adds one vertical slice on top of this skeleton without altering its architectural decisions:

- Phase 2: User points the app at a date-named folder, triggers a manual scan, and sees non-duplicate bill files loaded (adds an ingestion migration + a Bills screen slice)
- Phase 3: User configures an OpenAI-compatible key/model in Settings (stored via this secret store) and the app parses a document into validated structured fields (adds a parsed-results migration)
- Phase 4: User connects to QuickBooks Online via guided OAuth (tokens stored via this secret store) and sees connection health in the header slot
- Phase 5: Parsed bills reconcile against cached QuickBooks reference data
- Phase 6: User reviews every parsed and reconciled bill in one editable table (built on this theme and IPC boundary)
- Phase 7: User posts an approved batch to the sandbox, sees an audit trail, and can undo the last batch (adds ledger + audit migrations)
- Phase 8: Production cutover behind the environment seam; signed, auto-updating installers
