---
phase: quick-260727-iv0
plan: 01
subsystem: ui
tags: [react, bills-screen, information-architecture, wr-10, badge, definition-list]

# Dependency graph
requires:
  - phase: 03-ai-client-and-parse-pipeline
    provides: ParseFileResult with fields, confidence, validationFlags and truncated across the IPC boundary
provides:
  - Labeled label/value rendering of all nine parsed fields on the Bills row
  - flaggedFields, the per-field flag attribution helper with the unattributed-flag backstop
  - statusChip, the ten-row precedence table that resolves one Badge label plus variant
  - Per-field review markers replacing the single blanket row warning
  - The previously dropped `truncated` flag surfaced to the user
affects: [phase-06-review-table, phase-07-post-to-quickbooks]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Renderer-local mirror of a main-process rule instead of a cross-process import"
    - "Unattributed-input backstop: an unrecognized flag degrades toward MORE warnings, never fewer"
    - "Chip precedence table as a pure function, pinned row by row"

key-files:
  created:
    - test/bills-row-status.test.ts
  modified:
    - src/renderer/src/screens/BillsScreen.tsx
    - test/bills-parse-flags.test.ts

key-decisions:
  - "The renderer mirrors confidence.ts's flag-attribution rules locally rather than importing from src/main, because importing would pull main-process code into the renderer bundle"
  - "Any validation flag the renderer cannot attribute to a known field condemns all three money fields; since totalCents always renders, a non-empty flag set always produces a visible marker"
  - "File status (rows 1-5) outranks parse status in the chip, so a dedupe warning can never be overwritten by a cheerful Ready to review"
  - "Needs review outranks the cache-hit chip: a flagged bill wearing a calm Already read chip is the chip-level WR-10 failure"
  - "Only 'flagged' confidence is surfaced, never 'low': on the image-only route confidence.ts lands every non-flagged field at 'low' by design, so marking low would paint a marker on every phone-photo receipt"
  - "A null field is omitted UNLESS it carries a flag, mirroring computeConfidence's own omit-ungradeable-but-keep-flagged rule"
  - "The In batch badge was deleted rather than merged: the adjacent toggle already reads Remove from batch, which says the same thing and is actionable"

patterns-established:
  - "isFlagged(parse) === (flaggedFields(parse).size > 0) is kept as a proven property rather than collapsing one into the other, so the equivalence stays provable"
  - "Rendering assertions target a specific <dt>/<dd> pair, so a per-field claim cannot be satisfied by a marker elsewhere in the row"

requirements-completed: [WR-10]

# Metrics
duration: 14min
completed: 2026-07-27
---

# Quick 260727-iv0: Bills row labeled parse fields and single status chip Summary

**The Bills row now prints all nine parsed fields as labeled label/value pairs with the review marker on the field that actually failed, and wears exactly one precedence-driven status chip instead of stacking up to four badges.**

## Performance

- **Duration:** 14 min
- **Started:** 2026-07-27T17:45:40Z
- **Completed:** 2026-07-27T17:59:30Z
- **Tasks:** 2 (both TDD, 4 commits)
- **Files modified:** 3 (1 created, 2 modified)

## Accomplishments

- Replaced the single unlabeled `"Nassau Plumbing Supply $1,336.00"` string with a `<dl>` of labeled pairs covering every populated field: Vendor, Invoice number, Invoice date, Due date, Subtotal, Tax, Total, Currency, Suggested category.
- The `needs review` marker now sits on the individual field whose deterministic check failed, in `text-destructive`, instead of smearing one blanket warning across the row.
- Collapsed the badge stack (In batch + file status + parse status + Needs review) into one `Badge` whose label and variant both come from `statusChip`'s ten-row precedence table, so the color carries meaning.
- Strengthened WR-10 rather than weakening it: `flaggedFields` treats any flag it cannot attribute to a known field as condemning all three money fields, and since `totalCents` always renders, a non-empty flag set always yields at least one visible marker. Pinned as a property loop that includes flag strings this build does not recognize.
- Surfaced `parse.truncated`, which the contract already carried and the screen silently dropped. A truncated read presenting a confident total is the same class of silent-confidence problem WR-10 exists to prevent.

## Task Commits

1. **Task 1: Per-field flag attribution and the status chip, as pure functions**
   - `2158af3` (test) — RED: 38 failing pins for `flaggedFields` and `statusChip`
   - `823df94` (feat) — GREEN: both functions plus the field-order/label/money constants
2. **Task 2: Rebuild the row body as a labeled field list with one chip**
   - `72904c8` (test) — RED: WR-10 pin restated against the labeled structure, 9 failing
   - `927ac48` (feat) — GREEN: the `<dl>` row body, per-field markers, single chip

**Plan metadata:** see final commit (docs: complete quick task)

## Files Created/Modified

- `src/renderer/src/screens/BillsScreen.tsx` — added `FIELD_ORDER` / `FIELD_LABEL` / `KNOWN_FIELDS` / `MONEY_FIELDS`, `flaggedFields`, `statusChip`, `fieldValue`; rewrote the `ScanRow` body; deleted `parsedSummary`, `PARSE_STATUS_LABEL`, `PARSE_STATUS_VARIANT` and the four-badge stack.
- `test/bills-row-status.test.ts` — NEW. 38 assertions: per-field attribution, the four unattributed-flag shapes, all ten precedence rows, three ordering-collision cases, the dash check, and the `isFlagged`/`flaggedFields` equivalence property looped over 14 fixtures.
- `test/bills-parse-flags.test.ts` — the WR-10 pin, restated and strengthened. Exactly two presentation-coupled assertions moved; every other original assertion is byte-identical.

## Decisions Made

Design decisions were settled in the plan and implemented as written. Implementation-level notes worth carrying forward:

- `isFlagged` was left byte-identical (same name, export, body, doc comment) rather than being reimplemented as `flaggedFields(...).size > 0`. Keeping both is what makes the equivalence provable; collapsing them would turn the WR-10 property into a tautology.
- `fieldValue` prints `Not found` for a `totalCents` that is not a number (reachable only through a degraded cache blob) rather than `formatCents(0)`. A confident `$0.00` is the precise failure D-12 and WR-10 exist to prevent.
- `flaggedFields` counts a non-string entry in `validationFlags` as unattributed rather than skipping it, for the same reason: a cached row's flag list is rehydrated from JSON, and dropping an entry is the one outcome WR-10 forbids.
- `formatCents` was left untouched. It still does string math and never `cents / 100`.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Deferred the deletion of `parsedSummary` / `PARSE_STATUS_*` from Task 1 to Task 2**
- **Found during:** Task 1 (pure functions)
- **Issue:** Task 1's action text says to delete `parsedSummary`, `PARSE_STATUS_LABEL` and `PARSE_STATUS_VARIANT`, but `ScanRow` still referenced all three until Task 2 rewrote it. Deleting them inside Task 1 would have broken `tsc --build`, which is Task 1's own verification gate.
- **Fix:** Kept the three symbols through Task 1 and deleted them in the Task 2 commit that removed their last call sites. Net end state is identical to the plan's.
- **Files modified:** src/renderer/src/screens/BillsScreen.tsx
- **Verification:** `npm run typecheck` clean after both tasks; `grep` confirms all three symbols are gone.
- **Committed in:** 927ac48 (Task 2 commit)

**2. [Rule 3 - Blocking] Removed the now-unused `ParseFileStatus` type import**
- **Found during:** Task 2
- **Issue:** `ParseFileStatus` was imported only to type `PARSE_STATUS_VARIANT` / `PARSE_STATUS_LABEL`. Once those were deleted the import was dead.
- **Fix:** Dropped it from the `@shared/ipc-contract` type import list. `src/shared/ipc-contract.ts` itself was not touched.
- **Files modified:** src/renderer/src/screens/BillsScreen.tsx
- **Verification:** `npm run typecheck` clean; `git status --porcelain` on the three frozen contract files returns empty.
- **Committed in:** 927ac48 (Task 2 commit)

**3. [Rule 2 - Missing Critical] Refreshed two stale doc comments**
- **Found during:** Task 2
- **Issue:** The file header still described "badges every loaded row parsed / cached / could-not-read" and "Parsed rows show a read-only vendor and total", and the `STATUS_VARIANT` comment still explained a `loaded: 'default'` chip that `statusChip` supersedes. Both would have actively misdirected the next reader of a WR-10-critical file.
- **Fix:** Rewrote both comment blocks to describe the labeled `<dl>` structure, the single chip, and why the `loaded` table entry survives (`ScanFileStatus` is exhaustive).
- **Files modified:** src/renderer/src/screens/BillsScreen.tsx
- **Verification:** Comments only; full suite and typecheck re-run green after the edit.
- **Committed in:** 927ac48 (Task 2 commit)

---

**Total deviations:** 3 auto-fixed (2 blocking sequencing/typecheck, 1 documentation accuracy)
**Impact on plan:** No scope change. Deviations 1 and 2 are task-ordering consequences of `ScanRow` holding the last references; the end state matches the plan exactly. No visual redesign was attempted, per the explicit out-of-scope instruction.

## Issues Encountered

- The two `not.toMatch(...)` dash guards were first written into the test files with the raw UTF-8 dash characters inside the character class. Rewritten to use unicode escape sequences (backslash-u2014 and backslash-u2013) so the guards cannot be silently broken by an encoding round trip on a file the guards themselves are meant to police.

## Verification

| Gate | Result |
|------|--------|
| `npm run test:unit` | 27 files, 419 tests passed (was 26 / 358) |
| `npm run typecheck` | clean (`tsc --build`, exit 0) |
| `npm run build` | clean (main + preload + renderer) |
| `npx playwright test` | 8 passed |
| `git status --porcelain` on the three frozen contract files | empty |
| `/ 100` or hex literal on a non-comment line of BillsScreen.tsx | 0 |
| `In batch` in BillsScreen.tsx | 0 |
| `<Badge` elements in BillsScreen.tsx | 1 |
| Em dash / en dash in rendered markup | none, across all nine chip states |

The two presentation-coupled assertions that legitimately changed are the only ones that changed. The `$0.00` + `needs review` + `Needs review` + `text-destructive` block, the arithmetic-flag case, the parse-failed `not.toContain('$')` case, and the whole `isFlagged` block are all byte-identical to the originals and all pass.

## User Setup Required

None.

## Next Phase Readiness

- Phase 6's editable review table now has a working per-field flag model to build on: `flaggedFields` already answers "which cells need a badge", and the D-18 rich confidence UI can extend it to `low` when the review grid gives it somewhere non-noisy to live.
- `statusChip` is the single place a row status is decided, so adding an in-flight "Reading..." state later is a one-row change to the precedence table plus a prop. It was deliberately not added here (`ScanRow` has no access to batch parsing state, and the screen already shows "Reading bills: parsing N of M").
- No blockers introduced. Phase 03 verification is unaffected; this change touches only the renderer presentation layer.

## Self-Check: PASSED

- All four files exist on disk (`BillsScreen.tsx`, `bills-row-status.test.ts`, `bills-parse-flags.test.ts`, this SUMMARY).
- All four task commits exist in `git log`: `2158af3`, `823df94`, `72904c8`, `927ac48`.
- `parsedSummary` and `PARSE_STATUS*` appear 0 times in `BillsScreen.tsx`.
- `flaggedFields` and `statusChip` are exported alongside the untouched `isFlagged`.

---
*Phase: quick-260727-iv0*
*Completed: 2026-07-27*
