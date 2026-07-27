---
phase: 03-ai-client-and-parse-pipeline
plan: 01
subsystem: api
tags: [ipc, zod, openai, electron-preload, contract-first, test-double, pdfjs, sharp, heic]

# Dependency graph
requires:
  - phase: 01-foundation
    provides: "typed IPC boundary (src/shared/ipc-contract.ts, schemas.ts, sandbox-safe preload), the secrets safeStorage channel that stores the AI credential, app_settings + settings:get/set for the non-secret model id"
  - phase: 02-ingestion-and-dedupe
    provides: "ScanFile.hash (SHA-256) — reused verbatim as the parse cache key and the ParseBatchFile/ParseFileResult join key; the flag-and-continue per-file isolation pattern parse mirrors"
provides:
  - "Six pinned ai:* / parse:* IPC channel constants (ai:test-connection, ai:list-models, ai:set-model, parse:parse-batch, parse:reparse, parse:progress)"
  - "The full cross-boundary type set: ModelInfo, ParsedFields, FieldConfidence, ParseFileStatus, ParseFileResult, ParseBatchFile, ParseProgress, ParseBatchResult, AiApi, ParseApi"
  - "Zod payload schemas: AiTestConnectionSchema, AiListModelsSchema, AiSetModelSchema, ParseBatchSchema, ReparseSchema — plus BillSchema, the authoritative model-output gate"
  - "window.api.ai + window.api.parse preload bridge, incl. parse.onProgress subscribe/unsubscribe"
  - "test/helpers/fake-openai-client.ts — the shared OpenAIClientLike double every Phase 3 spec injects"
  - "The six locked Phase 3 dependencies installed and exact-pinned"
affects: [03-02-ai-config, 03-03-validation-confidence, 03-04-routing-image-prep, 03-05-vision-extraction, 03-06-cache-persistence, 03-07-pipeline-integration, 06-review-table]

# Tech tracking
tech-stack:
  added: [openai@6.48.0, unpdf@1.6.2, pdfjs-dist@6.1.200, sharp@0.35.3, heic-convert@2.1.0, "@napi-rs/canvas@1.0.2"]
  patterns:
    - "Interface-first wave ordering: one plan owns every shared-file edit so Wave 2 slices run in parallel with zero conflicts"
    - "Structural client type (OpenAIClientLike) instead of the concrete SDK class, so the injectable-deps pattern needs no mocking"

key-files:
  created:
    - test/helpers/fake-openai-client.ts
    - test/fake-openai-client.test.ts
  modified:
    - src/shared/ipc-contract.ts
    - src/shared/schemas.ts
    - src/preload/index.ts
    - test/ipc-contract.test.ts
    - e2e/ipc-boundary.spec.ts
    - package.json
    - package-lock.json

key-decisions:
  - "The AI credential and endpoint URL appear in zero types and zero schemas; the only AI config crossing the boundary is the non-secret model id (D-05, T-03-01), proven by a grep gate over both shared files"
  - "BillSchema keeps money as the raw printed string and requires only vendor + total; cents coercion is local and deterministic in 03-06's validate.ts (D-09/D-23, RESEARCH Pitfall 4)"
  - "ParseBatchSchema pins hash to exactly 64 chars so a malformed value can never become a parsed_results primary key"
  - "The six new deps are exact-pinned (no caret ranges), matching every other dependency in this repo and Anthony's explicit 6.48.0 / 1.6.2 choice"
  - "pdfjs-dist must be imported from pdfjs-dist/legacy/build/pdf.mjs in the Electron main process — the default build throws ReferenceError: DOMMatrix is not defined outside a DOM"

patterns-established:
  - "Contract-first: ai/parse channel constants, types, schemas and the preload bridge all land in one plan; downstream plans import and never re-edit the shared files"
  - "Shared test double: a hand-written OpenAIClientLike with a .calls recorder and throwForFilename, so 'the client was NEVER called' (PARSE-05) and 'only one file failed' (D-15) are directly assertable"
  - "Every payload-free channel gets its own strict-empty Zod schema so a caller cannot smuggle a credential into a handler"

requirements-completed: []  # see "Requirements Status" — this plan delivers the contract slice only; AI-02 / PARSE-03 / PARSE-05 stay Pending until their implementing plans land

# Metrics
duration: 11min
completed: 2026-07-27
---

# Phase 3 Plan 01: AI/Parse Contract Foundation Summary

**The complete ai:*/parse:* IPC contract (6 pinned channels, 9 cross-boundary types, 6 Zod schemas incl. the authoritative BillSchema), the window.api.ai/parse preload bridge, a shared no-network OpenAI client double, and the six locked Phase 3 libraries installed and ABI-verified.**

## Performance

- **Duration:** 11 min
- **Started:** 2026-07-27T12:22:53Z
- **Completed:** 2026-07-27T12:34:12Z
- **Tasks:** 3
- **Files modified:** 9 (2 created, 7 modified)

## Accomplishments

- **Every Phase 3 shared-file edit is now done.** Wave 2 plans (03-02 AI config, 03-03 validation, 03-04 routing, 03-05 vision, 03-06 persistence) can run fully in parallel: none of them needs to touch `ipc-contract.ts`, `schemas.ts`, or `preload/index.ts` again. Wave 3 (03-07) only adds handler wiring.
- **The secret boundary is enforced structurally, not by convention.** There is no field anywhere in the contract or the schemas that could carry the AI credential or endpoint URL — `ai:test-connection` and `ai:list-models` are strict-empty payloads, so the renderer cannot even send one. The grep gate over both files is clean (T-03-01 mitigated).
- **The two parse routes stay distinct in the contract.** `ParseFileResult.truncated` (D-21 page cap) and the `route` provenance the cache stores are modelled so that image-only PDFs go through pdfjs rasterization while only raw photos reach sharp/prepImage — the contract forecloses neither path.
- **The shared fake client is guarded by its own spec**, so the downstream "client NEVER called" (PARSE-05 cache-hit-no-recall) and "only the named file failed" (D-15 isolation) proofs cannot pass vacuously.
- **The e2e boundary spec passes against the running app** with the new `ai` + `parse` groups asserted — `window.api` exposes exactly `['ai','ingestion','parse','secrets','settings','theme']` and, within the new groups, only named methods.

## Task Commits

Each task was committed atomically:

1. **Task 1 (RED): pin the new channels and create the shared fake OpenAI client double** — `e5fceb1` (test)
2. **Task 2 (GREEN): add ai/parse channels, cross-boundary types, Zod schemas, and preload bridge** — `45c621f` (feat)
3. **Task 3: install the six Phase 3 libraries and verify Electron-ABI load** — `559e31b` (chore)

**Plan metadata:** see the final `docs(03-01)` commit.

## Files Created/Modified

- `src/shared/ipc-contract.ts` — six ai/parse channel constants; `ModelInfo` (with the three-state `vision` classification for D-01/D-02), `ParsedFields` (integer cents, mirrors the D-24 columns), `FieldConfidence`, `ParseFileStatus`, `ParseFileResult`, `ParseBatchFile`, `ParseProgress`, `ParseBatchResult`; `AiApi` + `ParseApi`; `Api` gains `ai` and `parse`
- `src/shared/schemas.ts` — `AiTestConnectionSchema` / `AiListModelsSchema` (strict-empty), `AiSetModelSchema`, `ParseBatchSchema` (64-char hash, 500-entry cap), `ReparseSchema`, and `BillSchema` + the inferred `Bill` type
- `src/preload/index.ts` — `window.api.ai` (3 invokes) and `window.api.parse` (2 invokes + `onProgress`, copying the `theme.onChange` listener/removeListener shape verbatim)
- `test/helpers/fake-openai-client.ts` — hand-written `OpenAIClientLike` (zero `openai` imports), `makeFakeClient()`, `makeChatResponse()`, `makeTextResponse()`; records every call, serves OpenAI-minimal and OpenRouter-rich `models.list()` shapes (both `.data` and async-iteration), ordered canned responses for the D-25 repair-retry ladder, and `throwForFilename` for D-15
- `test/fake-openai-client.test.ts` — guard spec for the double
- `test/ipc-contract.test.ts` — channel-stability assertion extended with the six new pins
- `e2e/ipc-boundary.spec.ts` — api-shape assertion extended with the `ai` and `parse` groups
- `package.json` / `package-lock.json` — the six locked libraries, exact-pinned
- `.planning/phases/03-ai-client-and-parse-pipeline/deferred-items.md` — one out-of-scope finding logged

## Decisions Made

- **`ParseFileResult.error?: string` and `AiApi.testConnection` returning `{ ok, models?, error? }`** — D-15's "needs attention / retry" row and D-04's "AI connection: error" status both have to display a plain, recoverable reason. Without a reason field the UI could only say "something failed". Typed as a human-readable string; handlers must never put a raw stack there (the `secrets.ts` graceful-null discipline).
- **`AiListModelsSchema` added** (the plan named four payload schemas; this is a fifth) — `ai:list-models` is payload-free like `ai:test-connection`, and Shared Pattern A requires a Zod parse even on an empty payload. A handler with no schema would accept a smuggled payload before doing privileged work.
- **`ModelInfo.vision` is a three-state union (`'vision' | 'vision-family' | 'unknown'`) rather than a boolean** — the UI treats the cases differently: metadata-confirmed and curated-family models get badged, `unknown` stays unbadged and hits the D-01 "use anyway" confirm gate. A boolean would collapse "we know it is not vision" into "we cannot tell", which is exactly the distinction AI-03 turns on.
- **Requirement IDs left Pending** (see Requirements Status below).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing Critical / CLAUDE.md precedence] Exact-pinned the six new dependencies**
- **Found during:** Task 3 (install)
- **Issue:** `npm install <pkg>@<version>` wrote caret ranges (`^6.48.0`, `^1.6.2`, ...) into `package.json`. Every existing dependency in this repo is exact-pinned, CLAUDE.md declares these versions locked, and Anthony explicitly chose 6.48.0 / 1.6.2 over the newer 6.49.0 / 1.7.0. A caret range means the next clean install silently pulls the versions he rejected.
- **Fix:** Rewrote the six entries to exact versions and re-ran `npm install` so the lockfile root spec matches.
- **Files modified:** package.json, package-lock.json
- **Verification:** lockfile spec and resolved version match exactly for all six; `npm install` postinstall (`electron-rebuild -f -w better-sqlite3`) completed clean.
- **Committed in:** `559e31b` (Task 3 commit)

**2. [Rule 2 - Missing Critical] Added a guard spec for the shared fake client**
- **Found during:** Task 1 (fake double creation)
- **Issue:** The double underwrites two load-bearing Phase 3 proofs — PARSE-05 "the injected client was NEVER called" and D-15 "only the named file failed". If the double silently stopped recording calls or stopped honoring `throwForFilename`, both proofs would pass vacuously and a real cache miss (a re-charged model call) or a batch abort would ship undetected.
- **Fix:** Added `test/fake-openai-client.test.ts` covering call recording, both `models.list()` access styles, per-filename throwing, ordered canned responses, and `reset()`.
- **Files modified:** test/fake-openai-client.test.ts (new)
- **Verification:** `npx vitest run test/fake-openai-client.test.ts` green; the filename is unclaimed by any other Phase 3 plan, so no Wave 2 conflict.
- **Committed in:** `e5fceb1` (Task 1 commit)

**3. [Rule 2 - Missing Critical] Added a recoverable-error field to two result types**
- **Found during:** Task 2 (contract)
- **Issue:** `ParseFileResult` had no way to carry why a file failed, and `testConnection` returned only `{ ok, models? }`. D-15 requires a visible "needs attention" reason and D-04 requires a plain recoverable error surface (CR-01/WR-04). The UI could not honor either.
- **Fix:** `ParseFileResult.error?: string` and `AiApi.testConnection(): Promise<{ ok, models?, error? }>`, both documented as human-readable and never a raw stack.
- **Files modified:** src/shared/ipc-contract.ts
- **Verification:** `npm run typecheck` green; grep gate still clean (no credential material introduced).
- **Committed in:** `45c621f` (Task 2 commit)

---

**Total deviations:** 3 auto-fixed (3 missing-critical; one of them CLAUDE.md-driven)
**Impact on plan:** All three protect correctness of things the plan already required (locked versions, non-vacuous proofs, recoverable error surfaces). No scope creep — no new module, no new channel, no behavior beyond the contract.

## Issues Encountered

**pdfjs-dist's default build cannot load in the Electron main process.** Verifying the install surfaced a hard failure that would have blocked 03-04:

```
ReferenceError: DOMMatrix is not defined
  at node_modules/pdfjs-dist/build/pdf.mjs:10407
```

The package itself warns `Please use the 'legacy' build in Node.js environments.` The main process is Node with no DOM, so the same failure applies there, not just in the verification script. The working import is:

```js
await import('pdfjs-dist/legacy/build/pdf.mjs')   // getDocument + OPS both resolve
```

Verified: the legacy build loads clean and exposes both `getDocument` and `OPS` (which D-20's gate needs for `paintImageXObject` and text-render-mode 3). **03-04 (route.ts, extract-pdf.ts) must use the legacy path**, and this compounds RESEARCH Pitfall 1 — `unpdf.renderPageAsImage` additionally needs `configureUnPDF` with the official build plus the `@napi-rs/canvas` provider. `unpdf` itself exports `extractText`, `renderPageAsImage`, and `configureUnPDF` as expected at 1.6.2.

No other issues. All five CJS-loadable libraries (`sharp`, `@napi-rs/canvas`, `better-sqlite3`, `heic-convert`, `openai`) require cleanly, and the electron-rebuild postinstall exited clean.

## Requirements Status

The plan's frontmatter lists `AI-02, PARSE-03, PARSE-05`, but this plan delivers only the **contract slice** of each. `REQUIREMENTS.md` was deliberately **not** updated, because none of the three is satisfied yet:

| Req | Text | Delivered here | Actually completed by |
|-----|------|----------------|-----------------------|
| AI-02 | fetches the model list and lets the user pick one | `AiApi.listModels`, `ModelInfo`, `AiSetModelSchema` | 03-02 |
| PARSE-03 | extracts structured fields with the vision model | `BillSchema`, `ParsedFields` | 03-05 |
| PARSE-05 | persists parsed results so a reload never re-calls the model | `ParseFileStatus: 'cached'`, `ReparseSchema` | 03-06 + 03-07 |

Marking them complete now would put "Complete" next to a feature that does not exist. They stay `Pending`; their implementing plans close them.

## Known Stubs

**The ai:* and parse:* channels have no main-side handlers yet — intentional, and the entire point of the plan's interface-first ordering.**

| Stub | File | Reason / resolver |
|------|------|-------------------|
| `window.api.ai.*` invokes reject with `No handler registered for 'ai:...'` | src/preload/index.ts | By design. `src/main/ipc/ai.ts` + its `register.ts` line are owned by **03-02**. |
| `window.api.parse.*` invokes reject with `No handler registered for 'parse:...'` | src/preload/index.ts | By design. `src/main/ipc/parse.ts` + pipeline wiring are owned by **03-07**. |
| No renderer currently calls the new groups | SettingsScreen.tsx / BillsScreen.tsx untouched | By design. UI surfaces are 03-02 (Settings AI config) and 03-07 (Bills parse status). |

The e2e boundary spec asserts only the *shape* of `window.api.ai` / `window.api.parse`, never invokes them, so it is green today and will stay green once handlers land. No stub blocks this plan's own goal (a complete, importable contract).

## User Setup Required

None — no external service configuration required by this plan. (The live end-to-end parse still needs Anthony's OpenAI-compatible key at the Phase 3 human-verify gate, per 03-VALIDATION "Manual-Only Verifications"; nothing here changes that.)

## Next Phase Readiness

**Wave 2 is unblocked and fully parallel.** 03-02 through 03-06 can start simultaneously — every shared file they would have contended over is finished, and each imports fixed contracts:

- **03-02** — `AiApi`, `ModelInfo` (three-state `vision`), `AiSetModelSchema`; inject `OpenAIClientLike` from `test/helpers/fake-openai-client.ts` for `test/ai-models.test.ts`.
- **03-03** — `ParsedFields` (integer cents), `FieldConfidence`, `BillSchema` as the input to `validate.ts`.
- **03-04** — `ParseFileResult.truncated`; **must import `pdfjs-dist/legacy/build/pdf.mjs`** (see Issues Encountered) and `configureUnPDF` with `@napi-rs/canvas`.
- **03-05** — `BillSchema` (authoritative re-validation) and the double's ordered `chatResponse` array to script the D-25 repair retry.
- **03-06** — `ParsedFields` maps 1:1 onto the D-24 `parsed_results` columns; `ReparseSchema`.
- **03-07** — `ParseBatchResult`, `ParseProgress`, and the double's `throwForFilename` for the D-15 isolation test.

**Concerns:** one, already documented — the pdfjs legacy-build requirement. It is verified working, not open.

## Self-Check: PASSED

- All 9 declared files exist on disk.
- All 3 task commits exist in git (`e5fceb1`, `45c621f`, `559e31b`).
- must_haves artifacts verified: `ipc-contract.ts` contains `aiTestConnection`; `schemas.ts` contains `ParseBatchSchema`; `preload/index.ts` contains `onProgress`; `fake-openai-client.ts` contains `OpenAIClientLike`.
- key_link verified: `preload/index.ts` references `Channels.(ai|parse)` 7 times.
- `npx vitest run` — 11 files, 77 tests passed.
- `npm run typecheck` — clean.
- `npx playwright test e2e/ipc-boundary.spec.ts` — passed against the running app.
- Secret grep gate over `ipc-contract.ts` + `schemas.ts` — no matches (T-03-01).

---
*Phase: 03-ai-client-and-parse-pipeline*
*Completed: 2026-07-27*
