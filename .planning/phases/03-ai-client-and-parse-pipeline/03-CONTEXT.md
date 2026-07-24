# Phase 3: AI Client and Parse Pipeline - Context

**Gathered:** 2026-07-24
**Status:** Ready for planning

<domain>
## Phase Boundary

Phase 3 turns each *loaded* bill document (the output of the Phase 2 scan — a supported, materialized, non-duplicate file with its SHA-256 hash and the batch's processing date) into validated, structured fields using a user-configured vision model, with per-field confidence signals and persistence. It has **no QuickBooks dependency**. Two halves:

1. **AI client configuration (AI-01..04):** a Settings section where the user enters an OpenAI-compatible API key + base URL (stored in the OS keychain via the Phase 1 `secrets` channel), fetches the endpoint's live model list, picks a model (with vision-capability flagging), and can change it anytime.
2. **Parse pipeline (PARSE-01..05):** programmatic text extraction for native PDFs plus image preparation for photos/scans, a vision-model call that returns a strict structured field set, deterministic validation with per-field confidence, and a persisted parsed-results cache so a reload or crash never re-calls the paid model for the same document.

**Out of scope (belongs to other phases):**
- Matching parsed vendor/category against real QuickBooks records — Phase 5 (Reconciliation). The Phase 3 "suggested category" is a rough model guess only.
- The rich editable review table (searchable dropdowns, Bill/Expense toggle, "Paid from", confidence filtering, duplicate warnings) — Phase 6. Phase 3 produces and persists the data; Phase 6 renders and edits it.
- Posting, audit, undo, reporting — Phase 7.
- QuickBooks connection/OAuth — Phase 4.
- Multi-line itemized category splitting (V2-01), multiple invoices split out of one PDF (V2-02), vendor→category learning (V2-05) — all explicitly v2.

**Requirements in scope:** AI-01, AI-02, AI-03, AI-04, PARSE-01, PARSE-02, PARSE-03, PARSE-04, PARSE-05.

</domain>

<decisions>
## Implementation Decisions

### AI Client Configuration (AI-01..04)
- **D-01:** Vision-capability handling is **flag + confirm**, not filter. The picker shows every model the endpoint returns, badges the ones confirmed vision-capable, and if the user selects a non-vision / unbadged model it requires an explicit "use anyway" confirmation. Satisfies AI-03's "cannot unknowingly select a text-only model" without hiding models the app cannot positively classify.
- **D-02:** Vision detection is **metadata-first with a curated fallback**. Use the endpoint's structured capability metadata when present (e.g. OpenRouter's `architecture.input_modalities` containing `image`). When the endpoint reports none (OpenAI's `/models`, custom gateways), fall back to a small maintained list of known vision-capable model families (gpt-4o, gpt-4.1, o-series vision, Claude sonnet/opus, Gemini, Llama/Qwen vision, etc.). Anything still unconfirmed stays unbadged and hits the D-01 confirm gate.
- **D-03:** Base URL entry is **presets + custom**: a dropdown with OpenAI and OpenRouter presets that auto-fill the correct base URL, plus a "Custom" option with a free-text field for any other OpenAI-compatible endpoint. Reduces base-URL typos for a non-technical user while staying provider-flexible.
- **D-04:** A **Connect/Test action calls `/models` once** — success both validates the key + base URL AND populates the model picker in the same step. Surface the result as an **"AI connection: OK / error"** status that mirrors the existing "Secret store: OK" `HealthIndicator` pattern on the Settings screen. A bad key or wrong URL shows a plain, recoverable error (same shape as the Phase 2 chooseInbox error surface, CR-01/WR-04).
- **D-05 (carried from Phase 1):** The API key and base URL are stored in the **OS keychain via the Phase 1 `secrets` safeStorage IPC channel** — never in SQLite, never plaintext. The selected model id (non-secret) lives in `app_settings` via the existing `settings:get/set` channel.

### Parse Routing (PARSE-01/02)
- **D-06:** For native/digital PDFs with an authoritative embedded text layer, use **belt-and-suspenders**: send BOTH the exact embedded text (unpdf) AND the rendered page image (pdfjs-dist) to the vision model, **text before image**, with the image declared as ground truth and the text as a reference transcription. This anchors totals/invoice numbers to exact text while letting the model read layout/tables from the image. Chosen deliberately for this app's accuracy-first / cost-irrelevant / low-volume profile (research-backed — see research notes).
- **D-07:** **Scanned/image-only PDFs and all photos go image-only to vision** (no text pairing). Photo/scan prep is the locked stack: heic-convert (HEIC→JPEG decode) → sharp (EXIF auto-orient, downscale to a sane long-edge, re-encode JPEG). Applies to JPEG, PNG, HEIC, and image-only PDFs (rendered to a bitmap).
- **D-08:** The native-vs-scan decision uses a **robust layered gate**, not a naive text-presence check. Treat a PDF as native-with-authoritative-text only when real text extracts AND it is not merely an invisible OCR overlay over a full-page image. Signals: text present, embedded fonts, low bitmap coverage, not text-render-mode-3 (invisible OCR layer). Otherwise route image-only. This guards the one belt-and-suspenders failure mode (pairing junk OCR text confuses the model). Exact numeric thresholds are research/planning territory (see research directives).

### Extraction, Confidence & Validation (PARSE-03/04)
- **D-09:** The model returns a **strict structured JSON schema** (structured-outputs / JSON-schema mode) with optional fields **nullable + an explicit "return null if absent" instruction**. Field set mirrors Azure's prebuilt-invoice schema: vendor, invoice/reference number (nullable), invoice date, due date (nullable), subtotal (nullable), tax (nullable), total, suggested category (nullable). Forcing fields to be required is a top cause of hallucinated fills (e.g. inventing an invoice number on a receipt), so optionals must be genuinely nullable.
- **D-10:** **Zod is the deterministic gate** on the model's output: coerce money to **integer cents**, parse/normalize dates to ISO, enforce types. Critically, **do not enforce `subtotal + tax = total` when tax or subtotal is null** (tax-included receipts and receipts with no separate tax line are normal, not errors).
- **D-11:** Per-field confidence is **hybrid, deterministic-weighted**. Grounding (does the value appear verbatim in the source text?), format/parse success, and arithmetic cross-checks decide the flag. The model's self-reported confidence is **advisory only**, used mainly for the category guess (which has no source to match against). LLM self-reported confidence is never the gate — it is poorly calibrated and overconfident, so it would green-light hallucinated totals (research-backed). For photos/scans with no embedded text, grounding leans on format+arithmetic checks; research may weigh a cheap second-pass cross-call agreement check.
- **D-12:** On a failed deterministic check, **flag-and-keep** — never reject, never silently auto-correct. A failed check becomes a visible per-field/row warning consumed by Phase 6's low-confidence flagging (REVIEW-07); parsed values are kept and nothing is blocked. Use a **small rounding tolerance** (a couple of cents) on `subtotal + tax = total` so per-line tax rounding does not false-alarm. The validation flag is **independent of model confidence** (a high-confidence total that fails the arithmetic still gets flagged).

### Parse Trigger, Persistence & Caching (PARSE-05)
- **D-13:** **Auto-parse right after the scan.** Scan → immediately parse every loaded (non-duplicate, ready) file → results land ready for review. Fits Nicole's drop-and-go model; cost is negligible at this volume; duplicates and not-ready files were already excluded by the Phase 2 scan before any model call.
- **D-14:** **Cache parsed results keyed on the Phase 2 SHA-256 file hash**, so a reload, crash, or re-scan never re-calls the model for the same bytes (PARSE-05). Store which model produced each result. Switching the selected model does **not** silently re-charge already-cached docs; a per-doc (and/or batch) **"Re-parse" override** forces a fresh call when the user deliberately wants one.
- **D-15:** Batch-parse failures **flag-and-continue with per-file isolation**. One doc failing (rate limit, network blip, unreadable) becomes a "needs attention / retry" row while the rest of the batch proceeds; show progress (e.g. "parsing 3/12") and allow retrying just the failed ones. Mirrors Phase 2's per-file error isolation (WR-01) and the flag-not-block philosophy.

### Architecture / Trust Boundary (carried from Phases 1-2)
- **D-16:** All AI network calls, PDF/text extraction, image prep, and DB writes run in the **Electron main process** behind the typed IPC boundary. The renderer touches none of it directly — it calls a **new AI/parse IPC channel group** added to `src/shared/ipc-contract.ts`, handled following the `src/main/ipc/settings.ts` / `src/main/ipc/ingestion.ts` pattern (assertTrustedSender → Zod-parse payload with a shared schema → work). The OpenAI-compatible client instantiates main-side; the API key is read from the keychain in main and never crosses to the renderer.
- **D-17:** The **parsed-results cache is a new forward-only migration (`migration0003`)** appended to `src/main/db/migrate.ts`, owned by Phase 3 (D-15 pattern from Phase 1), mirroring the `0001_init` / `0002_dedupe` STRICT-table style. It is keyed on the SHA-256 file hash and stores the validated fields, per-field confidence, the model used, a timestamp, and (planner's discretion) the raw model response for audit/debug.
- **D-18:** **Phase 3's UI surface is two things:** (a) the AI-config section on the **Settings screen** (extending the existing "Connection and model settings will appear here in a later update." placeholder), and (b) a **parse-status / progress surface on the Bills screen** that extends the Phase 2 loaded-results list (per-file parsed / failed / cached status + a "parsing N/M" indicator). The rich editable review table stays in Phase 6. Reuse the Phase 1 branded components (Badge, Button, EmptyState, HealthIndicator).

### Claude's Discretion
Standard approaches expected; research and planning decide (see research directives below for the specifics): exact "weak text layer" / native-vs-scan thresholds, multi-page PDF handling, prompt/instruction wording for the vision call, the exact parsed-results cache schema, image downscale dimensions and JPEG quality, IPC channel names/shapes, retry/backoff policy for model calls, and whether photos get a second-pass agreement check.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

Paths are relative to the NicoleBooks repo root (`C:/Users/anthony/claude-projects/nicole_quickbooks`).

### Phase Requirements and Scope
- `.planning/ROADMAP.md` (Phase 3 section) — phase goal and the five success criteria.
- `.planning/REQUIREMENTS.md` — AI-01..04 and PARSE-01..05 requirement text.

### Stack / Libraries (locked)
- `CLAUDE.md` (Technology Stack section) — locked libs for this phase: `openai` SDK (chat + vision + `models.list()`), `unpdf` (digital-PDF text, the fast-path extractor + emptiness gate), `pdfjs-dist` (coordinate/layout detail + render an image-only PDF page to a bitmap), `sharp` (resize / EXIF auto-orient / re-encode), `heic-convert` (HEIC→JPEG decode before sharp), `zod` (deterministic validation), `better-sqlite3` (parsed-results cache). **Area 5** of that section documents the vision-capability-detection gotcha that drives D-01/D-02.

### Foundation & Ingestion Seams (Phases 1-2 — MUST read before implementing)
- `.planning/phases/01-foundation/01-CONTEXT.md` — IPC trust boundary, `secrets` safeStorage channel (D-10/D-12 there; AI key + base URL live here), `app_settings` + `settings:get/set` (selected model id), migration mechanism, Settings screen as the config home, HealthIndicator pattern.
- `.planning/phases/02-ingestion-and-dedupe/02-CONTEXT.md` — the scan that produces Phase 3's input; the SHA-256 file hash that becomes the parse cache key; the flag-not-block / per-file-isolation / visibility-over-silence patterns Phase 3 mirrors.
- `src/shared/ipc-contract.ts` — single source of truth for the IPC boundary; add the new AI/parse channel group here (types + channel-name constants only, zero runtime imports). See the `ScanFile` / `ScanResult` shapes that feed parsing.
- `src/shared/schemas.ts` — shared Zod schemas; add AI-config and parse payload/result schemas alongside the existing ones.
- `src/main/ipc/settings.ts` and `src/main/ipc/ingestion.ts` — the canonical handler pattern to copy (assertTrustedSender → Zod-parse → work).
- `src/main/secrets/secret-store.ts` — the safeStorage service the AI key/base URL storage reuses.
- `src/main/db/migrate.ts` + `src/main/db/migrations/0001_init.ts`, `0002_dedupe.ts` — forward-only `user_version` migration runner + STRICT-table pattern to mirror for `migration0003` (parsed-results cache).
- `src/main/ipc/register.ts` — where IPC channel groups are registered after app 'ready'; register the new group here.
- `src/main/ingestion/scan.ts` — produces the loaded-file list (filename, hash, sizeBytes, batchEntryDate) that Phase 3 parses; the auto-parse trigger (D-13) chains off this.
- `src/renderer/src/screens/SettingsScreen.tsx` — extend the "Connection and model settings will appear here" placeholder with the AI-config section (D-18).
- `src/renderer/src/screens/BillsScreen.tsx` — the loaded-results surface that D-18's parse-status indicator extends.
- `src/renderer/src/components/` — reusable branded components (`EmptyState`, `HealthIndicator`, `ui/badge`, `ui/button`) for the config + status UI.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- **IPC contract + handler pattern** (`ipc-contract.ts`, `settings.ts`, `ingestion.ts`): add an AI/parse channel group; do not invent a new pattern.
- **`secrets` safeStorage channel + `secret-store.ts`**: stores the AI key + base URL; no new secret plumbing.
- **`app_settings` + `settings:get/set`**: stores the non-secret selected model id.
- **Migration runner + STRICT pattern** (`migrate.ts`, `0001`/`0002`): the parsed-results cache is `migration0003`.
- **Phase 2 SHA-256 hash** (`ingestion/hash.ts`, surfaced on `ScanFile.hash`): the natural parse-cache key — reusing it means an identical file is never re-parsed.
- **Settings HealthIndicator + Bills loaded-results list + Badge/Button/EmptyState**: build the AI-config status and parse-status surfaces from these.

### Established Patterns
- Renderer does zero direct fs/db/network; everything routes through typed IPC to main (Phase 1 trust boundary). Phase 3 honors this — the OpenAI client, PDF/text extraction, image prep, and DB writes all live in main.
- Zod validation at the IPC boundary before any privileged work.
- Feature tables are added by their owning phase's own migration (Phase 1 D-15); Phase 3 owns the parsed-results cache table.
- Forward-only, `user_version`-ratcheted migrations.
- Flag-not-block, per-file error isolation, visibility-over-silence (Phase 2): Phase 3's parse-failure handling (D-15) mirrors this exactly.

### Integration Points
- New AI/parse IPC channel group in `ipc-contract.ts`, registered in `register.ts`, handled in new `src/main/ipc/` files (e.g. `ai.ts` for config/model-list, `parse.ts` for the pipeline) backed by new `src/main/ai/` and `src/main/parse/` modules.
- New `migration0003` in `migrate.ts` for the parsed-results cache, keyed on the Phase 2 file hash.
- **Back-hook to Phase 2:** loaded files (filename + hash + batchEntryDate) are the parse input; auto-parse chains off the scan (D-13).
- **Forward hook to Phase 5:** the parsed "suggested category" + vendor are what reconciliation matches against real QuickBooks records.
- **Forward hook to Phase 6:** the persisted structured fields + per-field confidence flags feed the editable review table and its low-confidence highlighting/filtering.

</code_context>

<specifics>
## Specific Ideas

- **Process preference (important for downstream research):** Anthony wants research done first, then he chooses from the options — he does **not** want the researcher (or any agent) to unilaterally lock a still-open decision without his input. For the open items in the research directives below, the gsd-phase-researcher should **surface options with tradeoffs for Anthony to pick**, not silently pick. Two decisions in this discussion (PDF routing, and confidence/validation) were made exactly this way: research-then-choose.
- **Belt-and-suspenders was Anthony's own instinct** for native PDFs (take the embedded text if it's there, send it alongside the image, let the AI cross-check) and it matched the research recommendation for this app's profile.
- Accuracy-first, cost-irrelevant is the governing tradeoff for this phase (low volume, a wrong total is the worst outcome), which is what pushed toward pairing exact text + image and toward deterministic-grounded confidence over model self-report.

</specifics>

<deferred>
## Deferred Ideas

None new — the discussion stayed within Phase 3 scope. For clarity, these adjacent capabilities remain intentionally out of scope and belong to their tracked homes: multi-line itemized category splitting (V2-01), splitting multiple invoices out of one multi-page PDF (V2-02), and vendor→category learning/pre-fill (V2-05). Phase 3 assumes **one bill per file**.

</deferred>

---

## Research Directives (open items for gsd-phase-researcher — surface options, do not unilaterally decide)

1. **Native-vs-scan gate thresholds** — exact signals/thresholds for D-08 (bitmap coverage %, embedded-font presence, text-render-mode-3 invisible-overlay detection, char-count as a soft-only signal). Reference: Docling's `bitmap_area_threshold` (default 0.75) and `force_full_page_ocr`.
2. **Multi-page PDF handling** — one bill per file (V2-02 deferred), but totals are often on the last page and line items span pages; decide how many pages' text/images to send and how to reconcile.
3. **Photo/scan confidence** — whether to add a cheap second-pass cross-call agreement check to strengthen confidence where no embedded text exists for grounding.
4. **Prompt/instruction design** — text-before-image ordering, "image is ground truth / text is reference transcription" framing, and the "return null if absent" instruction; guard against hallucinated fills.
5. **Parsed-results cache schema** — exact `migration0003` columns: fields + per-field confidence + model used + timestamp + optionally raw response for audit; keyed on the SHA-256 file hash.
6. **OpenAI-compatible client details** — `client.models.list()` shape differences across OpenAI vs OpenRouter for the D-02 metadata read; structured-outputs / JSON-schema mode support across providers; retry/backoff.

### Research Notes (already gathered 2026-07-24 via gsd-advisor-researcher)

**PDF/photo routing:** Industry standard is route-by-document-origin; no single method wins. Vision decisively better on scans/photos (~92.7% vs ~64% parsed-text on scanned invoices). Native-text extraction still beats vision on born-digital PDFs (vision-LLM number OCR is a known weak spot). Belt-and-suspenders (pair exact embedded text + image) is a recognized net-positive pattern when the paired text is authoritative (not junk OCR). Sources: arXiv 2509.04469, 2510.15727, 2510.10138, 2506.21600; PyMuPDF (Medium, Nov 2025); Towards Data Science "Beyond extract_text" (Jun 2026); Docling discussion #2755; Tiny IDP "GPT4o vision not good at OCR" (Sep 2024); Azure DI prebuilt-invoice docs; LlamaIndex parser roundup; Reducto.

**Confidence/validation/schema:** LLM self-reported ("verbalized") confidence is poorly calibrated and overconfident (arXiv 2604.01457, 2607.20526); logprobs are weak for extraction (~0.705 ROC AUC, arXiv 2606.24420). Production confidence comes from grounding (value-in-source-text) + cross-source agreement + validation; the big IDPs expose one score and expect thresholding for human review (Azure ≥0.80 straight-through). Financial human-in-the-loop standard is FLAG-not-reject, never silent auto-correct; rounding tolerance is expected (round-last; per-line vs subtotal tax). Forcing required fields causes hallucinated fills — use structured outputs with nullable optionals + "return null if absent"; Zod as the deterministic gate; mirror the Azure prebuilt-invoice field set (VendorName, InvoiceId, InvoiceDate, DueDate, SubTotal, TotalTax, InvoiceTotal, AmountDue, line items). Sources: arXiv 2606.24420 / 2504.11101 / 2604.01457 / 2607.20526; Azure DI transparency note + prebuilt-invoice schema; Businessware benchmark; invoicedataextraction.com error-handling; Parseur HITL; Oracle invoice tolerances; DEV/Cohere structured-output null-handling.

---

*Phase: 3-AI Client and Parse Pipeline*
*Context gathered: 2026-07-24*
