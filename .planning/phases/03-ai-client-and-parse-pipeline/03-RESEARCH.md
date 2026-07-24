# Phase 3: AI Client and Parse Pipeline - Research

**Researched:** 2026-07-24
**Domain:** OpenAI-compatible vision LLM client + document parse pipeline (PDF text extraction, image prep, structured extraction, deterministic validation, SQLite result cache) inside an Electron main process
**Confidence:** HIGH on stack/versions/seams; MEDIUM on the six open design directives (they are genuinely tradeoff decisions surfaced as options for Anthony, per the process directive)

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions (D-01..D-18 — settled; research supports implementation, does NOT reopen)

**AI Client Configuration (AI-01..04)**
- **D-01:** Vision-capability handling is **flag + confirm**, not filter. Picker shows every model the endpoint returns, badges confirmed vision-capable ones; selecting a non-vision/unbadged model requires an explicit "use anyway" confirmation.
- **D-02:** Vision detection is **metadata-first with a curated fallback**. Use endpoint capability metadata when present (e.g. OpenRouter `architecture.input_modalities` containing `image`); when absent (OpenAI `/models`, custom gateways) fall back to a small maintained list of known vision-capable families (gpt-4o, gpt-4.1, o-series vision, Claude sonnet/opus, Gemini, Llama/Qwen vision). Anything still unconfirmed stays unbadged and hits the D-01 confirm gate.
- **D-03:** Base URL entry is **presets + custom**: dropdown with OpenAI and OpenRouter presets that auto-fill the base URL, plus a "Custom" free-text option for any OpenAI-compatible endpoint.
- **D-04:** A **Connect/Test action calls `/models` once** — success validates key + base URL AND populates the picker in one step. Surface as an "AI connection: OK / error" status mirroring the existing "Secret store: OK" HealthIndicator. A bad key/URL shows a plain recoverable error (Phase 2 chooseInbox error shape, CR-01/WR-04).
- **D-05 (carried from Phase 1):** API key and base URL stored in the **OS keychain via the Phase 1 `secrets` safeStorage IPC channel** — never SQLite, never plaintext. Selected model id (non-secret) lives in `app_settings` via `settings:get/set`.

**Parse Routing (PARSE-01/02)**
- **D-06:** For native/digital PDFs with an authoritative embedded text layer, use **belt-and-suspenders**: send BOTH the exact embedded text (unpdf) AND the rendered page image (pdfjs-dist) to the vision model, **text before image**, image declared ground truth and text a reference transcription.
- **D-07:** **Scanned/image-only PDFs and all photos go image-only to vision** (no text pairing). Prep: heic-convert (HEIC->JPEG) -> sharp (EXIF auto-orient, downscale, re-encode JPEG). Applies to JPEG, PNG, HEIC, and image-only PDFs (rendered to a bitmap).
- **D-08:** Native-vs-scan decision uses a **robust layered gate**, not naive text-presence. Native-with-authoritative-text only when real text extracts AND it is not merely an invisible OCR overlay over a full-page image. Signals: text present, embedded fonts, low bitmap coverage, not text-render-mode-3. Otherwise route image-only. (Exact thresholds = research directive 1.)

**Extraction, Confidence & Validation (PARSE-03/04)**
- **D-09:** Model returns a **strict structured JSON schema** with optional fields **nullable + explicit "return null if absent"**. Field set mirrors Azure prebuilt-invoice: vendor, invoice/reference number (nullable), invoice date, due date (nullable), subtotal (nullable), tax (nullable), total, suggested category (nullable).
- **D-10:** **Zod is the deterministic gate**: coerce money to **integer cents**, parse/normalize dates to ISO, enforce types. Do NOT enforce `subtotal + tax = total` when tax or subtotal is null.
- **D-11:** Per-field confidence is **hybrid, deterministic-weighted**. Grounding (value appears verbatim in source text?), format/parse success, and arithmetic cross-checks decide the flag. Model self-reported confidence is **advisory only** (mainly the category guess). LLM self-report is never the gate. For photos/scans with no embedded text, grounding leans on format+arithmetic; research may weigh a cheap second-pass cross-call agreement check.
- **D-12:** On a failed deterministic check, **flag-and-keep** — never reject, never silently auto-correct. Failed check -> visible per-field/row warning consumed by Phase 6 (REVIEW-07); values kept, nothing blocked. **Small rounding tolerance** (a couple of cents) on `subtotal + tax = total`. Validation flag is **independent of model confidence**.

**Parse Trigger, Persistence & Caching (PARSE-05)**
- **D-13:** **Auto-parse right after the scan.** Scan -> immediately parse every loaded (non-duplicate, ready) file -> results ready for review.
- **D-14:** **Cache parsed results keyed on the Phase 2 SHA-256 file hash**, so reload/crash/re-scan never re-calls the model for the same bytes (PARSE-05). Store which model produced each result. Switching the selected model does NOT silently re-charge cached docs; a per-doc (and/or batch) **"Re-parse" override** forces a fresh call.
- **D-15:** Batch-parse failures **flag-and-continue with per-file isolation**. One doc failing becomes a "needs attention / retry" row while the rest proceed; show progress ("parsing 3/12"); allow retrying just the failed ones. Mirrors Phase 2 WR-01.

**Architecture / Trust Boundary (carried from Phases 1-2)**
- **D-16:** All AI network calls, PDF/text extraction, image prep, DB writes run in the **Electron main process** behind the typed IPC boundary. Renderer touches none directly — new AI/parse IPC channel group in `src/shared/ipc-contract.ts`, handled via the `settings.ts`/`ingestion.ts` pattern (assertTrustedSender -> Zod-parse -> work). OpenAI-compatible client instantiates main-side; API key read from keychain in main, never crosses to renderer.
- **D-17:** Parsed-results cache is a new forward-only migration (`migration0003`) appended to `src/main/db/migrate.ts`, owned by Phase 3, mirroring the `0001`/`0002` STRICT-table style. Keyed on SHA-256 file hash; stores validated fields, per-field confidence, model used, timestamp, and (planner's discretion) raw model response.
- **D-18:** Phase 3's UI surface is two things: (a) AI-config section on the **Settings screen** (extending the existing placeholder), and (b) a **parse-status/progress surface on the Bills screen** extending the Phase 2 loaded-results list. Rich editable review table stays in Phase 6. Reuse Phase 1 branded components (Badge, Button, EmptyState, HealthIndicator).

### Claude's Discretion (research + planning decide; see Research Directives section)
Exact "weak text layer" / native-vs-scan thresholds, multi-page PDF handling, prompt/instruction wording, exact parsed-results cache schema, image downscale dimensions and JPEG quality, IPC channel names/shapes, retry/backoff policy, and whether photos get a second-pass agreement check.

### Deferred Ideas (OUT OF SCOPE)
- Matching parsed vendor/category against real QuickBooks records — Phase 5.
- Rich editable review table (searchable dropdowns, Bill/Expense toggle, "Paid from", confidence filtering, duplicate warnings) — Phase 6.
- Posting, audit, undo, reporting — Phase 7. QuickBooks connection/OAuth — Phase 4.
- Multi-line itemized category splitting (V2-01), multiple invoices split out of one PDF (V2-02), vendor->category learning (V2-05). **Phase 3 assumes one bill per file.**
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| AI-01 | Enter OpenAI-compatible API key + base URL, stored in OS keychain | Reuse Phase 1 `secrets` safeStorage channel (D-05); `openai` SDK `new OpenAI({ apiKey, baseURL })`. Directive 6 covers client details. |
| AI-02 | Fetch model list from endpoint, let user pick | `client.models.list()` (GET `/v1/models`). Directive 6 documents OpenAI vs OpenRouter response shapes. |
| AI-03 | Flag/filter vision-capable models so user does not pick text-only | D-01/D-02 flag+confirm with metadata-first detection. Directive 6 gives the exact metadata field paths + curated fallback list. |
| AI-04 | Change selected model any time | Selected model id in `app_settings` via `settings:set` (non-secret). |
| PARSE-01 | Extract embedded text from text PDFs before calling model | `unpdf.extractText` (fast path) + the native-vs-scan gate (Directive 1). |
| PARSE-02 | Prepare photos/scans (orient, resize, HEIC decode) before model | heic-convert -> sharp pipeline (Code Examples); image sizing in Directive 2/pitfalls. Image-only PDFs need canvas rendering (see Standard Stack note + Open Questions). |
| PARSE-03 | Extract structured fields via configured vision model | Structured-outputs strict JSON schema (D-09) + prompt design (Directive 4). |
| PARSE-04 | Validate deterministically (subtotal+tax=total, dates parse, money as integer cents) + per-field confidence | Zod gate (D-10) + hybrid deterministic confidence (D-11/Directive 3). Validation Architecture section maps each assertion. |
| PARSE-05 | Persist parsed results so reload/crash never re-calls paid model | `migration0003` cache keyed on SHA-256 hash (D-14/D-17, Directive 5). |
</phase_requirements>

## Summary

Phase 3 has two decoupled halves that share one trust-boundary pattern. The **AI-config half** is a thin Settings surface over the already-built `secrets` and `settings` IPC channels plus the `openai` SDK's `models.list()` — the only genuinely new external interaction is reading a live model list and classifying vision capability, where OpenAI and OpenRouter return materially different response shapes. The **parse half** is a main-process pipeline: route each loaded file (native-PDF vs image/scan), extract-or-render, call the vision model with a strict JSON schema, run a Zod deterministic gate that coerces money to integer cents and cross-checks arithmetic, compute a deterministic-weighted per-field confidence, and cache the result keyed on the Phase 2 SHA-256 hash so the paid model is never re-called for the same bytes.

Every library is already chosen and version-locked in CLAUDE.md and all five (`openai`, `unpdf`, `pdfjs-dist`, `sharp`, `heic-convert`) pass slopcheck `[OK]` with millions of weekly downloads and official repos. There is **one gap in the locked stack**: rendering an image-only PDF page to a bitmap (D-07) requires a canvas implementation in the Node/Electron main process, which the locked stack does not name. `@napi-rs/canvas` is the recommended addition (prebuilt N-API binary, no electron-rebuild needed). This is flagged for Anthony in Open Questions rather than silently locked.

The bulk of the real work is the **six open design directives**. Each is presented below as a decision with 2-3 concrete options, a recommendation, and an "Anthony picks" marker — per the explicit process directive that research surfaces options and does not unilaterally lock still-open decisions.

**Primary recommendation:** Build the parse pipeline as pure, dependency-injected main-process modules (mirroring the Phase 2 `ingestion/` module style: injectable OpenAI client, injectable file reader, so vitest drives them without Electron or a network), gate every model output through Zod before it touches the cache, and make the SHA-256 cache the first thing every parse checks and the last thing it writes.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| AI key + base URL storage | Main (safeStorage) | — | Secret material never crosses to renderer (D-05/D-16); reuses Phase 1 secret-store |
| Model list fetch + vision classification | Main (openai SDK) | Renderer (display/pick) | Network call + API key live main-side; renderer only renders the classified list and captures the pick |
| Selected model id persistence | Main (app_settings) | Renderer (read for display) | Non-secret; reuses `settings:get/set` |
| Native-vs-scan routing | Main (unpdf + pdfjs) | — | Filesystem + PDF parsing are privileged; never in renderer |
| PDF text extraction | Main (unpdf) | — | Byte access is main-only (Phase 1 boundary) |
| Image prep (HEIC decode, orient, resize) | Main (heic-convert + sharp) | — | Native modules + file bytes, main-only |
| PDF-page-to-bitmap render | Main (pdfjs-dist + canvas) | — | Rendering needs a Node canvas; main-only |
| Vision model call | Main (openai SDK) | — | API key + network, main-only |
| Deterministic validation (Zod, cents, arithmetic) | Main (parse module) | — | Runs on the model output before caching; pure, testable |
| Per-field confidence computation | Main (parse module) | — | Deterministic grounding/format/arithmetic logic |
| Parsed-results cache read/write | Main (better-sqlite3) | — | DB is main-only; keyed on hash |
| Parse trigger (auto after scan) | Main (chains off runScan) | Renderer (Scan now button) | Renderer initiates the scan; main orchestrates scan->parse |
| Parse status / progress UI | Renderer (Bills screen) | Main (emits progress) | Presentation only; extends Phase 2 results list |

## Standard Stack

### Core (all locked in CLAUDE.md; versions verified 2026-07-24)

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `openai` | 6.49.0 | OpenAI-compatible client: chat+vision, `models.list()`, structured-output helpers | Official SDK; `baseURL` swap targets OpenAI/OpenRouter/any compatible gateway unchanged. [VERIFIED: npm registry] [CITED: github.com/openai/openai-node] |
| `unpdf` | 1.7.0 | Fast-path embedded-text extraction + per-page text + `getMeta`/`renderPageAsImage` | Modern PDF.js wrapper (UnJS); clean `extractText` returning `{ totalPages, text }`. [VERIFIED: npm registry] [CITED: unjs.io/packages/unpdf] |
| `pdfjs-dist` | 6.1.200 | Operator-list access (invisible-text / bitmap-coverage signals) + page render | Mozilla PDF.js; `page.getOperatorList()` exposes `fnArray`/`argsArray` for the native-vs-scan gate. [VERIFIED: npm registry] |
| `sharp` | 0.35.3 | EXIF auto-orient, downscale, re-encode JPEG | Fastest image pipeline; `rotate()` applies EXIF orientation; already the app's one native-module precedent. [VERIFIED: npm registry] |
| `heic-convert` | 2.1.0 | HEIC/HEIF -> JPEG decode (pure JS/WASM) | sharp's prebuilt libvips cannot decode HEIC; decode first, then sharp. [VERIFIED: npm registry] |
| `zod` | 4.4.3 (installed) | Deterministic validation gate on model output | Already the IPC boundary validator; `zodResponseFormat` helper converts a Zod schema to the strict json_schema the API wants. [VERIFIED: package.json] |
| `better-sqlite3` | 13.0.1 (installed) | Parsed-results cache (`migration0003`) | Already the app's DB; synchronous prepared statements. [VERIFIED: package.json] |

### Supporting / Required Addition (NOT in locked stack — flag for Anthony)

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `@napi-rs/canvas` | 1.0.2 | Node canvas backend so pdfjs-dist / `unpdf.renderPageAsImage` can rasterize an image-only PDF page to a bitmap | Required by D-07 ("image-only PDFs rendered to a bitmap"). Prebuilt N-API binary, ~17M weekly downloads, no postinstall, **N-API is ABI-stable so it does NOT need electron-rebuild** (unlike better-sqlite3/sharp). [VERIFIED: npm registry] [ASSUMED: no-rebuild claim — confirm at build time] |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| `@napi-rs/canvas` | `canvas` (node-canvas 3.2.3) | node-canvas needs Cairo/native build headaches; @napi-rs ships prebuilt binaries. Prefer @napi-rs. |
| Render PDF page -> image ourselves | Send PDF bytes directly to a provider that accepts PDF (OpenAI Responses file input, some OpenRouter models) | Provider-dependent and breaks the "any OpenAI-compatible endpoint" contract; keep the render-to-image path for portability. |
| `zodResponseFormat` strict json_schema | Manual JSON-schema literal | Zod schema is already the validation source of truth; generating json_schema from it keeps one definition. |

**Installation:**
```bash
npm install openai@6.49.0 unpdf@1.7.0 pdfjs-dist@6.1.200 sharp@0.35.3 heic-convert@2.1.0
# Only if Anthony approves the canvas addition (Open Question OQ1):
npm install @napi-rs/canvas@1.0.2
```

**Version verification (run 2026-07-24, `npm view <pkg> version time.modified`):** openai 6.49.0 (2026-07-23), unpdf 1.7.0 (2026-07-24), pdfjs-dist 6.1.200 (2026-06-27), sharp 0.35.3 (2026-07-01), heic-convert 2.1.0 (2023-11-30, stable/mature), @napi-rs/canvas 1.0.2 (2026-06-30). CLAUDE.md pins openai 6.48.0 and unpdf 1.6.2; both moved forward one minor since (6.49.0 / 1.7.0). Recommend adopting the current patch/minor; no breaking changes indicated. [VERIFIED: npm registry]

## Package Legitimacy Audit

Slopcheck 0.6.1 run in `scan` mode against a temp manifest (avoids the install side-effect). All `[OK]`.

| Package | Registry | Age | Downloads | Source Repo | slopcheck | Disposition |
|---------|----------|-----|-----------|-------------|-----------|-------------|
| openai | npm | mature | 29.9M/wk | github.com/openai/openai-node | [OK] | Approved |
| unpdf | npm | mature | 2.0M/wk | github.com/unjs/unpdf | [OK] | Approved |
| pdfjs-dist | npm | mature | 20.9M/wk | github.com/mozilla/pdf.js | [OK] | Approved |
| sharp | npm | mature | 76.1M/wk | github.com/lovell/sharp | [OK] | Approved |
| heic-convert | npm | mature | 939K/wk | github.com/catdad-experiments/heic-convert | [OK] | Approved |
| @napi-rs/canvas | npm | mature | 17.0M/wk | github.com/Brooooooklyn/canvas | [OK] | Approved (addition — Anthony confirms per OQ1) |

**Packages removed due to slopcheck [SLOP] verdict:** none
**Packages flagged as suspicious [SUS]:** none
**Postinstall check (npm view scripts.postinstall):** all empty — no network/filesystem postinstall scripts. (The repo's own `postinstall` runs `electron-rebuild -w better-sqlite3`; the new modules do not add postinstall risk.)

## Architecture Patterns

### System Architecture Diagram

```
                         RENDERER (Bills + Settings screens)
   [Scan now] ──┐                                   [AI config form]
                │ window.api.parse.parseBatch(files)      │ window.api.ai.testConnection / listModels / setModel
                ▼                                          ▼
================ IPC trust boundary (assertTrustedSender -> Zod parse) ================
                │                                          │
      ┌─────────▼──────────┐                    ┌──────────▼───────────┐
      │  parse IPC handler │                    │   ai IPC handler     │
      │ (src/main/ipc/     │                    │ (src/main/ipc/ai.ts) │
      │       parse.ts)    │                    └──────────┬───────────┘
      └─────────┬──────────┘                               │
                │                          reads key/baseURL from secret-store (main only)
                ▼                                          │
   for each loaded file (per-file isolation, D-15):        ▼
                │                              openai SDK client.models.list()
   ┌────────────▼─────────────┐                            │
   │ 1. cache lookup by hash  │◄── HIT ──► return cached   ▼
   │    (migration0003)       │           (NO model call)  classify vision:
   └────────────┬─────────────┘                            metadata-first (OpenRouter
                │ MISS                                       architecture.input_modalities)
                ▼                                            else curated family list
   ┌────────────────────────────┐                          -> badge / unbadged (D-01 gate)
   │ 2. ROUTE (native-vs-scan   │
   │    gate, Directive 1)      │
   └──────┬──────────────┬──────┘
     native│         image-only│
          ▼                    ▼
   unpdf.extractText     heic-convert (if HEIC)
   + pdfjs render page      -> sharp (orient/resize/JPEG)
   -> {text, image}         -> {image}   (PDF: pdfjs render -> canvas -> JPEG)
          └─────────┬──────────┘
                    ▼
   ┌────────────────────────────┐
   │ 3. vision call             │  text-before-image, image=ground truth,
   │    strict json_schema      │  "return null if absent"  (Directive 4)
   │    (openai SDK, retries)   │
   └────────────┬───────────────┘
                ▼
   ┌────────────────────────────┐
   │ 4. Zod deterministic gate  │  money->cents, dates->ISO, types  (D-10)
   └────────────┬───────────────┘
                ▼
   ┌────────────────────────────┐
   │ 5. per-field confidence    │  grounding + format + arithmetic  (D-11)
   │    (deterministic-weighted)│  flag-and-keep on failure         (D-12)
   └────────────┬───────────────┘
                ▼
   ┌────────────────────────────┐
   │ 6. write cache (hash key)  │  fields + confidence + model + ts + raw?  (D-14/D-17)
   └────────────┬───────────────┘
                ▼
        ParseResult[] -> renderer  (per-file loaded/failed/cached + "parsing N/M")
```

### Recommended Project Structure

```
src/
├── shared/
│   ├── ipc-contract.ts        # add Channels.ai* + Channels.parse* + AiApi/ParseApi + result types
│   └── schemas.ts             # add AI-config + parse payload/result Zod schemas
├── main/
│   ├── ipc/
│   │   ├── ai.ts              # ai:test-connection / ai:list-models / ai:set-model handlers
│   │   ├── parse.ts           # parse:parse-batch / parse:reparse handlers
│   │   └── register.ts        # + registerAiIpc(); registerParseIpc()
│   ├── ai/
│   │   ├── client.ts          # buildClient(): reads key/baseURL from secret-store, new OpenAI()
│   │   ├── models.ts          # listModels() + classifyVision() (metadata-first + curated list)
│   │   └── vision-families.ts # curated known-vision-family matchers (D-02 fallback)
│   ├── parse/
│   │   ├── route.ts           # native-vs-scan gate (Directive 1)
│   │   ├── extract-pdf.ts     # unpdf text + pdfjs render-to-JPEG
│   │   ├── prep-image.ts      # heic-convert -> sharp pipeline
│   │   ├── extract-fields.ts  # vision call + prompt + strict schema (Directive 4)
│   │   ├── validate.ts        # Zod gate: cents, dates, arithmetic (D-10)
│   │   ├── confidence.ts      # deterministic-weighted per-field confidence (D-11)
│   │   ├── cache.ts           # read/write migration0003 by hash (D-14)
│   │   └── pipeline.ts        # orchestrates 1-6 per file with per-file isolation (D-15)
│   └── db/
│       ├── migrate.ts         # migrations array += migration0003
│       └── migrations/0003_parsed_results.ts
└── renderer/src/screens/
    ├── SettingsScreen.tsx     # + AI-config section (D-18a)
    └── BillsScreen.tsx        # + parse-status/progress surface (D-18b)
```

### Pattern 1: Injectable dependencies for testability (mirror Phase 2 `ScanDeps`)
**What:** Every main-process module takes its side-effecting dependencies as injected params with real defaults, exactly like `runScan(deps: ScanDeps)`.
**When to use:** Everywhere in `ai/` and `parse/`, so vitest drives the whole pipeline with a fake OpenAI client and in-memory buffers, no Electron and no network.
**Example:**
```typescript
// src/main/parse/pipeline.ts — the openai client, file reader, and clock are injectable
export interface ParseDeps {
  db?: Database.Database
  client?: OpenAIClientLike            // fake in tests, real openai SDK in prod
  readFile?: (p: string) => Promise<Buffer>
  now?: () => string                   // ISO timestamp, frozen in tests
}
```

### Pattern 2: Cache-first, cache-last (PARSE-05 correctness)
**What:** The first step of parsing any file is a `SELECT ... WHERE file_hash = ?`; the last step is the `INSERT`. A cache hit returns without any model call.
**When to use:** Always. This is the literal PARSE-05 guarantee and the thing the "cache-hit-no-recall" test proves.

### Pattern 3: Strict-schema structured output validated twice
**What:** Ask the provider for strict `json_schema` output (best-effort constraint), THEN re-validate with the same Zod schema locally (authoritative). Never trust the wire shape.
**When to use:** Every field extraction. Providers vary in enforcement (OpenRouter: "some guarantee schema-conforming output, others translate your schema"), so local Zod is the real gate.

### Anti-Patterns to Avoid
- **Trusting `extractText` length alone to route.** An invisible-OCR-overlay scan returns lots of text that is junk; pairing it poisons the model (the exact D-08 failure mode). Use the layered gate.
- **Enforcing `subtotal + tax = total` unconditionally.** Tax-included and no-separate-tax receipts are normal; skip the check when either operand is null (D-10).
- **Using LLM self-reported confidence as the gate.** Poorly calibrated and overconfident; it green-lights hallucinated totals (D-11). Advisory only.
- **Re-parsing on model switch.** Silently re-charges cached docs; a model change must not invalidate the cache without an explicit Re-parse (D-14).
- **Letting one file's failure abort the batch.** Per-file try/catch -> failed row + continue (D-15), exactly like `runScan`'s per-entry catch.
- **Reading the API key in the renderer.** Key stays main-side; renderer only ever sees a boolean "connection OK" and the (non-secret) model list.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| PDF text extraction | Custom PDF byte parser | `unpdf.extractText` | PDF text layout, encodings, CID fonts are a decade of edge cases |
| PDF page -> bitmap | Manual raster | `pdfjs-dist` render + `@napi-rs/canvas` | Correct CTM, fonts, annotations |
| HEIC decode | libheif bindings by hand | `heic-convert` | Patent-encumbered codec; WASM decode is turnkey |
| EXIF orientation + resize | Manual EXIF byte reads | `sharp.rotate().resize()` | `rotate()` with no args applies EXIF orientation; sideways phone receipts are the norm |
| JSON-schema from types | Hand-written json_schema literal | `zodResponseFormat(schema, 'name')` | One schema definition drives both the wire format and local validation |
| Retry/backoff on 429/5xx | Custom retry loop | openai SDK `maxRetries` | SDK retries 408/409/429/>=500 + connection errors with exponential backoff by default |
| Money math | Float dollars | Integer cents (Zod coercion) | Float rounding corrupts financial totals; store cents as INTEGER |
| Migration engine | ORM / db-push | Existing `migrate.ts` forward-only runner | Phase 1 established it; `migration0003` is one array entry |

**Key insight:** Almost every hard problem in this phase already has a maintained, high-download library in the locked stack. The genuinely novel code is small: the routing gate, the confidence scorer, the prompt, and the cache schema — which is exactly what the six directives below decide.

---

## Research Directives — Decisions for Anthony

> Per the explicit process directive, each open item is surfaced as options with tradeoffs and a recommendation. **Anthony picks.** Nothing here is locked by research.

### Directive 1 — Native-vs-scan gate thresholds (D-08)

**Signals available from the locked stack:**
- `unpdf.extractText(data, { mergePages: false })` -> `{ totalPages, text: string[] }` -> non-whitespace char count per page (soft signal). [CITED: unjs.io/packages/unpdf]
- `pdfjs` `page.getOperatorList()` -> `{ fnArray, argsArray }`. Scan `fnArray` for `OPS.paintImageXObject` / `OPS.paintInlineImageXObject` / `OPS.paintImageMaskXObject` (image paints) and for `OPS.setTextRenderingMode` with arg `3` (INVISIBLE = OCR overlay). [CITED: mozilla/pdf.js getOperatorList; TextRenderingMode.INVISIBLE = 3]
- Bitmap coverage: sum painted-image area (from the CTM/transform applied before each image paint) / page area. Reference: **Docling `bitmap_area_threshold` default 0.75** and `force_full_page_ocr`. [CITED: Docling discussion #2755, from CONTEXT research notes]
- Embedded fonts: presence of `OPS.setFont` + actual glyph-showing ops (`OPS.showText`) whose text-rendering-mode is NOT 3.

| Option | Logic | Tradeoff |
|--------|-------|----------|
| **A. Char-count + image-presence (simple)** | Native iff per-page non-whitespace chars >= ~100 AND not (a large image is painted while text is invisible). Uses `extractText` + a light operator scan. | Fastest, least code. Misses some mixed OCR-overlay cases; the ~100 char threshold is a guess. |
| **B. Docling-style layered gate (RECOMMENDED)** | Per page, in order: (1) if painted-bitmap coverage >= 0.75 of page area -> **image-only**; (2) else if >90% of glyph-show ops occur under text-render-mode 3 -> invisible OCR overlay -> **image-only**; (3) else if extracted non-whitespace chars >= ~50 AND at least one embedded font -> **native (belt-and-suspenders)**; (4) else -> **image-only**. A whole PDF is native only if a strong majority of pages are native. | Most robust; directly guards the D-08 junk-OCR failure mode; matches an industry default (0.75). More operator-list code and per-page work (fine at this volume). |
| **C. Belt-and-suspenders whenever any text extracts** | If `extractText` returns any real text, always pair text+image and let the "image is ground truth" prompt discard junk text. | Simplest routing code. Reintroduces the exact failure D-08 warns against (junk OCR text confuses the model); relies entirely on the prompt. |

**Recommendation:** **Option B** with these starting numbers, all tunable: `bitmapCoverage >= 0.75` -> image-only; `invisibleGlyphRatio > 0.90` -> image-only; native requires `chars >= 50/page` AND an embedded font; PDF is native if `>= 50%` of pages are native. Char count is a **soft** tiebreaker only, never the sole gate (matches D-08).

**Anthony picks:** ✅ **Option B (Docling-style layered gate)** — locked as D-20 in CONTEXT.md (2026-07-24).

---

### Directive 2 — Multi-page PDF handling (one bill per file; V2-02 deferred)

Problem: totals are often on the last page and line items span pages, but Phase 3 does not split invoices. It only needs correct top-level fields for one bill.

| Option | Approach | Tradeoff |
|--------|----------|----------|
| **A. Send all pages in one call (RECOMMENDED)** | Attach every page image (and, for native PDFs, the full concatenated text) in a single vision request, capped at N pages. The model sees the whole bill at once, so last-page totals and spanning line items are naturally in context. Cap N (~10-15); if exceeded, parse the first and last few pages and flag the doc for review. | Simplest; preserves cross-page context in one call; cost irrelevant at this volume. Token cost grows with pages (bounded by the cap). |
| **B. Per-page extract + app-layer merge** | Extract each page independently, then reconcile (match partial tables, dedupe headers, sum line items to total). | Needed only for very long/complex docs (not one-bill-per-file). Much more code and its own reconciliation bugs. |
| **C. First+last page heuristic** | Send only page 1 (header/vendor/invoice#) and the last page (totals). | Cheapest for long docs; fragile when fields land on middle pages; risky for a financial tool. |

**Recommendation:** **Option A.** For this app (one bill/file, low volume, accuracy-first, cost-irrelevant), a single multi-image call is both simplest and most accurate. Deterministic reconciliation stays the Zod arithmetic check (subtotal+tax=total), not page-merging. Set the cap at **10 pages**; over the cap, send pages 1..3 + last 2 and set a `truncated` flag that Phase 6 surfaces.

**Anthony picks:** ✅ **Option A (single multi-image call, cap 10)** — locked as D-21 in CONTEXT.md (2026-07-24).

---

### Directive 3 — Photo/scan confidence: add a second-pass cross-call agreement check?

Where there is no embedded text (photos, scanned/image-only PDFs), the D-11 grounding-by-verbatim-match signal is unavailable; only format-parse + arithmetic remain. Research: LLM self-consistency (agreement across samples) is a usable confidence proxy, BUT agreement is not correctness — models can agree from shared bias. [CITED: arXiv 2502.06233, 2607.08065]

| Option | Approach | Cost / latency | Tradeoff |
|--------|----------|----------------|----------|
| **A. No second call** | Confidence from format-parse + arithmetic + advisory model self-report only. | 1 call/doc | Cheapest/fastest. Weakest signal for total/vendor/date on a photo where arithmetic cannot verify (e.g. tax-included receipt: no subtotal to cross-check). |
| **B. Second-pass agreement on image-only docs (RECOMMENDED, scoped)** | For image-only docs only, make a second independent call and compare key numeric/string fields (total, subtotal, tax, invoice date, invoice #). Fields that agree -> higher confidence; disagreement -> flag for review. | 2 calls/image-only doc | Grounds confidence where nothing else can. Doubles cost on photos (negligible here). Must treat agreement as a signal, not proof. |
| **C. Targeted re-ask** | Single call; only re-call for fields that failed arithmetic or came back null. | 1-2 calls/doc | Middle ground; more branching logic; smaller confidence lift than a full second pass. |

**Recommendation:** **Option B, scoped to image-only docs**, because native PDFs already have verbatim-text grounding and do not need it. Use temperature 0 for both calls (determinism preferred over diversity for extraction) and treat a numeric mismatch as an automatic low-confidence flag (flag-and-keep, D-12). Keep it behind a config flag so it can be disabled if latency ever matters.

**Anthony picks:** ✅ **Option B (second-pass agreement, image-only docs only, both calls temp 0)** — locked as D-22 in CONTEXT.md (2026-07-24).

---

### Directive 4 — Prompt / instruction design (D-06/D-09)

Guardrails needed: text-before-image ordering, "image is ground truth / text is a reference transcription," "return null if absent," and no hallucinated fills. Recommended concrete structure:

**System message:**
```
You extract billing fields from a single vendor bill (invoice or receipt).
You return ONLY data that is actually present. If a field is not visibly present,
return null for it. Never invent, infer, or guess a value to fill a field.
The IMAGE is the ground truth. Any transcribed text provided is a NOISY reference
that may contain OCR errors; when the text and the image disagree, trust the image.
Report every monetary amount exactly as printed (digits and decimal separator as shown).
Report dates exactly as printed; do not reformat or infer a year that is not shown.
```

**User message content array (order matters — text first, then image(s)):**
```
1. { type: "text", text: "REFERENCE TRANSCRIPTION (may be empty or noisy):\n<unpdf text, or 'none'>" }
2. { type: "text", text: "Extract the fields defined by the schema. Return null for anything absent." }
3. { type: "image_url", image_url: { url: "data:image/jpeg;base64,...", detail: "high" } }   // one per page
```

**Schema (nullable optionals; strict):** `vendor` (string), `invoice_number` (string|null), `invoice_date` (string|null), `due_date` (string|null), `subtotal` (string|null — raw printed), `tax` (string|null), `total` (string), `currency` (string|null), `suggested_category` (string|null), plus an advisory `field_confidence` object (model self-report, D-11 advisory-only). Keep money as the **raw printed string** in the model output; the Zod gate coerces to integer cents locally (so the model is never asked to do math or unit conversion — a known hallucination source).

**Key guardrails baked in:** required-field minimization (only `vendor` and `total` are non-null-required; everything else nullable) directly prevents the "invent an invoice number on a receipt" failure (D-09). "Image is ground truth" resolves the belt-and-suspenders text/image conflict deterministically in the prompt.

**Recommendation:** Adopt the structure above verbatim as the starting prompt; keep it in one `parse/prompt.ts` constant so it is diffable and testable. (This is a concrete recommendation, not a lock — Anthony can adjust wording.)

**Anthony picks / edits:** ✅ **Adopt the recommended prompt verbatim** as the starting prompt (one `src/main/parse/prompt.ts` constant; wording tunable) — locked as D-23 in CONTEXT.md (2026-07-24).

---

### Directive 5 — Parsed-results cache schema (`migration0003`, D-14/D-17)

Mirror the STRICT-table style of `0001`/`0002`. Keyed on the SHA-256 file hash (PRIMARY KEY -> uniqueness + O(log n) lookup, same idiom as `posted_file_hashes`). Money as INTEGER cents. Two sub-decisions:

**5a. How to store per-field confidence.**
| Option | Shape | Tradeoff |
|--------|-------|----------|
| A. JSON blob column | `field_confidence TEXT` holding `{"vendor":"high","total":"high","tax":"flagged",...}` | Flexible, one column, easy to evolve; not queryable by SQL (fine — Phase 6 reads the whole row). RECOMMENDED. |
| B. Per-field flag columns | `vendor_flag TEXT, total_flag TEXT, ...` | SQL-queryable; rigid, wide table, every new field is a migration. Overkill for a per-row read. |

**5b. Store the raw model response?**
| Option | Tradeoff |
|--------|----------|
| A. Store `raw_response TEXT` (nullable) | Audit/debug for a financial tool; lets you re-derive without re-charging. Slightly larger rows. RECOMMENDED (audit value is high for money). |
| B. Do not store | Smaller rows; loses the audit trail and the ability to re-validate offline. |

**Recommended concrete migration (Option A + A):**
```sql
CREATE TABLE IF NOT EXISTS parsed_results (
  file_hash         TEXT PRIMARY KEY,   -- Phase 2 SHA-256 (the cache key, D-14)
  original_filename TEXT NOT NULL,      -- provenance for the Bills status list
  route             TEXT NOT NULL,      -- 'native' | 'image-only' (which path ran)
  page_count        INTEGER NOT NULL,
  model             TEXT NOT NULL,      -- model id that produced this (D-14: never silently recharge)
  base_url_host     TEXT,               -- provenance (host only; NEVER the key)
  vendor            TEXT,
  invoice_number    TEXT,
  invoice_date      TEXT,               -- ISO 'YYYY-MM-DD' after Zod normalize
  due_date          TEXT,
  subtotal_cents    INTEGER,            -- nullable (D-10)
  tax_cents         INTEGER,            -- nullable
  total_cents       INTEGER NOT NULL,   -- total is required (D-09)
  currency          TEXT,
  suggested_category TEXT,
  field_confidence  TEXT NOT NULL,      -- JSON: per-field 'high'|'low'|'flagged' + reason (5a-A)
  validation_flags  TEXT,               -- JSON: which deterministic checks failed (D-12)
  raw_response      TEXT,               -- nullable; full model JSON for audit (5b-A)
  parsed_at         TEXT NOT NULL,      -- ISO timestamp
  schema_version    INTEGER NOT NULL    -- prompt/schema version, so a schema change can force re-parse
) STRICT;
```
Notes: no secret material ever lands here (D-05/D-12) — `base_url_host` is host-only, never the key. `schema_version` lets a future prompt/schema bump invalidate stale rows deliberately (vs D-14's rule that a *model* switch alone does not).

**Anthony picks:** ✅ confidence storage **5a-A (JSON blob column)** · raw response **5b-A (store `raw_response`)** — locked as D-24 in CONTEXT.md (2026-07-24).

---

### Directive 6 — OpenAI-compatible client details (AI-01..03, PARSE-03)

**6a. `models.list()` response-shape differences (drives D-02 vision detection).**
- **OpenAI `/v1/models`**: minimal per-model object `{ id, object: "model", created, owned_by }`. **No capability metadata.** [CITED: OpenAI models endpoint]
- **OpenRouter `/api/v1/models`**: rich per-model object including `architecture.input_modalities: ["text","image","file"]`, `architecture.output_modalities`, `supported_parameters: [...]` (e.g. `"response_format"`, `"structured_outputs"`, `"tools"`), `pricing`, `context_length`, `name`. [CITED: openrouter.ai models docs]
- **SDK typing caveat:** the openai SDK's `client.models.list()` types each entry as the minimal `Model`. OpenRouter's extra fields arrive as untyped extras on the object at runtime. To read `architecture.input_modalities` reliably, either cast the returned item to a widened type, or fetch `${baseURL}/models` with the SDK's raw request path and Zod-parse it. Recommend a small `ModelInfoSchema` (Zod) with all rich fields optional, applied to whatever the endpoint returns.

**Vision classification (implements D-02):**
```
classifyVision(model):
  1. if model.architecture?.input_modalities includes 'image'  -> 'vision' (metadata)   [OpenRouter path]
  2. else if id matches curated vision-family regex            -> 'vision (known family)'
       (gpt-4o, gpt-4.1, o1/o3/o4 vision, claude-3/3.5/opus/sonnet, gemini-1.5/2/flash/pro,
        llama-3.2-vision, qwen2-vl / qwen2.5-vl, pixtral, ...)
  3. else                                                       -> unbadged -> D-01 confirm gate
```

**6b. Structured-outputs support + fallback ladder across providers.**
- OpenAI: native strict `json_schema` via `zodResponseFormat(schema,'bill')` + `client.chat.completions.parse(...)` (auto-parses to typed object). [CITED: openai-node helpers.md]
- OpenRouter: same `response_format: { type: 'json_schema', json_schema: { name, strict: true, schema }}`. **Unsupported model/provider errors explicitly (no silent fallback).** Force compatible routing with provider preference `require_parameters: true`, or pre-check `supported_parameters` includes `structured_outputs`/`response_format`. [CITED: openrouter.ai structured-outputs docs]
- Custom/unknown gateways: may support neither.

**Recommended fallback ladder (per call, chosen from the model's known capabilities):**
```
1. If strict json_schema supported (OpenAI, or OpenRouter supported_parameters) ->
   response_format json_schema strict:true  (best)
2. Else if json_object mode supported -> response_format {type:'json_object'} + schema described in prompt
3. Else -> plain prompt "respond with ONLY a JSON object matching <shape>"
ALWAYS: parse the returned text with the local Zod schema (authoritative). On Zod failure,
one repair retry ("your last output failed validation: <error>; return corrected JSON only"),
then flag-and-keep the file as a parse failure (D-15) if still invalid.
```

**6c. Retry / backoff / timeout.**
- SDK default: `maxRetries: 2`, exponential backoff, retries 408/409/429/>=500 + connection errors; default request `timeout: 600000` (10 min). [CITED: openai-node README]
- **Recommended:** `new OpenAI({ apiKey, baseURL, maxRetries: 3, timeout: 120000 })` (120s per call is ample for a single bill; 10 min is too long for a UI that shows "parsing N/M"). The SDK's transient-error retry sits INSIDE the D-15 per-file isolation, so a file that still fails after retries becomes a "needs attention / retry" row without aborting the batch.

**Anthony picks:** ✅ maxRetries **3** · per-call timeout **120s** · fallback ladder **as above** (+ separate `parse:parse-batch` channel and `parse:progress` broadcast per OQ2/OQ3) — locked as D-25/D-26 in CONTEXT.md (2026-07-24).

---

## Common Pitfalls

### Pitfall 1: `unpdf.renderPageAsImage` silently needs the official build + a canvas
**What goes wrong:** unpdf defaults to the serverless PDF.js build, which cannot rasterize. `renderPageAsImage` "requires the official PDF.js build and optional `canvas` module." Without it, image-only-PDF rendering (D-07) throws.
**How to avoid:** `configureUnPDF` with the official build and pass a `canvas` provider (`@napi-rs/canvas`). Add the dependency (OQ1). Cover it with a fixture test that renders a known image-only PDF.
**Warning signs:** "canvas is not defined" / render returns empty; works for text PDFs but not scans.

### Pitfall 2: HEIC must be decoded before sharp
**What goes wrong:** sharp's prebuilt libvips cannot decode HEIC; feeding `.heic` bytes straight to sharp throws.
**How to avoid:** `heic-convert` (WASM) HEIC->JPEG first, then sharp for orient/resize/re-encode. Phase 2 already recorded `.heic`/`.heif` type; Phase 3 owns the decode.

### Pitfall 3: Sideways phone receipts
**What goes wrong:** iPhone photos carry EXIF orientation; if ignored, the model reads a rotated receipt and mis-extracts.
**How to avoid:** `sharp(input).rotate()` with NO angle applies EXIF orientation automatically, then `.resize({ width: longEdge, withoutEnlargement: true }).jpeg({ quality: 80 })`.

### Pitfall 4: Float dollars corrupt totals
**What goes wrong:** `parseFloat('1234.10') * 100` can yield 123409.99999; storing dollars as REAL loses cents.
**How to avoid:** parse the printed amount as a string, strip currency/grouping, split on the decimal, compute integer cents deterministically in the Zod transform. Store INTEGER cents. Never ask the model to output cents.

### Pitfall 5: Vision models are weak at number OCR on born-digital PDFs
**What goes wrong:** Vision-LLM number transcription is a known weak spot; on a native PDF the embedded text has the exact digits.
**How to avoid:** That is precisely why belt-and-suspenders (D-06) exists — anchor numeric fields to the exact embedded text via grounding, use the image for layout. Confidence grounding (D-11) should prefer the verbatim-text match for numeric fields on native docs.

### Pitfall 6: Over-scaling images wastes tokens with no accuracy gain
**What goes wrong:** Sending a 4000px photo; OpenAI rescales to 768px short side / 512px tiles anyway.
**How to avoid:** Downscale to ~1600-2048px long edge before base64 (readable small print, bounded tokens). `detail: "high"` for dense invoices; the app is accuracy-first so keep high detail. [CITED: OpenAI vision image sizing]

### Pitfall 7: Cache key collisions across models are a feature, not a bug
**What goes wrong:** Naively you might key on `hash+model`, so switching models re-parses everything and re-charges (violates D-14).
**How to avoid:** Key on `file_hash` alone; store the `model` in the row. A model switch does NOT invalidate; only an explicit Re-parse or a `schema_version` bump does.

### Pitfall 8: better-sqlite3 has no BOOLEAN; STRICT rejects it
**What goes wrong:** STRICT tables allow only INTEGER/REAL/TEXT/BLOB/ANY. A `BOOLEAN` column or a JS boolean bind throws.
**How to avoid:** Store flags as TEXT ('high'/'low'/'flagged') or INTEGER 0/1, matching the existing STRICT tables.

## Code Examples

### HEIC-or-image -> normalized JPEG for vision
```typescript
// src/main/parse/prep-image.ts
import sharp from 'sharp'
import convert from 'heic-convert'

const LONG_EDGE = 2000 // downscale target; small print stays legible, tokens bounded

export async function prepImage(bytes: Buffer, ext: string): Promise<Buffer> {
  let input = bytes
  if (ext === '.heic' || ext === '.heif') {
    // sharp's libvips cannot decode HEIC — decode to JPEG first (Pitfall 2)
    input = Buffer.from(await convert({ buffer: bytes, format: 'JPEG', quality: 0.9 }))
  }
  return sharp(input)
    .rotate()                                              // apply EXIF orientation (Pitfall 3)
    .resize({ width: LONG_EDGE, height: LONG_EDGE, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 80 })
    .toBuffer()
}
```

### Vision field extraction with strict schema + local Zod re-validation
```typescript
// src/main/parse/extract-fields.ts (shape; see Directive 4 for the prompt, Directive 6 for fallback)
import { zodResponseFormat } from 'openai/helpers/zod'
import { z } from 'zod'

const BillSchema = z.object({
  vendor: z.string(),
  invoice_number: z.string().nullable(),
  invoice_date: z.string().nullable(),
  due_date: z.string().nullable(),
  subtotal: z.string().nullable(),      // RAW printed string; cents coercion happens in validate.ts
  tax: z.string().nullable(),
  total: z.string(),
  currency: z.string().nullable(),
  suggested_category: z.string().nullable(),
})

const resp = await client.chat.completions.parse({
  model,
  temperature: 0,
  response_format: zodResponseFormat(BillSchema, 'bill'), // strict json_schema when supported
  messages: [ /* system + text-before-image content, Directive 4 */ ],
})
const parsed = BillSchema.parse(resp.choices[0].message.parsed) // local Zod is authoritative
```

### Deterministic money -> integer cents (Zod transform)
```typescript
// src/main/parse/validate.ts
const toCents = (raw: string | null): number | null => {
  if (raw == null) return null
  const cleaned = raw.replace(/[^0-9.,-]/g, '').replace(/,(?=\d{3}\b)/g, '') // strip currency + thousands
  const norm = cleaned.replace(',', '.')
  const [d, c = ''] = norm.split('.')
  const cents = Number(d) * 100 + Number((c + '00').slice(0, 2))
  return Number.isFinite(cents) ? Math.round(cents) : null
}
// arithmetic check (D-10/D-12): only when BOTH operands present; tolerance ~2 cents
const ROUNDING_TOLERANCE = 2
function arithmeticOk(sub: number | null, tax: number | null, total: number): boolean | null {
  if (sub == null || tax == null) return null // not applicable — do NOT flag (D-10)
  return Math.abs(sub + tax - total) <= ROUNDING_TOLERANCE
}
```

### migration0003 registration (mirror Phase 2)
```typescript
// src/main/db/migrate.ts — one array entry, never renumber
import { migration0003 } from './migrations/0003_parsed_results'
const migrations: Migration[] = [migration0001, migration0002, migration0003]
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| OCR engine (Tesseract) then regex field mining | Vision LLM extraction with structured outputs | 2024-2025 | Vision decisively better on scans/photos (~92.7% vs ~64% parsed-text) [CITED: CONTEXT research notes / arXiv 2509.04469] |
| Trust one method for all PDFs | Route by document origin (native text vs vision) | 2025 | Native text still beats vision on born-digital number OCR; belt-and-suspenders pairs both (D-06) |
| Required fields in the schema | Nullable optionals + "return null if absent" | 2025 | Forcing required fields is a top hallucination cause (D-09) [CITED: Cohere/DEV structured-output null-handling] |
| LLM self-reported confidence as the score | Deterministic grounding + arithmetic + agreement | 2025-2026 | Verbalized confidence is overconfident/miscalibrated (D-11) [CITED: arXiv 2604.01457, 2607.20526] |
| Manual JSON mode + hope | `zodResponseFormat` strict json_schema + `.parse()` | 2024-08 (OpenAI Structured Outputs) | One schema drives wire + validation; strict mode constrains generation |

**Deprecated/outdated (from CLAUDE.md "What NOT to Use"):** `pdf-parse` (old PDF.js, weak maintenance -> use unpdf); `keytar` (archived -> safeStorage, already done); `node-quickbooks` as primary (not this phase); sharp prebuilt for HEIC (cannot decode -> heic-convert).

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | `@napi-rs/canvas` N-API binary needs no electron-rebuild (ABI-stable) | Standard Stack | If wrong, add an electron-rebuild step for it; low risk (N-API is designed for this) |
| A2 | Native-vs-scan thresholds (0.75 bitmap, 0.90 invisible, 50 chars/page, 50% pages) are good starting values | Directive 1 | Mis-routes some PDFs; mitigated by flag-and-keep + fixture tuning. These are STARTING values, not verified optima |
| A3 | Single multi-image call handles multi-page bills well enough for one-bill-per-file | Directive 2 | Very long/complex bills may need per-page merge; capped + flagged |
| A4 | Second-pass agreement on image-only docs is worth the extra call | Directive 3 | If agreement is misleading (shared bias), confidence is falsely high; mitigated by treating it as a signal + arithmetic still runs |
| A5 | Curated vision-family list stays current enough as a fallback | Directive 6 / D-02 | New model families unbadged -> D-01 confirm gate catches them (safe by design) |
| A6 | OpenRouter `supported_parameters`/`architecture.input_modalities` field names are stable | Directive 6 | Zod-parse with optional fields degrades gracefully to the curated fallback |
| A7 | 120s per-call timeout + maxRetries 3 suits a single-bill call | Directive 6 | Tunable one-liners |
| A8 | CLAUDE.md pins (openai 6.48.0 / unpdf 1.6.2) can move to current (6.49.0 / 1.7.0) | Standard Stack | Minor bumps; verify no breaking change at install |

## Open Questions (RESOLVED 2026-07-24)

> All three resolved by Anthony's picks, recorded in 03-CONTEXT.md "Locked Research Picks": OQ1 -> D-19 (add `@napi-rs/canvas@1.0.2`), OQ2 -> D-26 (separate `parse:parse-batch` channel), OQ3 -> D-26 (`parse:progress` broadcast).

1. **Canvas dependency for image-only PDF rendering (blocks D-07).** [RESOLVED -> D-19: approved]
   - What we know: `unpdf.renderPageAsImage` / pdfjs rendering needs a Node canvas; `@napi-rs/canvas` is the clean choice (prebuilt, slopcheck OK, 17M/wk).
   - What's unclear: it is NOT in the locked CLAUDE.md stack, so adding it is a stack decision, not planning discretion.
   - Recommendation: **Anthony approves adding `@napi-rs/canvas@1.0.2`** (default: yes — it is the only turnkey way to satisfy D-07). If declined, the alternative is sending image-only-PDF bytes directly to providers that accept PDF, which breaks the "any OpenAI-compatible endpoint" portability contract.

2. **Where does the parse trigger live relative to the scan (D-13 auto-parse)?** [RESOLVED -> D-26: separate `parse:parse-batch` channel]
   - What we know: D-13 chains parse off `runScan`. The scan currently returns a `ScanResult` to the renderer.
   - What's unclear: whether auto-parse runs inside the same IPC call (scan returns after parsing) or as a follow-up `parse:parse-batch` the renderer fires on the loaded set (better for the "parsing N/M" progress UX and per-file isolation).
   - Recommendation: separate `parse:parse-batch(loadedFiles)` channel fired by the renderer after scan, streaming per-file progress — cleaner cancellation, progress, and retry (D-15). Planner decides the exact channel shape.

3. **Progress streaming mechanism for "parsing N/M".** [RESOLVED -> D-26: `parse:progress` broadcast]
   - What we know: current IPC is request/response (`ipcMain.handle`). Progress needs main->renderer events (like `theme:changed`).
   - Recommendation: add a `parse:progress` broadcast (webContents.send) mirroring the existing theme broadcast pattern; or poll a status. Planner picks; note it in the contract.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node/Electron main runtime | all main-side work | Yes | Electron 43.2.0 | — |
| npm (install new packages) | openai/unpdf/pdfjs/sharp/heic-convert (+canvas) | Yes | project uses npm | — |
| electron-rebuild | sharp (native) rebuild vs Electron ABI | Yes | @electron/rebuild 4.2.0 in devDeps | already wired in `postinstall` |
| Network to AI endpoint | live model calls (AI-02, PARSE-03) | Gated | — | Unit tests inject a fake client; live calls need Anthony's OpenAI-compatible key (user-supplied, per CLAUDE.md). No sandbox needed (unlike QBO Phase 4) |
| Vision-capable model + API key | end-to-end parse | User-supplied | — | Test fixtures + injected fake client cover automated validation without a key |

**Missing dependencies with no fallback:** none block automated build/test — the pipeline is testable with injected fakes. Live end-to-end parsing needs a user-supplied key (expected; not a blocker for planning/execution of the deterministic layers).
**Missing dependencies with fallback:** `@napi-rs/canvas` must be added (OQ1) for the image-only-PDF render path; text PDFs and direct photos work without it.

## Validation Architecture

> nyquist_validation is enabled (config.json). This section drives VALIDATION.md.

### Test Framework
| Property | Value |
|----------|-------|
| Framework | vitest 4.1.10 (unit, `test/**/*.test.ts`, node env) + Playwright 1.61.1 (`e2e/`, Electron) |
| Config file | `vitest.config.ts` (include `test/**/*.test.ts`, `passWithNoTests: true`); `playwright.config.ts` |
| Quick run command | `npx vitest run test/parse-*.test.ts test/ai-*.test.ts` |
| Full suite command | `npm test` (vitest run && playwright test) |

### Phase Requirements -> Test Map
| Req | Behavior | Test Type | Automated Command | File Exists? |
|-----|----------|-----------|-------------------|-------------|
| PARSE-04 | money stored as integer cents ('1,234.10' -> 123410; '5.00'->500; float never used) | unit | `npx vitest run test/parse-validate.test.ts` | ❌ Wave 0 |
| PARSE-04 | dates parse/normalize to ISO; unparseable date -> flagged not thrown | unit | `npx vitest run test/parse-validate.test.ts` | ❌ Wave 0 |
| PARSE-04 | `subtotal+tax=total` checked ONLY when both present; within ~2c tolerance; null operand -> not-applicable (no flag) | unit | `npx vitest run test/parse-validate.test.ts` | ❌ Wave 0 |
| PARSE-04 | per-field confidence: verbatim-grounded field -> high; failed arithmetic -> flagged even at high model confidence (D-11/D-12) | unit | `npx vitest run test/parse-confidence.test.ts` | ❌ Wave 0 |
| PARSE-01/02 | native-vs-scan gate: text-PDF fixture -> native; invisible-OCR-overlay fixture -> image-only; bitmap-heavy -> image-only (Directive 1) | unit | `npx vitest run test/parse-route.test.ts` | ❌ Wave 0 |
| PARSE-02 | HEIC decode path runs before sharp; sideways EXIF photo auto-oriented | unit | `npx vitest run test/parse-prep-image.test.ts` | ❌ Wave 0 |
| PARSE-03 | vision call builds text-before-image content; required fields minimal; injected fake client returns schema-valid object -> Zod passes | unit (fake client) | `npx vitest run test/parse-extract.test.ts` | ❌ Wave 0 |
| PARSE-05 | cache-hit-no-recall: second parse of same hash returns cached row and the injected client is NEVER called | unit (real temp DB + spy client) | `npx vitest run test/parse-cache.test.ts` | ❌ Wave 0 |
| PARSE-05 | `migration0003` creates `parsed_results` STRICT with the documented columns; runner reaches user_version 3 | unit (temp DB) | `npx vitest run test/migrate.test.ts` (extend) | ⚠ extend existing |
| AI-03/D-02 | vision classification: OpenRouter metadata `input_modalities:['image']`->vision; OpenAI minimal shape->curated fallback; unknown->unbadged | unit | `npx vitest run test/ai-models.test.ts` | ❌ Wave 0 |
| D-15 | batch parse: one file throws -> that file marked failed, others still parsed; progress counts correct | unit (fake client with one throwing file) | `npx vitest run test/parse-pipeline.test.ts` | ❌ Wave 0 |
| AI-01/D-05 | API key/baseURL stored via secret-store (never SQLite, never renderer); no-secret-leak extends to the key canary | unit | `npx vitest run test/no-secret-leak.test.ts` (extend) | ⚠ extend existing |
| D-16 | new ai/parse IPC handlers assertTrustedSender first, Zod-parse payload | unit | `npx vitest run test/ipc-contract.test.ts` (extend) | ⚠ extend existing |

### Sampling Rate
- **Per task commit:** `npx vitest run <the touched parse-*/ai-* spec>` (< 30s).
- **Per wave merge:** `npx vitest run` (all unit).
- **Phase gate:** `npm test` green (unit + Playwright) before `/gsd:verify-work`.

### Wave 0 Gaps
- [ ] `test/fixtures/` — text-PDF, invisible-OCR-overlay-PDF, image-only-PDF, sideways-EXIF JPEG, HEIC sample (small, committed fixtures for the route + prep tests)
- [ ] `test/parse-validate.test.ts` — cents, dates, arithmetic (PARSE-04)
- [ ] `test/parse-confidence.test.ts` — deterministic-weighted confidence (D-11/D-12)
- [ ] `test/parse-route.test.ts` — native-vs-scan gate (Directive 1)
- [ ] `test/parse-prep-image.test.ts` — HEIC+EXIF+resize (PARSE-02)
- [ ] `test/parse-extract.test.ts` — prompt/content shape + Zod with a fake client (PARSE-03)
- [ ] `test/parse-cache.test.ts` — cache-hit-no-recall proof (PARSE-05)
- [ ] `test/parse-pipeline.test.ts` — per-file isolation + progress (D-15)
- [ ] `test/ai-models.test.ts` — vision classification metadata-first + fallback (D-02)
- [ ] Shared fake `OpenAIClientLike` test double (records calls, returns canned/schema-valid or throwing responses)
- [ ] Extend `test/migrate.test.ts`, `test/no-secret-leak.test.ts`, `test/ipc-contract.test.ts` for the new table/secret/channels

## Security Domain

> security_enforcement enabled, ASVS Level 1, block_on: high.

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | no | No app-level auth; the AI API key is a stored credential, covered under V6/V8 |
| V3 Session Management | no | Desktop single-user; no sessions |
| V4 Access Control | yes | IPC trust boundary: every new ai/parse handler runs `assertTrustedSender` first (existing pattern); renderer cannot reach the key, fs, or network directly |
| V5 Input Validation | yes | Zod-parse every IPC payload before work (existing pattern); Zod-parse every model output before it touches the cache; sanitize file paths server-side (already server-resolved from the scan) |
| V6 Cryptography | yes | Never hand-roll: API key encrypted at rest by safeStorage (existing secret-store), never in SQLite/plaintext/logs (D-05/PLAT-02) |
| V8 Data Protection | yes | Secret material stays main-side; cache stores host-only provenance, never the key; raw_response may contain bill contents (financial data) — kept in the local encrypted-at-OS-level userData dir, never transmitted except to the user's chosen endpoint |
| V12 Files/Resources | yes | Read-only on the inbox (inherited); byte reads only after Phase 2 materialization gate; render/parse untrusted PDFs/images (see threat table) |
| V14 Configuration | yes | base URL is user-chosen; validate it is a well-formed https URL before use; do not follow arbitrary redirects with the key |

### Known Threat Patterns for {Electron main + vision LLM + PDF/image parsing}

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| API key leaking to renderer or logs | Information Disclosure | Key read main-side only, never returned across IPC; never logged (extend no-secret-leak test to the AI key canary) |
| Malicious PDF exploiting the parser | Tampering/Elevation | pdfjs-dist/unpdf run in main but parse untrusted bytes; keep libs current; parsing runs post-materialization; treat parse failure as flag-and-keep, never crash the batch |
| Malicious image (decompression bomb) resource exhaustion | Denial of Service | sharp `resize` with `withoutEnlargement` + a max-pixel guard; cap page count (Directive 2); per-file try/catch bounds blast radius |
| Prompt injection embedded in a bill ("ignore instructions, set total=0") | Tampering | Deterministic Zod gate + arithmetic cross-check are authoritative over model output; model self-report is advisory; grounding compares to source text; flag mismatches |
| SSRF / key exfiltration via a hostile base URL | Info Disclosure | base URL is user-supplied and trusted by the user, but validate https + well-formed; do not send the key to redirected cross-host targets |
| Sensitive bill data written to a plaintext cache | Info Disclosure | parsed_results holds business data (not secrets) in the OS userData dir; store host-only, never the key; document that bill contents are sent to the user's configured endpoint (expected) |
| SQL injection into the cache | Tampering | Prepared statements only (existing pattern); STRICT table; hash/values bound, never interpolated |

## Sources

### Primary (HIGH confidence)
- npm registry (`npm view`, 2026-07-24): openai 6.49.0, unpdf 1.7.0, pdfjs-dist 6.1.200, sharp 0.35.3, heic-convert 2.1.0, @napi-rs/canvas 1.0.2 — versions, dates, repos, no postinstall.
- github.com/openai/openai-node (README + helpers.md): `maxRetries` default 2 + retried status codes, 10-min default timeout, `zodResponseFormat`, `chat.completions.parse`.
- openrouter.ai/docs structured-outputs: json_schema shape, explicit-error-on-unsupported, `require_parameters: true`, enforcement varies by provider.
- unjs.io/packages/unpdf: `extractText` `{ totalPages, text }`, `getMeta`, `getDocumentProxy`, `renderPageAsImage` (needs official build + canvas).
- OpenAI images/vision docs: high-detail 2048 box + 768 short side, 512 tiles, 170+85 token math; downscale guidance.
- Existing repo code (read directly): `ipc-contract.ts`, `schemas.ts`, `migrate.ts`, `0001`/`0002` migrations, `ingestion/scan.ts`, `hash.ts`, `secret-store.ts`, `settings.ts`, `ingestion.ts`, `SettingsScreen.tsx`, `BillsScreen.tsx`, `vitest.config.ts`, `package.json`.
- slopcheck 0.6.1 scan: all 6 packages `[OK]`.

### Secondary (MEDIUM confidence)
- mozilla/pdf.js: `getOperatorList` `fnArray`/`argsArray`, `OPS.paintImageXObject`, `TextRenderingMode.INVISIBLE = 3` (mechanism confirmed; exact per-op usage is implementation work).
- Docling `bitmap_area_threshold` default 0.75 / `force_full_page_ocr` (via CONTEXT research notes).
- arXiv self-consistency/confidence (2502.06233, 2607.08065, 2604.01457, 2607.20526) and routing/accuracy (2509.04469) — via CONTEXT research notes + this session's searches.

### Tertiary (LOW confidence — flagged in Assumptions)
- Specific gate thresholds (A2), multi-page single-call sufficiency (A3), @napi-rs/canvas no-rebuild (A1): reasoned starting points, to be confirmed by fixtures/build.

## Metadata

**Confidence breakdown:**
- Standard stack + versions + seams: HIGH — verified against npm + the actual repo files.
- Client details (models.list shapes, structured outputs, retry): HIGH — official OpenAI/OpenRouter docs.
- Six open directives: MEDIUM — genuine tradeoff decisions surfaced as options with recommended defaults; Anthony picks. Thresholds are starting values, not verified optima.
- Canvas addition: MEDIUM — clearly needed for D-07 but not in the locked stack (OQ1 for Anthony).

**Research date:** 2026-07-24
**Valid until:** ~2026-08-23 (30 days; openai/unpdf move fast — re-verify versions at plan time if later).

## RESEARCH COMPLETE
