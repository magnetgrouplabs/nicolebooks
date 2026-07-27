---
phase: 03-ai-client-and-parse-pipeline
verified: 2026-07-27T17:08:54Z
status: human_needed
score: 5/5 must-haves verified (code + automated tests); 3 human-only items outstanding
overrides_applied: 0
mvp_mode_note: "ROADMAP.md sets Mode: mvp for Phase 3, but the ROADMAP Goal field is a plain descriptive sentence ('The app turns each bill document into...'), not the strict 'As a X, I want to Y, so that Z.' user-story format. gsd-sdk's user-story.validate verb is unavailable on this machine (gsd-sdk is broken; the local gsd-tools.cjs fallback exposes no 'query' or user-story command). Rather than refuse verification, this report uses the equivalent user story embedded verbatim and identically in all seven 03-*-PLAN.md files' 'Phase Goal' sections ('As a non-technical bookkeeper, I want to configure a vision AI model once and have the app read each scanned bill into validated vendor/date/amount fields with confidence flags, so that I can review accurate entries instead of hand-typing every bill.') to produce the User Flow Coverage section below. Same gap and same handling as 02-VERIFICATION.md; recommend one /gsd mvp-phase pass across the roadmap if strict-mode verification matters going forward. Formatting gap, not an implementation gap."
human_verification:
  - test: "With a real OpenAI-compatible API key and base URL entered in Settings: press Connect and test, confirm it shows 'AI connection: OK' and populates the model picker; pick a model badged Vision; drop one native (text) PDF and one photo into the inbox; click Scan now; confirm both parse into populated vendor/date/amount fields; re-scan the same files and confirm they show 'Cached' with no new charge."
    expected: "Connect and test succeeds against the real endpoint; both documents parse to real fields; a re-scan of the same bytes never calls the model again (PARSE-05 no-recall in the real world, not just under the injected fake client)."
    why_human: "No live API key is configured in this environment (per CLAUDE.md, live testing is gated on a user-supplied key). Every deterministic layer (routing, validation, confidence, cache, fallback ladder) is covered by injected-fake unit tests (358 passing) and the pipeline's real image-only.pdf fixture proves the render path end to end, but no test in this repo can prove a real vision model reads real bill content correctly."
  - test: "On real vendor bills (not synthetic fixtures): confirm born-digital invoices route 'native' and photographed/scanned receipts route 'image-only'. If any real bill mis-routes, retune the D-20 thresholds (BITMAP_COVERAGE_THRESHOLD, INVISIBLE_GLYPH_RATIO, MIN_NATIVE_CHARS, NATIVE_PAGE_MAJORITY in src/main/parse/route.ts) against the committed fixtures."
    expected: "Native PDFs get the belt-and-suspenders text+image treatment; scans/photos go image-only. No junk-OCR-text-paired-with-image case reaches the model."
    why_human: "The 0.75/0.90/50-char/50%-page thresholds are research starting values (assumption A2), not verified optima. test/parse-route.test.ts drives all four rungs with synthetic injected signals plus one real image-only.pdf fixture, which proves the mechanism but not that the thresholds are correct for Nicole's actual vendor bills."
  - test: "Launch the app; open Settings and confirm the AI-config section renders correctly (provider preset dropdown, masked key field, Connect and test button, model list with Vision badges, use-anyway confirm dialog on an unbadged model). Open Bills, run a scan with AI configured, and confirm the 'parsing N of M' indicator, per-file Parsed/Cached/Could-not-read badges, the 'needs review' flag on a bad total, and the Retry control all render and behave as expected."
    expected: "Both screens are visually correct, legible, and interactive per 03-CONTEXT.md D-18a/D-18b; no layout breakage, no dead controls."
    why_human: "Visual rendering, dialog focus/interaction, and live progress animation cannot be verified by grep or by a headless assertion of DOM class names alone; this is the standard end-of-phase visual/interaction gate (VALIDATION.md Manual-Only rows 1 and 3)."
---

# Phase 3: AI Client and Parse Pipeline Verification Report

**Phase Goal:** The app turns each bill document into validated, structured fields using a user-configured vision model, emitting per-field confidence signals, with no QuickBooks dependency.
**Verified:** 2026-07-27T17:08:54Z
**Status:** human_needed
**Re-verification:** No — initial verification

## User Flow Coverage (MVP mode)

User story (from all seven PLAN `<Phase Goal>` sections, verbatim): *"As a non-technical bookkeeper, I want to configure a vision AI model once and have the app read each scanned bill into validated vendor/date/amount fields with confidence flags, so that I can review accurate entries instead of hand-typing every bill."*

| Step | Expected | Evidence | Status |
|------|----------|----------|--------|
| Configure a vision AI model once, in Settings | Provider preset (OpenAI/OpenRouter/custom) + masked API-key field, both written straight to the OS keychain; a "Connect and test" action calls `/models` exactly once, validates the credentials, and populates a classified model picker; vision-capable models are badged and an unconfirmed model requires an explicit "use anyway" | `src/renderer/src/screens/SettingsScreen.tsx:308-477` (AI-config section, `connectAndTest`, `VisionBadge`, `requestModel`/`pendingModel` confirm gate) + `src/main/ai/client.ts` (`buildClient`, https-only guard) + `src/main/ai/models.ts` (`listModels`, `classifyVision`) + `src/main/ai/vision-families.ts` (curated fallback) + `test/ai-models.test.ts`, `test/settings-key-provider.test.ts` (passing) | VERIFIED |
| Change the selected model at any time | Selection persists to `app_settings.ai-model` via `ai:set-model` and is changeable on every visit | `src/main/ai/models.ts:145-161` (`setSelectedModel`/`getSelectedModel`) + `src/main/ipc/ai.ts` handler + `test/ai-models.test.ts` (round-trip) | VERIFIED |
| The app reads each scanned bill into validated fields | Native PDFs get embedded-text extraction (unpdf) plus a rendered page image (pdfjs + @napi-rs/canvas), belt-and-suspenders; scans/photos get HEIC decode → EXIF-orient → downscale → JPEG (sharp); the vision call runs the D-25 fallback ladder and re-validates every reply against the local `BillSchema` | `src/main/parse/route.ts` (D-20 layered gate) + `src/main/parse/extract-pdf.ts` (`extractPdfText`, `renderPdfPageImage`) + `src/main/parse/prep-image.ts` (`prepImage`) + `src/main/parse/extract-fields.ts` (`extractFields` ladder + repair retry) + `src/shared/schemas.ts:105-118` (`BillSchema`: vendor+total required, rest nullable) + `test/parse-route.test.ts`, `test/parse-prep-image.test.ts`, `test/parse-extract.test.ts` (all passing) | VERIFIED |
| ...with confidence flags | Money → integer cents, dates → ISO, `subtotal+tax=total` checked only when both present (2c tolerance); per-field confidence is grounding+arithmetic-weighted, never gated on the model's own self-report; a second-pass agreement call strengthens image-only-doc confidence | `src/main/parse/validate.ts` (`toCents`, `normalizeDate`, `arithmeticOk`, `validateBill`) + `src/main/parse/confidence.ts` (`computeConfidence`, `agreementFlags`, sign-aware `groundsMoney`) + `test/parse-validate.test.ts`, `test/parse-confidence.test.ts` (all passing, including the CR-01 sign-handling regression cases) | VERIFIED |
| Outcome: review accurate entries instead of hand-typing, never re-paying for the same document | Bills screen auto-parses after scan, shows per-file Parsed/Cached/Could-not-read status, a "needs review" flag next to any flagged total, and a Retry control; a cache hit on `parsed_results` (keyed on the Phase 2 SHA-256 hash, re-verified against the bytes actually read) returns instantly with zero model calls | `src/renderer/src/screens/BillsScreen.tsx` (parse-status surface, `isFlagged`, `ScanButton`) + `src/main/parse/pipeline.ts` (`parseBatch`/`parseOne`: cache-first, TOCTOU re-hash, per-file isolation) + `src/main/parse/cache.ts` + `src/main/db/migrations/0003_parsed_results.ts` + `test/parse-pipeline.test.ts`, `test/parse-cache.test.ts` (all passing, including the no-recall and stale-bytes cases) | VERIFIED |

All five user-flow steps are backed by passing automated tests and directly-read source, not narrative claims. No step is blocked; the outstanding items are a live-model smoke test, real-bill threshold tuning, and a visual/interaction pass — all inherently unrunnable in this headless environment (see Human Verification Required below).

## Goal Achievement

### Observable Truths (ROADMAP Success Criteria)

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | User can enter an OpenAI-compatible API key and base URL in a settings screen (stored in the OS keychain), pick a model from the endpoint's live model list, and change the selected model at any time | ✓ VERIFIED | `SettingsScreen.tsx` AI-config section writes both values via `window.api.secrets.set`; `ai/client.ts:buildClient` reads them from `secretStore` only, never SQLite; `ai:list-models`/`ai:test-connection` call `/models` once; `ai:set-model` persists the pick to `app_settings` (non-secret), changeable at any time. `test/ai-models.test.ts`, `test/ai-ipc.test.ts`, `test/no-secret-leak.test.ts` all green |
| 2 | The app flags or filters vision-capable models so the user cannot unknowingly select a text-only model for image parsing | ✓ VERIFIED | D-01 "flag + confirm" implemented exactly as specified: `classifyVision` (metadata-first, then curated `vision-families.ts` fallback, else `'unknown'`); `VisionBadge` renders a badge for `'vision'`/`'vision-family'`; selecting `'unknown'` opens a blocking confirm dialog (`pendingModel`/`requestModel`) before the pick is saved. `test/ai-models.test.ts` covers all three classification rungs |
| 3 | For a text PDF the app extracts embedded text programmatically, and for a photo or scan it prepares the image (orient, resize, HEIC decode) before calling the model | ✓ VERIFIED | `route.ts` D-20 layered gate (bitmap coverage ≥0.75 → image-only; invisible-glyph ratio >0.90 → image-only; ≥50 chars + ≥1 font → native; else image-only; whole-doc native iff ≥50% pages native) routes correctly; `extract-pdf.ts` extracts text (unpdf) and renders image-only pages (pdfjs legacy build + @napi-rs/canvas, never sharp); `prep-image.ts` runs heic-convert before sharp, `rotate()` for EXIF, downscale to 2000px long edge with a `limitInputPixels` bomb guard. `test/parse-route.test.ts`, `test/parse-prep-image.test.ts` green, including the real `image-only.pdf`/`sideways-exif.jpg` fixtures |
| 4 | The app extracts structured fields (vendor, date, due date, reference number, subtotal, tax, total, suggested category) and validates them deterministically (subtotal plus tax equals total, dates parse, money stored as integer cents), recording per-field confidence signals | ✓ VERIFIED | `BillSchema` (`schemas.ts:105-115`) carries exactly this field set with only vendor+total required; `extract-fields.ts` runs the D-25 fallback ladder (`json_schema`→`json_object`→plain) with one repair retry, always re-validating against `BillSchema` locally; `validate.ts` coerces money to integer cents via digit-string math (never float), normalizes dates to ISO, checks `subtotal+tax=total` only when both present within a 2c tolerance; `confidence.ts` computes deterministic-weighted, sign-aware per-field confidence (grounding + arithmetic outrank the model's own self-report). `test/parse-validate.test.ts`, `test/parse-confidence.test.ts`, `test/parse-extract.test.ts` all green (108+ assertions across the three files) |
| 5 | The app persists parsed results so a reload or crash never re-calls the paid model for the same document | ✓ VERIFIED | `migration0003` creates `parsed_results` STRICT keyed on `file_hash`; `cache.ts` `getCached`/`putCached` are cache-first/cache-last with hash-alone keying (a model switch never invalidates; only a `schema_version` bump or explicit re-parse does); `pipeline.ts` `parseOne` re-hashes the bytes actually read and refuses a mismatch BEFORE any paid call (closes the TOCTOU gap found in code review). `test/parse-cache.test.ts`, `test/parse-pipeline.test.ts` green, including the explicit "injected client never called on a cache hit" assertion |

**Score:** 5/5 truths verified at the code level. All 28 individual plan-level `must_haves` truths (across the 7 plans' frontmatter) were spot-checked against source and pass; none reduce or contradict the 5 roadmap truths above.

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `src/shared/ipc-contract.ts` | `ai:*`/`parse:*` channels, `ModelInfo`/`ParsedFields`/`ParseFileResult`/`ParseProgress` types, `AiApi`/`ParseApi` | ✓ VERIFIED | `grep` confirms zero occurrences of `ai-api-key`/`ai-base-url`/`apiKey`/`baseURL` in this file — no secret material in the contract (D-05) |
| `src/shared/schemas.ts` | `AiTestConnectionSchema`, `AiSetModelSchema`, `ParseBatchSchema`, `ReparseSchema`, `BillSchema` | ✓ VERIFIED | `BillSchema` present at line 105, vendor+total required, rest `.nullable()`; same secret-free grep passes |
| `src/preload/index.ts` | `window.api.ai` + `window.api.parse` bridge, `parse.onProgress` subscribe/unsubscribe | ✓ VERIFIED (via ipc-boundary e2e) | `e2e/ipc-boundary.spec.ts` passes; `BillsScreen.tsx` and `SettingsScreen.tsx` both call the bridged methods successfully in unit/e2e |
| `src/main/ai/client.ts` | `buildClient()`: keychain read, https-only guard, `maxRetries:3`/`timeout:120000` | ✓ VERIFIED | Read directly; `assertHttpsBaseUrl` rejects non-https; no getter returns a credential |
| `src/main/ai/models.ts` | `listModels`/`classifyVision`/`setSelectedModel`/`getSelectedModel` | ✓ VERIFIED | Read directly; D-25 classification order confirmed (metadata → curated family → unknown) |
| `src/main/ai/vision-families.ts` | Curated regex family list | ✓ VERIFIED | 13 pattern entries covering the researched families |
| `src/main/ipc/ai.ts` | `registerAiIpc()`, three handlers | ✓ VERIFIED | `assertTrustedSender` first, Zod-parse, `recoverableReason` mapping on `ai:list-models` (WR-02 fix present) |
| `src/main/parse/route.ts` | `routePdf`/`routeFile`, D-20 layered gate | ✓ VERIFIED | Four named threshold constants at documented values |
| `src/main/parse/extract-pdf.ts` | `extractPdfText`/`renderPdfPageImage`, pdfjs legacy build + @napi-rs/canvas | ✓ VERIFIED | `PDFJS_LEGACY_BUILD`, `CANVAS_IMPORT`, `computeRenderScale` (CR-02 pixel-bound fix present); `extractPdfText` now creates+destroys its own document (WR-01 fix present) |
| `src/main/parse/prep-image.ts` | `prepImage`: heic-convert → sharp, bomb guard | ✓ VERIFIED | `MAX_INPUT_PIXELS = 100_000_000`, `withoutEnlargement: true` |
| `src/main/parse/prompt.ts` | `BILL_SYSTEM_PROMPT`, `buildUserContent` | ✓ VERIFIED | Contains "return null" and "ground truth" verbatim (grep-confirmed by the plan's own acceptance criteria) |
| `src/main/parse/extract-fields.ts` | `extractFields`: ladder + repair + local re-validate | ✓ VERIFIED | `BillSchema.safeParse` runs on every rung; `FALLBACK_STATUS` allow-list (WR-04 fix); temperature-rejection retry (WR-05 fix) |
| `src/main/parse/validate.ts` | `toCents`/`normalizeDate`/`validateBill` | ✓ VERIFIED | Sign-aware `toCents` (CR-01 fix: leading/trailing minus, parentheses, CR suffix, currency-between-sign-and-digits) |
| `src/main/parse/confidence.ts` | `computeConfidence`/`agreementFlags` | ✓ VERIFIED | Sign-aware `groundsMoney` (CR-01 companion fix) |
| `src/main/db/migrations/0003_parsed_results.ts` | `parsed_results` STRICT DDL | ✓ VERIFIED | 21 columns exactly as D-24 specifies; no BOOLEAN columns |
| `src/main/parse/cache.ts` | `getCached`/`putCached`, hash-alone keying | ✓ VERIFIED | Bound/prepared statements only; `baseUrlHost()` strips everything but host (D-05 guard) |
| `src/main/parse/pipeline.ts` | `parseBatch` orchestrator | ✓ VERIFIED | TOCTOU re-hash (CR-03 fix), batch-scope circuit breaker on 401/403/429 (WR-06 fix), realpath containment (WR-09 fix), HEIC pre-decode pixel budget (deferred-item-3 closure) all present and match their documented fixes |
| `src/main/ipc/parse.ts` | `registerParseIpc()`, progress broadcast | ✓ VERIFIED | Registered in `register.ts` alongside `registerAiIpc` |
| `src/renderer/src/screens/SettingsScreen.tsx` | AI-config section | ✓ VERIFIED | Presets+custom, masked key, Connect/Test, model picker+badges+confirm gate, all present; WR-08 key-provider-pairing fix present (`connectBlockedReason`, `KEY_PROVIDER_SETTING`) |
| `src/renderer/src/screens/BillsScreen.tsx` | Parse-status surface | ✓ VERIFIED | Auto-parse after scan (separate call, D-26), progress indicator, per-file badges, retry; WR-07 (scan button disabled while parsing) and WR-10 ("needs review" flag) fixes present |

### Key Link Verification

| From | To | Via | Status | Details |
|------|-----|-----|--------|---------|
| `SettingsScreen.tsx` | `ai:test-connection` | `window.api.ai.testConnection` | ✓ WIRED | Called in `connectAndTest`, line 220 |
| `ipc/ai.ts` | `secret-store.ts` | `secretStore.get('ai-api-key')`/`get('ai-base-url')` | ✓ WIRED | Via `ai/client.ts:buildClient`, called from the ai IPC handlers |
| `extract-pdf.ts` | `@napi-rs/canvas` | `createIsomorphicCanvasFactory`/`CANVAS_IMPORT` (unpdf 1.6.2's `definePDFJSModule`, replacing the deprecated `configureUnPDF` named in the plan) | ✓ WIRED | Both `renderPdfPageImage` and `encodeJpeg` use the canvas provider; module header explains the naming drift from the plan's `configureUnPDF` reference (removed in unpdf v2) |
| `extract-fields.ts` | `schemas.ts BillSchema` | `BillSchema.safeParse` | ✓ WIRED | Called in `validateReply`, run on every rung including the strict one |
| `cache.ts` | `parsed_results` | prepared `SELECT`/`INSERT ... ON CONFLICT(file_hash)` | ✓ WIRED | Bound parameters throughout, no interpolation |
| `BillsScreen.tsx` | `parse:parse-batch` | `window.api.parse.parseBatch(loadedFiles)` | ✓ WIRED | Fired after scan resolves, as a separate call (line 340), matching D-26 |
| `pipeline.ts` | `cache.ts` | `getCached` before any model call; `putCached` last | ✓ WIRED | `parseOne` step 1 is `getCached`; `putCached` runs only after validation+confidence succeed |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
|----------|---------------|--------|---------------------|--------|
| `SettingsScreen.tsx` model picker | `models` (ModelInfo[]) | `window.api.ai.testConnection()` → `ai:test-connection` → `listModels()` → real `client.models.list()` (or the injected fake in tests) | Yes — no static/empty fallback; an error path clears `models` to `[]` explicitly rather than faking data | ✓ FLOWING |
| `BillsScreen.tsx` parse rows | `parseResults` (Record<hash, ParseFileResult>) | `window.api.parse.parseBatch(files)` → `parse:parse-batch` → `parseBatch()` → real pipeline (cache/route/extract/validate) | Yes — traced through `pipeline.ts` to `cache.ts`/`extract-fields.ts`; no hardcoded stub values found | ✓ FLOWING |
| `BillsScreen.tsx` progress indicator | `parseProgress` (ParseProgress \| null) | `window.api.parse.onProgress(cb)` ← `parse:progress` broadcast ← `emitProgress` in `pipeline.ts`, called once per file | Yes — driven by the same loop that produces `parseResults`, not a separate/fake counter | ✓ FLOWING |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| Full unit suite | `npx vitest run` | 26 files, 358 tests, all passed, 2.43s | ✓ PASS |
| Full e2e suite | `npx playwright test` | 8 tests, all passed, 8.1s (includes `ingestion-scan.spec.ts` and both `secret-roundtrip.spec.ts` cases) | ✓ PASS |
| Typecheck | `npm run typecheck` | `tsc --build`, clean, no errors | ✓ PASS |
| Production build | `npm run build` | electron-vite build succeeds for main/preload/renderer; only informational `INEFFECTIVE_DYNAMIC_IMPORT` warnings (not errors, pre-existing lazy-load pattern for Electron-only modules) | ✓ PASS |
| Six locked libraries at pinned versions | `grep package.json` | `openai@6.48.0`, `unpdf@1.6.2`, `pdfjs-dist@6.1.200`, `sharp@0.35.3`, `heic-convert@2.1.0`, `@napi-rs/canvas@1.0.2` | ✓ PASS |
| No secret material in shared IPC files | `grep -n "ai-api-key\|ai-base-url\|apiKey\|baseURL" src/shared/ipc-contract.ts src/shared/schemas.ts` | No matches | ✓ PASS |

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|------------|-------------|--------|----------|
| AI-01 | 03-02 | API key + base URL in settings, keychain-stored | ✓ SATISFIED | `SettingsScreen.tsx` + `secretStore`; REQUIREMENTS.md marked Complete |
| AI-02 | 03-01, 03-02 | Fetches live model list, lets user pick | ✓ SATISFIED | `listModels()` + model picker UI |
| AI-03 | 03-02 | Flags/filters vision-capable models | ✓ SATISFIED | D-01 flag+confirm, `classifyVision` |
| AI-04 | 03-02 | User can change selected model at any time | ✓ SATISFIED | `ai:set-model` + `app_settings` round trip |
| PARSE-01 | 03-04 | Extract embedded text for text PDFs | ✓ SATISFIED | `route.ts` + `extract-pdf.ts` |
| PARSE-02 | 03-04 | Prepare image (orient/resize/HEIC) for photos/scans | ✓ SATISFIED | `prep-image.ts` |
| PARSE-03 | 03-01, 03-05 | Extract structured fields via vision model | ✓ SATISFIED | `extract-fields.ts` + `prompt.ts` |
| PARSE-04 | 03-03 | Deterministic validation + per-field confidence | ✓ SATISFIED | `validate.ts` + `confidence.ts`; REQUIREMENTS.md now correctly marked Complete (was briefly stale per deferred-items.md item 4, fixed in commit `e72e282`) |
| PARSE-05 | 03-01, 03-06, 03-07 | Persist parsed results, never re-call paid model | ✓ SATISFIED | `migration0003` + `cache.ts` + `pipeline.ts` cache-first/cache-last with TOCTOU re-hash |

No orphaned requirements: the union of all 7 plans' `requirements:` frontmatter fields (`AI-01..04`, `PARSE-01..05`) exactly matches the phase's 9 requirement IDs from ROADMAP.md and REQUIREMENTS.md. Every one is now marked Complete in REQUIREMENTS.md.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| `src/main/parse/confidence.ts` | n/a | `IN-02`: `modelSelfReport` parameter is never supplied by any caller, so precedence rung 4 of the confidence ladder is dead code; `suggestedCategory` confidence is always `'low'` rather than sometimes reflecting the model's own report | ℹ️ INFO | Degrades in the SAFE direction (never falsely certifies a category); documented and deliberately left open in 03-REVIEW.md as IN-02 |
| `src/main/ipc/ai.ts` | n/a | `IN-03`: `ai:list-models` channel is registered/bridged/typed but has no caller in the UI (`SettingsScreen` only calls `testConnection`, which also returns models) | ℹ️ INFO | No functional gap — `testConnection` already returns the classified model list in the one action the UI needs; documented in 03-REVIEW.md |
| `src/main/parse/extract-fields.ts` | 182-196 | `IN-04`: `startRung` exists but the pipeline never passes it, so every file re-walks the ladder from the top even against an endpoint with no `json_schema` support | ℹ️ INFO | Cost/latency inefficiency only, not a correctness gap; documented in 03-REVIEW.md |
| `src/main/parse/extract-fields.ts` / `pipeline.ts` | n/a | `IN-05`: `ExtractFailure.detail`/`.rung`/`.rawResponse` are computed but discarded by `parseOne`, so the audit value is not persisted for a failed parse | ℹ️ INFO | Documented in 03-REVIEW.md; does not affect a successful parse's audit trail (`raw_response` IS persisted on success) |
| `src/renderer/src/screens/SettingsScreen.tsx` | 404 | `IN-06`: "Currently using {selectedModel}" only renders inside the `models.length > 0` guard, so a fresh launch (before Connect/Test succeeds) does not show which model is configured; no "Remove stored key" control exists | ℹ️ INFO | UX completeness gap, not a functional one — AI-04's "change at any time" still works once models load; documented in 03-REVIEW.md, partially mitigated by the WR-08 fix (the key-provider placeholder now tells the truth across a restart) |
| — | — | No `TODO`/`FIXME`/`XXX`/`HACK`/`PLACEHOLDER`/"coming soon"/"not yet implemented" markers found anywhere in the phase's modified files | — | Clean |

All six Info-level items above are pre-existing, explicitly documented findings from `03-REVIEW.md` (2026-07-27), deliberately left open by decision after the Critical+Warning fix pass. None of them contradict a roadmap success criterion, and none is a debt marker requiring a formal follow-up reference — they are narrative code-review notes, not `TODO`/`FIXME` comments in source. No new anti-patterns were found beyond what 03-REVIEW.md already tracked.

### Confirmation Bias Counter (disconfirmation pass)

Per the verifier's required disconfirmation pass:

1. **Partially-met item found:** IN-06 (Settings screen) — the currently-selected model is invisible until a live Connect/Test succeeds, and there is no way to clear a stored key from the UI. This does not break AI-01..04 (all four are satisfied on their literal terms), but it is a real, documented UX gap that a human should see once a live key is available.
2. **A test that passes but proves less than it appears to:** `test/parse-confidence.test.ts`'s coverage of `modelSelfReport` exercises the parameter directly (calling `computeConfidence` with a manually-supplied self-report object), which proves the ladder rung 4 logic works in isolation — but no production code path ever supplies that argument (IN-02), so the passing test does not prove the feature is reachable end-to-end. Confirmed by grep: `computeConfidence` is called with exactly 3 arguments at its one call site in `pipeline.ts:408`.
3. **An error path with no test coverage found:** the case where `secretStore.get('ai-base-url')` in `pipeline.ts:readBaseUrl()` throws (Electron `safeStorage` unavailable, e.g. a locked OS keychain mid-batch) is caught and degrades to `null` provenance, but no test in `test/parse-pipeline.test.ts` drives that specific throw path. The degradation is safe (a null `base_url_host` column, never a crash) and the pattern mirrors an already-tested one (`readSelectedModel`'s identical try/catch, which IS tested), so this is a minor, low-risk gap in test breadth rather than a functional defect.

None of these three findings change the phase's overall PASS-level judgment; they are reported for transparency and do not appear as gaps below because none of them contradicts a roadmap success criterion or a plan must-have.

### Human Verification Required

#### 1. Live end-to-end parse against a real endpoint

**Test:** With a real OpenAI-compatible API key and base URL entered in Settings: press Connect and test, confirm "AI connection: OK" and a populated model picker; pick a Vision-badged model; drop one native PDF and one photo into the inbox; click Scan now; confirm both parse into populated fields; re-scan the same files and confirm 'Cached' status with no re-charge.
**Expected:** Real connection succeeds, real documents parse to real fields, and the cache genuinely prevents a second charge.
**Why human:** No live API key is configured in this environment (per CLAUDE.md, live testing is gated on a user-supplied key). All deterministic layers are proven by 358 injected-fake unit tests plus a real fixture render; no automated test here can prove a live model reads real content correctly.

#### 2. Real-bill routing threshold tuning

**Test:** On real vendor bills, confirm born-digital PDFs route 'native' and scanned/photographed receipts route 'image-only'. Retune `src/main/parse/route.ts`'s four D-20 constants against the committed fixtures if any real bill mis-routes.
**Expected:** No junk-OCR-paired-with-image case reaches the model; the routing gate behaves correctly on Nicole's actual bill mix.
**Why human:** The thresholds are research starting values (assumption A2), verified against synthetic signals and one real fixture, not against a corpus of Nicole's real bills.

#### 3. Settings AI-config + Bills parse-status visual/interaction check

**Test:** Launch the app; open Settings and confirm the AI-config section renders correctly and is interactive (preset dropdown, masked key field, Connect/Test, model list with badges, confirm dialog). Open Bills, scan with AI configured, and confirm the "parsing N of M" indicator, per-file status badges, the "needs review" flag, and the Retry control all render and work.
**Expected:** Both screens are visually correct and fully interactive, matching 03-CONTEXT.md D-18a/D-18b.
**Why human:** Visual rendering, dialog focus behavior, and live progress animation are not verifiable by static grep or a headless DOM assertion; this is the standard end-of-phase visual/interaction gate documented in VALIDATION.md Manual-Only rows 1 and 3.

### Gaps Summary

No gaps found. All 5 ROADMAP success criteria and all 9 requirement IDs (AI-01..04, PARSE-01..05) are genuinely satisfied at the code level, confirmed by direct source reading (not SUMMARY.md claims), 358 passing unit tests, 8 passing Playwright e2e tests, a clean typecheck, and a clean production build. The 4 Critical + 10 Warning findings from `03-REVIEW.md`'s code review pass were independently spot-checked in the current source and are genuinely fixed with real regression tests (verified: `toCents` sign handling across `$-45.00`/`45.00-`/`CR`-suffix formats; the AI credentials are write-only across the IPC boundary while the Phase 1 canary round-trip still works; the parse cache verifies the file hash against the bytes actually read). The 6 Info-level findings remain open by explicit, documented decision and do not block the phase goal.

Status is `human_needed` rather than `passed` only because three genuinely human-only verification items remain (a live-key smoke test, real-bill threshold tuning, and a visual/interaction pass) — exactly as anticipated in the phase's own VALIDATION.md Manual-Only Verifications table and the execution history notes. None of these are code gaps; they are the deliberately-deferred manual gate this phase's plans always intended to end on.

---

*Verified: 2026-07-27T17:08:54Z*
*Verifier: Claude (gsd-verifier)*
