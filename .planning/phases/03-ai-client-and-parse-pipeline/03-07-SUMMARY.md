---
phase: 03-ai-client-and-parse-pipeline
plan: 07
subsystem: parse
tags: [orchestrator, ipc, progress-broadcast, per-file-isolation, cache-first, d13, d14, d15, d19, d21, d22, d26]

# Dependency graph
requires:
  - phase: 03-01
    provides: "the frozen contract (ParseBatchFile / ParseFileResult / ParseProgress / ParseBatchResult, the three parse channel constants, the window.api.parse bridge with its onProgress disposer) and the shared fake OpenAIClientLike double whose call recording IS the no-recall proof"
  - phase: 03-02
    provides: "getSelectedModel (the model id from app_settings) and AI_BASE_URL_SECRET / buildClient, which extractFields loads lazily when no client is injected"
  - phase: 03-03
    provides: "validateBill (integer cents, ISO dates, the arithmetic cross-check) and computeConfidence / agreementFlags — the deterministic authority this plan wires in, in the order 03-03 specified"
  - phase: 03-04
    provides: "routeFile (the D-20 gate), extractPdfText, renderPdfPageImage (pdfjs legacy + @napi-rs/canvas), prepImage, and the real test/fixtures/image-only.pdf"
  - phase: 03-05
    provides: "extractFields (the D-25 ladder; never throws, reports failure as data) and the MAX/HEAD/TAIL page-cap constants"
  - phase: 03-06
    provides: "getCached / putCached over the parsed_results STRICT table, keyed on the SHA-256 alone"
provides:
  - "parseBatch — the cache-first, per-file-isolated batch orchestrator with progress emission (D-13/D-15/D-22/D-26)"
  - "selectPageIndexes — the D-21 cap applied BEFORE rendering, on both PDF branches"
  - "registerParseIpc — the parse:parse-batch / parse:reparse handlers and the parse:progress broadcast"
  - "the Bills parse-status surface: auto-parse after scan, parsing N of M, per-file badges, per-row reason and Retry"
  - "a pre-decode HEIC pixel budget that closes deferred item 3 (T-03-03)"
affects: [06-review-table, 07-posting-and-audit]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Cache-first means BEFORE the byte read, not merely before the model call — the no-recall spec boobytraps the byte reader too, so the ordering is proven rather than assumed"
    - "Document preparation branches on source type before it looks at the route, so sharp and PDF bytes can never meet"
    - "A failed parse is never written to the cache, which is what makes a Retry a genuinely fresh call rather than a cache read"
    - "Progress is a notification, not a step: a throwing listener is swallowed so a closing window cannot abort a paid batch"

key-files:
  created:
    - src/main/parse/pipeline.ts
    - src/main/ipc/parse.ts
    - test/parse-pipeline.test.ts
  modified:
    - src/main/ipc/register.ts
    - src/renderer/src/screens/BillsScreen.tsx
    - test/parse-cache.test.ts
    - e2e/ipc-boundary.spec.ts
    - .planning/phases/03-ai-client-and-parse-pipeline/03-VALIDATION.md
    - .planning/phases/03-ai-client-and-parse-pipeline/deferred-items.md
    - .planning/REQUIREMENTS.md

key-decisions:
  - "The cache lookup precedes the byte read, not just the model call, so a re-scan of an unchanged folder does no I/O per file beyond the Phase 2 hash it already had"
  - "The D-21 page cap selects indexes BEFORE rendering, so a 60-page bill never rasterizes 55 pages it will not send; extractFields keeps its own cap as the backstop for other callers"
  - "truncated is prepared.truncated OR result.truncated, because the two layers measure different places a page can be dropped and either one means the model saw an incomplete document"
  - "A failure reason is fixed copy, never the error's own text: fs errors carry absolute paths and SDK errors embed the request URL"
  - "parse:reparse resolves its filename server-side by re-scanning and matching hashes, because the frozen contract deliberately carries no path across the boundary"
  - "The HEIC pixel budget allows a file whose ispe box cannot be read, matching Phase 2's load-on-inconclusive-detection rule — a real bill must never be false-skipped by a header this parser could not parse"

patterns-established:
  - "An orchestrator injects every side-effecting collaborator (db, client, byte reader, clock, router, extractor, renderer, prepper) so the whole vertical slice runs offline, and omits them one at a time when a spec needs the real path"
  - "A security gate is proven by invoking the channel, not by asserting the method exists on the bridge"

requirements-completed: [PARSE-04, PARSE-05]

# Metrics
duration: 14min
completed: 2026-07-27
---

# Phase 3 Plan 07: Parse Pipeline Integration Summary

**The vertical slice that makes the parse capability real: a cache-first, per-file-isolated `parseBatch` that runs each bill through route to prep to vision to validate-and-score to cache write, streamed to the Bills screen as `parsing N of M` with per-file badges, a visible reason on every failure, and a Retry that re-parses just that file.**

## Performance

- **Duration:** 14 min
- **Started:** 2026-07-27T15:26Z
- **Completed:** 2026-07-27T15:40Z
- **Tasks:** 3
- **Files modified:** 10 (3 created, 7 modified, 3 of those planning docs)

## Accomplishments

- **PARSE-05 is now a proven behavior, not a stored row.** The no-recall spec seeds a cached row and then boobytraps BOTH collaborators: the fake client rejects every call and the byte reader throws. The batch still returns `status: 'cached'` with the stored fields, and `client.neverCalled()` is `true`. That double trap is what makes it a genuine no-recall proof rather than "the answer happened to match" — it pins that `getCached` runs before the file is even opened, so a re-scan of an unchanged folder is free in both money and I/O. Four more cases cover the shapes around it: a stale `schema_version` row is a miss that re-parses (and rewrites itself so the NEXT run hits), the D-14 `force` override upserts over the existing row instead of adding a second, and a mixed batch of one cached plus one new file makes exactly one paid call.
- **The anti-pattern this plan could most easily have undone is proven not to have been.** `prepareDocument` branches on SOURCE TYPE before it consults the route: every PDF is rasterized by `renderPdfPageImage`, and only raw photos reach `prepImage`. The real `test/fixtures/image-only.pdf` runs end to end through `parseBatch` with NO document collaborators injected, so the genuine pdfjs signal loader and the genuine pdfjs + @napi-rs/canvas renderer both run — and `prepImage` is injected as a function that throws. The result is `parsed`, the wire carries one buffer whose first three bytes are `ffd8ff` (a real JPEG, over 1000 bytes, not `%PDF`), and the cached row records `route: 'image-only'`. If a later change routes an image-only PDF to sharp, that boobytrap fires before sharp even gets the chance to reject the bytes.
- **The D-22 second call is wired where it actually changes an answer.** An image-only document makes 2 chat calls, a native PDF makes 1, and both calls carry `temperature: 0`. The load-bearing assertion is the pair: a second pass disagreeing on the total yields `agreement:totalCents` in `validationFlags` **and** `confidence.totalCents === 'low'`. Only the second half proves the merge happened before `computeConfidence` ran — 03-03 warned that merging late (or not at all) leaves the whole paid cross-call inert while still looking wired, and a flag with no confidence consequence is exactly what that failure looks like.
- **Per-file isolation is proven by failing a specific file, not a call index.** The injected byte reader stamps each file's name into its own bytes, which flow through the injected prep step into the image part, so the fake client can reject precisely the request carrying `two.pdf`. The batch returns `[parsed, parse-failed, parsed]`, the summary counts `{ parsed: 2, failed: 1 }`, and the failed row's reason contains neither `ECONNREFUSED` nor a stack frame. An unreadable file, a throwing progress listener, and a missing model all land the same way: one row, batch intact.
- **The D-21 cap now bounds render work, not just token count.** `selectPageIndexes` runs before rasterization, so a 14-page native invoice and a 12-page image-only scan each render exactly `[0,1,2,n-2,n-1]` — the spec asserts the rendered index list directly, which is the difference between capping the request and capping the work. `truncated` round-trips through migration0003's 0/1 column in both directions.
- **Deferred item 3 is closed, in the place it was assigned.** A `.heic` file's declared canvas is read from the ISOBMFF `ispe` box and checked against sharp's own `MAX_INPUT_PIXELS` ceiling BEFORE `heic-convert` touches it, because heic-convert runs first (sharp's libvips cannot decode HEIC at all) and has no pixel cap of its own. A declared 60000x60000 canvas becomes a `parse-failed` row while the rest of the batch parses; a 4032x3024 iPhone frame passes.
- **286 unit tests across 20 files and 7 Playwright specs green; `npm run build` and `npm run typecheck` clean.** `src/shared/ipc-contract.ts`, `src/shared/schemas.ts` and `src/preload/index.ts` are byte-identical to their 03-01 state.

## Task Commits

Each task was committed atomically:

1. **Task 1 (RED): spec per-file isolation, cache-hit-no-recall and progress counts** — `9f1a12b` (test)
2. **Task 2 (GREEN): pipeline.ts orchestrator + parse IPC handlers + progress broadcast** — `0c1b5e5` (feat)
3. **Task 3: Bills parse-status surface (auto-parse, badges, parsing N of M, retry)** — `36028b6` (feat)
4. **Deviation: prove the parse channels are invocable, not merely present** — `e32aa93` (test)

**Plan metadata:** see the final `docs(03-07)` commit.

## Files Created/Modified

- `src/main/parse/pipeline.ts` — `ParseDeps` (12 injectable collaborators, all defaulting to the real implementation), `selectPageIndexes` (the D-21 cap), `parseBatch` (the sequential batch loop with progress), `parseOne` (the six-step per-file body inside one try/catch), `prepareDocument` (the source-type branch), the pre-decode HEIC pixel budget, the inbox containment guard, and the fixed failure-copy table.
- `src/main/ipc/parse.ts` — `registerParseIpc`: `parse:parse-batch` and `parse:reparse`, both `assertTrustedSender` first then Zod-parse; `progressBroadcaster` (theme.ts's `webContents.send`, narrowed to the sender window and guarded against a destroyed one); `findInboxFileByHash` (server-side filename resolution via `runScan`).
- `src/main/ipc/register.ts` — `registerParseIpc()` added alongside `registerAiIpc()`.
- `src/renderer/src/screens/BillsScreen.tsx` — auto-parse after scan (a separate call, D-26), the `onProgress` subscription whose cleanup is the bridge's own disposer, `PARSE_STATUS_VARIANT` / `PARSE_STATUS_LABEL`, a `parsing N of M` indicator, a settled tally, per-row parse badges, a read-only vendor and total on parsed rows, the reason plus Retry on failed rows, and `formatCents` (string math, never `cents / 100`).
- `test/parse-pipeline.test.ts` — 28 tests in six groups: isolation, progress, the D-22 second pass and D-06 pairing, the D-21 cap, the real image-only-PDF composition, and the configuration/input guards.
- `test/parse-cache.test.ts` — appended the pipeline PARSE-05 describe block (6 tests) on top of the storage layer's own 15, reusing the exported `makeRow` / `FIELDS` / `HASH_A` / `HASH_B` rather than rewriting the file.
- `e2e/ipc-boundary.spec.ts` — step 4: the parse channels invoked from the renderer, both Zod bounds tripped, the disposer type checked.
- `.planning/.../03-VALIDATION.md` — the six 03-07 rows flipped green with what each now proves; `wave_0_complete: true`; every Wave-0 checkbox ticked.
- `.planning/.../deferred-items.md` — item 3 closed with the mechanism and the two specs that pin it.
- `.planning/REQUIREMENTS.md` — PARSE-04 marked complete (see Deviations).

## Decisions Made

- **Cache-first means before the byte read, not merely before the model call.** The plan's wording ("a HIT returns status 'cached' WITHOUT any model call") is satisfied by either ordering, but reading bytes for a file whose answer is already on disk is pure waste on the most common path there is: Nicole re-scans a folder she has already processed. Putting `getCached` first also gives the spec something much stronger to assert — a byte reader that throws — which turns an ordering convention into a proven property.
- **A failed parse is never cached.** `failedResult` returns without touching `putCached`. If a failure were stored, the Retry affordance would answer from the cache and the "retry just the failed ones" half of D-15 would be decorative. Nothing auditable is lost: the failure carries no model output to preserve.
- **The D-21 cap is applied before rendering, not left entirely to `extractFields`.** 03-05 deliberately put the cap inside `extractFields` so no caller could put an unbounded page count on the wire, and that backstop stays. But rasterizing 60 pages to then discard 55 spends exactly the render budget the cap exists to bound (T-03-02), and the spec asserts the rendered index list, not just the request. The cap constants are imported from `extract-fields.ts`, so the two layers cannot drift apart.
- **`truncated` is `prepared.truncated || result.truncated`.** 03-05's handoff says `result.truncated` is authoritative over a value re-derived from `pageCount`, and it still is — this is not a re-derivation. The two flags measure different places a page can be dropped (this module's pre-render selection, and the request assembly), and either one means the model saw an incomplete document. OR-ing them is the honest answer; taking only `result.truncated` would report `false` for every over-cap PDF now that the selection happens upstream.
- **A failure reason is fixed copy, never the error's own text.** This follows 03-02's ruling for the ai IPC layer, and it matters more here: `fs` errors carry absolute paths (which name the user's folders) and SDK errors routinely embed the request URL. Neither tells a non-technical user anything she can act on. The five sentences shipped each name a next step; `extractFields`'s three reason codes map to three of them.
- **`parse:reparse` resolves its filename by re-scanning.** The frozen contract carries only a hash, deliberately — no renderer-supplied path reaches the filesystem. The cached row's `original_filename` looks like a cheaper source, but a previously-FAILED file has no cached row, and retrying a failure is the primary reason the channel exists. `runScan` already enumerates, gates and hashes the folder, so reusing it is both the correct answer and the one that cannot introduce a second, differently-guarded filesystem path. One scan of a 5-to-20 file folder is an acceptable cost for a deliberate single-file user action.
- **The batch is sequential.** Parallelism would multiply peak memory (a rasterized page is tens of megabytes) and turn one rate-limit response into a burst of them, for no benefit at this volume. It also makes the `parsing N of M` counter mean what it says.
- **The Bills screen shows a read-only vendor and total on parsed rows.** The plan says status and progress only, and the rich editable table is explicitly Phase 6 — but the plan's own human-check asks the verifier to confirm "per-file parsed status and populated fields". One non-interactive line per row satisfies that without building any of Phase 6: no dropdowns, no toggle, no editing, no table.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing Critical] Renderer-supplied file names are containment-checked before any read**
- **Found during:** Task 2
- **Issue:** The pipeline has to join a renderer-supplied `filename` onto the server-resolved inbox path to read bytes. `ParseBatchSchema` bounds the string's length but says nothing about its shape, and the schema's own comment asserts that "filename is bounded but is NEVER used to build a filesystem path". Once the pipeline exists, it necessarily is — so the guard the comment assumes had to become real, or `../../../etc/passwd` would have been a readable path (T-02-02, carried from Phase 2).
- **Fix:** `safeInboxPath` rejects an empty name, `.`, `..`, any `/`, `\` or NUL, and a Windows drive prefix, then independently verifies the resolved path is still inside the resolved inbox root.
- **Files modified:** src/main/parse/pipeline.ts, test/parse-pipeline.test.ts
- **Verification:** a `../../../etc/passwd` entry becomes a `parse-failed` row, the rest of the batch is unaffected, and `client.neverCalled()` is true.
- **Committed in:** `9f1a12b` (spec) / `0c1b5e5` (guard)

**2. [Rule 2 - Missing Critical] Pre-decode HEIC pixel budget (closes deferred item 3, T-03-03)**
- **Found during:** Task 2 — explicitly assigned to this plan by 03-04.
- **Issue:** `prepImage`'s decompression-bomb guard is sharp's `limitInputPixels`, but a `.heic` must pass through `heic-convert` FIRST (sharp's prebuilt libvips cannot decode HEIC), and heic-convert exposes no pixel or memory cap. A hostile HEIC declaring an enormous canvas is fully decoded before sharp's guard applies.
- **Fix:** the declared canvas is read from the ISOBMFF `ispe` box — validated as a real 20-byte FullBox with version 0, so stray bytes spelling `ispe` cannot refuse a legitimate photo — and compared against the same `MAX_INPUT_PIXELS` ceiling sharp uses, before `prepImage` is called. Over budget is a `parse-failed` row, never an exception through the batch. An unreadable or absent `ispe` ALLOWS the file, matching Phase 2's inconclusive-detection rule (load on total detection failure, skip only on positive evidence).
- **Files modified:** src/main/parse/pipeline.ts, test/parse-pipeline.test.ts, deferred-items.md
- **Verification:** a declared 60000x60000 canvas fails while the sibling file in the batch still parses; a 4032x3024 iPhone frame passes.
- **Committed in:** `9f1a12b` (spec) / `0c1b5e5` (guard)

**3. [Rule 2 - Missing Critical] The e2e proves the parse channels are invocable, not merely present**
- **Found during:** Task 3
- **Issue:** `e2e/ipc-boundary.spec.ts` asserted the shape of `window.api.parse`, which is exactly the assertion that let `ingestion:scan` ship permanently-rejecting for a whole phase (quick task 260727-fb9). STATE.md carries a standing note naming these handlers specifically. 03-VALIDATION.md already assigns the e2e extension to 03-07, though the file is not in the plan's `files_modified`.
- **Fix:** step 4 added — `parse:parse-batch` is actually invoked from the renderer and must resolve with its zero summary, the 64-char hash bound must actually reject on BOTH parse channels, and `onProgress` must actually return a disposer. An empty batch is used deliberately: it proves registration and the payload gate without touching the inbox or the model.
- **Files modified:** e2e/ipc-boundary.spec.ts
- **Verification:** the spec passes; it would fail with "No handler registered" if `registerParseIpc` were dropped.
- **Committed in:** `e32aa93`

**4. [Rule 2 - Missing Critical] PARSE-04 marked complete (closes deferred item 4's PARSE-04 half)**
- **Found during:** the state update
- **Issue:** 03-03 shipped `validate.ts` and `confidence.ts` but deliberately left PARSE-04 `Pending`, writing that "nothing calls them yet" and "03-07 closes it". This plan is what calls them, on every parsed file, and the pipeline specs assert the coerced integer cents, the ISO date and the confidence values end to end.
- **Fix:** `gsd-tools requirements mark-complete PARSE-04`.
- **Files modified:** .planning/REQUIREMENTS.md
- **Verification:** the checkbox and the traceability row both read Complete; the behavior is asserted by `test/parse-pipeline.test.ts` ("persists a parsed file..." and the confidence cases).
- **Committed in:** the final `docs(03-07)` commit.

---

**Total deviations:** 4 auto-fixed (all Rule 2 — missing critical functionality)
**Impact on plan:** No scope change, no contract change, no new dependency, no new module. Two close correctness gaps the plan's own threat register already assigned to this file (the batch loop's blast radius, and the renderer-to-main trust boundary), one closes a coverage class this project has already been burned by, and one is a requirement-status reconciliation another plan explicitly deferred here.

## Issues Encountered

**None blocking; every spec passed on the first GREEN run.** Three notes worth carrying:

**The plan's `throwForFilename` option on the fake client could not drive the isolation case as written.** That option matches against TEXT content parts, but the D-23 prompt never mentions the file name — and it must not, since the prompt is locked and adding metadata to it would be a contract change. The spec instead stamps each file's name into its own injected bytes, which flow through the injected prep step into the image part, so the fake can reject precisely the request carrying `two.pdf`. That is a stronger discriminator than a call index anyway: it fails a FILE, not a position in a sequence.

**`extractFields` re-caps the pages it is handed, so its `truncated` is now almost always `false`.** The pipeline caps first (to bound render work), and both layers use the same imported constants, so they agree by construction. Anyone reading `ExtractSuccess.truncated` in isolation should know the pipeline's `prepared.truncated` is the other half; `ParseFileResult.truncated` and the cached column carry the OR of the two.

**The auto-parse fires on every scan, including in the existing `e2e/ingestion-scan.spec.ts`.** That spec still passes because an unconfigured model produces a clean per-file `parse-failed` row rather than a rejection — the "choose an AI model in Settings" path — and the renderer skips `parseBatch` entirely when nothing loaded. Worth knowing before adding e2e coverage that drops real files into the inbox.

## Threat Flags

None. No new network endpoint, auth path, or schema surface. The plan's three assigned threats are mitigated as specified, plus one the register implied and this plan made real:

| Threat | Disposition | How |
|--------|-------------|-----|
| T-03-04 (prompt injection via bill content) | mitigated | `validateBill` + `computeConfidence` run on every file before anything is cached; the model's output is a candidate, never authoritative, and the model is never asked to compute money. A disagreement between two temperature-0 reads becomes a low-confidence flag rather than an averaged number. |
| T-03-02 / T-03-03 (malicious PDF, decompression bomb, one bad file) | mitigated | Per-file try/catch bounds the blast radius to one `parse-failed` row (proven by the three-file isolation case). The D-21 cap bounds render work BEFORE rasterization. The new pre-decode HEIC pixel budget closes the one path that reached a decoder ahead of sharp's guard. |
| T-03-01 (information disclosure) | mitigated | Both handlers `assertTrustedSender` then Zod-parse. The API key stays inside the injected/lazily-built client and is never read here. Only the base URL's HOST is persisted, and `cache.ts` derives it. Progress carries a file name, a status and two counters. Failure reasons are fixed sentences, never a raw error, and this module logs nothing. |
| T-02-02 (path injection, carried from Phase 2) | mitigated | The inbox is resolved server-side; the renderer-supplied name is rejected if it is not a plain file name, and the joined path is independently proven to be inside the inbox root. |

## Requirements Status

| Req | Text | Status |
|-----|------|--------|
| PARSE-05 | Persist parsed results so a reload or crash never re-calls the paid model for the same document | **Complete.** 03-06 shipped the storage half; this plan makes `getCached` the pipeline's first step and proves the guarantee behaviorally with a booby-trapped client and byte reader. |
| PARSE-04 | Validate parsed data deterministically and record per-field confidence signals | **Complete.** 03-03 shipped the validator and the scorer and deferred the status flip to this plan because nothing called them. `parseOne` now calls both on every file, with `agreementFlags` merged before the scorer, and the pipeline specs assert the coerced cents, the ISO date and the resulting confidence values. |

Phase 3's other seven requirements (AI-01..04, PARSE-01..03) were already marked complete by 03-02, 03-04 and 03-05. All nine now read Complete, which puts Phase 3 code-complete pending the end-of-phase human gate.

## Known Stubs

None. Every path in this plan does real work: the pipeline calls the real modules, the handlers call the real pipeline, and the Bills screen renders real results from real IPC. The only deliberately-unrendered data is the per-field `confidence` map and the `validationFlags` list — both are computed, persisted and returned across the boundary, but the screen shows only status and a one-line vendor plus total. That is the plan's explicit boundary (the rich review table with low-confidence highlighting is Phase 6 / REVIEW-07), not a stub: the data exists and is already in the contract Phase 6 will read.

## User Setup Required

**The live end-to-end parse needs an API key.** Everything in this plan is unit- and e2e-proven offline, but the phase's manual gate requires real credentials:

1. On the Settings screen, enter an OpenAI-compatible API key and pick a base URL preset.
2. Press Connect and test; confirm "AI connection: OK" and that the model picker populates.
3. Select a vision-badged model.
4. Drop one native PDF and one photo into the inbox folder, then press Scan now on the Bills screen.
5. Confirm the `parsing N of M` indicator appears, then per-file Parsed badges with a vendor and total.
6. Press Scan now again on the same files and confirm they read Cached (no second charge).

Without a configured model, every file returns a clean "Choose an AI model in Settings" row rather than an error.

## Next Phase Readiness

**Phase 3 is code-complete.** All seven plans have shipped and all nine requirements read Complete. What remains is the end-of-phase human gate: the live-parse smoke above, plus the D-20 threshold tuning against real vendor bills (03-04's A2 note — the 0.75 / 0.90 / 50 / 50% constants are research starting values exposed deliberately as named constants), plus the Settings and Bills visual checks.

**Phase 6 (review table)** consumes exactly what this plan persists and returns: `ParseFileResult.fields` (integer cents, ISO dates), `.confidence` (the per-field `high | low | flagged` map REVIEW-07 highlights from), `.validationFlags` (including the `agreement:` prefixed ones), and `.truncated`. The `parsed_results` row carries the same values plus `raw_response` for audit. Nothing in Phase 6 needs to re-derive or re-validate — `validate.ts` is the authority and it has already run.

**Phase 5 (reconciliation)** reads `fields.vendor` and `fields.suggestedCategory` from the same source. The category is deliberately never grounded (it is a classification guess, not a transcription), so its confidence comes from the model's advisory self-report and Phase 5 should treat it as a starting suggestion, not an answer.

**Concerns:** two, both known and tracked.

1. **The D-20 thresholds are unverified against real bills** (03-04's A2 assumption, on the manual gate). A mis-route is not silent — the cached `route` column records which path each document took, so a bill that reads badly can be diagnosed by looking at its row.
2. **`SCHEMA_VERSION` is the deliberate re-parse lever.** Whoever next edits `BILL_SYSTEM_PROMPT` or `BillSchema` in a way that changes the MEANING of stored fields must bump it, or the cache will keep serving rows produced under a contract that no longer exists. A model change is explicitly not a reason to bump.

## Self-Check: PASSED

- All 3 created files exist on disk; all 7 modified files updated.
- All 4 task commits exist in git (`9f1a12b`, `0c1b5e5`, `36028b6`, `e32aa93`).
- `must_haves` artifacts verified: `pipeline.ts` exports `parseBatch`; `parse.ts` exports `registerParseIpc`; `BillsScreen.tsx` contains `parseBatch`.
- `must_haves` key_links verified: `BillsScreen.tsx` matches `window\.api\.parse\.parseBatch` (line 271); `pipeline.ts` matches `getCached|putCached` (lines 243, 316).
- All six `must_haves` truths asserted by passing tests.
- Acceptance greps: `getCached` (line 243) precedes the first `extractFields` call (line 270); `parse.ts` runs `assertTrustedSender` as the first statement of both handlers and Zod-parses before work; `register.ts` calls both `registerAiIpc` and `registerParseIpc`; `grep -n "#\|rgb(\|hsl(" BillsScreen.tsx` returns nothing.
- `npx vitest run test/parse-pipeline.test.ts test/parse-cache.test.ts` — 49 passed.
- `npx vitest run` — 20 files, 286 tests passed.
- `npx playwright test` — 7 passed.
- `npm run build` — clean (main, preload, renderer).
- `npm run typecheck` — clean.
- `git diff HEAD -- src/shared/ipc-contract.ts src/shared/schemas.ts src/preload/index.ts` — empty.
- No file deletions in any of the four task commits.

---
*Phase: 03-ai-client-and-parse-pipeline*
*Completed: 2026-07-27*
