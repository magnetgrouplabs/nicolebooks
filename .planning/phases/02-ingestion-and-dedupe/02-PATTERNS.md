# Phase 2: Ingestion and Dedupe - Pattern Map

**Mapped:** 2026-07-24
**Files analyzed:** 21 (8 new source, 1 new inbox module, 6 new test files, 6 modified)
**Analogs found:** 20 / 21 (every file has a same-repo pattern to mirror; only the placeholder-detection core logic in `materialization.ts` has no exact analog and pulls from RESEARCH)

This phase is a disciplined re-application of Phase 1 seams. Almost every new file mirrors an existing Phase 1 file verbatim in structure. The excerpts below are the exact patterns to copy, with paths and line numbers.

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|-------------------|------|-----------|----------------|---------------|
| `src/main/ingestion/filetype.ts` (new) | utility (pure) | transform | `src/main/ipc/trusted-sender.ts` (pure exported fns) | role-match |
| `src/main/ingestion/hash.ts` (new) | utility | file-I/O (streaming) | RESEARCH Pattern 3 (no repo analog) | research-only |
| `src/main/ingestion/materialization.ts` (new) | utility | file-I/O (stat metadata) | `src/main/db/connection.ts` (injectable-pure pattern) | partial (structure) |
| `src/main/ingestion/inbox.ts` (new) | service | CRUD + file-I/O | `src/main/ipc/settings.ts` (app_settings prepared stmt) + `connection.ts` (app.getPath) | role-match |
| `src/main/ingestion/scan.ts` (new) | service (orchestrator) | file-I/O + CRUD | `src/main/ipc/settings.ts` (delegated logic module) | partial (role) |
| `src/main/ingestion/ledger.ts` (new) | model / repository | CRUD (read-only) | `src/main/ipc/settings.ts` lines 22-33 (prepared-statement read) | exact (pattern) |
| `src/main/ipc/ingestion.ts` (new) | controller (IPC group) | request-response | `src/main/ipc/settings.ts` + `src/main/ipc/theme.ts` (dialog handler) | exact |
| `src/main/db/migrations/0002_dedupe.ts` (new) | migration | schema | `src/main/db/migrations/0001_init.ts` | exact |
| `test/ingestion-filetype.test.ts` (new) | test (unit, pure) | — | `test/ipc-contract.test.ts` | exact |
| `test/ingestion-hash.test.ts` (new) | test (unit, temp fs) | — | `test/migrate.test.ts` (temp-file setup) | role-match |
| `test/ingestion-ledger.test.ts` (new) | test (unit, temp DB) | — | `test/migrate.test.ts` (temp better-sqlite3) | exact |
| `test/ingestion-materialization.test.ts` (new) | test (unit inject + integration fs) | — | `test/migrate.test.ts` (fs setup) | role-match |
| `test/ingestion-scan.test.ts` (new) | test (unit) | — | `test/migrate.test.ts` | role-match |
| `test/ingestion-inbox.test.ts` (new) | test (unit, temp DB) | — | `test/migrate.test.ts` | exact |
| `src/shared/ipc-contract.ts` (modified) | contract | — | itself (append to `Channels` + interfaces) | exact |
| `src/shared/schemas.ts` (modified) | validation | — | itself (append `ScanRequestSchema`) | exact |
| `src/main/db/migrate.ts` (modified) | migration runner | — | itself (append to `migrations` array) | exact |
| `src/main/ipc/register.ts` (modified) | bootstrap | — | itself (add one register call) | exact |
| `src/preload/index.ts` (modified) | bridge | — | itself (add `ingestion` object) | exact |
| `src/renderer/src/env.d.ts` (unchanged, verify) | type augmentation | — | already derives from preload `Api`; no edit needed | n/a |
| `src/renderer/src/screens/BillsScreen.tsx` (modified) | component | request-response | `src/renderer/src/components/HealthIndicator.tsx` (window.api + useState) | exact (pattern) |
| `e2e/ipc-boundary.spec.ts` (modified) | test (e2e) | — | itself (extend apiShape assertions) | exact |

---

## Pattern Assignments

### `src/main/ipc/ingestion.ts` (controller, request-response) — THE central analog

**Analog:** `src/main/ipc/settings.ts` (DB handlers) + `src/main/ipc/theme.ts` (non-DB / dialog handler) + `src/main/ipc/secrets.ts` (graceful-null return).

This is the file the whole phase orbits. Copy the handler contract exactly: `assertTrustedSender(event)` FIRST, then `Schema.parse(raw)`, then delegate to the logic module. Prepared statements live in the register function, prepared once for the app lifetime.

**Imports + register-function + prepared-statement shape** (`src/main/ipc/settings.ts` lines 12-26):
```typescript
import { ipcMain } from 'electron'
import { Channels } from '../../shared/ipc-contract'
import { SettingsKeySchema, SettingsSetSchema } from '../../shared/schemas'
import { getDatabase } from '../db/connection'
import { assertTrustedSender } from './trusted-sender'

/** Register the settings channel handlers. Call after app 'ready' (getDatabase needs it). */
export function registerSettingsIpc(): void {
  const db = getDatabase()
  // Prepared once for the app lifetime; getDatabase returns a singleton handle.
  const getStmt = db.prepare('SELECT value FROM app_settings WHERE key = ?')
  const setStmt = db.prepare(
    'INSERT INTO app_settings (key, value) VALUES (@key, @value) ' +
      'ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  )
```

**Core handler shape — assertTrustedSender -> Zod-parse -> prepared statement** (`src/main/ipc/settings.ts` lines 28-40):
```typescript
  ipcMain.handle(Channels.settingsGet, (event, raw) => {
    assertTrustedSender(event)
    const key = SettingsKeySchema.parse(raw)
    const row = getStmt.get(key) as { value: string } | undefined
    return row?.value ?? null
  })

  ipcMain.handle(Channels.settingsSet, (event, raw) => {
    assertTrustedSender(event)
    const payload = SettingsSetSchema.parse(raw)
    setStmt.run(payload)
    return true
  })
```

**Dialog / non-DB handler shape** — for `ingestionChooseInbox`, mirror `theme.ts`'s "validate sender then call an Electron API" (no payload) rather than the DB handler. (`src/main/ipc/theme.ts` lines 17-20):
```typescript
  ipcMain.handle(Channels.themeGet, (event) => {
    assertTrustedSender(event)
    return nativeTheme.shouldUseDarkColors
  })
```
For `chooseInbox`, the handler adds `dialog` + `BrowserWindow` from `electron` and resolves the window from the sender (RESEARCH Pattern 4, lines 272-279 of 02-RESEARCH.md):
```typescript
  ipcMain.handle(Channels.ingestionChooseInbox, async (event) => {
    assertTrustedSender(event)
    const win = BrowserWindow.fromWebContents(event.sender) ?? undefined
    const res = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] })
    if (res.canceled || res.filePaths.length === 0) return { canceled: true as const }
    persistInboxPath(res.filePaths[0])
    return { canceled: false as const, path: res.filePaths[0] }
  })
```
For `ingestionScan`, the payload is empty: `ScanRequestSchema.parse(raw)` then `return runScan()` (which reads the inbox path server-side from `app_settings`, so no renderer path reaches fs — the path-injection guard).

**Graceful-null-on-unavailable option** (from `src/main/ipc/secrets.ts` lines 21-27) — if a subsystem (e.g. Windows attribute read) can be unavailable, return a benign value rather than throwing a raw stack into the renderer.

---

### `src/main/ingestion/ledger.ts` (model/repository, read-only CRUD)

**Analog:** `src/main/ipc/settings.ts` lines 22-33 — the prepared-statement read pattern is the exact model. Ledger prepares `SELECT 1 FROM posted_file_hashes WHERE hash = ?` (Design B, RESEARCH-recommended: Phase 2 is read-only on this table).

**Prepared-statement read** (mirror `settings.ts` lines 22, 28-33):
```typescript
  const getStmt = db.prepare('SELECT value FROM app_settings WHERE key = ?')
  // ...
    const row = getStmt.get(key) as { value: string } | undefined
    return row?.value ?? null
```
Ledger equivalent: prepare `SELECT posted_at, original_filename FROM posted_file_hashes WHERE hash = ?`, bind the 64-char hex hash with `?` (never interpolate — T-01-06), return the row or `undefined`. A hit becomes `duplicate-excluded` with `postedAt`; a miss becomes `loaded`. Take the `db` handle from `getDatabase()` (see `connection.ts` line 37) or via injection for tests.

---

### `src/main/ingestion/inbox.ts` (service, CRUD + file-I/O)

**Analog:** `src/main/ipc/settings.ts` (app_settings prepared read/write, key `inbox_path`) + `src/main/db/connection.ts` lines 37-43 (`app.getPath` + main-only singleton).

`resolveInboxPath()`: read `app_settings` for `inbox_path`; if unset, compute `join(app.getPath('documents'), 'NicoleBooks', 'Inbox')` and `mkdirSync(path, { recursive: true })`, persist it, return `{ path, created }`. `persistInboxPath(path)`: the UPSERT from `settings.ts` lines 23-26.

**app.getPath + main-only singleton reference** (`src/main/db/connection.ts` lines 37-43):
```typescript
export function getDatabase(): Database.Database {
  if (handle) return handle
  const dbPath = join(app.getPath('userData'), 'app.db')
  handle = openDatabase(dbPath)
  migrate(handle)
  return handle
}
```
Note RESEARCH Pitfall 6: `mkdirSync(..., {recursive:true})` in main is mandatory; do not rely on the dialog's `createDirectory` (macOS-only).

---

### `src/main/ingestion/materialization.ts` (utility, stat metadata; injectable for tests)

**Analog:** `src/main/db/connection.ts` lines 23-28 (`openDatabase(dbPath)`) — the "pure opener that takes an explicit path so unit tests can inject" pattern. Apply the same injectability: `isNotMaterialized(fullPath, siblingNames, fileName, platform = process.platform)` and `isSettled(fullPath, {intervalMs, maxSamples})` take an injectable `platform` / stat-like fn / fake attribute-reader so both OS branches test on one CI OS (RESEARCH lines 588-599).

**Injectable-pure reference** (`src/main/db/connection.ts` lines 23-28):
```typescript
/** Open a better-sqlite3 handle at dbPath with WAL journaling. Pure: no electron, no migrate. */
export function openDatabase(dbPath: string): Database.Database {
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  return db
}
```
The actual detection logic (mac `blocks === 0` / `.icloud` sentinel; Windows batched `execFile('attrib'|powershell)` with an args array, never a shell string) has no repo analog — copy RESEARCH Patterns 1 and 2 (02-RESEARCH.md lines 186-236) verbatim and honor Pitfall 4 (no `exec` string concat).

---

### `src/main/ingestion/hash.ts` (utility, streaming file-I/O)

**Analog:** none in repo. Copy RESEARCH Pattern 3 (02-RESEARCH.md lines 243-254) exactly:
```typescript
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'

export async function sha256File(fullPath: string): Promise<string> {
  const hash = createHash('sha256')
  await pipeline(createReadStream(fullPath), hash)
  return hash.digest('hex')
}
```
Stream (never `readFileSync`) for constant memory on large PDFs/photos.

---

### `src/main/ingestion/filetype.ts` (utility, pure transform)

**Analog:** `src/main/ipc/trusted-sender.ts` — the "pure exported functions, no side effects, no Electron/DB" module shape (a single-purpose file exporting named pure functions). Copy the concrete classifier from RESEARCH Code Examples (02-RESEARCH.md lines 488-509): `isJunk`, `isSupported`, `iCloudSentinelTarget`, plus `localDateStamp` (lines 513-521). Critical ordering: translate `.<name>.icloud` to a placeholder signal BEFORE the generic dotfile-junk rule.

---

### `src/main/ingestion/scan.ts` (service, orchestrator)

**Analog:** `src/main/ipc/settings.ts`'s "thin handler delegates to a logic module" relationship (settings.ts is thin over `db/`; `ipc/ingestion.ts` is thin over `ingestion/scan.ts`). No single-file orchestrator analog exists, so structure follows the ordered pipeline in RESEARCH (02-RESEARCH.md lines 381-388 decision rule + lines 129-164 diagram): `readdir` (flat, no recursion) -> junk filter -> extension classify -> materialization check (metadata only) -> stability poll -> stream-hash all -> within-scan collapse by hash (D-10) -> ledger check (D-08/09). Returns the `ScanResult` shape defined in the contract. Compute ALL hashes before grouping (Pitfall 5). Skip symlinks via `Dirent.isFile()` (Security Domain).

---

### `src/main/db/migrations/0002_dedupe.ts` (migration, STRICT table)

**Analog:** `src/main/db/migrations/0001_init.ts` — mirror the object shape exactly, bump `version` to 2.

**Migration object shape** (`src/main/db/migrations/0001_init.ts` lines 15-27):
```typescript
import type Database from 'better-sqlite3'

export const migration0001 = {
  version: 1,
  up(db: Database.Database): void {
    db.exec(
      `CREATE TABLE IF NOT EXISTS app_settings (
         key   TEXT PRIMARY KEY,
         value TEXT NOT NULL
       ) STRICT;`
    )
  }
}
```
Copy to `migration0002` (version 2). Table body from RESEARCH Section 3 (02-RESEARCH.md lines 403-409), STRICT, `hash TEXT PRIMARY KEY`:
```sql
CREATE TABLE IF NOT EXISTS posted_file_hashes (
  hash              TEXT PRIMARY KEY,
  posted_at         TEXT NOT NULL,
  original_filename TEXT NOT NULL,
  qbo_entity        TEXT,
  qbo_id            TEXT
) STRICT;
```

---

## Modified Files — Exact Insertion Patterns

### `src/shared/ipc-contract.ts` (append only; zero runtime imports)

Append three constants to `Channels` (after line 25 `themeChanged`), then add the `ScanFileStatus` / `ScanFile` / `ScanResult` / `IngestionApi` types and extend `Api`.

**`Channels` shape to extend** (lines 18-26):
```typescript
export const Channels = {
  settingsGet: 'settings:get',
  settingsSet: 'settings:set',
  secretsSet: 'secrets:set',
  secretsGet: 'secrets:get',
  secretsDelete: 'secrets:delete',
  themeGet: 'theme:get',
  themeChanged: 'theme:changed'
} as const
```
Add: `ingestionResolveInbox: 'ingestion:resolve-inbox'`, `ingestionChooseInbox: 'ingestion:choose-inbox'`, `ingestionScan: 'ingestion:scan'`.

**Api interface to extend** (lines 73-77):
```typescript
export interface Api {
  settings: SettingsApi
  secrets: SecretsApi
  theme: ThemeApi
}
```
Add `ingestion: IngestionApi`. Full type shapes (`ScanFileStatus`, `ScanFile`, `ScanResult`, `IngestionApi`) are pre-specified in 02-RESEARCH.md lines 436-464 — copy them in.

### `src/shared/schemas.ts` (append one schema alongside the existing four)

**Existing shape to match** (lines 17-23):
```typescript
export const SettingsSetSchema = z.object({
  key: z.string().min(1).max(128),
  value: z.string().max(4096)
})

export const SettingsKeySchema = z.string().min(1).max(128)
```
Add: `export const ScanRequestSchema = z.object({}).strict()` — scan takes no renderer payload (inbox path is read server-side; removes path-injection surface). `resolveInbox`/`chooseInbox` need no inbound schema; they still run `assertTrustedSender`.

### `src/main/db/migrate.ts` (append to the array; never renumber 0001)

**Import + array** (lines 18, 24):
```typescript
import { migration0001 } from './migrations/0001_init'
// ...
const migrations: Migration[] = [migration0001]
```
Add `import { migration0002 } from './migrations/0002_dedupe'` and change the array to `[migration0001, migration0002]`. The runner (lines 26-41) needs no change — it already filters `version > current` and bumps `user_version` per migration.

### `src/main/ipc/register.ts` (one import + one call)

**Current** (lines 8-17):
```typescript
import { registerSettingsIpc } from './settings'
import { registerSecretsIpc } from './secrets'
import { registerThemeIpc } from './theme'

export function registerIpc(): void {
  registerSettingsIpc()
  registerSecretsIpc()
  registerThemeIpc()
}
```
Add `import { registerIngestionIpc } from './ingestion'` and call `registerIngestionIpc()` in the body. (Called after app 'ready' from `src/main/index.ts` line 65 — no change there.)

### `src/preload/index.ts` (add an `ingestion` object; never expose raw ipcRenderer)

**Existing `settings` shape to mirror** (lines 19-23, 42):
```typescript
const api: IpcApi = {
  settings: {
    get: (key) => ipcRenderer.invoke(Channels.settingsGet, key),
    set: (key, value) => ipcRenderer.invoke(Channels.settingsSet, { key, value })
  },
  // ...
}
// ...
export type Api = typeof api
```
Add an `ingestion` block with three thin `ipcRenderer.invoke` methods on the new channel constants:
```typescript
  ingestion: {
    resolveInbox: () => ipcRenderer.invoke(Channels.ingestionResolveInbox),
    chooseInbox: () => ipcRenderer.invoke(Channels.ingestionChooseInbox),
    scan: () => ipcRenderer.invoke(Channels.ingestionScan)
  }
```
`env.d.ts` (lines 9-15) already derives `window.api` from this exported `Api`, so it auto-picks up `ingestion` with no edit.

### `src/renderer/src/screens/BillsScreen.tsx` (replace EmptyState placeholder with scan trigger + results)

**Current placeholder** (lines 10-18):
```typescript
export function BillsScreen(): React.JSX.Element {
  return (
    <EmptyState
      icon={Receipt}
      heading="No bills to review"
      body="Bills you import will appear here for review before they post to QuickBooks."
    />
  )
}
```

**Analog for the new interactive behavior:** `src/renderer/src/components/HealthIndicator.tsx` — the canonical `window.api` consumption + `useState` + async-effect + status-mapping pattern.

**window.api call + state pattern to mirror** (`HealthIndicator.tsx` lines 24-46):
```typescript
export function HealthIndicator(): React.JSX.Element {
  const [state, setState] = useState<HealthState>('checking')

  useEffect(() => {
    let cancelled = false
    async function check(): Promise<void> {
      try {
        await window.api.secrets.set(CANARY_KEY, CANARY_VALUE)
        const value = await window.api.secrets.get(CANARY_KEY)
        if (cancelled) return
        setState(value === CANARY_VALUE ? 'ok' : 'unavailable')
      } catch {
        if (!cancelled) setState('unavailable')
      }
    }
    void check()
    return () => { cancelled = true }
  }, [])
```
For BillsScreen: swap the mount-effect for a `Button onClick={runScan}` handler that calls `await window.api.ingestion.scan()`, holds `ScanResult | null` + a `scanning` boolean in `useState`, and renders the results list. Keep the `cancelled` guard idiom if resolving after unmount is possible.

**Empty-state reuse** (`EmptyState.tsx` lines 18-30) — keep for the empty-inbox / all-skipped states.

**Status badges** — `src/renderer/src/components/ui/badge.tsx` variants (lines 11-21) map cleanly to statuses: `destructive` for `duplicate-excluded` / `not-ready-skipped`, `secondary`/`outline` for `unsupported-skipped`, `default` for `loaded`. Import `{ Badge }` from `../components/ui/badge`.

**Scan button** — `src/renderer/src/components/ui/button.tsx` (`variant="default"`, `size="default"`; use `disabled={scanning}` — the button already styles `disabled:opacity-50`, line 7). Import `{ Button }` from `../components/ui/button`.

**Composition reference** (`SettingsScreen.tsx` lines 9-19) — the `flex flex-col gap-4` section-stack layout for arranging the button, summary line, batch date, and results list.

---

## Test File Assignments

### `test/ingestion-filetype.test.ts` — analog `test/ipc-contract.test.ts`

Pure-function accept/reject unit spec. Mirror the `describe`/`it` + `expect(fn(input)).toBe(...)` structure (ipc-contract.test.ts lines 26-53). No fs, no DB — feeds names to `isJunk`/`isSupported`/`iCloudSentinelTarget`.

### `test/ingestion-ledger.test.ts` and `test/ingestion-inbox.test.ts` — analog `test/migrate.test.ts` (exact)

Real `better-sqlite3` on a temp file (not `:memory:`). Copy the temp-DB lifecycle verbatim (`migrate.test.ts` lines 26-33):
```typescript
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nb-migrate-'))
  dbPath = join(dir, 'app.db')
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})
```
Then `new Database(dbPath)`, run `migrate(db)` to get `posted_file_hashes` (proves `migration0002` too), exercise the ledger read / inbox persistence. The `columnNames` helper (lines 35-38) and persistence-across-reopen test (lines 76-92) transfer directly.

### `test/ingestion-hash.test.ts`, `test/ingestion-materialization.test.ts`, `test/ingestion-scan.test.ts` — analog `test/migrate.test.ts` (fs setup)

Reuse the `mkdtempSync`/`rmSync` temp-dir lifecycle for real temp files with known bytes (hash: known-vector), a controlled background writer (materialization: `isSettled` must not settle until writing stops — RESEARCH line 598), injected fake stat/attr for placeholder branches (RESEARCH lines 596-597), and a temp inbox for scan orchestration (D-10 collapse, D-05 date, D-04 read-only invariant).

### `e2e/ipc-boundary.spec.ts` (extend) — analog itself

Add `ingestion` to the exposed-groups assertion. **Current** (lines 45-48):
```typescript
    expect(apiShape.top).toEqual(['secrets', 'settings', 'theme'])
    expect(apiShape.settings).toEqual(['get', 'set'])
    expect(apiShape.secrets).toEqual(['delete', 'get', 'set'])
    expect(apiShape.theme).toEqual(['get', 'onChange'])
```
Extend `top` to `['ingestion', 'secrets', 'settings', 'theme']` and add `expect(apiShape.ingestion).toEqual(['chooseInbox', 'resolveInbox', 'scan'])`. Also extend the `Channels` stable-string test in `test/ipc-contract.test.ts` (lines 114-126) with the three new channel constants.

---

## Shared Patterns

### Trust-boundary gate (assertTrustedSender FIRST)
**Source:** `src/main/ipc/trusted-sender.ts` (lines 19-45)
**Apply to:** every handler in `src/main/ipc/ingestion.ts`, as the first statement before any Zod parse or fs/DB/dialog work.
```typescript
export function assertTrustedSender(event: IpcMainInvokeEvent): void {
  const frame = event.senderFrame
  if (!frame) throw new Error('UNTRUSTED_SENDER')
  // ...file:// (packaged) and ELECTRON_RENDERER_URL origin (dev) accepted; else throw
}
```

### Zod-at-the-boundary
**Source:** `src/shared/schemas.ts` + usage in `src/main/ipc/settings.ts` line 30/37
**Apply to:** the `ingestionScan` handler (`ScanRequestSchema.parse(raw)`). A thrown parse becomes a rejected renderer promise before any privileged action.

### Prepared statements only (no SQL string interpolation)
**Source:** `src/main/ipc/settings.ts` lines 22-26 (`WHERE key = ?`, named-param UPSERT)
**Apply to:** `ledger.ts` (`WHERE hash = ?`) and `inbox.ts` (`inbox_path` UPSERT). Never build SQL from a scanned filename or hash (T-01-06).

### Forward-only migration ratchet
**Source:** `src/main/db/migrate.ts` lines 26-41 + `migrations/0001_init.ts`
**Apply to:** `migration0002` — append to the array, never renumber; STRICT table; `IF NOT EXISTS`.

### Named-method preload exposure (never raw ipcRenderer)
**Source:** `src/preload/index.ts` lines 19-39
**Apply to:** the `ingestion` object — three thin named `invoke`s, nothing generic (T-01-02).

### Semantic-theme component styling (no hardcoded hex)
**Source:** `EmptyState.tsx`, `HealthIndicator.tsx`, `ui/badge.tsx`, `ui/button.tsx`
**Apply to:** BillsScreen results surface — reuse `Button`, `Badge`, `EmptyState`; all colors via semantic classes / `cva` variants.

---

## No Analog Found

| File | Role | Data Flow | Reason |
|------|------|-----------|--------|
| `src/main/ingestion/hash.ts` (core logic) | utility | streaming file-I/O | No streaming-hash exists in the repo yet; copy RESEARCH Pattern 3 verbatim. Module *shape* still follows the single-purpose pure-fn convention. |
| `src/main/ingestion/materialization.ts` (detection logic) | utility | stat metadata | Cross-platform placeholder detection is genuinely novel to this repo (the phase's one hard problem). Structure mirrors `connection.ts` injectability; the mac `blocks`/`.icloud` and Windows `attrib`/PowerShell logic come from RESEARCH Section 1 and MUST be locked by the Wave-0 empirical probe. |

Everything else has a same-repo analog to copy directly.

## Metadata

**Analog search scope:** `src/main/ipc/`, `src/main/db/`, `src/main/db/migrations/`, `src/main/secrets/`, `src/shared/`, `src/preload/`, `src/renderer/src/screens/`, `src/renderer/src/components/`, `test/`, `e2e/`
**Files scanned:** 18 existing source/test files read in full (settings.ts, secrets.ts, theme.ts, trusted-sender.ts, register.ts, ipc-contract.ts, schemas.ts, migrate.ts, 0001_init.ts, connection.ts, preload/index.ts, env.d.ts, BillsScreen.tsx, SettingsScreen.tsx, HealthIndicator.tsx, EmptyState.tsx, ui/badge.tsx, ui/button.tsx) plus migrate.test.ts, ipc-contract.test.ts, ipc-boundary.spec.ts
**Pattern extraction date:** 2026-07-24
