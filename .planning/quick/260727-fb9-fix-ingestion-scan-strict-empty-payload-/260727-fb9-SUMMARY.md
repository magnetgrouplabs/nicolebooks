---
phase: quick-260727-fb9
plan: 01
subsystem: ipc
tags: [electron, ipc, zod, vitest, playwright, ingestion, regression]

# Dependency graph
requires:
  - phase: 02-ingestion
    provides: the ingestion IPC group (resolve-inbox / choose-inbox / scan) and runScan
  - phase: 03-ai-client-and-parse-pipeline
    provides: the parse(raw ?? {}) normalization shape proven on the ai:* handlers in 03-02
provides:
  - "ingestion:scan handler that accepts the genuine no-arg preload call while keeping the strict-empty path-injection gate"
  - "Handler-level regression pin for the payload gate (both halves, including runScan-not-called)"
  - "E2E invocation proof that window.api.ingestion.scan() resolves and the Scan now button succeeds"
affects: [03-07 parse pipeline, any future payload-free IPC handler, Phase 3 human verification gate]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Payload-free IPC handlers normalize before the strict-empty parse: Schema.parse(raw ?? {})"
    - "Security gates whose reject half is unreachable from the renderer are pinned at the main-process handler; the resolve half is proven by an e2e that actually invokes the channel"

key-files:
  created:
    - test/ingestion-ipc-scan.test.ts
    - e2e/ingestion-scan.spec.ts
  modified:
    - src/main/ipc/ingestion.ts

key-decisions:
  - "Normalized undefined -> {} rather than relaxing ScanRequestSchema, so a smuggled payload still throws before runScan (T-02-02)"
  - "Split the two halves of the gate across layers: resolve proven in e2e, reject proven at the handler, because the zero-arity preload makes a renderer-level reject assertion a false failure"
  - "Proved both new specs are genuine regression pins by temporarily reverting the fix and watching each turn red with the production ZodError"

patterns-established:
  - "parse(raw ?? {}) is the house shape for every payload-free IPC handler"
  - "An e2e that asserts a bridge method EXISTS is not a proof of function; the channel must be invoked"

requirements-completed: [ING-01, ING-02]

# Metrics
duration: 12min
completed: 2026-07-27
---

# Quick Task 260727-fb9: Fix ingestion:scan strict-empty payload rejection Summary

**One-character fix (`ScanRequestSchema.parse(raw ?? {})`) that makes the Bills "Scan now" button work for the first time, plus the two-layer regression coverage whose absence let a permanently-rejecting IPC handler ship green through an entire phase.**

## Performance

- **Duration:** ~12 min
- **Started:** 2026-07-27T15:04:00Z
- **Completed:** 2026-07-27T15:16:00Z
- **Tasks:** 3
- **Files modified:** 3 (1 modified, 2 created)

## Accomplishments

- `ingestion:scan` no longer rejects every call. `src/main/ipc/ingestion.ts` normalizes the absent payload before the strict-empty parse, matching the shape already proven on `ai:test-connection` / `ai:list-models` in plan 03-02.
- The strict-empty gate (threat T-02-02, path injection) is intact and now provably un-removable: a smuggled payload still throws, and `runScan` is asserted NOT to have run on that path.
- The coverage hole is closed at both reachable layers. Reverting the fix turns **both** new specs red with the exact production error, `Invalid input: expected object, received undefined`.
- ING-01 and ING-02, which were marked Complete in REQUIREMENTS.md but were in fact non-functional, are now genuinely functional and covered.

## Task Commits

Each task was committed atomically:

1. **Task 1: Normalize the ingestion:scan payload + confirm the sibling audit** - `8aaddb0` (fix)
2. **Task 2: Handler-level regression pin** - `fdf9eaf` (test)
3. **Task 3: E2E invocation proof** - `6c26cc0` (test)

**Plan metadata:** see the final `docs(quick-260727-fb9-01)` commit.

## Files Created/Modified

- `src/main/ipc/ingestion.ts` - `ScanRequestSchema.parse(raw ?? {})` with a three-line comment naming T-02-02 and warning against deleting the parse; file-header block updated to describe the normalize-then-strict-parse flow with the inbox still resolved server-side.
- `test/ingestion-ipc-scan.test.ts` (new, 110 lines) - Captures `ipcMain.handle` registrations behind a mocked `electron`, no-ops `assertTrustedSender`, and spies `runScan`. Five cases: handler registered; resolves on `undefined`; resolves on `{}`; rejects `{ inboxPath: 'C:\\Windows' }`; `runScan` not called on that rejection.
- `e2e/ingestion-scan.spec.ts` (new, 96 lines) - Seeds a temp inbox with one `.pdf` **before** launch (so the 750ms settling poll sees it stable), stubs `dialog.showOpenDialog` and routes the app there through the real `chooseInbox` handler, then (1) invokes `window.api.ingestion.scan()` inside `window.evaluate` and asserts it RESOLVED with a well-formed `ScanResult` (`total/loaded = 1`, matching `inboxPath`, `YYYY-MM-DD` batch date, 64-char hex hash, the seeded filename at status `loaded`), and (2) clicks the real "Scan now" button and asserts the batch-date line and filename render with `role="alert"` count 0.

## Sibling-Handler Audit (confirmed, not re-derived)

The planning-time audit in the plan's `<audit_already_performed>` block was confirmed by running the verify greps against the post-fix tree. `grep -rE "Schema\.parse\(raw\)" src/main/ipc/` returns exactly **6** non-comment sites, each cross-checked against `src/preload/index.ts`:

| Channel | Handler parse | Preload sends an arg? | Verdict |
|---------|---------------|-----------------------|---------|
| `ingestion:resolve-inbox` | none | no | safe (no parse to trip) |
| `ingestion:choose-inbox` | none | no | safe (no parse to trip) |
| `ingestion:scan` | `parse(raw ?? {})` | no | **FIXED here** (was `parse(raw)`) |
| `theme:get` | none | no | safe (no parse to trip) |
| `ai:test-connection` | `parse(raw ?? {})` | no | already fixed in 03-02 |
| `ai:list-models` | `parse(raw ?? {})` | no | already fixed in 03-02 |
| `ai:set-model` | `parse(raw)` | yes, `{ modelId }` | safe |
| `settings:get` | `parse(raw)` | yes, `key` | safe |
| `settings:set` | `parse(raw)` | yes, `{ key, value }` | safe |
| `secrets:set` | `parse(raw)` | yes, `{ key, value }` | safe |
| `secrets:get` | `parse(raw)` | yes, `key` | safe |
| `secrets:delete` | `parse(raw)` | yes, `key` | safe |

The six surviving bare `parse(raw)` calls (ai:set-model, settings x2, secrets x3) all belong to handlers whose preload method genuinely passes an argument. `ingestion:scan` was the last mis-shaped instance in `src/main/ipc/`.

## Decisions Made

- **Normalize, do not relax the schema.** Widening `ScanRequestSchema` (e.g. dropping `.strict()` or making it optional) would have made the symptom go away while deleting the T-02-02 path-injection guard. `raw ?? {}` accepts only the absent payload; anything real still throws.
- **The reject half is tested at the handler, not in e2e.** `src/preload/index.ts:40` is zero-arity and silently discards caller arguments, so `window.api.ingestion.scan({...})` resolves — a renderer-level reject assertion would be a false failure inviting someone to "fix" it by weakening the schema. Honored the plan's `<critical_constraint>`.
- **Verified both specs are real pins, not decoration.** Since Task 1 (the fix) precedes Task 2/3 (the tests), the TDD RED gate was demonstrated by temporarily reverting `parse(raw ?? {})` to `parse(raw)`: the unit spec failed at the undefined case and the e2e failed at the invocation-proof assertion, both citing `Invalid input: expected object, received undefined`. The fix was restored via `git checkout --` on that single file and both suites re-run green.

## Deviations from Plan

None - plan executed exactly as written.

No deviation rules fired. No architectural changes, no package installs, no scope-guard violations: `src/shared/ipc-contract.ts`, `src/shared/schemas.ts`, and `src/preload/index.ts` are byte-unchanged, and no Phase 3 parse/ai source was touched. `git diff --name-only HEAD~3 HEAD` returns exactly `e2e/ingestion-scan.spec.ts`, `src/main/ipc/ingestion.ts`, `test/ingestion-ipc-scan.test.ts`.

## Issues Encountered

- **TDD ordering vs. plan ordering.** Task 2 carries `tdd="true"` but the plan sequences the fix (Task 1) before the test. Rather than skip the RED gate, RED was demonstrated retroactively by reverting the fix in the working tree, observing the failure, and restoring — which also satisfies the plan's own done criterion ("Reverting Task 1's change makes this spec fail"). Handled inside Task 2/3; no commit ordering was disturbed.
- **e2e inbox isolation.** A naive spec would scan the developer's real `Documents/NicoleBooks/Inbox`, making assertions non-deterministic. Solved with the `inbox-picker.spec.ts` stubbed-dialog pattern: `dialog.showOpenDialog` returns a temp dir, `chooseInbox` persists it through the real handler, and the scan then enumerates a folder holding exactly one seeded file.

## Verification

| Gate | Result |
|------|--------|
| `npm run typecheck` | exit 0 |
| `npx vitest run` (full unit suite) | 19 files, **253 tests passed** (incl. the new 5) |
| `npm run build` | succeeds (main + preload + renderer) |
| `npx playwright test` (full e2e suite) | **7 passed**, incl. the new `ingestion-scan.spec.ts` |
| `grep -c "ScanRequestSchema.parse(raw ?? {})" src/main/ipc/ingestion.ts` | `1` |
| Bare `Schema.parse(raw)` sites in `src/main/ipc/` | `6`, all real-payload handlers |
| Scope guard (`src/shared/*`, `src/preload/index.ts` untouched) | confirmed via `git diff --name-only HEAD~3 HEAD` |

## Self-Check: PASSED

- `src/main/ipc/ingestion.ts` — FOUND, contains `ScanRequestSchema.parse(raw ?? {})`
- `test/ingestion-ipc-scan.test.ts` — FOUND (5 tests passing)
- `e2e/ingestion-scan.spec.ts` — FOUND (passing)
- Commit `8aaddb0` — FOUND
- Commit `fdf9eaf` — FOUND
- Commit `6c26cc0` — FOUND

## Tracking Updates

- **`.planning/phases/03-ai-client-and-parse-pipeline/deferred-items.md` item 2 is now CLOSED**, annotated in place with the three commit hashes. Its standing note is retained and re-scoped: any future payload-free handler must use `parse(raw ?? {})`.
- **STATE.md's "APP-BREAKING (Phase 2 regression, found during 03-02)" blocker has been cleared**, rewritten as a RESOLVED entry pointing at this task, and a "Quick Tasks Completed" table was added recording 260727-fb9.
- ING-01 / ING-02 were already checked in REQUIREMENTS.md (prematurely — the feature did not work). No checkbox change was needed; they are now genuinely satisfied and covered by automated proof.

## Standing Note for the 03-07 Executor

The parse IPC handlers (`parse:batch`, `parse:reparse`, `parse:progress`) **do not exist yet** — nothing in `src/main/ipc/` registers them. When 03-07 creates them:

- Any handler the preload invokes **without** an argument (check `src/preload/index.ts`) must Zod-parse **`raw ?? {}`**, never a bare `raw`. A strict-empty schema on bare `raw` always throws, and the failure is invisible to a spec that only asserts the bridge method exists.
- `parse:batch` and `parse:reparse` both send payloads (`files`, `{ fileHash }`), so a bare `parse(raw)` is correct for those two. There is currently no payload-free parse channel, but this rule applies to any added later.

## Next Phase Readiness

- Phase 2 ingestion is functional end-to-end for the first time; the Bills screen scan surface can be exercised in the Phase 3 human verification gate without hitting the "Could not scan your inbox folder" alert.
- Phase 3 remains at 6/7 plans; 03-07 (parse pipeline) is unblocked and unaffected by this change.
- No new blockers introduced.

---
*Quick task: 260727-fb9*
*Completed: 2026-07-27*
