---
phase: 03-ai-client-and-parse-pipeline
plan: 03
subsystem: parsing
tags: [validation, zod-gate, integer-cents, date-normalization, confidence, grounding, prompt-injection, pure-functions]

# Dependency graph
requires:
  - phase: 03-ai-client-and-parse-pipeline
    provides: "03-01's frozen contract — BillSchema (the raw-string model-output shape validateBill consumes), ParsedFields (integer cents + ISO dates) and FieldConfidence"
provides:
  - "src/main/parse/validate.ts — toCents (integer cents by digit-string math), normalizeDate (ISO or flagged, never thrown), arithmeticOk (not-applicable on a null operand, 2-cent tolerance), validateBill (the whole gate)"
  - "src/main/parse/confidence.ts — computeConfidence over a documented precedence ladder where deterministic evidence outranks the model's self-report, and agreementFlags for the D-22 image-only second pass"
  - "The validation-flag vocabulary ('<check>:<parsedFieldKey>' plus the single spanning ARITHMETIC_FLAG) that the cache stores and Phase 6 renders"
affects: [03-05-vision-extraction, 03-06-cache-persistence, 03-07-pipeline-integration, 06-review-table]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Money is coerced by concatenating digit strings and reading the result once; `dollars * 100` and parseFloat appear nowhere in the pipeline"
    - "Flag vocabulary is '<check>:<ParsedFields key>', so the confidence scorer maps a flag onto its field mechanically instead of through a hand-maintained lookup"
    - "Grounding is boundary-checked, not plain substring containment — a smaller printed amount cannot certify itself inside a larger one"

key-files:
  created:
    - src/main/parse/validate.ts
    - src/main/parse/confidence.ts
    - test/parse-validate.test.ts
    - test/parse-confidence.test.ts
  modified: []

key-decisions:
  - "toCents returns null (never 0) for unreadable input — a total reading 'N/A' must surface as a flagged empty amount, never as a confident $0.00 bill; the RESEARCH reference implementation returned 0 here"
  - "The RESEARCH toCents also mis-signed negatives ('-5.50' -> -450); sign is now detected before digit extraction and applied at the end, so credits and accounting parentheses are exact"
  - "Separator disambiguation: both separators present -> the rightmost is the decimal point (reads '1,234.10' and the European '1.234,56'); a lone comma with exactly three trailing digits is grouping; any other lone separator is the decimal point"
  - "arithmeticOk widened to accept a null total as well, so an unreadable total emits its own money flag and NOT a second, misleading arithmetic flag"
  - "A second-pass disagreement (D-22) maps to 'low', while a failed deterministic check maps to 'flagged' — a cross-call mismatch means uncertain, not provably wrong"
  - "The suggested category is never grounded against the source text: it is a QuickBooks-classification guess, not a transcription, so a coincidental substring must not certify it (this is the field the advisory self-report exists for)"
  - "Fields with a legitimately absent nullable value are omitted from the confidence record rather than graded 'low', so Phase 6 does not badge an empty cell"

patterns-established:
  - "Pure, dependency-free parse modules in the src/main/ingestion/hash.ts convention: no Electron, no network, no state, directly unit-testable"
  - "Un-throwable validation: a missing payload degrades to a fully flagged empty result rather than a crash (the 03-02 `parse(raw ?? {})` guard class, applied to property access)"

requirements-completed: []  # PARSE-04 needs 03-07's pipeline to actually call these modules — see Requirements Status

# Metrics
duration: 9min
completed: 2026-07-27
---

# Phase 3 Plan 03: Validation Gate and Confidence Scorer Summary

**The deterministic authority over model output: money re-derived as integer cents by digit-string math, dates normalized to ISO or flagged (never thrown, never guessed), subtotal + tax = total cross-checked only where applicable within a two-cent tolerance, and a confidence scorer whose precedence ladder puts a failed check above anything the model claims about itself.**

## Performance

- **Duration:** 9 min
- **Started:** 2026-07-27T13:08:42Z
- **Completed:** 2026-07-27T13:17:30Z
- **Tasks:** 2
- **Files modified:** 4 (4 created, 0 modified)

## Accomplishments

- **A hallucinated total cannot pass by sounding confident.** `computeConfidence` resolves a field through a documented five-rung ladder, and rung 1 is the failed deterministic check. The spec drives the exact adversarial case: an arithmetic failure with `modelSelfReport: { totalCents: 'high', subtotalCents: 'high', taxCents: 'high' }` still returns `'flagged'` for all three money fields. The self-report is consulted only at rung 4, for a field with no source anchor at all.
- **Grounding is boundary-checked, which turns out to matter more than the grounding itself.** A tax of `$8.00` occurs as a substring inside a total of `$108.00`. Plain containment would have certified a tax line that never appeared on the document as `'high'` — hiding the most common number-OCR error the scorer exists to catch. `containsToken` requires the character before the match not to be `[0-9.,]` and the character after not to be a digit, and there is a spec for exactly that case.
- **Money never touches a float.** Cents are produced by concatenating the whole-digit string with a two-character fraction string and reading the result once. The gate greps clean for `parseFloat` and `* 100`, and the spec pins the two classic traps directly: `19.99 * 100 === 1998.9999999999998` and `0.07 * 100 === 7.000000000000001` both come back as exact integers.
- **The not-applicable path is honored in both directions.** `subtotal: null, tax: null, total: '108.00'` produces an entirely empty flag list, because a tax-included receipt is normal and not an error (D-10). The tolerance boundary is pinned on both sides: two cents off does not flag, three cents does.
- **Every flag is a string and every flag names its field.** The vocabulary is `'<check>:<ParsedFields key>'` (`date:invoiceDate`, `money:totalCents`, `missing:vendor`, `agreement:totalCents`) plus the one spanning `ARITHMETIC_FLAG`, so `confidence.ts` maps a flag onto its field mechanically. That also satisfies RESEARCH Pitfall 8 ahead of 03-06: nothing bound into the STRICT `parsed_results` table is a boolean.

## Task Commits

Each task was committed atomically:

1. **Task 1 (RED): spec cents/dates/arithmetic and deterministic-weighted confidence** — `4bccfb6` (test)
2. **Task 2 (GREEN): validate.ts (Zod gate) + confidence.ts (deterministic-weighted)** — `a6794cf` (feat)

**Plan metadata:** see the final `docs(03-03)` commit.

## Files Created/Modified

- `src/main/parse/validate.ts` — `ROUNDING_TOLERANCE`, `ARITHMETIC_FLAG`, `MONTH_NAMES`, `toCents`, `normalizeDate`, `arithmeticOk`, `validateBill`, plus the `ValidatedBill` result type. Pure, zero-dependency, no Electron.
- `src/main/parse/confidence.ts` — `AGREEMENT_PREFIX`, the `ModelSelfReport` type, `computeConfidence`, `agreementFlags`. Imports `ARITHMETIC_FLAG` and `MONTH_NAMES` from `validate.ts` (the plan's declared key link).
- `test/parse-validate.test.ts` — 30 assertions across `toCents`, `normalizeDate` and both halves of `validateBill`.
- `test/parse-confidence.test.ts` — 25 assertions across grounding, the precedence ladder and D-22 agreement.

## Decisions Made

- **`toCents` returns `null`, never `0`, for unreadable input.** The RESEARCH reference implementation returns `0` for garbage (`Number('') * 100 + 0` is finite), which would turn a total reading "N/A" into a confident $0.00 bill posted to QuickBooks. Null forces the caller to flag it. This is the difference between a visible failure and a silent wrong number, so it was worth departing from the cited code.
- **Sign is detected before digit extraction.** The RESEARCH implementation splits the cleaned string on the decimal point and computes `Number(whole) * 100 + Number(fraction)`, which for `'-5.50'` yields `-500 + 50 = -450`. Sign is now a separate boolean captured up front (covering both a leading minus and accounting parentheses) and applied once at the end.
- **Separator disambiguation is explicit and US-first.** Both separators present means the rightmost is the decimal point, which reads `'1,234.10'` and the European `'1.234,56'` correctly. A repeated lone separator is grouping. A lone comma with exactly three trailing digits is grouping (`'1,234'` -> $1,234.00). Everything else is a decimal point, which means the one genuinely ambiguous case — a lone dot with three trailing digits — reads US-first: `'1.234'` is $1.23. Documented on the function and pinned by a spec, because a wrong guess here is a 1000x error.
- **`arithmeticOk` accepts a null total too.** The plan typed the third parameter `number`. Widening it to `number | null` means an unreadable total emits `money:totalCents` and stops there, instead of also emitting an arithmetic flag comparing against a fallback of 0. One failure, one flag.
- **Flags use camelCase `ParsedFields` keys, not the model's snake_case.** The plan's example was `'date:invoice_date'`; the shipped vocabulary is `'date:invoiceDate'` so `confidence.ts` can split on the colon and look the field up directly. A snake_case flag would have required a hand-maintained translation table between the two modules — a place for them to silently drift apart.
- **A D-22 disagreement is `'low'`, a failed check is `'flagged'`.** Two temperature-0 passes disagreeing means the read is unstable (uncertain); a failed arithmetic or date check means the value is provably inconsistent. Collapsing them would lose the distinction Phase 6 needs to prioritize review.
- **`agreementFlags` compares validated values, not raw strings.** Both passes go through `validateBill` first, so `'$108.00'` versus `'108.00'` can never masquerade as a disagreement — only a genuinely different amount can.
- **Null fields are omitted from the confidence record.** A legitimately absent due date has nothing to grade; grading it `'low'` would badge an empty cell in Phase 6. A *flagged* field is always present even when its value is null, because there the flag is the thing to show.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] The RESEARCH `toCents` returns 0 for unreadable input instead of null**
- **Found during:** Task 2 (the plan instructed "copy RESEARCH lines 552-559 directly")
- **Issue:** `Number('') * 100 + Number('00')` is `0`, and `Number.isFinite(0)` is true, so the cited implementation returns `0` for `''`, `'N/A'`, `'see attached'` and `'$'`. The plan's own Task 1 spec requires `garbage -> null (flagged, not thrown)`. Shipping the cited code would have recorded a bill whose total the model could not read as a confident $0.00 — a silent wrong number in a financial tool, and precisely the failure mode D-12's flag-and-keep exists to prevent.
- **Fix:** Rewrote the digit path to require at least one digit after stripping, and to return `null` when none is present or when the result is not a safe integer.
- **Files modified:** src/main/parse/validate.ts
- **Verification:** `toCents` spec covers `''`, `'   '`, `'N/A'`, `'see attached'`, `'--'`, `'$'`, `'.'`; `validateBill` spec proves an unreadable total emits `money:totalCents`.
- **Committed in:** `a6794cf`

**2. [Rule 1 - Bug] The RESEARCH `toCents` mis-signs a negative amount with a fraction**
- **Found during:** Task 2
- **Issue:** `Number(whole) * 100 + Number(fraction)` applies the sign only to the whole part, so `'-5.50'` yields `-500 + 50 = -450`. A credit or refund line would be wrong by twice its cents.
- **Fix:** Sign is captured before digits are extracted (leading minus or accounting parentheses) and applied once to the assembled magnitude.
- **Files modified:** src/main/parse/validate.ts
- **Verification:** spec asserts `toCents('-5.50') === -550` and `toCents('($5.50)') === -550`.
- **Committed in:** `a6794cf`

**3. [Rule 2 - Missing Critical] Grounding needed a numeric boundary check**
- **Found during:** Task 1 (writing the confidence spec)
- **Issue:** Plain `sourceText.includes(value)` grounding certifies a tax of `8.00` as `'high'` on any bill whose total is `108.00`, `208.00`, `1,008.00` and so on. Since grounding is the primary confidence signal (D-11), a false ground is worse than no ground: it actively suppresses review of the exact digit-misread case the scorer targets.
- **Fix:** `containsToken` scans every occurrence and accepts one only when the preceding character is not `[0-9.,]` and the following character is not a digit.
- **Files modified:** src/main/parse/confidence.ts
- **Verification:** dedicated spec — tax `800` against a source containing only `100.00` and `$108.00` must not be `'high'`.
- **Committed in:** `a6794cf`

**4. [Rule 2 - Missing Critical] Money and date grounding needed printed-form variants**
- **Found during:** Task 1
- **Issue:** `computeConfidence` receives normalized values (integer cents, ISO dates) but the document prints `'108.00'` and `'07/24/2026'`. Comparing `10800` or `'2026-07-24'` against raw text would never match, so every money and date field on the native-PDF route would have fallen to `'low'` — silently disabling grounding for the fields it matters most for, while still looking like it worked.
- **Fix:** `moneyVariants` (dot and comma decimal, grouped and ungrouped) and `dateVariants` (ISO, slash/dash/dot numeric, two-digit year, long and short month names in both orders), all boundary-checked.
- **Files modified:** src/main/parse/confidence.ts
- **Verification:** specs ground `totalCents: 10800` against `'Total $108.00'` and `invoiceDate: '2026-07-24'` against `'Date 07/24/2026'`.
- **Committed in:** `a6794cf`

**5. [Rule 2 - Missing Critical] A missing vendor is now flagged**
- **Found during:** Task 2
- **Issue:** `BillSchema` types `vendor` as a required `z.string()`, which an empty string satisfies. A bill with no vendor cannot be reconciled in Phase 5 or posted in Phase 7, so it must not reach the review table looking clean.
- **Fix:** `validateBill` trims the vendor and pushes `missing:vendor` when nothing remains; `computeConfidence` maps that flag to `'flagged'` through the same generic rule as every other flag.
- **Files modified:** src/main/parse/validate.ts
- **Verification:** specs for a whitespace-only vendor and for the missing-payload degenerate case.
- **Committed in:** `a6794cf`

### Spec Correction

**6. The RED spec contained one self-contradictory assertion pair**

Task 1 pinned both `toCents('1.234') === 123400` (a lone dot with three trailing digits read as grouping) and `toCents('19.999') === 1999` (the same shape read as a decimal point). No single rule satisfies both. Task 2 replaced that assertion with the deliberate rule — a lone **comma** with three trailing digits is grouping, a lone **dot** is always the decimal point — split across three named specs with the locale tradeoff written out. The correction is a spec decision that RED got wrong, not an implementation being fitted to a test; the underlying behavior was chosen and documented on `toCents` before the assertion was edited, and every other assertion in the file was already green when it was made.

---

**Total deviations:** 5 auto-fixed (2 bugs in the cited reference implementation, 3 missing-critical), 1 spec correction
**Impact on plan:** All five protect correctness of behavior the plan already required — the plan's own Task 1 spec demanded `garbage -> null`, and D-11 demands grounding that actually works. No new module, no new export beyond the plan's list plus `arithmeticOk` (which the plan's `must_haves` names under `provides`), no scope creep.

## Issues Encountered

None blocking. Two notes for downstream plans:

**The `'1.234'` ambiguity is a real, accepted risk.** A lone dot followed by exactly three digits is genuinely ambiguous between three-decimal US money and European thousands grouping. It resolves US-first ($1.23). Any genuinely European invoice also prints its decimal comma (`'1.234,56'`), which the both-separators rule reads correctly, so the exposure is limited to a European amount printed with no decimals at all. Documented on `toCents` and pinned by a spec so a future change is deliberate.

**Grounding is unavailable on the image-only route.** With no embedded text every non-flagged field lands at `'low'`. That is the honest answer, and it is why D-22 adds the second cross-call there — but 03-07 must actually merge `agreementFlags` output into `validationFlags` before `computeConfidence` runs, or the D-22 signal never reaches a confidence value.

## Requirements Status

The plan's frontmatter lists `PARSE-04`. `REQUIREMENTS.md` was deliberately **not** updated. PARSE-04 reads "validates the extracted fields and flags low-confidence ones"; these two modules are the validator and the scorer, but nothing calls them yet — `extract-fields.ts` (03-05) produces their input and `pipeline.ts` (03-07) wires them into the run. Marking it complete now would put "Complete" next to a check that never executes. It stays `Pending` and 03-07 closes it.

| Req | Text | Delivered here | Actually completed by |
|-----|------|----------------|-----------------------|
| PARSE-04 | validates extracted fields and flags low-confidence ones | `validateBill`, `computeConfidence`, `agreementFlags` — the complete deterministic logic, fully unit-tested | 03-07 (pipeline wiring) |

## Known Stubs

None. Both modules are complete and fully exercised; nothing returns a placeholder, an empty literal, or a TODO. They have no callers yet, which is the interface-first wave ordering working as designed, not a stub.

## Interfaces For Downstream Plans

- **03-05 (`extract-fields.ts`)** — hand `validateBill` the object returned by `BillSchema.parse`. It never throws, so no try/catch is needed around it.
- **03-06 (`cache.ts` / `migration0003`)** — `validationFlags` is `string[]` and `FieldConfidence` is a flat string map; both JSON-serialize directly into the `validation_flags` and `field_confidence` TEXT columns. No boolean is ever produced (Pitfall 8).
- **03-07 (`pipeline.ts`)** — order matters: run `validateBill` on each pass, then `agreementFlags(primary, second)` on the image-only route, then concatenate those flags onto `validationFlags` **before** calling `computeConfidence`. Pass the extracted text as `sourceText` on the native route and `''`/`null` on the image-only route.

## User Setup Required

None — pure local computation, no credentials, no external service.

## Next Phase Readiness

Nothing is blocked. The two modules are importable, typed against the frozen 03-01 contract, and green. The remaining Wave 2 plans (03-04 routing/image prep, 03-05 vision extraction, 03-06 cache) are untouched by this work; 03-07 consumes it per the ordering note above.

## Self-Check: PASSED

- All 4 declared files exist on disk.
- Both task commits exist in git (`4bccfb6`, `a6794cf`).
- must_haves artifacts verified: `validate.ts` exports `toCents`, `normalizeDate`, `validateBill` (plus `arithmeticOk`); `confidence.ts` exports `computeConfidence` and `agreementFlags`.
- key_link verified: `confidence.ts` imports `ARITHMETIC_FLAG, MONTH_NAMES` from `./validate`.
- `npx vitest run test/parse-validate.test.ts test/parse-confidence.test.ts` — 55 tests passed.
- `npx vitest run` — 14 files, 156 tests passed (no regression in the existing suite).
- `npm run typecheck` — clean.
- Pitfall 4 gate: `grep -nE "parseFloat|Number\(.*\)\s*\*\s*100\b|/\s*100\b"` over both modules returns only a comment reading "string math, never cents / 100".
- Pitfall 8 gate: `grep -nE "true|false" src/main/parse/validate.ts` returns only comments, `normalizeDate`'s internal `flagged` signal (the return shape the plan itself specifies) and one `=== false` comparison. No boolean reaches `validationFlags` or `ParsedFields`.
- Scope gate: `git diff --name-only 4bccfb6^..HEAD` lists exactly the 4 in-scope files — `src/shared/ipc-contract.ts`, `src/shared/schemas.ts` and `src/preload/index.ts` are untouched, so the sibling Wave-2 plans stay conflict-free.
- Deletion gate: `git diff --diff-filter=D` over this plan's commits is empty.

---
*Phase: 03-ai-client-and-parse-pipeline*
*Completed: 2026-07-27*
