# Phase 3: AI Client and Parse Pipeline - Pattern Map

**Mapped:** 2026-07-24
**Files analyzed:** 22 (11 create, 11 modify)
**Analogs found:** 19 / 22 with a direct in-repo analog; 3 are genuinely novel (prompt, confidence, extract-fields vision-call) and use RESEARCH.md code examples

This map grounds every new/modified Phase 3 file against an existing NicoleBooks file. The three load-bearing analogs the planner should point each plan at:

- **`src/main/ipc/settings.ts` + `src/main/ipc/ingestion.ts`** — the canonical IPC handler shape (`assertTrustedSender(event)` -> `Schema.parse(raw)` -> privileged work). Every new `ai.ts` / `parse.ts` handler copies this line-for-line.
- **`src/main/ingestion/scan.ts`** — the `ScanDeps` injectable-dependency + per-file try/catch isolation pattern. Every new `ai/` and `parse/` module copies the `deps = {}` default-to-real style so vitest drives it with a fake OpenAI client and injected file reader.
- **`src/main/db/migrate.ts` + `migrations/0002_dedupe.ts`** — the forward-only `user_version` runner + STRICT-table DDL that `migration0003` (`parsed_results`) copies exactly.

---

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|-------------------|------|-----------|----------------|---------------|
| `src/shared/ipc-contract.ts` (mod) | config / contract | request-response | itself (settings/secrets/ingestion groups) | exact |
| `src/shared/schemas.ts` (mod) | config / validation | request-response | itself (SettingsSetSchema / ScanRequestSchema) | exact |
| `src/main/ipc/ai.ts` (create) | controller (IPC handler) | request-response | `src/main/ipc/ingestion.ts` | exact |
| `src/main/ipc/parse.ts` (create) | controller (IPC handler) | request-response + event-driven | `ingestion.ts` (handler) + `theme.ts` (broadcast) | exact |
| `src/main/ipc/register.ts` (mod) | config | request-response | itself | exact |
| `src/main/ai/client.ts` (create) | service | request-response | `secret-store.ts` (reads key) + `scan.ts` deps | role-match |
| `src/main/ai/models.ts` (create) | service | request-response (fetch+transform) | `scan.ts` (injectable deps + classify) | role-match |
| `src/main/ai/vision-families.ts` (create) | utility | transform | `ingestion/hash.ts` (pure, zero-dep helper) | role-match |
| `src/main/parse/route.ts` (create) | service | transform / routing | `scan.ts` classify+gate loop | role-match |
| `src/main/parse/extract-pdf.ts` (create) | service | file-I/O + transform | `ingestion/hash.ts` (byte access, main-only) | partial |
| `src/main/parse/prep-image.ts` (create) | service | file-I/O + transform | RESEARCH Code Example + `hash.ts` byte pattern | partial |
| `src/main/parse/extract-fields.ts` (create) | service | request-response (network) | `scan.ts` deps style; vision call = RESEARCH example | no vision analog |
| `src/main/parse/prompt.ts` (create) | config / constant | n/a | RESEARCH Directive 4 (D-23) | no analog |
| `src/main/parse/validate.ts` (create) | service / utility | transform | `ingestion/hash.ts` (pure fn) + RESEARCH `toCents` | partial |
| `src/main/parse/confidence.ts` (create) | service / utility | transform | RESEARCH D-11 (deterministic-weighted) | no analog |
| `src/main/parse/cache.ts` (create) | model (data access) | CRUD | `settings.ts` prepared-statement pattern + `ingestion/ledger.ts` | role-match |
| `src/main/parse/pipeline.ts` (create) | service (orchestrator) | batch + event-driven | `src/main/ingestion/scan.ts` (`runScan`) | exact |
| `src/main/db/migrate.ts` (mod) | config | n/a | itself | exact |
| `src/main/db/migrations/0003_parsed_results.ts` (create) | migration | n/a | `migrations/0002_dedupe.ts` | exact |
| `src/renderer/src/screens/SettingsScreen.tsx` (mod) | component | request-response | itself + `HealthIndicator.tsx` | exact |
| `src/renderer/src/screens/BillsScreen.tsx` (mod) | component | event-driven + request-response | itself + `theme.onChange` subscribe | exact |
| `src/preload/index.ts` (mod) | config / bridge | request-response + event | itself (theme.onChange for parse:progress) | exact |

---

## Shared Patterns

These cross-cutting patterns apply to whole groups of the new files. Copy them once, apply everywhere noted.

### Shared Pattern A — IPC handler shape (assertTrustedSender -> Zod-parse -> work)
**Source:** `src/main/ipc/settings.ts` lines 28-40, `src/main/ipc/ingestion.ts` lines 21-43
**Apply to:** every handler in `src/main/ipc/ai.ts` and `src/main/ipc/parse.ts` (D-16)

The invariant: `assertTrustedSender(event)` is the FIRST statement in every handler, before any Zod parse or privileged work. Then Zod-parse the raw payload with a schema from `src/shared/schemas.ts`. Sync handlers return a value; async handlers (dialogs, network, DB batches) are `async` and return a promise. From `settings.ts`:

```typescript
export function registerSettingsIpc(): void {
  const db = getDatabase()
  const getStmt = db.prepare('SELECT value FROM app_settings WHERE key = ?')
  // ...
  ipcMain.handle(Channels.settingsGet, (event, raw) => {
    assertTrustedSender(event)               // FIRST — reject foreign frames (T-01-03)
    const key = SettingsKeySchema.parse(raw) // THEN — Zod gate the payload
    const row = getStmt.get(key) as { value: string } | undefined
    return row?.value ?? null                // THEN — the privileged work
  })
}
```

The async variant (network/dialog) from `ingestion.ts` lines 39-43 — note `async` + `.parse(raw)` even on an empty payload:

```typescript
ipcMain.handle(Channels.ingestionScan, async (event, raw) => {
  assertTrustedSender(event)
  ScanRequestSchema.parse(raw) // rejects any payload before any privileged work (T-02-02)
  return runScan()             // server-side resolution; no renderer input reaches fs/network
})
```

`ai.ts` handlers (`ai:test-connection`, `ai:list-models`, `ai:set-model`) and `parse.ts` handlers (`parse:parse-batch`, `parse:reparse`) mirror this exactly. The AI key is read main-side inside the handler (via `secret-store`), never accepted from or returned to the renderer (D-05/D-16).

### Shared Pattern B — Injectable dependencies with real defaults (`ScanDeps` style)
**Source:** `src/main/ingestion/scan.ts` lines 30-57
**Apply to:** every module in `src/main/ai/` and `src/main/parse/` (RESEARCH Pattern 1; makes the pipeline vitest-drivable with a fake client, no Electron, no network)

Each module takes a `deps` interface with `?`-optional side-effecting collaborators, defaulting to the real implementation via `deps.x ?? realX`. Tests inject fakes; production omits `deps`. From `scan.ts`:

```typescript
export interface ScanDeps {
  inboxPath?: string
  db?: Database.Database
  isNotMaterialized?: (fullPath: string, siblingNames: Set<string>, fileName: string) => Promise<boolean>
  isSettled?: (fullPath: string) => Promise<boolean>
  sha256File?: (fullPath: string) => Promise<string>
}

export async function runScan(deps: ScanDeps = {}): Promise<ScanResult> {
  const db = deps.db ?? getDatabase()               // real singleton unless injected
  const inboxPath = deps.inboxPath ?? resolveInboxPath({ db }).path
  const hashFile = deps.sha256File ?? sha256File    // test spy proves "bytes-last"
  const settled = deps.isSettled ?? ((p) => isSettled(p))
  // ...
}
```

For Phase 3, `ParseDeps` carries `{ db?, client?: OpenAIClientLike, readFile?, now? }` (RESEARCH lines 246-252) and `AiDeps` carries `{ client?, secretStore? }`. The `client` default is the real `openai` SDK instance from `ai/client.ts`; in tests it is the shared fake `OpenAIClientLike` double (records calls, returns canned/schema-valid or throwing responses). `now?: () => string` is the ISO clock, frozen in tests — same role as `localDateStamp()` in scan.

### Shared Pattern C — Per-file error isolation (flag-and-continue, D-15)
**Source:** `src/main/ingestion/scan.ts` lines 110-131
**Apply to:** the batch loop in `src/main/parse/pipeline.ts` (D-15 mirrors Phase 2 WR-01 exactly)

One file's failure never aborts the batch. Wrap each file's work in try/catch; on throw, record a recoverable "needs attention / retry" status and continue. From `scan.ts`:

```typescript
try {
  if (await notMaterialized(fullPath, siblingNames, name)) {
    files.push({ filename: name, status: 'not-ready-skipped' })
    continue
  }
  const st = await stat(fullPath)
  const hash = await hashFile(fullPath)
  files.push({ filename: name, status: 'loaded', hash, sizeBytes: Number(st.size) })
} catch {
  files.push({ filename: name, status: 'not-ready-skipped' }) // benign, surfaced for re-scan
}
```

In `pipeline.ts` the caught state is a `parse-failed` row (the D-15 "retry just the failed ones" surface); the SDK's own transient-error retry (`maxRetries: 3`, D-25) sits INSIDE this try/catch, so a file that still fails after retries becomes one failed row without aborting the batch.

### Shared Pattern D — Zod schema at the IPC boundary
**Source:** `src/shared/schemas.ts` lines 17-37
**Apply to:** the new AI-config + parse payload schemas in `schemas.ts`

Every channel gets a named exported schema with explicit bounds; `settings:set` shows the object shape, `ingestion:scan` shows the strict-empty shape:

```typescript
export const SettingsSetSchema = z.object({
  key: z.string().min(1).max(128),
  value: z.string().max(4096)
})
// no-payload channel: reject anything smuggled in
export const ScanRequestSchema = z.object({}).strict()
```

New: `ParseBatchSchema` (array of `{ filename, hash, batchEntryDate }` mirroring `ScanFile`), `ReparseSchema` (`{ fileHash }`), `AiTestConnectionSchema` / `AiSetModelSchema`. NOTE: the AI **key + base URL never travel over an IPC payload schema** — they are read main-side from `secret-store` (D-05); only the non-secret model id and a boolean/`connection-ok` result cross the boundary. The `BillSchema` (the model-output Zod gate, RESEARCH lines 528-538) also lives here or in `parse/validate.ts` — it is the authoritative re-validation layer per RESEARCH Pattern 3.

### Shared Pattern E — Branded renderer conventions
**Source:** `SettingsScreen.tsx`, `BillsScreen.tsx`, `HealthIndicator.tsx`, `ui/badge.tsx`
**Apply to:** the AI-config section and the parse-status surface (D-18)

- Renderer does ZERO direct fs/db/network; everything goes through `window.api.*` (preload). See `SettingsScreen.tsx` lines 24-38 and `BillsScreen.tsx` lines 141-159.
- All colors are semantic theme classes (`text-muted-foreground`, `text-destructive`, `bg-card`, `text-success`), NEVER hardcoded hex.
- Error surfaces use the exact recoverable-error block from `BillsScreen.tsx` lines 196-203 / `SettingsScreen.tsx` lines 73-80 (`role="alert"`, `border-destructive/30 bg-destructive/10`).
- Async effect + `cancelled` guard for on-mount loads (`SettingsScreen.tsx` lines 24-38).
- `Badge` variants available: `default | secondary | destructive | outline | ghost | link` (`ui/badge.tsx` lines 11-22).

---

## Pattern Assignments

### `src/shared/ipc-contract.ts` (config/contract, request-response)

**Analog:** itself — the existing `settings`/`secrets`/`ingestion` groups (lines 18-124)

Add to the `Channels` const (types + string constants ONLY; zero runtime imports — this file is imported by the sandboxed preload). Follow the existing grouped-with-comment style, lines 18-31:

```typescript
export const Channels = {
  // ...existing...
  ingestionScan: 'ingestion:scan',
  // ai channel group (Phase 3): config + live model list + selected-model persistence
  aiTestConnection: 'ai:test-connection',
  aiListModels: 'ai:list-models',
  aiSetModel: 'ai:set-model',
  // parse channel group (Phase 3): batch parse + single re-parse + progress broadcast
  parseBatch: 'parse:parse-batch',
  parseReparse: 'parse:reparse',
  parseProgress: 'parse:progress' // main->renderer broadcast (mirrors themeChanged)
} as const
```

Add API interfaces mirroring `IngestionApi` (lines 107-111) and result types mirroring `ScanFile`/`ScanResult` (lines 84-99). The parse result type reuses the `ScanFile.hash` (SHA-256) as the join key. Add `ModelInfo` (with all rich OpenRouter fields optional, RESEARCH lines 427), `ParseFileStatus` (`parsed | parse-failed | cached`), `ParsedFields`, and per-field `confidence` types. The `theme` broadcast pattern is the model for `parseProgress`: `ParseApi.onProgress(cb)` returns an unsubscribe fn exactly like `ThemeApi.onChange` (lines 67-70). Finally append `ai` and `parse` to the `Api` interface (lines 119-124).

---

### `src/shared/schemas.ts` (config/validation, request-response)

**Analog:** itself (lines 17-37) — see Shared Pattern D. Add `AiTestConnectionSchema`, `AiSetModelSchema`, `ParseBatchSchema`, `ReparseSchema`, and the model-output `BillSchema` (RESEARCH lines 528-538). Keep the same explicit `.min()/.max()` bounds discipline.

---

### `src/main/ipc/ai.ts` (controller, request-response)

**Analog:** `src/main/ipc/ingestion.ts` (lines 20-44) + `src/main/ipc/secrets.ts` (lines 20-43, for reading `secret-store`)

Copy the `registerAiIpc()` export + `ipcMain.handle` structure verbatim (Shared Pattern A). Three handlers:
- `ai:test-connection` — reads key+baseURL from `secret-store` main-side, builds the client (`ai/client.ts`), calls `client.models.list()` once (D-04: validate + populate in one step), classifies vision (`ai/models.ts`), returns `{ ok: true, models }` or a plain recoverable error `{ ok: false }`. NEVER returns the key.
- `ai:list-models` — same list+classify path (re-fetch).
- `ai:set-model` — writes the non-secret model id to `app_settings` via the existing `settings` prepared-statement path (D-05); the `secrets.ts` handler (lines 21-27) is the template for the "read from store, no secret crosses the boundary" discipline.

Error handling: return the plain recoverable shape (like `ingestion.ts` chooseInbox), never leak a raw stack — mirror `secrets.ts` lines 24-26 graceful-null-on-unavailable.

---

### `src/main/ipc/parse.ts` (controller, request-response + event-driven)

**Analogs:** `src/main/ipc/ingestion.ts` (handler shape) + `src/main/ipc/theme.ts` (lines 22-27, the broadcast)

Two `ipcMain.handle` handlers (`parse:parse-batch`, `parse:reparse`) following Shared Pattern A, delegating to `parse/pipeline.ts` (like `ingestion.ts` delegates to `runScan`). Progress streams via a main->renderer broadcast copied from `theme.ts`:

```typescript
// theme.ts lines 22-27 — copy this for parse:progress
nativeTheme.on('updated', () => {
  const isDark = nativeTheme.shouldUseDarkColors
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(Channels.themeChanged, isDark)
  }
})
```

For parse: the pipeline emits `{ done, total, filename, status }` progress; the handler forwards each via `win.webContents.send(Channels.parseProgress, progress)` to the sender window (or all windows) — the "parsing N/M" surface (D-26). The broadcast is main-initiated, so there is no sender to validate on that path (theme.ts comment lines 8-9).

---

### `src/main/ipc/register.ts` (config, request-response)

**Analog:** itself (lines 8-19). One-line-per-group addition:

```typescript
import { registerAiIpc } from './ai'
import { registerParseIpc } from './parse'
// ...inside registerIpc():
registerAiIpc()
registerParseIpc()
```

---

### `src/main/ai/client.ts` (service, request-response)

**Analogs:** `src/main/secrets/secret-store.ts` (lines 40-61, the `secretStore.get()` it reads from) + `scan.ts` deps style (Shared Pattern B)

`buildClient(deps)` reads the key + base URL from `secretStore.get('ai-api-key')` / `secretStore.get('ai-base-url')` (or `secretStore` injected for tests), validates the base URL is a well-formed https URL (RESEARCH Security V14), and returns `new OpenAI({ apiKey, baseURL, maxRetries: 3, timeout: 120000 })` (D-25). The `secret-store.ts` `get()` returning `string | null` (lines 57-61) is the exact read shape. The client instance is what `ParseDeps.client` / `AiDeps.client` default to.

---

### `src/main/ai/models.ts` (service, request-response / transform)

**Analog:** `src/main/ingestion/scan.ts` — the classify-each-entry loop (lines 73-101) is the structural analog for classify-each-model

`listModels(deps)` calls `client.models.list()`, then maps each returned model through `classifyVision()` (D-02): metadata-first (`architecture.input_modalities` includes `'image'`) -> curated regex (`vision-families.ts`) -> unbadged. Zod-parse each entry with a lenient `ModelInfoSchema` (all rich fields optional, RESEARCH lines 427) so OpenRouter's extra fields survive and OpenAI's minimal shape degrades gracefully to the curated fallback. Injectable `client` per Shared Pattern B so tests drive OpenAI-minimal vs OpenRouter-rich shapes without a network.

---

### `src/main/ai/vision-families.ts` (utility, transform)

**Analog:** `src/main/ingestion/hash.ts` (lines 1-17) — a small, pure, zero-Electron helper module with a single focused export. (The Phase 2 `ingestion/filetype.ts` `isSupported()` classifier is the closest structural sibling — a curated matcher list — though grounded here in the hash.ts "tiny pure module" convention.)

Export the curated vision-family regex/matchers (gpt-4o, gpt-4.1, o-series vision, claude sonnet/opus, gemini, llama-vision, qwen-vl, pixtral — RESEARCH lines 434-436) as a pure function `isKnownVisionFamily(id: string): boolean`. No side effects, directly unit-testable like `hash.ts`.

---

### `src/main/parse/route.ts` (service, transform/routing)

**Analog:** `src/main/ingestion/scan.ts` classify+gate loop (lines 73-131) — the "layered signals decide a per-item route" pattern

Implements the D-20 Docling-style layered gate per page: (1) painted-bitmap coverage >= 0.75 -> image-only; (2) >0.90 glyph-show ops under text-render-mode 3 -> image-only; (3) >=50 non-whitespace chars AND >=1 embedded font -> native; (4) else image-only; whole PDF native iff >=50% pages native. Signals come from `unpdf.extractText` (char count) and `pdfjs page.getOperatorList()` (`OPS.paintImageXObject`, `TextRenderingMode.INVISIBLE = 3`). Thresholds are module constants tunable via committed fixtures (mirror how scan.ts keeps its gates injectable). Injectable deps for the pdf loader so route.ts is fixture-tested.

---

### `src/main/parse/extract-pdf.ts` (service, file-I/O + transform)

**Analog:** `src/main/ingestion/hash.ts` (lines 8-17) — the "read file bytes main-side, stream, return a value" byte-access convention

`unpdf.extractText` for the embedded text (native path) + pdfjs render-to-JPEG via `@napi-rs/canvas` (D-19) for the page image. RESEARCH Pitfall 1 (lines 465-468): `renderPageAsImage` needs `configureUnPDF` with the official build + a canvas provider — cover with a fixture test. Byte access stays main-only (Phase 1 boundary, same as hash.ts). Injectable file reader per Shared Pattern B.

---

### `src/main/parse/prep-image.ts` (service, file-I/O + transform)

**Analog:** RESEARCH Code Example (lines 500-519) grounded in `hash.ts` byte-access convention

HEIC-decode-before-sharp pipeline. Copy the RESEARCH example directly:

```typescript
const LONG_EDGE = 2000
export async function prepImage(bytes: Buffer, ext: string): Promise<Buffer> {
  let input = bytes
  if (ext === '.heic' || ext === '.heif') {
    input = Buffer.from(await convert({ buffer: bytes, format: 'JPEG', quality: 0.9 })) // Pitfall 2
  }
  return sharp(input)
    .rotate()                                              // EXIF orient (Pitfall 3)
    .resize({ width: LONG_EDGE, height: LONG_EDGE, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 80 })
    .toBuffer()
}
```

No direct code analog (Phase 2 never decoded/resized images); use the RESEARCH example verbatim as the starting point.

---

### `src/main/parse/extract-fields.ts` (service, request-response/network)

**Analog:** `scan.ts` injectable-deps style for structure; the vision call itself is novel (RESEARCH Code Example lines 522-546)

Builds the text-before-image content array (D-23 prompt from `prompt.ts`), calls the vision model with the D-25 structured-output fallback ladder (strict `json_schema` via `zodResponseFormat` -> `json_object`+schema-in-prompt -> plain-prompt JSON), then re-validates with the local `BillSchema` (authoritative — RESEARCH Pattern 3). The `client` is injectable (`ParseDeps.client`) so tests use the fake `OpenAIClientLike`. D-22 second-pass agreement (image-only docs, both temp 0) lives here behind a config flag. This is the one file with no in-repo analog for its core (vision) behavior — the planner should reference RESEARCH lines 522-546 and Directive 6.

---

### `src/main/parse/prompt.ts` (config/constant, n/a)

**Analog:** none — new. Single exported constant holding the D-23 prompt verbatim (RESEARCH Directive 4, lines 347-365): system message + text-before-image ordering, "image is ground truth / text is noisy reference", "return null if absent, never invent", only `vendor` + `total` non-null-required, money as raw printed string. Keep it as one diffable/testable constant (the CONTEXT D-23 instruction).

---

### `src/main/parse/validate.ts` (service/utility, transform)

**Analog:** `src/main/ingestion/hash.ts` (pure-function module convention) + RESEARCH Code Example (lines 549-565)

The Zod deterministic gate: `toCents` string->integer-cents coercion, date->ISO normalization, and the arithmetic cross-check that runs ONLY when both operands present within a ~2-cent tolerance (D-10/D-12). Copy the RESEARCH `toCents` and `arithmeticOk` directly:

```typescript
const ROUNDING_TOLERANCE = 2
function arithmeticOk(sub: number | null, tax: number | null, total: number): boolean | null {
  if (sub == null || tax == null) return null // not applicable — do NOT flag (D-10)
  return Math.abs(sub + tax - total) <= ROUNDING_TOLERANCE
}
```

Pure and directly unit-testable like `hash.ts` (PARSE-04 test map). STRICT-table note (RESEARCH Pitfall 8): store flags as TEXT/INTEGER, never boolean.

---

### `src/main/parse/confidence.ts` (service/utility, transform)

**Analog:** none direct — new. Deterministic-weighted per-field confidence (D-11): grounding (value appears verbatim in source text) + format-parse + arithmetic decide the flag; model self-report is advisory-only (mainly the category guess). Emits `'high' | 'low' | 'flagged'` per field (flag-and-keep, D-12). Pure function, unit-tested (PARSE-04 confidence test). Grounds on the D-11/D-12 spec, not an in-repo analog.

---

### `src/main/parse/cache.ts` (model/data-access, CRUD)

**Analog:** `src/main/ipc/settings.ts` prepared-statement pattern (lines 22-40) + `src/main/ingestion/ledger.ts` (`checkPostedHash`, referenced from `scan.ts` line 27/155)

Read-and-write the `parsed_results` table by `file_hash`, using prepared statements bound (never interpolated), exactly like settings.ts:

```typescript
// settings.ts lines 22-26 — the prepared-statement idiom to copy
const getStmt = db.prepare('SELECT value FROM app_settings WHERE key = ?')
const setStmt = db.prepare(
  'INSERT INTO app_settings (key, value) VALUES (@key, @value) ' +
    'ON CONFLICT(key) DO UPDATE SET value = excluded.value'
)
```

Cache-first, cache-last (RESEARCH Pattern 2): the first pipeline step is `SELECT ... WHERE file_hash = ?`; a hit returns without any model call (the PARSE-05 "cache-hit-no-recall" test). Key on `file_hash` ALONE (RESEARCH Pitfall 7) — a model switch stores a new `model` value but does NOT invalidate; only an explicit re-parse or a `schema_version` bump does. `db` is injectable per Shared Pattern B (tests use a real temp DB like `migrate.test.ts`).

---

### `src/main/parse/pipeline.ts` (service/orchestrator, batch + event-driven)

**Analog:** `src/main/ingestion/scan.ts` `runScan` (lines 51-179) — THE structural template

`parseBatch(files, deps: ParseDeps)` mirrors `runScan(deps: ScanDeps)`: resolve injectable deps at top (Shared Pattern B), loop each loaded file with per-file try/catch isolation (Shared Pattern C), emit progress per file, aggregate a summary. Per-file body runs the 6 steps: cache lookup (`cache.ts`) -> route (`route.ts`) -> extract (`extract-pdf.ts`/`prep-image.ts`) -> vision (`extract-fields.ts`) -> validate+confidence (`validate.ts`/`confidence.ts`) -> cache write. The cache-first check makes the SDK client never fire on a hit. `now?: () => string` injectable clock like scan's `localDateStamp()`.

---

### `src/main/db/migrate.ts` (config, n/a)

**Analog:** itself (lines 18-26). Append `migration0003` to the array; never renumber:

```typescript
import { migration0003 } from './migrations/0003_parsed_results'
const migrations: Migration[] = [migration0001, migration0002, migration0003]
```

---

### `src/main/db/migrations/0003_parsed_results.ts` (migration, n/a)

**Analog:** `src/main/db/migrations/0002_dedupe.ts` (lines 17-30) — exact STRICT-table template

Copy the `export const migrationNNNN = { version, up(db) { db.exec(...) } }` shape. `0002` shows `hash TEXT PRIMARY KEY` as both uniqueness + O(log n) lookup — `parsed_results` uses `file_hash TEXT PRIMARY KEY` identically (D-24). Money as INTEGER cents; per-field confidence + validation flags + raw response as TEXT (JSON blobs); no boolean columns (RESEARCH Pitfall 8). Use the D-24 DDL from RESEARCH lines 393-414:

```typescript
export const migration0003 = {
  version: 3,
  up(db: Database.Database): void {
    db.exec(
      `CREATE TABLE IF NOT EXISTS parsed_results (
         file_hash          TEXT PRIMARY KEY,   -- Phase 2 SHA-256 (cache key, D-14)
         original_filename  TEXT NOT NULL,
         route              TEXT NOT NULL,       -- 'native' | 'image-only'
         page_count         INTEGER NOT NULL,
         model              TEXT NOT NULL,       -- never silently recharge on model switch (D-14)
         base_url_host      TEXT,                -- host only, NEVER the key (D-05)
         vendor             TEXT,
         invoice_number     TEXT,
         invoice_date       TEXT,                -- ISO after Zod normalize
         due_date           TEXT,
         subtotal_cents     INTEGER,             -- nullable (D-10)
         tax_cents          INTEGER,             -- nullable
         total_cents        INTEGER NOT NULL,    -- required (D-09)
         currency           TEXT,
         suggested_category TEXT,
         field_confidence   TEXT NOT NULL,       -- JSON blob (5a-A)
         validation_flags   TEXT,                -- JSON (D-12)
         raw_response       TEXT,                -- nullable, audit (5b-A)
         parsed_at          TEXT NOT NULL,       -- ISO
         schema_version     INTEGER NOT NULL     -- prompt/schema bump can force re-parse
       ) STRICT;`
    )
  }
}
```

Extend `test/migrate.test.ts` (lines 45-91): assert `user_version` reaches 3, table set becomes `['app_settings', 'posted_file_hashes', 'parsed_results']`, and the `parsed_results` columns match.

---

### `src/renderer/src/screens/SettingsScreen.tsx` (component, request-response)

**Analogs:** itself (lines 19-83) + `HealthIndicator.tsx` (lines 24-82, the "OK / unavailable" status template)

Extend the existing placeholder at lines 60-62 ("Connection and model settings will appear here in a later update.") with the AI-config section (D-18a): base-URL presets+custom dropdown (D-03), API-key field (written via `window.api.secrets.set`), a Connect/Test button (`window.api.ai.testConnection`), and an "AI connection: OK / error" status that MIRRORS `HealthIndicator` (D-04). Copy the HealthIndicator status structure (lines 47-81): `text-success` on OK, `text-destructive` on error, the `rounded-xl border border-border bg-card p-4` card shell. The model picker renders the classified list with a vision `Badge` (D-01/D-02) and the "use anyway" confirm gate for unbadged models. Reuse the recoverable-error block (lines 73-80) for a bad key/URL. Persist the selected model via `window.api.ai.setModel` (writes `app_settings`).

---

### `src/renderer/src/screens/BillsScreen.tsx` (component, event-driven + request-response)

**Analogs:** itself (lines 117-306, the loaded-results list) + the `theme.onChange` subscribe pattern (`preload/index.ts` lines 31-35) for `parse:progress`

Extend the loaded-results surface (D-18b) with per-file parse status (`parsed | parse-failed | cached`) and a "parsing N/M" indicator. Reuse the exact `STATUS_VARIANT` / `STATUS_LABEL` Badge maps (lines 35-49) and the `ScanRow` component (lines 87-115), adding parse-status badges. Fire `window.api.parse.parseBatch(loadedFiles)` after a scan (D-26, separate from the scan IPC call) and subscribe to progress via `window.api.parse.onProgress(cb)` in a `useEffect` with an unsubscribe cleanup — the SAME subscribe/unsubscribe shape as `theme.onChange` (preload lines 31-35). A `parse-failed` row gets the "Include/retry" affordance mirroring the existing `duplicate-excluded` "Include anyway" control (lines 107-111). All progress state is renderer-local, colors are semantic classes.

---

### `src/preload/index.ts` (config/bridge, request-response + event)

**Analog:** itself (lines 19-42) — the `theme.onChange` subscribe bridge (lines 31-35) is the exact template for `parse.onProgress`

Add `ai` and `parse` to the exposed `api` object. Request-response methods are thin `ipcRenderer.invoke` on the named channel constant (like `ingestion`, lines 37-41). The progress subscription copies the `theme.onChange` listener+unsubscribe shape verbatim:

```typescript
// preload lines 31-35 — copy this for parse.onProgress
onChange: (cb) => {
  const listener = (_event: IpcRendererEvent, isDark: boolean): void => cb(isDark)
  ipcRenderer.on(Channels.themeChanged, listener)
  return () => ipcRenderer.removeListener(Channels.themeChanged, listener)
}
```

Never expose `ipcRenderer` or a generic invoke (preload lines 8-11, T-01-02). The `env.d.ts` Window augmentation (lines 9-15) derives from this file's exported `Api` type automatically, so no separate renderer type change is needed.

---

## No Analog Found

Files with no close in-repo match — the planner should use the RESEARCH.md code examples and directives cited:

| File | Role | Data Flow | Reason / Source to use instead |
|------|------|-----------|--------------------------------|
| `src/main/parse/prompt.ts` | config/constant | n/a | No prompts exist yet. Use D-23 verbatim (RESEARCH Directive 4, lines 347-365). |
| `src/main/parse/confidence.ts` | service/utility | transform | No confidence scorer exists. Use D-11/D-12 spec (RESEARCH lines 27-28, 43-44). |
| `src/main/parse/extract-fields.ts` (vision call core) | service | request-response | No vision/LLM call exists in-repo. Structure from `scan.ts` deps; vision call from RESEARCH lines 522-546 + Directive 6. |

Everything else has at least a role-match analog above.

---

## Metadata

**Analog search scope:** `src/main/ipc/`, `src/main/ingestion/`, `src/main/db/` + `migrations/`, `src/main/secrets/`, `src/shared/`, `src/preload/`, `src/renderer/src/screens/`, `src/renderer/src/components/`, `test/`
**Files scanned/read:** 24 (settings.ts, ingestion.ts, secrets.ts, theme.ts, register.ts, trusted-sender.ts, scan.ts, hash.ts, migrate.ts, 0001_init.ts, 0002_dedupe.ts, ipc-contract.ts, schemas.ts, secret-store.ts, preload/index.ts, env.d.ts, SettingsScreen.tsx, BillsScreen.tsx, HealthIndicator.tsx, EmptyState.tsx, ui/badge.tsx, ingestion-scan.test.ts, migrate.test.ts, + RESEARCH/CONTEXT)
**Key architectural constraint threaded through every assignment:** renderer touches zero fs/db/network; the AI key stays main-side and never crosses IPC (D-05/D-16); every handler is `assertTrustedSender` -> Zod-parse -> work; every `ai/`+`parse/` module is `ScanDeps`-style injectable so vitest drives it with a fake OpenAI client.
**Pattern extraction date:** 2026-07-24
