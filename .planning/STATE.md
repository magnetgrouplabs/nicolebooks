---
gsd_state_version: 1.0
milestone: v1.0
milestone_name: milestone
status: verifying
stopped_at: Completed 03-07-PLAN.md (Phase 03 code complete, 7/7 plans)
last_updated: "2026-07-27T17:59:30.000Z"
last_activity: 2026-07-27
progress:
  total_phases: 8
  completed_phases: 2
  total_plans: 18
  completed_plans: 17
  percent: 25
---

# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-07-22)

**Core value:** Turn a folder of mixed bill documents into correctly categorized, non-duplicate QuickBooks Online entries that a non-technical user can review and approve with confidence, in a fraction of the time manual entry takes.
**Current focus:** Phase 03 — ai-client-and-parse-pipeline

## Current Position

Phase: 03 (ai-client-and-parse-pipeline) — EXECUTING
Plan: 7 of 7
Status: Phase complete — ready for verification
Last activity: 2026-07-27

Progress: [█████████░] 89% (16/18 plans complete — Phases 01+02 done bar the 01-08 cross-OS human gate; Phase 03 at 6/7)

## Performance Metrics

**Velocity:**

- Total plans completed: 3
- Average duration: n/a
- Total execution time: 0 hours

**By Phase:**

| Phase | Plans | Total | Avg/Plan |
|-------|-------|-------|----------|
| 02 | 3 | - | - |

**Recent Trend:**

- Last 5 plans: n/a
- Trend: n/a

*Updated after each plan completion*
| Phase 1 P1 | 14min | 3 tasks | 15 files |
| Phase 01 P02 | 9min | 3 tasks | 7 files |
| Phase 01 P03 | 14min | 2 tasks | 15 files |
| Phase 01 P04 | 4min | 2 tasks | 7 files |
| Phase 01 P05 | 3min | 2 tasks | 6 files |
| Phase 01 P06 | 6min | 2 tasks | 9 files |
| Phase 01 P07 | 14min | 2 tasks | 6 files |
| Phase 02 P02-01 | 12min | 4 tasks | 21 files |
| Phase 02 P02-02 | 4min | 3 tasks | 5 files |
| Phase 02 P02-03 | 9min | 3 tasks | 5 files |
| Phase 03 P01 | 11min | 3 tasks | 9 files |
| Phase 03 P02 | 15min | 3 tasks | 9 files |
| Phase 03 P03-03 | 9min | 2 tasks | 4 files |
| Phase 03 P03-04 | 18min | 2 tasks | 10 files |
| Phase 03 P05 | 14min | 2 tasks | 4 files |
| Phase 03 P06 | 11min | 2 tasks | 6 files |
| Phase 03 P03-07 | 14min | 3 tasks | 8 files |

## Accumulated Context

### Decisions

Decisions are logged in PROJECT.md Key Decisions table.
Recent decisions affecting current work:

- Roadmap: Dependency-driven, sandbox-first phase order (8 phases). QuickBooks is isolated behind a single environment seam so nearly everything is built and tested against the sandbox before any production access.
- Roadmap: Phases 2, 3, and 4 depend only on Phase 1 and can proceed in parallel; Phase 4 is the single live-credentials pause seam (sandbox credentials).
- Foundation: Electron two-process shell chosen by research (settled, not open), with all IO, secrets, and network confined to the main process behind a typed IPC boundary.
- [Phase ?]: Foundation: kept both locked pins (vite 8.1.5 and electron-vite 5.0.0) via .npmrc legacy-peer-deps; three-artifact build proven functional under vite 8
- [Phase ?]: Foundation: better-sqlite3 13.0.1 rebuilt against Electron 43 ABI on Windows via prebuilt binary (no source compile, no MSVC/Python); Mac rebuild deferred to 01-07 cross-OS gate
- [Phase ?]: Foundation: typed IPC boundary defined once in src/shared/ipc-contract.ts (seven channel constants) with Zod payload schemas; preload exposes only named window.api methods, never raw ipcRenderer (SC4, threats T-01-02/T-01-03)
- [Phase ?]: Foundation: fixed pre-existing TS 7 baseUrl typecheck breakage (migrated tsconfig path maps to relative); node TS project now emits declarations only so the renderer can consume the preload type across the process split
- [Phase ?]: Foundation: base-nova shadcn resolves the Base UI primitive (@base-ui/react 1.6.0 pinned), not classic Radix; 01-06 wires components against @base-ui/react and wraps the tree in TooltipProvider
- [Phase ?]: Foundation: BRAND-01 theme seam wired in renderer globals.css (Tailwind v4 @theme, light and dark palettes, local @font-face for Jost and DM Sans, semantic and chart colors); values authored from vendored tokens.json (fg #343434, muted-fg #6e6e73), not the marketing site
- [Phase 01]: Foundation: SQLite persistence seam is a lazy migrating singleton (getDatabase opens userData/app.db and runs forward-only user_version migrations on first access) plus a pure openDatabase(path) opener for tests; migration 0001 creates only app_settings STRICT, no feature tables (D-13/D-15)
- [Phase 01]: Foundation: safeStorage secret store (secretStore.set/get/delete/available) writes base64 ciphertext only to userData/secrets.enc mode 0o600, throws SECRET_STORE_UNAVAILABLE when unavailable, never touches SQLite (D-12) and never logs secrets (T-01-05); no-secret-leak test proves the canary absent from secrets.enc, app.db, and logs
- [Phase 01]: Foundation: IPC handlers are sender-validated then Zod-gated before any privileged action (SC4/T-01-03); assertTrustedSender validates the frame origin (file:// packaged or the exact ELECTRON_RENDERER_URL dev origin), single-sourced in src/main/ipc/trusted-sender.ts
- [Phase 01]: Foundation: ready-time ordering is getDatabase()+migrate(db) before the window then registerIpc() after it, so app_settings exists before the renderer loads and safeStorage/handlers init post-ready; secrets handlers return null when the store is unavailable rather than leaking a stack trace (T-01-05)
- [Phase ?]: Foundation: 01-06 branded shell wired against Base UI (@base-ui/react) with the tree wrapped in TooltipProvider; App uses a CSS grid (56px header row, 280px sidebar column), header spanning both columns, swappable content region, default Bills (D-09)
- [Phase ?]: Foundation: OS light/dark mirror awaits the async window.api.theme.get() before the first React render then subscribes to onChange; with the window hidden until ready-to-show this yields no theme flash (RESEARCH Pitfall 4)
- [Phase ?]: Foundation: HealthIndicator is the permanent SC2+SC4 proof (D-11); on mount it stores then reads a canary through window.api.secrets and renders Secret store: OK only on an exact round-trip match, never rendering or logging the secret (T-01-05)
- [Phase ?]: Foundation: all renderer components use only semantic brand-token classes (text-primary, hover primary tint, focus ring token, success/destructive) with structural radius 0 for header/sidebar; zero hardcoded hex
- [Phase ?]: Foundation: fixed a blocking preload-bundling bug (electron resolved to node_modules/electron/index.js requiring child_process) by externalizing electron in the preload build, so window.api now loads in the packaged loadFile app; every SC2/SC3/SC4 e2e proof and the shipped product depend on it
- [Phase ?]: Foundation: Wave 0 e2e surface complete (secret-roundtrip, persistence, ipc-boundary, theme via Playwright _electron with per-test --user-data-dir isolation); ran green on Windows locally, macos-latest CI leg authored but deferred to CI and the 01-08 human checkpoint
- [Phase ?]: Foundation: cross-OS CI matrix (windows-latest plus macos-latest, fail-fast false) with a distinct electron-rebuild step and no embedded token/secret; PLAT-01 automatable half done, real-machine half is 01-08
- [Phase 02]: Ingestion: posted_file_hashes ledger is Design B (posted-only); Phase 2 reads it in 02-02, Phase 7 writes it. No Phase 2 code path inserts (verified: no INSERT INTO posted_file_hashes in src/).
- [Phase 02]: Ingestion: scan runs entirely main-side behind a new sender-gated ingestion IPC group; scan takes no renderer payload (ScanRequestSchema strict-empty) so the server-side inbox path is the path-injection guard (T-02-02).
- [Phase 02]: Dedupe (02-02): read-only ledger.checkPostedHash (prepared SELECT WHERE hash = ?, bound never interpolated) confirms Design B holds — posted_file_hashes in src/ only as the migration CREATE and the ledger SELECT, zero writes (T-02-06/T-02-07). ING-04 complete.
- [Phase 02]: Dedupe (02-02): scan groups the batch by hash after computing all hashes (Pitfall 5); a ledger hit marks EVERY entry with that hash duplicate-excluded (precedence over within-scan duplicate-in-batch); Bills-screen include-anyway override is renderer-only local state (no IPC write, Phase 2 ends at loaded-for-processing).
- [Phase 02]: Materialization (02-03): the scan runs isNotMaterialized then isSettled BEFORE sha256File for every file (metadata-first, bytes-last), so a cloud placeholder or a still-writing file is never hashed/downloaded — it is flagged not-ready-skipped and surfaced for re-scan. macOS uses blocks===0 / .icloud sentinel; Windows reads OFFLINE/RECALL attribute bits via ONE batched injection-safe execFile per scan (args array, shell:false, path via env var; T-02-08). ING-03 complete (both unsupported + not-materialized halves).
- [Phase 02]: Materialization (02-03): inconclusive-detection fallback resolved — the scan LOADS on total detection failure (Windows attribute read throws/empty) and SKIPS only on positive placeholder evidence, so a real bill is never false-skipped (02-RESEARCH OQ1).
- [Phase 02]: Fixed a stray NUL byte a prior plan left in BillsScreen fileKey (`${filename}\x00${hash}`) that made git treat the source file as binary; replaced with a space (Rule 1).
- [Phase 03]: AI config (03-02): payload-free IPC handlers must Zod-parse raw ?? {} — the preload invokes with no argument, so a bare parse(raw) on a strict-empty schema always throws. Proven on the running app; the same latent bug breaks Phase 2 ingestion:scan (logged as a blocker).
- [Phase 03]: AI config (03-02): the API key and base URL are write-only from the renderer perspective — written via secrets.set, read ONLY in src/main/ai/client.ts, never returned across IPC, never logged, and SettingsScreen has no read path back (D-05/T-03-01). buildClient rejects any non-https or malformed base URL via new URL() before instantiating the client (T-03-05).
- [Phase 03]: AI config (03-02): the ai IPC layer never forwards a raw error — three opaque service codes map to fixed recoverable copy and everything else falls back to one generic sentence, because OpenAI SDK errors routinely embed the request URL.
- [Phase 03]: AI config (03-02): classifyVision runs the curated-family rung even when metadata is present but omits image, so a provider under-reporting modalities cannot strip the Vision badge off gpt-4o; a model entry failing the lenient ModelInfoSchema is skipped, never fatal to the picker.
- [Phase 03]: Parse (03-03): the validation gate is the authority over model output — toCents returns null (never 0) for unreadable money so a total reading 'N/A' can never post as a confident zero-dollar bill, sign is captured before digit extraction (the RESEARCH impl mis-signed '-5.50' as -450), and cents are built by concatenating digit strings so dollars*100 float error never enters the pipeline.
- [Phase 03]: Parse (03-03): confidence resolves through a five-rung ladder where a failed deterministic check outranks the model's self-report (D-11/D-12); grounding is boundary-checked so a tax of 8.00 cannot certify itself inside a total of 108.00, the suggested category is never grounded (it is a classification guess, not a transcription), and a D-22 cross-call disagreement maps to low while a failed check maps to flagged.
- [Phase 03]: Parse (03-04): routing branches on SOURCE TYPE before content — a raw photo goes to prepImage (heic-convert then sharp) while an image-only PDF goes to renderPdfPageImage (pdfjs legacy build + @napi-rs/canvas), because sharp cannot decode PDF bytes and collapsing the two image-only cases would make every scanned bill unparseable (D-07/D-19).
- [Phase 03]: Parse (03-04): the D-20 gate evaluates the two 'this is really a picture' rungs FIRST (bitmap coverage >= 0.75, then invisible-glyph ratio > 0.90) so a bitmap page carrying an OCR overlay never reaches the text rung; char count is a soft tiebreaker that also requires an embedded font, and a malformed signal coerces to 0 so a broken loader degrades toward image-only rather than pairing junk text.
- [Phase 03]: Parse (03-04): unpdf 1.6.2 renamed configureUnPDF to definePDFJSModule (deprecated, removed in v2) and pdfjs 6 dropped PDFDocumentProxy.destroy() for doc.loadingTask.destroy(); unpdf's renderPageAsImage emits PNG, so the JPEG re-encode uses @napi-rs/canvas rather than sharp to keep the PDF path provably sharp-free.
- [Phase 03]: 03-05: rung-2/3 prompt schema text is generated from BillSchema via z.toJSONSchema — A hand-written copy would drift from the schema that validates the reply; one source of truth for prompt and gate
- [Phase 03]: 03-05: an OMITTED optional key normalizes to explicit null before BillSchema runs — BillSchema uses .nullable() (key required) while the prompt invites absence; filling only undefined saves a paid repair call per no-tax-line receipt and cannot weaken vendor/total, which are non-nullable
- [Phase 03]: 03-05: the D-25 ladder descends on error CLASS, not on any failure — 400/404/422 and method-missing TypeErrors descend; 401/403/408/409/429, 5xx and connection errors return immediately, so a bad key costs one call per file instead of three
- [Phase 03]: 03-05: the D-21 10-page cap is enforced inside extractFields, not by the caller — The request is assembled here, so no future call site can put an unbounded page count and token bill on the wire; truncated is returned on both result branches
- [Phase 03]: Parse cache (03-06): the SCHEMA_VERSION staleness gate lives inside getCached, so a row produced under a retired prompt/schema contract can never be served by a call site that forgot to check; the row is kept on disk for audit, not deleted (D-24).
- [Phase 03]: Parse cache (03-06): parsed_results is keyed on file_hash ALONE with ON CONFLICT(file_hash) upsert — storing a different model updates the one row (proven by COUNT(*)=1 across a model switch), because keying on hash+model would silently re-parse and re-charge the entire history the first time the user changed models (D-14/Pitfall 7).
- [Phase 03]: Parse cache (03-06): putCached takes the raw base URL and stores only new URL().host, so a gateway URL carrying the key in userinfo or a query string cannot reach SQLite; money is bound as-is with no rounding fallback (a silent auto-correct is what D-12 forbids), and a corrupt JSON blob degrades to {}/[] rather than aborting a batch.
- [Quick 260727-fb9]: payload-free IPC handlers normalize before the strict-empty parse (`parse(raw ?? {})`) — the gate stays a real path-injection guard because a non-empty payload still throws before any privileged work, while the genuine no-arg preload call is accepted. ingestion:scan was the last mis-shaped site; the six surviving bare `Schema.parse(raw)` calls all belong to handlers whose preload method sends an argument.
- [Quick 260727-iv0]: the renderer mirrors confidence.ts's flag-attribution rules LOCALLY rather than importing from src/main (which would pull main-process code into the renderer bundle), and any flag it cannot attribute to a known ParsedFields key condemns all three money fields. ARITHMETIC_FLAG is literally 'arithmetic:subtotal+tax!=total' whose suffix is not a field name, so a naive split(':') mapping would drop the whole cross-check silently; the backstop makes every future unrecognized flag degrade toward showing MORE review markers, and since totalCents always renders it guarantees a non-empty flag set is always visible (WR-10).
- [Quick 260727-iv0]: the Bills row shows exactly ONE status chip whose label and variant both come from statusChip's ten-row precedence table. File status (rows 1-5) outranks parse status so a dedupe warning can never be overwritten by "Ready to review", and "Needs review" outranks "Already read" because a flagged bill wearing a calm cache-hit chip is the chip-level WR-10 failure. Only 'flagged' confidence is surfaced, never 'low' (the image-only route lands every non-flagged field at 'low' by design, so marking low would badge every phone-photo receipt).
- [Quick 260727-fb9]: a bridge-shape assertion is not a proof of function — e2e/ipc-boundary.spec.ts asserted `scan` existed on window.api, which a permanently-rejecting handler passed for a whole phase. Security gates whose reject half is unreachable from the renderer (the preload discards arguments) are pinned at the main-process handler instead, with the resolve half proven by an e2e that actually invokes the channel.

### Pending Todos

None yet.

### Blockers/Concerns

- Phase 01 acceptance is NOT closed: the 01-08 cross-OS human verification (real Mac plus real Windows, light and dark) is deferred and tracked (see Deferred Items). Downstream Phases 2/3/4 are unblocked (they depend only on Phase 01 code, which is verified), but the phase stays pending until the checks pass and /gsd:verify-work 01 is run. Surfaces in /gsd:audit-uat and /gsd:progress.
- Phase 4 (QuickBooks Connection) is gated on Anthony providing QuickBooks sandbox client id, client secret, and redirect URI. Sandbox credentials are available immediately; production credentials come later at Phase 8.
- Phase 8 packaging depends on code-signing certificates with real lead time (Apple Developer Program enrollment, Windows HSM or cloud code-signing). Start procurement early, well before Phase 8 opens.
- OAuth token-lifecycle facts changed in November 2025 (60-minute access tokens, roughly 24-hour refresh-token rotation, 5-year cap, mandatory Reconnect URL by Feb 24, 2026). Re-verify against Intuit's live docs at Phase 4 planning time.
- RESOLVED 2026-07-27 (was APP-BREAKING): ingestion:scan always rejected (Phase 2 regression found during 03-02). Fixed by quick task 260727-fb9 — src/main/ipc/ingestion.ts now runs ScanRequestSchema.parse(raw ?? {}), and the coverage hole is closed at two layers (test/ingestion-ipc-scan.test.ts pins the reject half at the handler; e2e/ingestion-scan.spec.ts actually invokes window.api.ingestion.scan() and clicks Scan now). Reverting the fix turns both red. Phase 3 deferred-items.md item 2 is CLOSED.
- STANDING for 03-07: the parse IPC handlers do not exist yet. Any payload-free handler among them must Zod-parse `raw ?? {}`, never a bare `raw` — the preload invokes payload-free channels with no argument, so a strict-empty schema on bare `raw` always throws.

## Quick Tasks Completed

| ID | Date | Task | Outcome |
|----|------|------|---------|
| 260727-fb9 | 2026-07-27 | Fix ingestion:scan strict-empty payload rejection + regression coverage | `parse(raw ?? {})` in src/main/ipc/ingestion.ts; new test/ingestion-ipc-scan.test.ts (5 cases) and e2e/ingestion-scan.spec.ts (invocation + UI proof). ING-01/ING-02 now genuinely functional. Commits 8aaddb0, fdf9eaf, 6c26cc0. |
| 260727-k05 | 2026-07-27 | Swap the text wordmark for the real NicoleBooks logo and retheme from Magnet Group violet to the logo's crimson | Four root logo files moved to src/renderer/src/assets/ under kebab-case. Header renders the PNG lockup at h-8 (the SVG is unusable: no @font-face, wordmark set in a commercial trial face installed only on the build machine, plus legacy raster layers). Accent palette moved to #910023 crimson across primary/ring/info/chart-1, accent to #e28299 rose; globals.css and tokens.json kept in sync. Dark ring derived as #e02a52 (3.83/3.42/3.16:1, clears 3:1 on all three dark surfaces, which #8f33ff did not). Destructive moved #ff3b30 -> #e8500f to double hue separation from the new crimson (11.3 -> 22.8 deg) so alert chips stop reading as brand chrome. launch.spec.ts strengthened to assert the logo decoded (naturalWidth 1931). Open: needs a dark-mode logo variant. Commits 538ac40, 09b9f49, ebe734d. |
| 260727-iv0 | 2026-07-27 | Bills row: labeled parse fields + a single status chip | ScanRow now renders all nine parsed fields as labeled `<dl>` pairs with the review marker on the field that failed, plus exactly one Badge from `statusChip`'s ten-row precedence table (the In batch / file-status / parse-status / blanket Needs review stack is gone). New `flaggedFields` helper; `truncated` surfaced. WR-10 strengthened, not weakened. New test/bills-row-status.test.ts (38 pins). Suite 358 -> 419. Commits 2158af3, 823df94, 72904c8, 927ac48. |

## Deferred Items

Items acknowledged and carried forward from previous milestone close:

| Category | Item | Status | Deferred At |
|----------|------|--------|-------------|
| Human UAT | 01-08 cross-OS real-machine verification: (1) Mac better-sqlite3 native rebuild (exit 0, no NODE_MODULE_VERSION), (2) keychain OK path plus locked-keychain "unavailable" copy, (3) visual brand fidelity vs 01-UI-SPEC in light and dark on both Mac and Windows. Steps: 01-08-PLAN.md how-to-verify. Close with /gsd:verify-work 01. | Open, tracked | 2026-07-23 (Phase 01) |

## Session Continuity

Last session: 2026-07-27T17:59:30.000Z
Stopped at: Completed quick task 260727-iv0 (Bills row labeled fields + single status chip)
Resume file: None
