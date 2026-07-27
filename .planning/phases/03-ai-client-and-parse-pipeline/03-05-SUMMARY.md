---
phase: 03-ai-client-and-parse-pipeline
plan: 05
subsystem: parse
tags: [vision, prompt, structured-outputs, fallback-ladder, zod, repair-retry, d21-page-cap]

# Dependency graph
requires:
  - phase: 03-01
    provides: "the authoritative BillSchema in src/shared/schemas.ts (vendor+total required, every other field nullable) and the shared fake OpenAIClientLike double at test/helpers/fake-openai-client.ts"
  - phase: 03-02
    provides: "buildClient() — the D-25-configured OpenAI-compatible client (maxRetries 3, timeout 120000) that extractFields lazily loads when no client is injected"
provides:
  - "BILL_SYSTEM_PROMPT — the D-23 system message verbatim, as one diffable constant"
  - "buildUserContent — the D-23 content array with text-before-image enforced structurally"
  - "SCHEMA_IN_PROMPT_INSTRUCTION / PLAIN_JSON_INSTRUCTION — the rung-2 and rung-3 prompt text, with the shape derived from BillSchema via z.toJSONSchema"
  - "extractFields — the D-25 fallback ladder (strict json_schema -> json_object -> plain) with local BillSchema re-validation on every rung, one repair retry, then a failure marker"
  - "selectPageImages — the D-21 10-page cap (pages 1-3 + last 2, truncated flag)"
affects: [03-07-pipeline-integration]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Images are appended LAST and in exactly one place, so text-before-image is a structural property of buildUserContent rather than a convention every call site must remember"
    - "The ladder descends only on parameter rejections; a 401, a rate limit, a 5xx or a dead connection returns immediately instead of paying three calls per file"
    - "Failure is data (a structured marker), never an exception, so one unreadable bill cannot abort a batch"

key-files:
  created:
    - src/main/parse/prompt.ts
    - src/main/parse/extract-fields.ts
    - test/parse-extract.test.ts
  modified:
    - .planning/phases/03-ai-client-and-parse-pipeline/03-VALIDATION.md

key-decisions:
  - "The rung-2/3 schema text is generated from BillSchema with z.toJSONSchema instead of being hand-written, so the shape described in the prompt and the shape that validates the reply cannot drift apart"
  - "An OMITTED optional key normalizes to an explicit null before BillSchema runs — that omission IS the prompt's 'return null if absent' contract, and vendor/total stay required because a filled null still fails z.string()"
  - "canFallBack() gates the ladder on error class: 400/404/422 and method-missing TypeErrors descend; 401/403/408/409/429, 5xx and connection errors do not"
  - "The D-21 page cap is applied INSIDE extractFields, not left to the caller, so no future call site can put an unbounded page count on the wire"
  - "The failure detail is bounded at 400 chars and carries only Zod field paths and type expectations — no document values, no raw reply, and this module logs nothing at all"

requirements-completed: [PARSE-03]

# Metrics
duration: 14min
completed: 2026-07-27
---

# Phase 3 Plan 05: Vision Field Extraction Summary

**The D-23 prompt as one diffable constant plus the D-25 structured-output fallback ladder — strict `json_schema` degrading to `json_object`+schema-in-prompt to plain-prompt JSON, with the local `BillSchema` re-validating on every rung and exactly one repair retry before a flag-and-keep failure marker.**

## Performance

- **Duration:** 14 min
- **Started:** 2026-07-27T13:50Z
- **Completed:** 2026-07-27T14:04Z
- **Tasks:** 2
- **Files modified:** 4 (3 created, 1 planning doc updated)

## Accomplishments

- **Text-before-image is structural, not conventional.** `buildUserContent` appends image parts in one loop that runs last, so the ladder's schema instruction and the repair re-ask physically cannot land after the images. The spec asserts the ordering on the wire for every rung including the repair call, not just on the builder's return value. This matters because a vision model weights the last-seen modality heavily — text-after-image is exactly how a junk OCR transcription overrides a correctly-read total on a belt-and-suspenders (D-06) native PDF.
- **All three rungs are proven against the injected fake, plus the two cases where the ladder must NOT descend.** A fake that rejects `json_schema` proves rung 2; one that rejects both `response_format` types proves rung 3 (and that rung 3 carries no `response_format` at all). A 401 and an `APIConnectionError` each produce exactly ONE call — walking the ladder there would mean 36 rejected calls for a 12-bill batch against a bad key.
- **The local schema is the gate on every rung, including the strict one.** The spec includes a case where the "strict" rung returns a numeric total anyway; local validation catches it and the repair retry fixes it. That is RESEARCH Pattern 3 made non-optional: providers vary in how much of a `json_schema` they enforce, and the reply is untrusted content derived from an attacker-influenceable document (T-03-04).
- **The repair retry is exactly one, and its failure is data.** Invalid-then-valid is 2 calls with `failed validation` / `corrected JSON only` present on only the second. Invalid-twice is 2 calls and a `{ ok: false, reason: 'schema-invalid' }` marker — no third attempt, no throw. The module also survives a non-`Error` rejection, an empty `choices` array, and a 5000-character provider dump (the returned detail is bounded at 512).
- **40 tests green; full unit suite 228 across 17 files; `npm run typecheck` clean.** `src/shared/ipc-contract.ts`, `src/shared/schemas.ts` and `src/preload/index.ts` are byte-identical to their 03-01 state.

## Task Commits

Each task was committed atomically:

1. **Task 1 (RED): spec the D-23 content order and the D-25 fallback ladder** — `0c6f837` (test)
2. **Task 2 (GREEN): prompt.ts + extract-fields.ts** — `bae1ed5` (feat)

**Plan metadata:** see the final `docs(03-05)` commit.

## Files Created/Modified

- `src/main/parse/prompt.ts` — `BILL_SYSTEM_PROMPT` (D-23 verbatim), `REFERENCE_TRANSCRIPTION_HEADER`, `NO_TRANSCRIPTION_MARKER`, `EXTRACT_INSTRUCTION`, `IMAGE_DETAIL`, `BILL_JSON_SCHEMA` (from `z.toJSONSchema(BillSchema)`), `SCHEMA_IN_PROMPT_INSTRUCTION`, `PLAIN_JSON_INSTRUCTION`, `buildRepairInstruction`, and `buildUserContent`. Zero SDK import — its only dependency is the shared `BillSchema`.
- `src/main/parse/extract-fields.ts` — `extractFields` (the ladder + local re-validation + one repair retry), `selectPageImages` (D-21 cap), the `VisionClientLike` structural client slice, `LADDER` / `MAX_PAGE_IMAGES` / `HEAD_PAGE_IMAGES` / `TAIL_PAGE_IMAGES`, and the `ExtractFieldsResult` discriminated union.
- `test/parse-extract.test.ts` — 40 tests across six groups: the D-23 prompt guardrails, content ordering (builder and wire), required-field minimization (`BillSchema` directly and end to end), the three-rung ladder plus the two no-descend cases, the single repair retry and its failure marker, and the D-21 cap.
- `.planning/.../03-VALIDATION.md` — the two PARSE-03 rows flipped to green and the Wave-0 checkbox ticked.

## Decisions Made

- **The prompt's schema text is generated, not written.** Rungs 2 and 3 have to describe the bill shape in prose, and a hand-written copy would silently drift from `BillSchema` the first time a field changed — the model would then be told to return one shape while the gate demanded another. `z.toJSONSchema(BillSchema)` keeps one source of truth, matching what `zodResponseFormat` does for rung 1.
- **An omitted optional key is treated as an explicit null.** On the non-strict rungs a model routinely drops null-valued keys entirely, and `BillSchema` uses `.nullable()` (value-optional), not `.optional()` (key-optional), so the key must be present. Since the schema is FINAL and out of scope for this plan, the normalization happens on the candidate: only `undefined` is filled, only for the nine known keys, and a wrong TYPE is never coerced. This cannot weaken required-field minimization — `vendor` and `total` are non-nullable, so filling them with null still fails, which the spec asserts directly. Without it, every tax-included receipt on a plain-prompt endpoint would cost a paid repair call and then be lost.
- **The ladder descends on error class, not on every error.** `canFallBack()` returns true for 400/404/422 and for a `TypeError` from a client with no `parse` method (the actual "this endpoint does not support this parameter" cases), and false for 401/403/408/409/429, any 5xx, and connection/timeout errors. The SDK has already spent its own `maxRetries: 3` (D-25) on the transient cases before an error reaches here, so descending again would triple the damage per file.
- **The D-21 cap lives inside `extractFields`, not in the caller.** 03-07 could apply it and probably will still reason about `pageCount`, but putting the bound at the point where the request is built means no future call site can put an unbounded page count (and an unbounded token bill) on the wire. `truncated` is returned on both the success and failure branches so the pipeline can persist it either way.
- **Nothing is logged, and the failure detail is value-free.** The threat register requires that `extract-fields` never log the key or dump the raw reply at error level; the module goes further and logs nothing. The Zod detail carries field paths and type expectations only, bounded at 400 characters. The raw reply is *returned* as data because D-24's `raw_response` audit column needs it, which is storage, not logging.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing Critical] Omitted optional keys normalize to explicit null before validation**
- **Found during:** Task 2
- **Issue:** `BillSchema`'s optional fields are `.nullable()`, so the KEY is required even though the VALUE may be null. On rungs 2 and 3 there is no schema enforcement on the wire and models routinely omit null-valued keys, which would fail local validation, burn the single repair retry, and then discard a perfectly good bill — on the single most common receipt shape (no separate tax line).
- **Fix:** `normalizeCandidate()` fills only `undefined` values, only for the nine known `BillSchema` keys, immediately before `BillSchema.safeParse`. Wrong types are never coerced. The schema file itself was NOT touched (it is contract-final and out of scope).
- **Files modified:** src/main/parse/extract-fields.ts
- **Verification:** two spec cases — an omitted `currency`/`due_date` parses with one call and no repair; a payload missing `total` still fails and reaches the failure marker.
- **Committed in:** `bae1ed5`

**2. [Rule 2 - Missing Critical] The ladder does not descend on non-parameter errors**
- **Found during:** Task 2
- **Issue:** The plan says "on an unsupported-parameter error fall to rung 2 ... on failure fall to rung 3". Read literally, ANY failure descends — so a rejected API key produces three calls per file, a 12-bill batch produces 36 rejected calls, and a rate limit is answered by two more requests.
- **Fix:** `canFallBack()` classifies the error before descending (see Decisions). The plan's intent — degrade when the endpoint cannot honor the parameter — is preserved exactly.
- **Files modified:** src/main/parse/extract-fields.ts, test/parse-extract.test.ts
- **Verification:** the 401 case and the `APIConnectionError` case each make exactly one call; the all-rungs-unsupported case still makes three.
- **Committed in:** `0c6f837` (spec) / `bae1ed5` (guard)

**3. [Rule 2 - Missing Critical] The D-21 page cap is enforced inside extractFields**
- **Found during:** Task 2
- **Issue:** The plan's file scope did not name the cap, but D-21 is listed as a locked decision this plan implements and this module is the only place a multi-image request is assembled. Left to the caller, a 60-page PDF becomes a 60-image request.
- **Fix:** `selectPageImages()` (pages 1-3 + last 2 over a cap of 10) is applied at the top of `extractFields`, exported for 03-07, and `truncated` is reported on both result branches.
- **Files modified:** src/main/parse/extract-fields.ts, test/parse-extract.test.ts
- **Verification:** 14 pages select `[1,2,3,13,14]` with `truncated: true`; 10 pages pass through untruncated; a 12-page call puts 5 image parts on the wire.
- **Committed in:** `0c6f837` (spec) / `bae1ed5` (implementation)

**4. [Rule 2 - Missing Critical] Tolerant JSON extraction on the unstructured rung**
- **Found during:** Task 2
- **Issue:** Rung 3 has no syntactic guarantee at all, and the two things models add unprompted are a markdown code fence and a sentence of preamble. A strict `JSON.parse` would burn the repair retry on formatting rather than on content.
- **Fix:** `parseJsonLoose` strips a ```` ```json ```` fence, then falls back to the first `{` .. last `}` slice. Tolerance costs nothing in safety because `BillSchema` still decides whether the extracted object is acceptable.
- **Files modified:** src/main/parse/extract-fields.ts
- **Verification:** a fenced reply parses in one call; a prose-only reply ("I am sorry, I cannot read this receipt") is still treated as invalid and repaired once.
- **Committed in:** `bae1ed5`

---

**Total deviations:** 4 auto-fixed (all Rule 2 — missing critical functionality)
**Impact on plan:** No scope change and no contract change. Three close correctness gaps the plan's own decisions already implied (D-21's cap, D-25's "unsupported-parameter" wording, the nullable-vs-optional gap between the prompt's contract and the schema's), and one is ordinary robustness on the rung that has no guarantees. No new module, no new dependency.

## Issues Encountered

**`zodResponseFormat` works against zod 4.4.3 under openai 6.48.0.** This was worth verifying before building on it — the openai SDK's zod helper was a zod-3-only surface for a long time. 6.48.0 declares `zod: ^3.25 || ^4.0` and `zodResponseFormat(BillSchema, 'bill')` emits the expected `{ type:'json_schema', json_schema:{ name:'bill', strict:true, schema } }`, which the spec pins.

**`nullable()` is not `optional()`, and the prompt says "return null if absent".** These two statements are in tension the moment a rung has no wire-level schema enforcement: the prompt invites a model to express absence, and JSON's natural way to express absence is omission. Deviation 1 resolves it on the candidate rather than in the schema. If 03-07 or a later phase ever revisits `BillSchema`, `.nullish()` on the seven optional fields would let that normalization be deleted — noted, not done, because the contract is final for this phase.

**The `truncated` flag now has two producers.** `extractFields` returns it, and 03-04's `routeFile` returns a `pageCount` from which 03-07 will also derive it. They agree by construction (both use the same cap), but 03-07 should treat `ExtractSuccess.truncated` as authoritative for what actually went on the wire, since that is the value measured at the request rather than predicted from the document.

## Threat Flags

None. No new network endpoint, auth path, file access pattern, or schema surface. The two threats the plan assigned to this file are mitigated as specified:

| Threat | Disposition | How |
|--------|-------------|-----|
| T-03-04 (prompt injection via bill content) | mitigated | The reply is only a candidate. `BillSchema.safeParse` runs on every rung including the strict one, the model is never asked to compute money (raw printed strings only, D-23), and the deterministic gate in 03-03's `validate.ts` is the final authority downstream. |
| T-03-01 (information disclosure on error paths) | mitigated | The key lives inside the injected client and is never read here. The module logs nothing. The failure `detail` is bounded at 400 characters and carries only Zod field paths and type expectations. |

## Requirements Status

| Req | Text | Status |
|-----|------|--------|
| PARSE-03 | Extract structured fields via the configured vision model | **Complete.** The prompt, the content assembly, the three-rung ladder, the authoritative local re-validation and the bounded repair retry all ship and are unit-proven against the injected fake. What remains for 03-07 is calling `extractFields` from the pipeline with real page images and a real client — wiring, not building. The live end-to-end call against a real endpoint stays on the manual gate (a user-supplied key is required and cannot run in CI). |

## Known Stubs

None. Every exported function does its real work. `extractFields` has no main-process caller yet — `src/main/parse/pipeline.ts` and `src/main/ipc/parse.ts` are owned by 03-07 — which is the interface-first wave ordering working as designed, not a stub.

## User Setup Required

None. Every test in this plan runs offline with no key and no network.

## Next Phase Readiness

**03-07 (pipeline integration)** can wire this directly:

```ts
const result = await extractFields({
  model: selectedModelId,                       // app_settings, via 03-02's getSelectedModel
  referenceText: route === 'native' ? pdfText : null,   // D-06 belt-and-suspenders
  imageDataUrls: pageJpegs.map(toDataUrl),      // prepImage / renderPdfPageImage output
  client                                        // omit in production; buildClient() loads lazily
})
if (!result.ok) { /* parse-failed row, D-15 — result.reason is 'call-failed' | 'schema-invalid' | 'client-unavailable' */ }
const { fields, validationFlags } = validateBill(result.bill)  // 03-03 owns cents/dates/arithmetic
```

Four things to carry forward:

1. **`extractFields` never throws.** It still belongs inside the per-file try/catch (Shared Pattern C) because the *preparation* steps around it do throw, but its own failures arrive as `{ ok: false, reason, detail }`.
2. **`result.truncated` is authoritative** for what actually went on the wire; persist that, not a value re-derived from `pageCount`.
3. **`result.rawResponse` is the D-24 `raw_response` audit value.** It is returned deliberately and must be stored, not logged.
4. **D-22's second-pass agreement check is the pipeline's job.** Call `extractFields` twice for image-only docs (both are already temperature 0) and feed the two bills to 03-03's `agreementFlags`. This module is deliberately single-pass.

**Concerns:** none open. `startRung` exists so a future capability probe (OpenRouter's `supported_parameters`) can skip rungs the endpoint is known not to support; until that exists, every call starts at `json_schema`, which costs at most two extra rejected calls on the first bill of a batch against a limited gateway.

## Self-Check: PASSED

- All 3 created files exist on disk; `03-VALIDATION.md` updated.
- Both task commits exist in git (`0c6f837`, `bae1ed5`).
- `must_haves` artifacts verified: `prompt.ts` exports `BILL_SYSTEM_PROMPT` + `buildUserContent`; `extract-fields.ts` exports `extractFields`.
- `must_haves` key_link verified: `extract-fields.ts` line 421 matches `BillSchema\.(parse|safeParse)`.
- All four `must_haves` truths asserted by passing tests.
- Acceptance greps: `temperature: 0` present (line 380); `BillSchema` appears 12 times; `prompt.ts` contains both "return null" and "ground truth".
- `npx vitest run test/parse-extract.test.ts` — 40 passed.
- `npx vitest run` — 17 files, 228 tests passed.
- `npm run typecheck` — clean.
- `git diff HEAD -- src/shared/ipc-contract.ts src/shared/schemas.ts src/preload/index.ts` — empty.

---
*Phase: 03-ai-client-and-parse-pipeline*
*Completed: 2026-07-27*
