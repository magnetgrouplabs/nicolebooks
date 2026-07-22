# Phase 1: Foundation - Research

**Researched:** 2026-07-22
**Domain:** Cross-platform Electron desktop shell (main/renderer/preload split), hardened IPC boundary, local SQLite persistence with migrations, OS-keychain secret storage, Tailwind v4 brand theming
**Confidence:** HIGH (locked stack, versions verified against npm this session, integration patterns cited from official Electron and electron-vite docs)

> No em dashes or en dashes appear in this file. Plain hyphens only, per project rule.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- **D-01:** Canonical brand source is the Magnet Group W3C design-token file `tokens.json` (v2026.06.1). Its values are rendered into the app's Tailwind v4 `@theme`. The live website's `globals.css` is a secondary cross-check, not the source.
- **D-02:** Vendor a copy of `tokens.json` into the NicoleBooks repo during Phase 1 as the build-time source of truth (for example under `design/` or `src/renderer/brand/`). Do NOT reference the sibling `themagnetgroup` repo at build time: it will not exist on Anthony's Mac, on a clean machine, or in CI.
- **D-03:** Wire both light and dark palettes. The window follows the OS color-scheme preference (Electron `nativeTheme` plus `prefers-color-scheme`). No in-app theme toggle in v1.
- **D-04:** Fonts (Jost headings, DM Sans body) are bundled with the app and served locally. Never fetched from Google's CDN.
- **D-05:** Foreground text color normalizes to `#343434` (the TMG logo dark), per `tokens.json`, not the website's `#1d1d1f`.
- **D-06:** Plain "NicoleBooks" wordmark, no logo (BRAND-02). Semantic colors (success, warning, info) and chart colors are carried into the theme now for later reuse, even though nothing consumes them in Phase 1.
- **D-07:** Phase 1 renders a real, reusable app frame, not a splash: persistent branded header + persistent left navigation + swappable content region.
- **D-08:** The header carries the "NicoleBooks" wordmark and a connection-status slot. The slot shows a neutral placeholder in Phase 1; Phase 4 populates it.
- **D-09:** Navigation is a labeled left sidebar (280px width, structural radius 0), icon + text, three destinations: Bills, History, Settings. Each renders a placeholder empty-state screen in Phase 1.
- **D-10:** Build a keychain service backed by Electron `safeStorage`, exposed to the renderer through a typed `secrets` IPC channel (set / get / delete). Locked stack choice (not keytar, not electron-store).
- **D-11:** Prove the round-trip end-to-end in Phase 1 by storing and reading back a non-sensitive canary value through the real renderer to IPC to main to keychain path, surfaced as a permanent "Secret store: OK / unavailable" health indicator on the Settings screen. Permanent, not throwaway, and doubles as the Success-Criteria-4 IPC-boundary proof.
- **D-12:** The `safeStorage` ciphertext blob is persisted in a dedicated app-data file under the OS userData directory (for example `secrets.enc`). No secret material, not even OS-encrypted ciphertext, is ever written to the SQLite database.
- **D-13:** Phase 1 establishes the migration mechanism plus only the minimal schema it needs: a schema-version table and a small non-secret `app_settings` key-value table.
- **D-14:** The "data survives a restart" criterion (SC3) is demonstrated by writing to and reading back from `app_settings` across an app restart.
- **D-15:** Feature tables (dedupe hashes, parsed-results cache, sent-transaction ledger, audit log) are NOT created in Phase 1. Each is added by its owning phase via that phase's own migration.

### Claude's Discretion
Standard approaches expected; research and planning may decide:
- Migration engine mechanics: default to forward-only, `user_version`-pragma-based, hand-rolled against better-sqlite3 (no heavy migration dependency) unless research surfaces a strong reason otherwise.
- Exact IPC channel naming and organization conventions.
- Window default size, minimum size, and single-instance-lock behavior.
- The Windows + Mac dev and build scaffolding via electron-vite (packaging and signing are Phase 8, not here).
- The testing approach that proves the app launches and the keychain round-trips on both Windows and Mac.

### Deferred Ideas (OUT OF SCOPE)
None. The discussion stayed within Phase 1 scope; no new capabilities or cross-phase ideas surfaced.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| BRAND-01 | App is styled with the Magnet Group brand tokens (colors and typography) | Tailwind v4 `@theme` wiring from vendored `tokens.json` (see Pattern 5); light + dark palettes wired; locally bundled Jost + DM Sans |
| BRAND-02 | App displays a plain "NicoleBooks" wordmark and uses no logo | Header composition (Pattern 4); copy contract already locked in UI-SPEC; wordmark is Jost 20px 600 text, no image asset |
| PLAT-01 | App runs on both Windows and Mac | electron-vite scaffold (Pattern 1); Electron 43 bundled Chromium gives identical render; native module rebuild handled per Pitfall 1; cross-platform proof approach in Validation Architecture |
| PLAT-02 | All secrets stored in the OS keychain, never committed to the repo or written to logs | safeStorage service in main process (Pattern 3), ciphertext persisted to `secrets.enc` under userData (D-12), typed `secrets` IPC channel, health-check round trip (D-11) |
</phase_requirements>

## Summary

Phase 1 is a Walking Skeleton for a financial desktop tool. Every load-bearing decision is already locked in CLAUDE.md and CONTEXT.md, so this research is about the correct wiring of a known stack, not the selection of one. The genuinely non-trivial work is four seams: (1) an electron-vite scaffold that produces a hardened three-artifact build (main, preload, renderer) and runs identically on Windows and Mac, (2) a typed IPC trust boundary where the renderer is fully sandboxed and can touch nothing except a narrow `contextBridge` API, (3) a `better-sqlite3` connection plus a hand-rolled forward-only migration runner keyed on the SQLite `user_version` pragma, and (4) a `safeStorage` secret service whose ciphertext lands in a dedicated file under `userData`, never in SQLite.

The two biggest execution risks are both known and preventable. First, `better-sqlite3` is a native C++ addon whose `install` script is `node-gyp rebuild`; it must be rebuilt against Electron 43's ABI (via `@electron/rebuild`) or the app crashes on first `require` with a `NODE_MODULE_VERSION` mismatch. On this machine MSVC is not on PATH and Python is 3.14 (very new for node-gyp), so if a matching prebuild is not downloaded the source compile can fail. Second, with `sandbox: true` (the correct, secure default) a preload script cannot `require` npm modules or split into multiple CommonJS files; electron-vite must emit the preload as a single bundled CJS artifact. Getting either of these wrong produces a shell that launches on the builder's machine but fails on a clean Mac or in CI.

**Primary recommendation:** Scaffold with `electron-vite` (main + preload + renderer). Lock `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, `webSecurity: true` on the single BrowserWindow. Confine all filesystem, SQLite, keychain, and (future) network access to the main process behind `ipcMain.handle` handlers that Zod-validate every payload. Expose exactly three typed channel groups from a minimal bundled-CJS preload: `settings` (SQLite app_settings get/set), `secrets` (safeStorage set/get/delete), and `theme` (nativeTheme read). Drive the whole vertical slice through the Settings "Secret store: OK" health check, which is simultaneously the SC2 keychain proof and the SC4 IPC-boundary proof.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| App frame / branded UI (header, sidebar, content) | Renderer (React) | Preload (typed API surface) | UI is React in the sandboxed Chromium renderer; it never touches the OS directly |
| Brand theme (Tailwind v4 `@theme`, fonts) | Renderer | Build (vendored tokens.json) | CSS + fonts are renderer assets bundled by Vite |
| OS color-scheme detection (light/dark) | Main (`nativeTheme`) | Renderer (`prefers-color-scheme` mirror) | `nativeTheme.shouldUseDarkColors` is authoritative; the renderer reflects it and can also read the media query as a fallback |
| IPC trust boundary | Preload (`contextBridge`) | Main (`ipcMain.handle`) | Preload is the only bridge; main owns every privileged handler |
| Secret storage (safeStorage) | Main | Preload (`secrets` channel) | `safeStorage` is a main-process-only API backed by OS Keychain/DPAPI |
| Secret persistence file (`secrets.enc`) | Main (fs under userData) | none | Ciphertext blob written by main only; never in the renderer, never in SQLite |
| SQLite connection + queries | Main (`better-sqlite3`) | Preload (`settings` channel) | Native addon runs only in the non-sandboxed main process |
| Migration runner (`user_version`) | Main | none | Schema evolution is a main-process startup concern |
| Window lifecycle, single-instance lock, app paths | Main | none | Electron `app`/`BrowserWindow` live in main |
| Product business logic | none (Phase 1) | none | Phase 1 ships seams only; no features |

## Standard Stack

All versions verified via `npm view <pkg> version` on 2026-07-22 and passed `slopcheck --ecosystem npm` [OK] (18/18). Package names are the locked CLAUDE.md stack.

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| electron | 43.2.0 | Desktop shell (Chromium + Node) | Locked. Bundled Chromium = identical render on Win/Mac; main process runs the full Node ecosystem `[VERIFIED: npm registry]` |
| electron-vite | 5.0.0 | Build tool for main/preload/renderer split | Standard modern Electron+Vite scaffold; unified `electron.vite.config.ts`; HMR for renderer, hot reload for main/preload. Requires Node 20.19+/22.12+ and Vite 5.0+ `[VERIFIED: npm registry]` `[CITED: electron-vite.org/guide]` |
| vite | 8.1.5 | Renderer bundler + dev server | Locked; paired with electron-vite `[VERIFIED: npm registry]` |
| @vitejs/plugin-react | 6.0.4 | React fast-refresh + JSX transform for the renderer | Standard React+Vite plugin `[VERIFIED: npm registry]` |
| react + react-dom | 19.2.8 | Renderer UI framework | Locked `[VERIFIED: npm registry]` |
| typescript | 7.0.2 | Language across main/preload/renderer | Locked; type-safety across the IPC boundary is high value `[VERIFIED: npm registry]` |
| tailwindcss | 4.3.3 | CSS-first styling + design tokens | Locked; v4 `@theme` maps cleanly to brand tokens `[VERIFIED: npm registry]` |
| @tailwindcss/vite | 4.3.3 | First-party Tailwind v4 Vite plugin (no PostCSS config) | v4 ships as a Vite plugin; no `tailwind.config.js` needed `[VERIFIED: npm registry]` `[CITED: WebSearch, cross-checked to tailwindcss.com v4 docs]` |
| better-sqlite3 | 13.0.1 | Local SQLite (app_settings, schema_version) | Locked; synchronous, fastest, most ergonomic SQLite API. Native C++ addon (see Pitfall 1). `install` script is `node-gyp rebuild` `[VERIFIED: npm registry]` |
| zod | 4.4.3 | IPC payload validation at the main-process boundary | Locked; validates every inbound IPC argument before a privileged handler runs `[VERIFIED: npm registry]` |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| lucide-react | 1.25.0 | Icon set (Receipt, History, Settings, ShieldCheck, ShieldAlert, Circle) | Nav + health indicator icons; matches reference `components.json` `iconLibrary: lucide` `[VERIFIED: npm registry]` |
| shadcn (CLI) | 4.14.0 | Copy-in accessible components (button, badge, separator, tooltip) | Run `npx shadcn init` once during Phase 1; add the conservative set named in UI-SPEC `[VERIFIED: npm registry]` |
| @radix-ui/react-slot | 1.3.0 | Primitive pulled in by shadcn button | Transitive; added by shadcn `[VERIFIED: npm registry]` |
| class-variance-authority | 0.7.1 | Variant helper used by shadcn components | Transitive; added by shadcn `[VERIFIED: npm registry]` |
| clsx | 2.1.1 | className join helper (`cn` util) | shadcn `lib/utils` `[VERIFIED: npm registry]` |
| tailwind-merge | 3.6.0 | Tailwind class-conflict resolver (`cn` util) | shadcn `lib/utils` `[VERIFIED: npm registry]` |
| tw-animate-css | 1.4.0 | Tailwind v4 animation utilities (replaces `tailwindcss-animate`) | Imported in `globals.css` like the reference site; optional in Phase 1 (motion is minimal) `[VERIFIED: npm registry]` |
| @types/better-sqlite3 | 7.6.13 | Types for better-sqlite3 | devDependency `[VERIFIED: npm registry]` |
| @types/react / @types/react-dom | 19.2.17 / 19.2.3 | React types | devDependency `[VERIFIED: npm registry]` |
| @types/node | 26.1.1 | Node types for main/preload | devDependency `[VERIFIED: npm registry]` |

### Development Tools (Phase 1 relevant)
| Tool | Version | Purpose | Notes |
|------|---------|---------|-------|
| @electron/rebuild | 4.2.0 | Rebuild native modules against Electron's ABI | REQUIRED in Phase 1 dev so `better-sqlite3` matches Electron 43's ABI. Run after install (a `postinstall` or explicit `rebuild` script) `[VERIFIED: npm registry]` |
| electron-builder | 26.15.3 | Packaging + `install-app-deps` (auto-rebuild) | Named for completeness only. Packaging, signing, notarization are **Phase 8, NOT Phase 1**. Phase 1 uses `@electron/rebuild` directly for the dev binary `[VERIFIED: npm registry]` |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Hand-rolled `user_version` migration runner | umzug / a migration library | Locked to hand-rolled per Discretion note; a library adds a dependency for a runner that is ~30 lines. Only revisit if migrations grow complex (they will not in Phase 1) |
| @electron/rebuild in Phase 1 | electron-builder `install-app-deps` | `install-app-deps` also rebuilds, but it is a packaging tool. For dev-only Phase 1, `@electron/rebuild` (or the `electron-rebuild` bin) is the lighter, correct choice; electron-builder arrives in Phase 8 |
| better-sqlite3 | node:sqlite (Node built-in) | Would drop the native rebuild entirely, but CLAUDE.md locks better-sqlite3 (sharp already ships as a native module in later phases, so the rebuild step exists regardless) |

**Installation (Phase 1):**
```bash
# Scaffold: electron-vite gives the main/preload/renderer split.
npm create @quick-start/electron@latest nicolebooks -- --template react-ts

# Renderer UI layer (Tailwind v4 is a Vite plugin, no PostCSS config)
npm install tailwindcss @tailwindcss/vite
npm install lucide-react clsx tailwind-merge class-variance-authority tw-animate-css

# Backend capabilities (main process)
npm install better-sqlite3 zod
npm install -D @types/better-sqlite3 @electron/rebuild

# shadcn init + conservative component set (run during execution)
npx shadcn@latest init
npx shadcn@latest add button badge separator tooltip

# Align the native module with Electron's ABI (see Pitfall 1)
npx electron-rebuild -f -w better-sqlite3
```

**Version verification note:** All versions above were confirmed against the npm registry on 2026-07-22. Electron `latest` dist-tag = 43.2.0 (matches CLAUDE.md). electron-vite latest = 5.0.0 (a major bump past the 2.x referenced in older guides; its config API `defineConfig` + `externalizeDepsPlugin` is unchanged). lucide-react is legitimately at 1.x now (latest dist-tag 1.25.0, package created 2020).

## Package Legitimacy Audit

Run 2026-07-22 with `slopcheck 0.6.1` against the **npm** registry (the default PyPI run was a false-positive cross-ecosystem SLOP wall and was corrected with `-e npm`). All packages are the locked CLAUDE.md stack, cross-checked against official docs.

| Package | Registry | slopcheck (npm) | Source Repo | Disposition |
|---------|----------|-----------------|-------------|-------------|
| electron | npm | [OK] | github.com/electron/electron | Approved |
| electron-vite | npm | [OK] | github.com/alex8088/electron-vite | Approved |
| vite | npm | [OK] | github.com/vitejs/vite | Approved |
| @vitejs/plugin-react | npm | [OK] | github.com/vitejs/vite-plugin-react | Approved |
| react / react-dom | npm | [OK] | github.com/facebook/react | Approved |
| typescript | npm | [OK] | github.com/microsoft/TypeScript | Approved |
| tailwindcss | npm | [OK] | github.com/tailwindlabs/tailwindcss | Approved |
| @tailwindcss/vite | npm | [OK] | github.com/tailwindlabs/tailwindcss | Approved |
| better-sqlite3 | npm | [OK] | github.com/WiseLibs/better-sqlite3 | Approved (native addon, see Pitfall 1) |
| zod | npm | [OK] | github.com/colinhacks/zod | Approved |
| lucide-react | npm | [OK] | github.com/lucide-icons/lucide | Approved |
| shadcn | npm | [OK] | github.com/shadcn-ui/ui | Approved |
| @radix-ui/react-slot | npm | [OK] | github.com/radix-ui/primitives | Approved |
| class-variance-authority | npm | [OK] | github.com/joe-bell/cva | Approved |
| clsx | npm | [OK] | github.com/lukeed/clsx | Approved |
| tailwind-merge | npm | [OK] | github.com/dcastil/tailwind-merge | Approved |
| tw-animate-css | npm | [OK] | github.com/Wombosvideo/tw-animate-css | Approved |

**Packages removed due to slopcheck [SLOP] verdict:** none (the PyPI-default run flagged all npm packages as "not on PyPI"; this is expected cross-ecosystem behavior, not a real SLOP signal. The `-e npm` run returned 18/18 OK).
**Packages flagged as suspicious [SUS]:** none.

**Postinstall caution:** `better-sqlite3` runs a native build on install (`install: node-gyp rebuild`). This is legitimate and expected for a C++ addon, not a supply-chain red flag, but it is why the Environment Availability toolchain (compiler + Python) matters.

## Architecture Patterns

### System Architecture Diagram (Phase 1 vertical slice: the "Secret store: OK" round trip)

```
                         RENDERER PROCESS (sandboxed Chromium, React)
   +-------------------------------------------------------------------------+
   |  App frame: <Header> <Sidebar> <ContentRegion>                          |
   |                                                                         |
   |  Settings screen mounts -> calls window.api.secrets.set('canary', 'ok') |
   |                             then window.api.secrets.get('canary')       |
   |                             then window.api.theme.get()                 |
   |                                                                         |
   |  window.api  (the ONLY bridge; no fs/db/keychain/net reachable here)    |
   +----------------------------------|--------------------------------------+
                                      |  contextBridge  (typed, allow-listed)
                                      v
                         PRELOAD SCRIPT (bundled CJS, sandbox-safe)
   +-------------------------------------------------------------------------+
   |  contextBridge.exposeInMainWorld('api', {                              |
   |    settings: { get, set },                                             |
   |    secrets:  { set, get, delete },                                     |
   |    theme:    { get, onChange },                                        |
   |  })  ->  each method is a thin ipcRenderer.invoke('<channel>', payload)|
   +----------------------------------|--------------------------------------+
                                      |  IPC (ipcRenderer.invoke <-> ipcMain.handle)
                                      v
                              MAIN PROCESS (Node, privileged)
   +-------------------------------------------------------------------------+
   |  ipcMain.handle('secrets:set', (e, raw) => {                           |
   |     assertSender(e);            // validate sender (security checklist) |
   |     const {key,value} = SecretSetSchema.parse(raw);   // Zod gate      |
   |     return secretStore.set(key, value);                                |
   |  })                                                                     |
   |                                                                         |
   |   +-----------------+   +------------------+   +----------------------+ |
   |   | SecretStore     |   | Db (better-sql3) |   | nativeTheme          | |
   |   | safeStorage     |   | userData/app.db  |   | shouldUseDarkColors  | |
   |   | encryptString   |   | migrations via   |   | 'updated' event ->   | |
   |   | -> secrets.enc  |   | user_version     |   | broadcast to render  | |
   |   +--------|--------+   +---------|--------+   +----------------------+ |
   +------------|---------------------|--------------------------------------+
                v                     v
        OS Keychain / DPAPI    userData/app.db (SQLite file)
        (via secrets.enc       app_settings + schema_version tables
         ciphertext file)      NO secret material ever written here
```

Data flow for the health check (SC2 + SC4 proof): Settings mounts, calls `window.api.secrets.set` then `.get`, which cross the contextBridge, ride `ipcRenderer.invoke`, hit a Zod-gated `ipcMain.handle` in main, run through `safeStorage.encryptString`, land ciphertext in `secrets.enc`, read back, decrypt, and return `"ok"`. If any step fails or `safeStorage.isEncryptionAvailable()` is false, the indicator renders "Secret store: unavailable".

### Recommended Project Structure
```
nicolebooks/
├── electron.vite.config.ts        # main + preload + renderer build config
├── package.json                    # better-sqlite3 in dependencies; rebuild script
├── tsconfig.json / tsconfig.node.json / tsconfig.web.json
├── components.json                 # shadcn config (rsc:false, css -> renderer globals.css)
├── design/
│   └── tokens.json                 # vendored copy of Magnet Group tokens (D-02)
├── src/
│   ├── main/                       # MAIN PROCESS (privileged; Node)
│   │   ├── index.ts                # app lifecycle, single-instance lock, window
│   │   ├── ipc/                    # ipcMain.handle registrations, one file per channel group
│   │   │   ├── settings.ts
│   │   │   ├── secrets.ts
│   │   │   └── theme.ts
│   │   ├── db/
│   │   │   ├── connection.ts       # better-sqlite3 open at userData/app.db
│   │   │   ├── migrate.ts          # forward-only user_version runner
│   │   │   └── migrations/         # 0001_init.ts (schema_version + app_settings)
│   │   └── secrets/
│   │       └── secret-store.ts     # safeStorage + secrets.enc file I/O
│   ├── preload/
│   │   └── index.ts                # contextBridge exposeInMainWorld('api', ...)
│   ├── shared/                     # IMPORTED BY BOTH SIDES: types only, no runtime
│   │   ├── ipc-contract.ts         # channel names + payload/return TS types
│   │   └── schemas.ts              # Zod schemas (used by main; types inferred for shared)
│   └── renderer/
│       ├── index.html
│       ├── src/
│       │   ├── main.tsx
│       │   ├── App.tsx             # shell: Header + Sidebar + ContentRegion
│       │   ├── globals.css         # @import tailwindcss; @theme inline; :root tokens
│       │   ├── brand/fonts/        # Jost + DM Sans woff2, bundled locally (D-04)
│       │   ├── components/         # Header, Sidebar, EmptyState, HealthIndicator
│       │   ├── components/ui/      # shadcn copy-ins (button, badge, separator, tooltip)
│       │   ├── screens/            # BillsScreen, HistoryScreen, SettingsScreen
│       │   └── lib/utils.ts        # cn() helper
│       └── env.d.ts                # augments Window with the api type from ipc-contract
```

### Pattern 1: electron-vite three-artifact config
**What:** One config file builds three targets. Main and preload externalize their `dependencies`; the renderer runs React + Tailwind.
**When to use:** The scaffold. Everything else hangs off this.
**Example:**
```typescript
// electron.vite.config.ts
// Source: electron-vite.org/guide + tailwind v4 renderer setup (WebSearch, cross-checked)
import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  main: {
    // Externalize native/npm deps so better-sqlite3 is NOT bundled (it cannot be).
    plugins: [externalizeDepsPlugin()],
  },
  preload: {
    // Preload runs under sandbox: it must be a single bundled CJS file.
    // Do NOT externalize deps here; keep the preload minimal (electron built-ins only).
    build: { rollupOptions: { output: { format: 'cjs' } } },
  },
  renderer: {
    resolve: { alias: { '@': resolve('src/renderer/src'), '@shared': resolve('src/shared') } },
    plugins: [react(), tailwindcss()],
  },
})
```
Note: `better-sqlite3` must be listed in `dependencies` (not `devDependencies`) so packaging keeps it and `externalizeDepsPlugin` leaves it external. `[CITED: electron-vite.org/guide/dependency-handling]`

### Pattern 2: Hardened BrowserWindow + typed IPC boundary
**What:** A single window with the full security posture on, plus the invoke/handle + contextBridge pattern.
**When to use:** The core of SC4. Every privileged action routes through here.
**Example:**
```typescript
// src/main/index.ts (window creation excerpt)
// Source: electronjs.org/docs/latest/tutorial/security + context-isolation
const win = new BrowserWindow({
  width: 1200, height: 800, minWidth: 940, minHeight: 600,   // Discretion: defaults
  show: false,
  webPreferences: {
    preload: join(__dirname, '../preload/index.js'),
    contextIsolation: true,   // default v12+, keep explicit
    sandbox: true,            // default v20+, keep explicit
    nodeIntegration: false,   // never true
    webSecurity: true,        // keep same-origin protections
  },
})
win.once('ready-to-show', () => win.show())
// Block all in-app navigation and new windows (nothing external in Phase 1):
win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
win.webContents.on('will-navigate', (e) => e.preventDefault())
```
```typescript
// src/preload/index.ts  (minimal, sandbox-safe: only electron built-ins)
import { contextBridge, ipcRenderer } from 'electron'
const api = {
  settings: {
    get: (key: string) => ipcRenderer.invoke('settings:get', key),
    set: (key: string, value: string) => ipcRenderer.invoke('settings:set', { key, value }),
  },
  secrets: {
    set: (key: string, value: string) => ipcRenderer.invoke('secrets:set', { key, value }),
    get: (key: string) => ipcRenderer.invoke('secrets:get', key),
    delete: (key: string) => ipcRenderer.invoke('secrets:delete', key),
  },
  theme: {
    get: () => ipcRenderer.invoke('theme:get'),
    onChange: (cb: (isDark: boolean) => void) => {
      const listener = (_: unknown, isDark: boolean) => cb(isDark)
      ipcRenderer.on('theme:changed', listener)
      return () => ipcRenderer.removeListener('theme:changed', listener)
    },
  },
}
contextBridge.exposeInMainWorld('api', api)
export type Api = typeof api   // shared type for the renderer's Window augmentation
```
```typescript
// src/main/ipc/secrets.ts  (main-side handler: validate sender, Zod-gate payload)
import { ipcMain } from 'electron'
import { z } from 'zod'
import { secretStore } from '../secrets/secret-store'

const SetSchema = z.object({ key: z.string().min(1).max(128), value: z.string().max(8192) })

export function registerSecretIpc() {
  ipcMain.handle('secrets:set', (event, raw) => {
    assertTrustedSender(event)                 // security checklist item 5
    const { key, value } = SetSchema.parse(raw)  // throws -> rejected Promise in renderer
    return secretStore.set(key, value)
  })
  ipcMain.handle('secrets:get', (event, raw) => {
    assertTrustedSender(event)
    const key = z.string().min(1).parse(raw)
    return secretStore.get(key)
  })
  ipcMain.handle('secrets:delete', (event, raw) => {
    assertTrustedSender(event)
    return secretStore.delete(z.string().min(1).parse(raw))
  })
}
```
The renderer never imports `ipcRenderer`; it only sees `window.api`. `[CITED: electronjs.org/docs/latest/tutorial/ipc, context-isolation, security]`

### Pattern 3: safeStorage secret service persisting to secrets.enc
**What:** A main-process store that encrypts with the OS keychain and writes ciphertext to a file under `userData`, never to SQLite.
**When to use:** Every secret in the app (Phase 3 AI key, Phase 4 QuickBooks tokens) will use this exact service.
**Example:**
```typescript
// src/main/secrets/secret-store.ts
// Source: electronjs.org/docs/latest/api/safe-storage
import { app, safeStorage } from 'electron'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const FILE = () => join(app.getPath('userData'), 'secrets.enc')

// In-file shape: { [key]: base64(ciphertext) }. Only ever holds encrypted blobs.
function readAll(): Record<string, string> {
  if (!existsSync(FILE())) return {}
  return JSON.parse(readFileSync(FILE(), 'utf8'))
}
function writeAll(map: Record<string, string>) {
  writeFileSync(FILE(), JSON.stringify(map), { mode: 0o600 })   // owner-only
}

export const secretStore = {
  available(): boolean {
    // Must be called after app 'ready'. macOS Keychain / Windows DPAPI back this.
    return safeStorage.isEncryptionAvailable()
  },
  set(key: string, value: string): void {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('SECRET_STORE_UNAVAILABLE')
    const map = readAll()
    map[key] = safeStorage.encryptString(value).toString('base64')
    writeAll(map)
  },
  get(key: string): string | null {
    const raw = readAll()[key]
    if (!raw) return null
    return safeStorage.decryptString(Buffer.from(raw, 'base64'))
  },
  delete(key: string): void {
    const map = readAll(); delete map[key]; writeAll(map)
  },
}
```
Notes: `safeStorage` must be used after the `ready` event. On macOS it uses Keychain (keys protected per-app); on Windows it uses DPAPI (protected from other users, not other apps in the same userspace). A newer async variant exists (`encryptStringAsync` / `decryptStringAsync`, the latter returning `{ result, shouldReEncrypt }`); the synchronous API is fine for the tiny Phase 1 canary. `[CITED: electronjs.org/docs/latest/api/safe-storage]`

### Pattern 4: App shell composition (branded frame, no logo)
**What:** A CSS grid shell: 56px header row, then a 280px sidebar column beside the swappable content region. Values come verbatim from `tokens.json` via the UI-SPEC.
**When to use:** The persistent frame all later screens mount into (D-07).
**Structure:** `grid-template-rows: 56px 1fr; grid-template-columns: 280px 1fr;` with the header spanning both columns (`elevation.nav` = z-index 20, structural radius 0). Header left = "NicoleBooks" wordmark (Jost 20px 600, plain text, no image). Header right = connection-status slot (neutral gray dot + "Not connected"). Sidebar = three `Receipt`/`History`/`Settings` nav items; active item gets violet text + a violet left-edge indicator bar and the focus ring token. Content region = 24px padding, dominant surface background, renders the active screen's centered empty state. All copy is already locked in the UI-SPEC Copywriting Contract.

### Pattern 5: Tailwind v4 @theme wiring from vendored tokens
**What:** Render `tokens.json` values into a renderer `globals.css` using v4's `@theme inline` + `:root`/`.dark` variable blocks, adapted from the reference `themagnetgroup_website/src/app/globals.css`.
**When to use:** BRAND-01. This is the theme seam all UI phases consume.
**Key adaptations for the Electron renderer (vs the Next.js reference):**
- Reference uses `@import "shadcn/tailwind.css"`; for a Vite renderer keep `@import "tailwindcss";` + `@import "tw-animate-css";` and the shadcn base layer that `npx shadcn init` writes.
- Normalize `--foreground` to `#343434` (D-05), NOT the site's `#1d1d1f`. Normalize `--muted-foreground` to `#6e6e73` (canonical), not the site's `#48484a`.
- Add a full `.dark { ... }` block from the tokens `dark.*` values (the reference file only defines `:root`; NicoleBooks must wire both palettes per D-03). Dark ring = `#8f33ff`.
- Fonts: `@font-face` blocks pointing at locally bundled `brand/fonts/*.woff2` (Jost, DM Sans). Never a Google Fonts `@import` or `<link>` (D-04). Set `--font-heading: 'Jost', ...` and `--font-sans: 'DM Sans', ...` to the token family strings.
- Add `@custom-variant dark (&:is(.dark *));` (as the reference does) and toggle `document.documentElement.classList` with `dark` from the renderer based on `window.api.theme.get()` / `onChange`, which mirrors main's `nativeTheme.shouldUseDarkColors`.
- Structural radius: sidebar/header/panels use radius 0; the shadcn `--radius` still drives cards (14px), inputs (7px), etc. per `radiusUsage`.

**shadcn config (`components.json`) deltas from the reference:** set `"rsc": false` (Vite renderer, not React Server Components), point `"tailwind.css"` at the renderer `globals.css`, keep `"style": "base-nova"`, `"baseColor": "neutral"`, `"cssVariables": true`, `"iconLibrary": "lucide"`, `"registries": {}`. Aliases must resolve through the renderer's Vite alias + tsconfig `paths` (`@/components`, `@/lib/utils`, etc.).

### Pattern 6: Forward-only migration runner (user_version pragma)
**What:** On startup, read `PRAGMA user_version`, apply each migration whose index is greater, in a transaction, then bump the pragma.
**When to use:** D-13/D-15. Phase 1 ships migration 0001 (schema_version + app_settings). Later phases append 0002, 0003, ...
**Example:**
```typescript
// src/main/db/migrate.ts
// Source: SQLite user_version pragma + better-sqlite3 transaction API (ASSUMED from training,
// verified against better-sqlite3 README transaction() semantics)
import type Database from 'better-sqlite3'

type Migration = { version: number; up: (db: Database.Database) => void }

const migrations: Migration[] = [
  {
    version: 1,
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS app_settings (
          key   TEXT PRIMARY KEY,
          value TEXT NOT NULL
        ) STRICT;
      `)
      // schema_version is tracked by PRAGMA user_version; a mirror table is optional.
    },
  },
]

export function migrate(db: Database.Database) {
  const current = db.pragma('user_version', { simple: true }) as number
  const pending = migrations.filter((m) => m.version > current).sort((a, b) => a.version - b.version)
  const run = db.transaction((list: Migration[]) => {
    for (const m of list) {
      m.up(db)
      db.pragma(`user_version = ${m.version}`)   // pragma value cannot be a bound param
    }
  })
  run(pending)
}
```
`app_settings` is a plain key-value table (window size/position, last-scanned-folder, and so on). NO secret material lands here (D-12). Use parameterized statements everywhere except the `user_version` pragma, whose value is an integer sourced only from the code-controlled migration list (see Security Domain). `[ASSUMED: standard SQLite/better-sqlite3 pattern]`

### Anti-Patterns to Avoid
- **Exposing `ipcRenderer` (or the whole `ipcRenderer.invoke`) through contextBridge.** Gives any renderer code arbitrary IPC. Expose only named, purpose-built methods. `[CITED: electronjs.org security]`
- **Importing npm modules in the preload while `sandbox: true`.** The preload cannot `require` npm packages; it must be a single bundled CJS file using only electron built-ins. `[CITED: WebSearch: electron-vite discussion #423]`
- **Bundling `better-sqlite3` into the main build.** Native addons cannot be bundled; keep it external via `externalizeDepsPlugin` and in `dependencies`. `[CITED: electron-vite dependency-handling]`
- **Opening the SQLite DB at a relative path or in the app bundle.** It must live at `app.getPath('userData')`, which is writable and per-user on both OSes. `[ASSUMED: Electron app paths]`
- **Writing any secret (even encrypted) into SQLite.** D-12 forbids it; ciphertext goes only to `secrets.enc`.
- **Skipping the native rebuild.** Running the app against a `better-sqlite3` built for the local Node ABI throws `NODE_MODULE_VERSION` mismatch on first query. Rebuild against Electron's ABI.
- **Disabling `webSecurity` or `sandbox` to make something work.** Never; find the correct pattern instead.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| OS secret encryption | Custom AES + a key file | Electron `safeStorage` (Keychain/DPAPI) | OS-backed key protection; hand-rolled crypto and key storage is the classic financial-tool footgun (and CLAUDE.md forbids keytar/electron-store) |
| Cross-boundary type safety | Ad hoc `any` IPC payloads | Shared TS `ipc-contract.ts` + Zod schemas at handlers | One source of truth for channel names, payloads, and returns; Zod validates at runtime, TS at compile time |
| SQLite access | Raw `sqlite3` async callbacks or a hand-written binding | better-sqlite3 (locked) | Synchronous, transactional, prepared-statement API; fewer race conditions in the main process |
| Native ABI alignment | Manual `node-gyp` invocations | `@electron/rebuild` (dev) / electron-builder `install-app-deps` (Phase 8) | Knows the correct Electron ABI/headers; downloads prebuilds when available |
| Tailwind config | A `tailwind.config.js` + PostCSS chain | `@tailwindcss/vite` plugin + CSS-first `@theme` | v4 is CSS-first; the Vite plugin is the supported path and needs no PostCSS file |
| Accessible primitives (button, badge, tooltip) | Custom focus/ARIA handling | shadcn/ui (Radix) copy-ins | Correct keyboard/focus/ARIA out of the box; brandable via tokens |
| Icon set | Hand-drawn SVGs | lucide-react | Consistent, tree-shakeable, matches the reference `components.json` |

**Key insight:** Phase 1's whole value is establishing correct seams. Every item above is a place where a shortcut here becomes a security or portability defect that ripples through Phases 2 to 8. The migration runner is the one intentional hand-roll (Discretion note), and it is safe because it is ~30 lines against better-sqlite3's transactional API.

## Common Pitfalls

### Pitfall 1: better-sqlite3 native ABI mismatch (crashes on a clean machine or CI)
**What goes wrong:** `npm install` compiles `better-sqlite3` against the local Node ABI (its install script is `node-gyp rebuild`). Electron embeds a different Node/V8 ABI, so the first `require('better-sqlite3')` in the main process throws `Error: The module was compiled against a different Node.js version` (`NODE_MODULE_VERSION` mismatch).
**Why it happens:** Native C++ addons are ABI-specific; Electron 43 != system Node 22.18.
**How to avoid:** After install, run `npx electron-rebuild -f -w better-sqlite3` (or an `@electron/rebuild` script, or in Phase 8 electron-builder's `install-app-deps`). Keep better-sqlite3 in `dependencies`. Wire this into a `postinstall`/`rebuild` npm script so a fresh clone on the Mac "just works".
**Secondary risk (this machine):** MSVC `cl` is not on PATH and Python is 3.14 (newer than node-gyp typically targets). If `@electron/rebuild` cannot download a prebuilt binary for Electron 43 and must compile from source, the build fails without: Windows -> Visual Studio Build Tools (Desktop C++) + a node-gyp-supported Python (3.11/3.12 is safest); macOS -> Xcode Command Line Tools (`xcode-select --install`). Plan a task to confirm the rebuild succeeds on both OSes before declaring the phase done.
**Warning signs:** App launches but white-screens or throws on the first DB call; error text mentions `NODE_MODULE_VERSION` or `.node` file.

### Pitfall 2: Sandboxed preload cannot require modules / splits break
**What goes wrong:** With `sandbox: true` (correct), a preload that `require`s an npm module, or that electron-vite splits into multiple CommonJS chunks, fails at runtime with "module not found" or an empty `window.api`.
**Why it happens:** Sandboxed preloads only get a polyfilled `require` for a short allow-list (`electron` renderer modules, `events`, `timers`, `url`) and cannot load arbitrary CJS files. `[CITED: electronjs.org/docs/latest/tutorial/sandbox]`
**How to avoid:** Keep the preload minimal (only `contextBridge` + `ipcRenderer`). Emit it as a single bundled CJS file: in `electron.vite.config.ts` set the preload build `rollupOptions.output.format = 'cjs'` and do NOT use `externalizeDepsPlugin` for the preload. `[CITED: WebSearch: alex8088/electron-vite discussion #423]`
**Warning signs:** `window.api` is undefined in the renderer; devtools console shows a preload require error.

### Pitfall 3: safeStorage called before app is ready, or unavailable
**What goes wrong:** Calling `safeStorage.isEncryptionAvailable()` / `encryptString` before the `ready` event, or on a machine where the backend is missing, returns false / throws, and the canary health check reports "unavailable" even though wiring is correct.
**Why it happens:** The keychain backend initializes at/after `ready`. On the two shipping OSes (macOS Keychain, Windows DPAPI) availability is essentially always true post-ready; the "unavailable" branch mainly guards Linux (out of scope) and locked-keychain edge cases.
**How to avoid:** Register secret IPC and run the canary only after `app.whenReady()`. Handle the false branch gracefully (render the locked "Secret store: unavailable" copy from the UI-SPEC) rather than crashing.
**Warning signs:** Health indicator red on a machine where the keychain is fine; errors thrown during `app` startup before the window shows.

### Pitfall 4: Theme flash / palette not following the OS
**What goes wrong:** The window renders light then snaps to dark (FOUC), or ignores the OS setting entirely.
**Why it happens:** The renderer applied `prefers-color-scheme` late, or main's `nativeTheme` was never consulted, or the `.dark` class was toggled after first paint.
**How to avoid:** Read `nativeTheme.shouldUseDarkColors` in main, pass the initial value to the renderer (via a `theme:get` invoke resolved before first meaningful paint, or an injected boot flag), toggle `documentElement.classList` synchronously, and subscribe to `nativeTheme` `'updated'` to broadcast `theme:changed`. Keep `show: false` until `ready-to-show`.
**Warning signs:** A visible flash on launch; dark-mode machine shows light UI.

### Pitfall 5: electron-vite version/config drift from old tutorials
**What goes wrong:** Copying a 2.x-era or `vite-plugin-electron` config into an electron-vite 5 project produces build errors.
**Why it happens:** electron-vite is at 5.0.0 now; many tutorials reference 1.x/2.x or the unrelated `vite-plugin-electron`. The `defineConfig` + `externalizeDepsPlugin` API is stable, but scaffolds differ.
**How to avoid:** Scaffold with the official `@quick-start/electron` react-ts template, then layer Tailwind v4 and the DB/secret code on top. Confirm Node >= 20.19/22.12 (this machine: 22.18, OK).
**Warning signs:** Config errors referencing plugins or options that do not exist in electron-vite 5.

## Code Examples

### Renderer Window type augmentation (typed `window.api`)
```typescript
// src/renderer/src/env.d.ts
// Source: electronjs.org/docs/latest/tutorial/context-isolation (TypeScript section)
import type { Api } from '../../preload'   // reuse the preload's exported type
declare global {
  interface Window { api: Api }
}
export {}
```

### Reading nativeTheme in main and broadcasting changes
```typescript
// src/main/ipc/theme.ts
import { ipcMain, nativeTheme, BrowserWindow } from 'electron'
export function registerThemeIpc() {
  ipcMain.handle('theme:get', () => nativeTheme.shouldUseDarkColors)
  nativeTheme.on('updated', () => {
    const isDark = nativeTheme.shouldUseDarkColors
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send('theme:changed', isDark)
  })
}
```

### Single-instance lock (Discretion; standard)
```typescript
// src/main/index.ts (top of app bootstrap)
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const [w] = BrowserWindow.getAllWindows()
    if (w) { if (w.isMinimized()) w.restore(); w.focus() }
  })
}
```

### app_settings read/write round trip (SC3 proof)
```typescript
// src/main/ipc/settings.ts
import { ipcMain } from 'electron'
import { z } from 'zod'
import { db } from '../db/connection'
const SetSchema = z.object({ key: z.string().min(1).max(128), value: z.string().max(4096) })
export function registerSettingsIpc() {
  const get = db.prepare('SELECT value FROM app_settings WHERE key = ?')
  const set = db.prepare(
    'INSERT INTO app_settings (key, value) VALUES (@key, @value) ' +
    'ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  )
  ipcMain.handle('settings:get', (e, raw) => {
    const key = z.string().min(1).parse(raw)
    return (get.get(key) as { value: string } | undefined)?.value ?? null
  })
  ipcMain.handle('settings:set', (e, raw) => { set.run(SetSchema.parse(raw)); return true })
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| keytar for secrets | Electron `safeStorage` | keytar archived Dec 2022 | Locked; no native keytar dep, OS-backed |
| `tailwind.config.js` + PostCSS | `@tailwindcss/vite` + CSS-first `@theme` | Tailwind v4 (2025) | No config/PostCSS files; tokens live in CSS |
| nodeIntegration in renderer | sandbox + contextIsolation + contextBridge | Electron 20 (sandbox default) | Renderer is untrusted; all privilege in main |
| `remote` module | `ipcRenderer.invoke` / `ipcMain.handle` | Deprecated, removed | Explicit, validated request/response IPC |
| `vite-plugin-electron` / electron-vite 2.x tutorials | electron-vite 5.0.0 | 2025-2026 | Use current scaffold; ignore stale configs |
| tailwindcss-animate | tw-animate-css | Tailwind v4 era | v4-compatible animation utilities (reference site already uses it) |

**Deprecated/outdated (do not use):** keytar, electron-store for secrets, `remote` module, `nodeIntegration: true`, PostCSS-based Tailwind config, AG Grid (not relevant until Phase 6, and CLAUDE.md prefers TanStack there).

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Migration runner: forward-only `user_version` pragma with a code-defined migration list is sufficient for Phase 1 | Pattern 6 | Low. Matches Discretion note; if later phases need down-migrations, extend then. Only app_settings + schema_version exist now |
| A2 | Window defaults 1200x800, min 940x600, single-instance lock on | Pattern 2 / code examples | Low. Explicitly Claude's Discretion; planner/user may pick other sizes |
| A3 | `@tailwindcss/vite` works unchanged inside the electron-vite renderer target | Standard Stack / Pattern 5 | Low-Medium. Widely reported working (WebSearch); the renderer is a standard Vite build. Verify HMR on first run |
| A4 | `@electron/rebuild` will find or build a better-sqlite3 binary for Electron 43 on both OSes | Pitfall 1 | Medium. If no prebuild exists, a source compile needs MSVC+Python (Win) / Xcode CLT (Mac). Confirm early on both machines |
| A5 | Keeping `externalizeDepsPlugin()` off the preload + CJS output is the right sandbox-safe preload build | Pattern 1 / Pitfall 2 | Low. Corroborated by electron-vite discussion #423; the preload uses only electron built-ins so it needs no external deps anyway |
| A6 | Synchronous safeStorage API is acceptable (vs the newer async variant) for the Phase 1 canary | Pattern 3 | Low. Payload is a tiny canary; sync is simplest. Later high-volume secret writes could adopt the async API |
| A7 | Python 3.14 on this Windows machine may be too new for node-gyp source compilation | Pitfall 1 / Environment | Medium. Only bites if a prebuild is unavailable; mitigation is to install Python 3.11/3.12 |

## Open Questions

1. **Does a better-sqlite3 13.0.1 prebuilt binary exist for Electron 43's ABI on macOS arm64 and Windows x64?**
   - What we know: `@electron/rebuild` prefers prebuilds and falls back to source compile; better-sqlite3 publishes prebuilds on GitHub releases.
   - What's unclear: exact ABI coverage for Electron 43 at build time on both targets.
   - Recommendation: In the first execution wave, run `npx electron-rebuild -f -w better-sqlite3` on both OSes and treat a source-compile fallback (needing the C++ toolchain) as an expected branch, not a surprise.

2. **Where exactly to vendor `tokens.json`: `design/` vs `src/renderer/brand/`?**
   - What we know: D-02 allows either; the renderer consumes it at build time to author `globals.css`.
   - What's unclear: whether the planner wants a codegen step (tokens -> CSS) or a one-time hand-authored `globals.css` cross-checked against tokens.
   - Recommendation: For Phase 1, hand-author `globals.css` from the token values (the UI-SPEC already enumerates every value) and keep `tokens.json` vendored as the audit trail. Defer any token-to-CSS codegen unless later phases demand it.

## Environment Availability

| Dependency | Required By | Available (this machine) | Version | Fallback |
|------------|------------|--------------------------|---------|----------|
| Node.js | electron-vite 5 (needs 20.19+/22.12+) | Yes | 22.18.0 | none needed |
| npm | install/scripts | Yes | 10.9.3 | none needed |
| git | repo | Yes | 2.53.0 | none needed |
| Python | node-gyp (only if source-compiling native module) | Yes (but very new) | 3.14.3 | Install Python 3.11/3.12 if node-gyp rejects 3.14 |
| MSVC C++ build tools (`cl`) | better-sqlite3 source compile on Windows | No (not on PATH) | - | Prefer a downloaded prebuild via @electron/rebuild; else install VS Build Tools (Desktop C++) |
| Xcode Command Line Tools | better-sqlite3 source compile on macOS | Unknown (Anthony's Mac not probed) | - | `xcode-select --install` on the Mac before first rebuild |
| Electron 43 runtime | dev + native ABI target | Installed by npm during scaffold | 43.2.0 | none |

**Missing dependencies with no fallback:** none that block a prebuild-based path.
**Missing dependencies with fallback:** the C++ toolchain (MSVC on Windows, Xcode CLT on Mac) is only needed if `@electron/rebuild` cannot download a matching prebuilt better-sqlite3 binary. This is the single most likely execution snag; the planner should include an explicit "verify native rebuild on both OSes" task and, if it falls back to source compilation, a toolchain-install task (with Python 3.11/3.12 on Windows given the 3.14 concern).

## Validation Architecture

> Nyquist validation is enabled (`workflow.nyquist_validation: true`). This section derives the VALIDATION.md coverage that proves the four Success Criteria.

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Vitest (unit, main-process logic) + Playwright `_electron` (end-to-end launch/IPC/DB proof) |
| Config file | none yet - Wave 0 creates `vitest.config.ts` and `playwright.config.ts` (or a `tests/e2e` runner) |
| Quick run command | `npx vitest run` (unit) |
| Full suite command | `npx vitest run && npx playwright test` |

Rationale: Vitest is the native test runner for a Vite/electron-vite project and covers pure main-process units (migration runner, secret-store logic with a mocked `safeStorage`, Zod schemas). Playwright's `_electron.launch` is the standard way to boot the packaged/dev app, drive the real renderer, and assert the real IPC-to-main-to-keychain and DB round trips on both Windows and Mac. WebdriverIO's electron service is a valid alternative (auto-detects the app, integrates with electron-builder) and could be swapped in if the team already knows it. `[CITED: electronjs.org/docs/latest/tutorial/automated-testing; WebSearch Playwright _electron]`

### Phase Requirements to Test Map
| Req / SC | Behavior | Test Type | Automated Command | File Exists? |
|----------|----------|-----------|-------------------|-------------|
| SC1 / BRAND-01/02 / PLAT-01 | App launches; branded window renders wordmark, sidebar (Bills/History/Settings), no logo | e2e (Playwright `_electron`) | `npx playwright test e2e/launch.spec.ts` | Wave 0 |
| SC1 (theme) | Window follows OS color scheme (light/dark class applied) | e2e + unit | `npx playwright test e2e/theme.spec.ts` | Wave 0 |
| SC2 / PLAT-02 | Store + retrieve a canary secret via keychain; ciphertext lands in `secrets.enc`; nothing secret in SQLite | e2e + unit | `npx playwright test e2e/secret-roundtrip.spec.ts`; `npx vitest run test/secret-store.test.ts` | Wave 0 |
| SC2 (negative) | No secret material appears in `app.db` or logs (grep the DB file + stdout) | unit/e2e assertion | `npx vitest run test/no-secret-leak.test.ts` | Wave 0 |
| SC3 / (persistence) | Write app_settings, restart app, read back the same value | e2e (relaunch) | `npx playwright test e2e/persistence.spec.ts` | Wave 0 |
| SC3 (migration) | Fresh DB gets `user_version` 0 -> 1; app_settings table exists; idempotent on second run | unit | `npx vitest run test/migrate.test.ts` | Wave 0 |
| SC4 | Renderer has no fs/db/keychain/net access; only `window.api` methods reach main; Zod rejects malformed payloads | unit + e2e | `npx vitest run test/ipc-contract.test.ts`; `npx playwright test e2e/ipc-boundary.spec.ts` | Wave 0 |

### Sampling Rate
- **Per task commit:** `npx vitest run` (fast main-process units: migration, secret-store with mocked safeStorage, Zod schemas)
- **Per wave merge:** `npx vitest run && npx playwright test` (adds the electron launch/round-trip e2e)
- **Phase gate:** Full suite green on BOTH Windows and Mac before `/gsd:verify-work`. The cross-OS run is the load-bearing gate for PLAT-01; CI can cover one OS (matrix: windows + macos runners) but the keychain round trip and native rebuild should also be confirmed on a real machine of each kind.

### Wave 0 Gaps
- [ ] `vitest.config.ts` - unit runner for main-process modules
- [ ] `playwright.config.ts` + `e2e/` - Electron `_electron.launch` harness pointing at the built main entry
- [ ] `test/migrate.test.ts` - covers SC3 migration idempotency
- [ ] `test/secret-store.test.ts` - covers SC2 with a mocked `safeStorage`
- [ ] `test/no-secret-leak.test.ts` - asserts DB file and logs contain no secret material
- [ ] `test/ipc-contract.test.ts` - Zod schema accept/reject cases for every channel
- [ ] `e2e/launch.spec.ts`, `theme.spec.ts`, `secret-roundtrip.spec.ts`, `persistence.spec.ts`, `ipc-boundary.spec.ts`
- [ ] CI workflow (matrix windows + macos) that installs, runs `electron-rebuild`, and executes both suites
- [ ] Framework install: `npm install -D vitest @playwright/test`

**What is testable in CI vs what needs a real machine:** Launch, migration, app_settings persistence, IPC contract, and theme class toggling are fully CI-automatable on both windows and macos runners. The `safeStorage` round trip depends on an available OS keychain; GitHub macos/windows runners generally provide a working backend (DPAPI is always present on Windows; macOS runners have a Keychain), so the canary round trip should pass in CI, but confirm on Anthony's real Mac at least once because a locked/absent login keychain is the realistic "unavailable" case. Native rebuild success must be proven on both OSes.

## Security Domain

> `security_enforcement: true`, `security_asvs_level: 1`, `security_block_on: high`. Phase 1 handles credentials indirectly (it builds the secret store and IPC boundary all later credentials flow through), so its security surface is the boundary itself.

### Applicable ASVS Categories (L1)
| ASVS Category | Applies | Standard Control (Phase 1) |
|---------------|---------|-----------------------------|
| V1 Architecture | yes | Documented trust boundary: renderer untrusted, main privileged, preload the only bridge (this research is the artifact) |
| V2 Authentication | no | No user auth in Phase 1 (QuickBooks OAuth is Phase 4) |
| V3 Session Management | no | No sessions in Phase 1 |
| V4 Access Control | partial | Renderer cannot reach fs/db/keychain/net except via allow-listed IPC methods; validate IPC sender |
| V5 Input Validation | yes | Zod-validate every IPC payload at the main-process handler before use |
| V6 Cryptography / Secret Storage | yes | Electron `safeStorage` (OS Keychain/DPAPI); never hand-roll; ciphertext in `secrets.enc` with `0o600`, never in SQLite or logs |
| V7 Error Handling / Logging | yes | Never log secret values; the "unavailable" path surfaces a user message, not a stack trace with secrets |
| V8 Data Protection | yes | Secret file owner-only permissions; DB holds no secrets; `secrets.enc` and `*.db` are gitignored |
| V12 Files / Resources | yes | DB and secret file under `userData` only; deny navigation and `window.open` |
| V13 API / IPC | yes | `ipcMain.handle` with sender validation; no raw `ipcRenderer` exposed; contextBridge allow-list only |

### Known Threat Patterns for this stack (Phase 1 surface)
| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Renderer XSS escalates to RCE via Node access | Elevation of Privilege | `nodeIntegration: false`, `sandbox: true`, `contextIsolation: true`; renderer has no Node |
| Overbroad preload exposes full IPC | Elevation of Privilege | Expose only named methods via contextBridge; never expose `ipcRenderer` or a generic `invoke` |
| Malicious/malformed IPC payload reaches a privileged handler | Tampering | Zod-parse every payload; validate `event.sender` (single-window app: assert it is the app window) |
| Secret exfiltration from disk | Information Disclosure | `safeStorage` OS-backed encryption; `secrets.enc` `0o600`; never in SQLite; gitignore secret + DB files |
| Secret leakage via logs | Information Disclosure | Never log secret values; log booleans/keys only (e.g., "secret store: ok") |
| SQL injection into app_settings | Tampering | Parameterized prepared statements everywhere; the only string-interpolated SQL is `PRAGMA user_version = N` where N is an integer from the code-controlled migration list (never user/renderer input) |
| Untrusted navigation / new window loads remote code | Tampering / EoP | `setWindowOpenHandler(() => deny)`, `will-navigate` preventDefault; local content only in Phase 1 |
| Native module tampering / wrong binary | Tampering | Pin better-sqlite3 version; rebuild via `@electron/rebuild`; better-sqlite3 passed slopcheck [OK] |

**Blocking posture:** `security_block_on: high`. The high-severity Phase 1 controls are: sandbox/contextIsolation/nodeIntegration settings, no-raw-ipcRenderer exposure, Zod validation at handlers, safeStorage-only secrets with no DB/log leakage, and parameterized SQL. A plan that omits any of these should not pass the security gate.

## Sources

### Primary (HIGH confidence)
- electronjs.org/docs/latest/tutorial/context-isolation - contextBridge pattern, TypeScript Window augmentation, argument filtering
- electronjs.org/docs/latest/tutorial/sandbox - sandboxed preload allow-list (electron modules + events/timers/url only), no npm require
- electronjs.org/docs/latest/tutorial/security - the security checklist (contextIsolation, sandbox, nodeIntegration, CSP, validate sender, no raw ipcRenderer, webSecurity, navigation control)
- electronjs.org/docs/latest/tutorial/ipc - invoke/handle preferred for two-way IPC
- electronjs.org/docs/latest/api/safe-storage - methods, macOS Keychain / Windows DPAPI backends, ready-event timing, async variant
- electron-vite.org/guide + /guide/dependency-handling - three-artifact config, Node/Vite version floor, externalizeDepsPlugin, native modules external + in dependencies
- npm registry (`npm view`, 2026-07-22) - all version numbers verified
- slopcheck 0.6.1 (`-e npm`, 2026-07-22) - 18/18 packages [OK]
- Local vendored refs: `../themagnetgroup/brand-guide/agents/tokens.json` (v2026.06.1, confirmed present), `../themagnetgroup_website/src/app/globals.css` and `components.json` (confirmed present) - theme values and reference wiring

### Secondary (MEDIUM confidence)
- WebSearch (electron-vite + Tailwind v4 renderer setup) - config example cross-checked against tailwindcss.com v4 Vite-plugin docs
- WebSearch (alex8088/electron-vite discussion #423) - sandbox preload must be bundled CJS, do not externalize preload deps
- WebSearch (Electron automated testing) - Playwright `_electron.launch` and WebdriverIO electron service as the two standard e2e paths

### Tertiary (LOW confidence, flagged)
- Existence of a better-sqlite3 13.0.1 prebuild for Electron 43 on both OSes - unverified; treat source-compile as an expected fallback (Open Question 1)

## Project Constraints (from CLAUDE.md)

Directives the planner must honor (same authority as locked decisions):
- **No em dashes or en dashes** anywhere (copy, code comments, docs). Plain hyphens only. Numeric ranges use a plain hyphen.
- **No personal/owner/founder names** in any copy. Max reference is "family-owned". The Phase 1 wordmark is the product name "NicoleBooks" (a product name, not a person reference); no other names appear.
- **Locked stack only** (Electron 43, React 19, electron-vite, TypeScript, Tailwind 4, shadcn/ui, better-sqlite3, safeStorage, Zod). Do not propose alternatives to these.
- **"What NOT to Use":** never keytar, never electron-store for secrets, never `nodeIntegration` in the renderer. (pdf-parse, node-quickbooks, AG Grid Enterprise, Tauri, sharp-HEIC are later-phase concerns, not Phase 1.)
- **Secrets never committed to the repo or written to logs;** stored only in the OS keychain via safeStorage. Add `secrets.enc`, `*.db`, and env files to `.gitignore`.
- **Brand token file is canonical;** do not invent colors or fonts. Extract from vendored `tokens.json`; cross-check against the UI-SPEC.
- **GSD workflow enforcement:** file changes happen through GSD commands (this is a research artifact, not a code change).

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - every version verified via npm 2026-07-22 and slopcheck [OK]; names are the locked CLAUDE.md stack
- Architecture / IPC / security: HIGH - cited from official Electron docs (context-isolation, sandbox, security, ipc, safe-storage)
- electron-vite + Tailwind v4 wiring: MEDIUM-HIGH - config cited from electron-vite docs + WebSearch, cross-checked; verify HMR on first run
- Native rebuild toolchain: MEDIUM - rebuild path is standard, but prebuild availability for Electron 43 on both OSes is unverified (Open Question 1); local Windows lacks MSVC and has Python 3.14
- Migration runner: HIGH pattern, ASSUMED specifics - standard SQLite `user_version`; ~30-line hand-roll per Discretion note

**Runtime State Inventory:** Not applicable. Phase 1 is greenfield (repo contains only CLAUDE.md and .planning). No stored data, live-service config, OS-registered state, secrets, or build artifacts pre-exist to migrate. Verified by directory listing of the repo root on 2026-07-22.

**Research date:** 2026-07-22
**Valid until:** 2026-08-21 (30 days; stack is stable, but re-verify better-sqlite3/Electron prebuild coverage and electron-vite 5.x at plan time if delayed)
