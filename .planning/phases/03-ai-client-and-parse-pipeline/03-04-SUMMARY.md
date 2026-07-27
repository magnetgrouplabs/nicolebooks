---
phase: 03-ai-client-and-parse-pipeline
plan: 04
subsystem: parse
tags: [routing, pdfjs, unpdf, napi-canvas, sharp, heic, exif, docling-gate, fixtures]

# Dependency graph
requires:
  - phase: 03-01
    provides: "the six pinned libraries (unpdf 1.6.2, pdfjs-dist 6.1.200, sharp 0.35.3, heic-convert 2.1.0, @napi-rs/canvas 1.0.2) and the verified finding that pdfjs-dist's DEFAULT build throws ReferenceError: DOMMatrix is not defined in the Electron main process"
  - phase: 02-ingestion-and-dedupe
    provides: "src/main/ingestion/scan.ts's injectable-deps + classify-and-gate convention, and the extension-based file classification that guarantees only .pdf/.jpg/.jpeg/.png/.heic/.heif bytes ever reach this layer"
provides:
  - "routePage / routePdf / routeFile — the D-20 Docling-style layered native-vs-scan gate with the four thresholds as tunable named constants"
  - "extractPdfText — per-page embedded text (unpdf, mergePages: false)"
  - "loadPdfSignals — the four D-20 signals read from the pdfjs operator list + extracted text"
  - "renderPdfPageImage — an image-only PDF page rasterized to a real JPEG via pdfjs legacy build + @napi-rs/canvas (D-19)"
  - "prepImage — heic-convert -> sharp EXIF-orient/downscale/re-encode with a decompression-bomb guard (D-07, T-03-03)"
  - "test/fixtures/image-only.pdf + test/fixtures/sideways-exif.jpg + a provenance README"
affects: [03-05-vision-extraction, 03-07-pipeline-integration]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Source-type branch before content gate: photos go to prepImage, PDFs go through the D-20 gate, and an image-only PDF goes to renderPdfPageImage — never to sharp"
    - "Layered signal gate with the two 'this is really a picture' rungs evaluated FIRST, so a bitmap page carrying an OCR overlay can never reach the text rung"
    - "Injected synthetic signals for threshold logic, committed fixtures only for what injection cannot prove"

key-files:
  created:
    - src/main/parse/route.ts
    - src/main/parse/extract-pdf.ts
    - src/main/parse/prep-image.ts
    - test/parse-route.test.ts
    - test/parse-prep-image.test.ts
    - test/fixtures/README.md
    - test/fixtures/image-only.pdf
    - test/fixtures/sideways-exif.jpg
  modified:
    - .planning/phases/03-ai-client-and-parse-pipeline/03-VALIDATION.md
    - .planning/phases/03-ai-client-and-parse-pipeline/deferred-items.md

key-decisions:
  - "unpdf 1.6.2 renamed configureUnPDF to definePDFJSModule (configureUnPDF is deprecated and removed in v2), so the plan-named call is made through the current API; the canvas provider is wired via renderPageAsImage's canvasImport"
  - "unpdf's renderPageAsImage emits PNG (canvas.toDataURL defaults to it), so the rendered bitmap is re-encoded to JPEG by @napi-rs/canvas, deliberately NOT by sharp — the PDF path stays 100% sharp-free so the D-07 boundary is unambiguous"
  - "pdfjs 6 dropped PDFDocumentProxy.destroy(); teardown goes through doc.loadingTask.destroy() inside a never-throwing finally, so a long batch does not leak one worker per bill"
  - "Bitmap coverage is measured as |det(CTM)| at each image-paint op divided by page area; repeat/group image ops are counted once, which under-estimates and can therefore never turn a textless scan into a native verdict"
  - "renderPdfPageImage takes a ZERO-based pageIndex (callers iterate pages) and converts to unpdf's one-based page number in exactly one place"
  - "Render scale is derived from the page's own geometry toward a 2000px long edge, clamped to [1, 4] so neither a tiny nor an enormous MediaBox can drive the raster out of bounds"

requirements-completed: [PARSE-01, PARSE-02]

# Metrics
duration: 18min
completed: 2026-07-27
---

# Phase 3 Plan 04: Routing and Image Preparation Summary

**The Docling-style layered native-vs-scan gate (D-20) plus both document-preparation routes: unpdf text extraction and pdfjs+@napi-rs/canvas page rasterization for PDFs, and heic-convert -> sharp EXIF-orient/downscale for photos — with the image-only-PDF branch proven end-to-end against a real hand-assembled fixture.**

## Performance

- **Duration:** 18 min
- **Started:** 2026-07-27T13:21Z
- **Completed:** 2026-07-27T13:39Z
- **Tasks:** 2
- **Files modified:** 10 (8 created, 2 planning docs updated)

## Accomplishments

- **The anti-pattern this plan exists to prevent is now structurally impossible.** `routeFile` branches on source type before it looks at content: a JPEG/PNG/HEIC goes to `prepImage`, and a PDF the gate calls `image-only` goes to `renderPdfPageImage`. sharp never sees PDF bytes. The spec proves both halves — a real image-only PDF renders to a real JPEG (`ffd8ff` magic, 30 KB), and feeding the same PDF's bytes to `prepImage` rejects. That second assertion is what makes the branch a proven requirement rather than a stylistic preference.
- **All four D-20 rungs and both threshold boundaries are covered, driven by injected synthetic signals.** Including the ones that are easy to get backwards: coverage `>=` 0.75 trips but 0.74 does not; invisible ratio `>` 0.90 means exactly 0.90 is NOT an overlay; 5000 characters with no embedded font is still `image-only` (char count is a soft signal, never the sole gate); 2-of-4 native pages is still native because the rule is `>= 50%`, not a strict majority.
- **The pdfjs legacy-build landmine from 03-01 never fired.** `definePDFJSModule(() => import('pdfjs-dist/legacy/build/pdf.mjs'))` is resolved once per process, memoized on the promise so a concurrent batch cannot race two resolutions, and both the signal loader and the renderer read through it. RESEARCH Pitfall 1 (renderPageAsImage needs a canvas provider in Node) is satisfied by `canvasImport`.
- **The fixtures are genuinely what they claim.** `image-only.pdf` measures coverage 1.0, 0 extractable non-whitespace characters and 0 fonts through the REAL pdfjs loader; `sideways-exif.jpg` really carries EXIF orientation 6 and really comes out 1000x2000 (portrait) rather than 2000x1000 (landscape), so the auto-orient assertion cannot pass vacuously. Both are byte-reproducible from a script inlined in `test/fixtures/README.md`.
- **Full unit suite green at 188 tests across 16 files; `npm run typecheck` clean.**

## Task Commits

Each task was committed atomically:

1. **Task 1 (RED): spec the layered gate + image prep, and build the fixtures** — `a399b92` (test)
2. **Task 2 (GREEN): route.ts + extract-pdf.ts + prep-image.ts** — `71e62c7` (feat)

**Plan metadata:** see the final `docs(03-04)` commit.

## Files Created/Modified

- `src/main/parse/route.ts` — `ParseRoute`, `PageSignals`, the four exported thresholds (`BITMAP_COVERAGE_THRESHOLD` 0.75, `INVISIBLE_GLYPH_RATIO` 0.9, `MIN_NATIVE_CHARS` 50, `NATIVE_PAGE_MAJORITY` 0.5), `routePage` (the four rungs in order), `routePdf` (the `>= 50%`-native-pages rule, empty document falls safe to `image-only`), and `routeFile` (source-type dispatch, with the real signal loader lazily imported so the pure gate never drags in pdfjs)
- `src/main/parse/extract-pdf.ts` — `extractPdfText`, `loadPdfSignals`, `renderPdfPageImage`, the render constants, the operator-list walker (graphics-state stack tracking CTM and text-rendering mode; `|det(CTM)|` area accumulation; `setTextRenderingMode` 3 counted against all glyph-show ops; distinct `setFont` resources), and the never-throwing `closeDocument` teardown
- `src/main/parse/prep-image.ts` — `prepImage` plus `LONG_EDGE` 2000, `JPEG_QUALITY` 80, `MAX_INPUT_PIXELS` 100_000_000, `HEIC_DECODE_QUALITY` 0.9, and the `SharpLike` / `HeicConvertLike` injection seams
- `test/parse-route.test.ts` — 21 tests: threshold constants, four rungs with boundaries, whole-document majority, `routeFile` dispatch (a photo never reaches the pdf loader), and four real-fixture cases
- `test/parse-prep-image.test.ts` — 11 tests: HEIC-before-sharp ordering AND data flow, never for jpg/png, `.heif` and case-insensitivity, pipeline shape, bomb guard, real EXIF fixture, no-enlargement, and the "sharp rejects PDF bytes" proof
- `test/fixtures/image-only.pdf`, `test/fixtures/sideways-exif.jpg`, `test/fixtures/README.md` — the two committed fixtures and their provenance
- `.planning/.../03-VALIDATION.md` — the three 03-04 rows and the Wave-0 checkboxes updated to reflect what actually shipped
- `.planning/.../deferred-items.md` — one residual threat gap logged (item 3)

## Decisions Made

- **`definePDFJSModule` instead of the plan's `configureUnPDF`.** In unpdf 1.6.2 `configureUnPDF` is explicitly deprecated (`@deprecated Use definePDFJSModule instead. Will be removed in v2`) and both are thin wrappers over the same `resolvePDFJSImport(resolver, { reload: true })`. Writing the deprecated alias would have shipped a known-removed call into a financial tool's parse path for zero benefit. The plan's intent — point unpdf at the official build and give it a canvas provider — is satisfied exactly; the module comment records the rename so the D-19 trail stays readable.
- **JPEG re-encode by @napi-rs/canvas, not sharp.** unpdf's renderer produces PNG. sharp would convert it in one line, but the invariant this plan is accountable for is that sharp and PDFs never meet, and a `sharp(...)` call sitting inside `extract-pdf.ts` would make that invariant unverifiable by inspection. `loadImage` + `createCanvas` + `toBuffer('image/jpeg', 80)` costs one extra decode on 5-20 documents a week and keeps the boundary greppable.
- **Bitmap coverage under-estimates rather than over-estimates.** Repeat/group image ops are counted once at the current CTM instead of once per placement. Under-estimating can only push a page toward the native rungs, where it still has to independently clear 50 characters AND an embedded font — so the error can never fabricate a "native" verdict for a textless scan. Over-estimating could have done the reverse.
- **`MAX_INPUT_PIXELS = 100_000_000`.** Roughly 300 MB of raw RGB: far above any real phone camera or flatbed scanner, far below sharp's own 268 MP default, and low enough that a hostile file cannot exhaust the main process before `resize` runs.
- **A malformed signal counts as zero, not as a passing value.** `routePage` coerces every non-finite input to 0, so a broken loader degrades toward `image-only` (forfeit the text anchor) rather than toward `native` (pair junk text with the image — the exact D-08 failure).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] `unpdf.configureUnPDF` is deprecated; used `definePDFJSModule`**
- **Found during:** Task 2
- **Issue:** The plan names `configureUnPDF` (from RESEARCH Pitfall 1, written against an earlier unpdf). unpdf 1.6.2 marks it `@deprecated ... Will be removed in v2`.
- **Fix:** Called `definePDFJSModule(() => import('pdfjs-dist/legacy/build/pdf.mjs'))`, the current name for the identical operation, and documented the rename in the module header.
- **Files modified:** src/main/parse/extract-pdf.ts
- **Verification:** the D-19 real-fixture render test passes; the plan's acceptance grep (`configureUnPDF\|canvas`) and the `must_haves` key_link pattern (`canvas|configureUnPDF|renderPageAsImage`) both still match.
- **Committed in:** `71e62c7`

**2. [Rule 1 - Bug] `PDFDocumentProxy.destroy()` does not exist in pdfjs 6**
- **Found during:** Task 2 (first GREEN run — two real-fixture tests failed with `TypeError: doc.destroy is not a function`)
- **Issue:** pdfjs 6 moved teardown to the loading task. Without it, every parsed bill would leak a document/worker for the life of the main process.
- **Fix:** `closeDocument(doc)` calls `doc.loadingTask.destroy()` and swallows its own errors, because it runs in a `finally` where a teardown throw would mask both the parsed result and any genuine parse failure the pipeline must flag (D-15).
- **Files modified:** src/main/parse/extract-pdf.ts
- **Verification:** both real-fixture tests pass; full suite 188 green.
- **Committed in:** `71e62c7`

**3. [Rule 2 - Missing Critical] Added a render-scale clamp and an explicit out-of-range page guard**
- **Found during:** Task 2
- **Issue:** The plan specified `renderPageAsImage` but no scale policy. At unpdf's default `scale: 1` a Letter page renders 612x792 (72 DPI) — too coarse for a vision model to read small print, which is the entire purpose of the image-only route. Left unbounded in the other direction, a hostile MediaBox could drive an enormous raster (T-03-02).
- **Fix:** scale derived from the page's own long edge toward `RENDER_LONG_EDGE` 2000, clamped to `[RENDER_MIN_SCALE 1, RENDER_MAX_SCALE 4]`; an out-of-range `pageIndex` throws a named error instead of returning an empty buffer.
- **Files modified:** src/main/parse/extract-pdf.ts, test/parse-route.test.ts (out-of-range case)
- **Verification:** the fixture renders 1224x1584 at scale 2; `renderPdfPageImage(bytes, 5)` rejects.
- **Committed in:** `71e62c7` (guard) / `a399b92` (spec)

**4. [Rule 2 - Missing Critical] Fixture set narrowed, and the reason recorded**
- **Found during:** Task 1
- **Issue:** 03-VALIDATION.md's Wave-0 list named five fixtures (text PDF, invisible-OCR-overlay PDF, image-only PDF, sideways JPEG, HEIC). The plan itself names two. Committing an "invisible-overlay PDF" that did not actually exhibit a >0.90 invisible-glyph ratio would be worse than not having one — it would look like coverage while proving nothing, and it would freeze the thresholds against a hand-authored artifact rather than real bills.
- **Fix:** built the two fixtures the plan names, drove every rung from injected synthetic signals instead, and updated the VALIDATION.md Wave-0 row to state the substitution and why.
- **Files modified:** test/fixtures/*, .planning/.../03-VALIDATION.md
- **Verification:** all four rungs plus both boundaries are covered; the real fixture still carries the end-to-end route + render proof.
- **Committed in:** `a399b92` (fixtures) / final docs commit (VALIDATION.md)

---

**Total deviations:** 4 auto-fixed (1 blocking, 1 bug, 2 missing-critical)
**Impact on plan:** No scope change. Two were forced by library reality (a deprecated alias, a removed method), two closed gaps in behavior the plan already required (a readable render, honest fixtures). No new module, no contract change.

## Issues Encountered

**`src/shared/*` was not touched, as instructed.** `ipc-contract.ts`, `schemas.ts` and `preload/index.ts` are byte-identical to their 03-01 state. Nothing in this plan needed a contract change: `RouteDecision` is a main-internal type, and the only contract field this plan feeds (`ParseFileResult.route` provenance, `truncated`) already exists.

**One design tension worth recording for 03-07.** `routeFile` returns `pages: PageSignals[]`, which is empty for photos. That is correct (a photo has no pages to measure) but it means `pageCount` is the authoritative count and `pages.length` is not — the pipeline should read `pageCount` when it applies the D-21 10-page cap, not `pages.length`.

## Threat Flags

| Flag | File | Description |
|------|------|-------------|
| threat_flag: DoS residual (T-03-03) | src/main/parse/prep-image.ts | The bomb guard is `sharp(input, { limitInputPixels })`, exactly as the plan's threat register specifies — but a `.heic`/`.heif` file must pass through `heic-convert` FIRST (sharp's libvips cannot decode HEIC), and heic-convert exposes no pixel or memory cap. A hostile HEIC declaring an enormous canvas is fully decoded before sharp's guard applies. JPEG/PNG/PDF inputs are unaffected. Logged as deferred item 3 for 03-07, where flag-and-keep (D-15) lives; fixing it here would have meant unilaterally changing a signature 03-07 is about to consume. |

No new trust boundary, network path, auth path, or schema surface was introduced. T-03-02 (malicious PDF) is mitigated as planned: untrusted bytes are parsed only by maintained libraries in main, rendering is bounded per page by the scale clamp, and every document is torn down in a `finally`.

## Requirements Status

| Req | Text | Status |
|-----|------|--------|
| PARSE-01 | Extract embedded text from text PDFs before calling the model | **Complete.** `extractPdfText` returns per-page text; `routePdf` decides when that text is authoritative enough to pair (D-06/D-20). The pairing itself is 03-05's prompt assembly. |
| PARSE-02 | Prepare photos/scans (orient, resize, HEIC decode) before the model | **Complete.** `prepImage` for raw photos; `renderPdfPageImage` for image-only PDFs. |

Both are marked complete in REQUIREMENTS.md: the preparation capability is fully delivered and unit-proven here. What remains for 03-07 is calling these functions from the pipeline, not building them.

## Known Stubs

None. Every exported function in this plan does its real work against real bytes; there are no placeholder returns, no hardcoded empties that reach a UI, and no TODO markers. The three modules have no main-process caller yet — `src/main/ipc/parse.ts` and `parse/pipeline.ts` are owned by 03-07 — which is the interface-first wave ordering working as designed, not a stub.

## User Setup Required

None. Every test in this plan runs offline with no key and no network.

## Next Phase Readiness

**03-05 (vision extraction)** is unaffected by this plan and can proceed independently — it consumes `BillSchema` and the fake client, not these modules.

**03-07 (pipeline integration)** now has everything it needs to wire the per-file body:

```ts
const decision = await routeFile({ filename, bytes })          // 'native' | 'image-only'
if (decision.route === 'native') {
  const { text } = await extractPdfText(bytes)                 // pair text + images (D-06)
}
const image = isPdf
  ? await renderPdfPageImage(bytes, pageIndex)                 // image-only PDF (D-19)
  : await prepImage(bytes, extname(filename))                  // raw photo (D-07)
```

Four things 03-07 should carry forward:
1. **Use `decision.pageCount`, not `decision.pages.length`,** for the D-21 10-page cap (photos return an empty `pages` array).
2. **`renderPdfPageImage` is zero-based** and renders ONE page per call; the D-21 multi-image call loops it.
3. **Wrap these calls in the per-file try/catch** (Shared Pattern C). `renderPdfPageImage` throws on an out-of-range index and both PDF functions can throw on a corrupt file — that must become a `parse-failed` row, never a batch abort (D-15, T-03-02).
4. **Deferred item 3** (the HEIC decode is outside the pixel guard) is assigned to 03-07.

**Concerns:** none open. The A2 threshold-tuning note stands as originally planned — 0.75 / 0.90 / 50 / 50% are research starting values, exposed as named constants precisely so the end-of-phase manual gate against real vendor bills can retune them.

## Self-Check: PASSED

- All 8 created files exist on disk; both planning docs updated.
- Both task commits exist in git (`a399b92`, `71e62c7`).
- `must_haves` artifacts verified: `route.ts` exports `routePdf` + `routeFile`; `extract-pdf.ts` exports `extractPdfText` + `renderPdfPageImage`; `prep-image.ts` exports `prepImage`.
- `must_haves` key_link verified: `extract-pdf.ts` matches `canvas|configureUnPDF|renderPageAsImage` (14 lines, including `canvasImport: CANVAS_IMPORT` on the `renderPageAsImage` call).
- All four `must_haves` truths asserted by passing tests.
- `npx vitest run test/parse-route.test.ts test/parse-prep-image.test.ts` — 32 passed.
- `npx vitest run` — 16 files, 188 tests passed.
- `npm run typecheck` — clean.
- `git diff` confirms zero changes to `src/shared/ipc-contract.ts`, `src/shared/schemas.ts`, `src/preload/index.ts`.

---
*Phase: 03-ai-client-and-parse-pipeline*
*Completed: 2026-07-27*
