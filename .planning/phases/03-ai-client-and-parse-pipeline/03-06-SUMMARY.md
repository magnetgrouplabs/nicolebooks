---
phase: 03-ai-client-and-parse-pipeline
plan: 06
subsystem: database
tags: [sqlite, better-sqlite3, migration, strict-table, cache, prepared-statements, d14, d24, d21]

# Dependency graph
requires:
  - phase: 03-01
    provides: "the ParsedFields / FieldConfidence / ParseFileResult contract types the cache row maps to (src/shared/ipc-contract.ts)"
  - phase: 01
    provides: "the forward-only user_version migration runner (src/main/db/migrate.ts) and the STRICT-table + prepared-statement conventions from 0001_init / settings.ts"
  - phase: 02
    provides: "the SHA-256 file hash that IS the cache key, and the ledger.ts bound-parameter SELECT convention"
provides:
  - "migration0003 — the parsed_results STRICT table (D-24 DDL, 21 columns), keyed on file_hash"
  - "getCached(db, fileHash) — the cache-first lookup that lets the pipeline skip the paid model call"
  - "putCached(db, row) — the cache-last upsert on file_hash alone (a model switch never invalidates, D-14)"
  - "SCHEMA_VERSION — the one deliberate cache-invalidation lever (a prompt/schema bump, never a model change)"
  - "baseUrlHost() — reduces any base URL to its host so no credential can reach SQLite (D-05)"
affects: [03-07-pipeline-integration, 06-review-table, 07-posting-and-audit]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "The SCHEMA_VERSION staleness gate lives inside getCached, so a cached row produced under a retired prompt contract can never be served by a call site that forgot to check"
    - "putCached takes the base URL and stores only its host — 'never persist the key' is structural, not a convention each caller must remember"
    - "Every nullable input is normalized to an explicit null before binding, because an undefined bind would throw away an already-paid-for model call"

key-files:
  created:
    - src/main/db/migrations/0003_parsed_results.ts
    - src/main/parse/cache.ts
    - test/parse-cache.test.ts
  modified:
    - src/main/db/migrate.ts
    - test/migrate.test.ts
    - .planning/phases/03-ai-client-and-parse-pipeline/03-VALIDATION.md

key-decisions:
  - "getCached returns null when the stored schema_version differs from SCHEMA_VERSION — the D-24 forced re-parse is enforced in the cache, not left to the caller, mirroring how 03-05 put the D-21 page cap inside extractFields"
  - "putCached accepts a base URL and derives the host itself; a gateway URL carrying the key in userinfo or a query string physically cannot reach the database"
  - "Money is bound as-is with no rounding: validate.ts guarantees integer cents, and silently rounding a total would be exactly the auto-correction D-12 forbids, so a bad amount fails loudly against the STRICT INTEGER column and becomes a retryable per-file error"
  - "A corrupt JSON blob degrades to {} / [] instead of throwing, so one unreadable row can never abort a batch (the same failure-is-data stance as 03-05)"
  - "The no-BOOLEAN assertion checks declared column types from PRAGMA table_info rather than the DDL text, because sqlite_master keeps source comments and the DDL comment legitimately names the rule"

patterns-established:
  - "Cache invalidation levers are explicit and asymmetric: hash identity and schema_version gate a hit; the model id is recorded provenance and never a key"
  - "Migration specs assert the real upgrade path (an existing user_version-N database moving forward), not only the fresh-install path"

requirements-completed: [PARSE-05]

# Metrics
duration: 11min
completed: 2026-07-27
---

# Phase 3 Plan 06: Parsed-Results Cache Summary

**The `parsed_results` STRICT table (migration0003, forward-only to user_version 3) plus the `getCached`/`putCached` module that reads and writes it through bound prepared statements, keyed on the Phase 2 SHA-256 alone so switching models never re-charges the user for bytes already parsed.**

## Performance

- **Duration:** 11 min
- **Started:** 2026-07-27T15:04Z
- **Completed:** 2026-07-27T15:15Z
- **Tasks:** 2
- **Files modified:** 6 (3 created, 3 modified)

## Accomplishments

- **The cache key is the bytes, and only the bytes.** `file_hash TEXT PRIMARY KEY` with `ON CONFLICT(file_hash) DO UPDATE` means storing a result from a different model updates the one existing row rather than creating a second one. The spec proves it directly: write with `gpt-4o-2024-11-20`, write again with `anthropic/claude-sonnet-4`, `COUNT(*)` is 1. That is RESEARCH Pitfall 7 — keying on `hash+model` would silently re-parse and re-charge Nicole's entire history the first time she changed the model in Settings.
- **The one legitimate invalidation lever is enforced where it cannot be forgotten.** `getCached` treats a row whose `schema_version` differs from `SCHEMA_VERSION` as a miss. A prompt (D-23) or output-schema change means the stored fields came from a contract we retired, so they must be re-derived; a *model* change means no such thing. The stale row is left on disk so its `raw_response` keeps its audit value.
- **No credential can reach SQLite even if the user pastes one into the base-URL field.** `putCached` accepts the base URL and stores `new URL(raw).host`, which drops the scheme, userinfo, path, query and fragment. The spec writes `https://sk-live-CANARY123@gateway.example.com:8443/v1?key=sk-live-CANARY123` and asserts the canary appears nowhere in the serialized row and the stored value is exactly `gateway.example.com:8443`.
- **The D-21 truncated flag survives a cache hit as a real boolean.** STRICT tables have no BOOLEAN and better-sqlite3 refuses to bind a JS boolean (Pitfall 8), so the column is `INTEGER NOT NULL DEFAULT 0` and the 0/1 <-> boolean coercion lives in one place. Proven in both directions plus the omitted-flag case, which is the one that would otherwise bind `undefined` and throw.
- **The migration spec now proves the real upgrade, not just a fresh install.** A database built to `user_version` 2 with live `app_settings` and `posted_file_hashes` rows is migrated forward: it reaches 3, gains `parsed_results`, and both pre-existing rows are still readable. That is the path every installed copy will actually take.
- **26 tests green in the two touched specs; full unit suite 248 across 18 files; `npm run typecheck` clean.** `src/shared/ipc-contract.ts`, `src/shared/schemas.ts` and `src/preload/index.ts` are byte-identical to their 03-01 state.

## Task Commits

Each task was committed atomically:

1. **Task 1 (RED): spec the migration schema and the hash-keyed cache CRUD** — `3620711` (test)
2. **Task 2 (GREEN): migration0003 + cache.ts prepared-statement CRUD** — `a6b6e8c` (feat)

**Plan metadata:** see the final `docs(03-06)` commit.

## Files Created/Modified

- `src/main/db/migrations/0003_parsed_results.ts` — `migration0003`: the D-24 DDL verbatim as one `CREATE TABLE ... STRICT`. 21 columns: the 20 from RESEARCH lines 393-414 plus `truncated INTEGER NOT NULL DEFAULT 0`. Money is INTEGER cents (`total_cents` NOT NULL, `subtotal_cents`/`tax_cents` nullable); `field_confidence`/`validation_flags`/`raw_response` are TEXT JSON blobs; `base_url_host` is documented host-only.
- `src/main/db/migrate.ts` — `migration0003` appended to the array (`[migration0001, migration0002, migration0003]`); nothing renumbered. The "append 0003" comment rolled forward to "append 0004".
- `src/main/parse/cache.ts` — `SCHEMA_VERSION`, `CacheRowInput`, `CachedResult`, `baseUrlHost`, `getCached`, `putCached`, plus the private `parseConfidence`/`parseFlags`/`safeParse` deserializers. One `SELECT ... WHERE file_hash = ?` and one named-parameter upsert; zero string interpolation.
- `test/parse-cache.test.ts` — 15 tests in five groups: round trip, the D-21 flag, hash-alone keying, no-secret-material, and bound-never-interpolated. Exports `makeRow`, `FIELDS`, `HASH_A`, `HASH_B` so 03-07 appends its pipeline cache-hit-no-recall block rather than rewriting the file.
- `test/migrate.test.ts` — extended: user_version 3, the exact 21-column list, PK on `file_hash` alone, declared storage types, STRICT with no BOOLEAN-typed column, and the 2 -> 3 upgrade-with-data test. Temp handles are now registered and closed in `afterEach`.
- `.planning/.../03-VALIDATION.md` — the PARSE-05/D-24 row flipped green; the PARSE-05/D-14 and D-21 rows annotated with their storage half done and the 03-07 half named; the `parse-cache.test.ts` Wave-0 checkbox ticked.

## Decisions Made

- **The `schema_version` staleness check belongs in `getCached`, not in the pipeline.** The plan's own `must_haves` truth says "only a schema_version bump or explicit re-parse" invalidates a row, and the plan's action text describes `getCached` as a plain `SELECT ... WHERE file_hash = ?`. Those are reconcilable in two places; putting the gate in the cache is the one that cannot rot. If 03-07 (or Phase 6, or a Phase 7 re-post path) reads the cache without remembering the rule, it still gets correct behavior. This is the same reasoning 03-05 used to put the D-21 page cap inside `extractFields`. The row is not deleted, so nothing auditable is lost.
- **`putCached` takes `baseUrl`, not `baseUrlHost`.** Handing the module the already-reduced host would mean every call site is individually responsible for not leaking a credential, and D-03 lets the user type an arbitrary custom base URL. Taking the raw URL and reducing it here makes "never the key" a property of the storage layer. `baseUrlHost` is exported so 03-07 can reuse it, and it returns null rather than throwing on junk — missing provenance is not worth failing a parse over.
- **Money is bound as given, with no rounding fallback.** A non-integer cents value would fail against the STRICT INTEGER column and surface as a retryable per-file error (D-15). The tempting alternative — `Math.round` so the row always stores — is a silent auto-correction of a money value, which D-12 forbids outright. `validate.ts` already guarantees integers, so this branch should never fire; if it ever does, loud is right.
- **Deserialization is defensive, serialization is not.** A corrupt or non-conforming `field_confidence` blob degrades to `{}` and a bad `validation_flags` blob to `[]`, and unknown confidence values are dropped rather than passed through. One unreadable row must not throw away a whole batch. On the write side there is nothing to be defensive about: the values come from our own validated types.
- **The no-BOOLEAN assertion reads declared types, not DDL text.** The first draft matched `/BOOLEAN/i` against `sqlite_master.sql` and failed — because `sqlite_master` preserves source comments and the DDL comment explains *why* there is no BOOLEAN column. Asserting over `PRAGMA table_info` types (and that every declared type is in the STRICT-allowed set) tests the actual constraint and is immune to how the file is commented.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing Critical] `getCached` enforces the SCHEMA_VERSION gate**
- **Found during:** Task 2
- **Issue:** The plan's action text describes `getCached` as a bare `SELECT * FROM parsed_results WHERE file_hash = ?`, which would serve rows produced under a retired prompt/schema contract forever. The plan's own `must_haves` truth requires that a `schema_version` bump invalidate.
- **Fix:** `getCached` returns null when `row.schema_version !== SCHEMA_VERSION`. The row stays on disk (audit value preserved) and the next `putCached` overwrites it.
- **Files modified:** src/main/parse/cache.ts, test/parse-cache.test.ts
- **Verification:** a row rewritten to `SCHEMA_VERSION - 1` reads back as null while remaining present in a raw SELECT.
- **Committed in:** `3620711` (spec) / `a6b6e8c` (gate)

**2. [Rule 2 - Missing Critical] The base URL is reduced to a host inside `putCached`**
- **Found during:** Task 2
- **Issue:** The plan said "extract `base_url_host` from the base URL host only if a caller supplies it". Accepting a pre-reduced host would push the D-05 obligation onto every call site; a custom gateway URL (D-03 allows any) can carry the key in userinfo or a query string, and one careless caller would write it to disk.
- **Fix:** `putCached` accepts `baseUrl` and stores `new URL(raw).host`; `baseUrlHost()` is exported and never throws.
- **Files modified:** src/main/parse/cache.ts, test/parse-cache.test.ts
- **Verification:** a URL with a `sk-live-CANARY123` in both userinfo and query stores exactly `gateway.example.com:8443`, and the canary is absent from the serialized row.
- **Committed in:** `3620711` (spec) / `a6b6e8c` (implementation)

**3. [Rule 1 - Bug] Windows temp-DB handles leaked on a failed assertion in `migrate.test.ts`**
- **Found during:** Task 1
- **Issue:** Each test called `db.close()` as its last statement, so a failed assertion skipped the close; Windows then refused to unlink the temp file and the `afterEach` `rmSync` threw `EBUSY`, adding a second, misleading failure to every real one. Observed live during the RED run.
- **Fix:** an `openDb()` helper registers every handle and `afterEach` closes them all before `rmSync`; the two-handle upgrade test additionally uses try/finally.
- **Files modified:** test/migrate.test.ts
- **Verification:** the RED run reports only the 7 genuine failures, with no EBUSY cascade.
- **Committed in:** `a6b6e8c`

**4. [Rule 2 - Missing Critical] The migration spec proves the real 2 -> 3 upgrade path**
- **Found during:** Task 1
- **Issue:** The plan asked only that a fresh `migrate()` reach user_version 3. Every already-installed copy takes a different path — an existing database at 2 with live Phase 1/2 rows — and that is the path where a mistake destroys user data.
- **Fix:** a test builds a database at `user_version` 2 with an `app_settings` row and a `posted_file_hashes` row, reopens it, migrates, and asserts version 3, the new table, and both pre-existing rows intact.
- **Files modified:** test/migrate.test.ts
- **Verification:** the test is green; forward-only behavior confirmed (only migration0003 applies).
- **Committed in:** `3620711` (spec) / `a6b6e8c` (green)

---

**Total deviations:** 4 auto-fixed (3 Rule 2 missing-critical, 1 Rule 1 bug)
**Impact on plan:** No scope change, no contract change, no new dependency. Three of the four close gaps the plan's own decisions already implied (its `must_haves` schema_version truth, D-05's "never the key", the forward-only ratchet applied to a real upgrade); the fourth is test hygiene that was actively obscuring failures on this platform.

## Issues Encountered

**`sqlite_master.sql` preserves comments, which made the first no-BOOLEAN assertion self-defeating.** The DDL comment "STRICT has no BOOLEAN" matched the `/BOOLEAN/i` guard against the stored CREATE TABLE text. Rewritten to assert over `PRAGMA table_info` declared types plus a whitelist of the five STRICT-allowed types — a stronger check that tests the constraint rather than the prose.

**`getCached(db, hash)` keeps the ledger's default-then-required parameter order.** `checkPostedHash(db = getDatabase(), hash)` established it in Phase 2. A leading defaulted parameter means callers always pass both, which reads oddly in isolation, but matching the existing data-access convention beats introducing a second shape for the same job. 03-07 will always pass an explicit handle anyway.

## Threat Flags

None. No new network endpoint, auth path, or IPC surface. One new schema surface (`parsed_results`), which is this plan's subject and is covered by the register:

| Threat | Disposition | How |
|--------|-------------|-----|
| T-03-06 (SQL injection via cache.ts) | mitigated | One `SELECT ... WHERE file_hash = ?` and one named-parameter (`@name`) upsert, both prepared; zero interpolation (`grep -E '(SELECT\|INSERT\|UPDATE\|DELETE)[^\`]*\$\{'` returns nothing). Two specs prove it behaviorally: an injection payload as the hash is a literal miss and the table survives, and a vendor of `Robert'); DROP TABLE parsed_results; --` round-trips verbatim as text. |
| T-03-01 (information disclosure in the row) | mitigated | `base_url_host` is derived via `new URL().host`, so scheme, userinfo, path and query are dropped before storage; the API key is never read by this module. `raw_response` holds the model's reply about the bill (business data), stored for audit and never logged — this module logs nothing at all. |

## Requirements Status

| Req | Text | Status |
|-----|------|--------|
| PARSE-05 | Persist parsed results so a reload or crash never re-calls the paid model | **Storage half complete.** The table, the hash-keyed lookup and the upsert all ship and are unit-proven against a real temp database, including the model-switch case that is the whole point of D-14. The remaining half is behavioral and belongs to 03-07: making `getCached` the pipeline's first step so the injected client is provably never called on a hit. The 03-VALIDATION row stays pending until that spec exists. |

## Known Stubs

None. Both exported functions do their real work against a real database. `cache.ts` has no main-process caller yet — `src/main/parse/pipeline.ts` is owned by 03-07 — which is the interface-first wave ordering working as designed, not a stub.

## User Setup Required

None. Every test in this plan runs offline against a temp SQLite file with no key and no network.

## Next Phase Readiness

**03-07 (pipeline integration)** can wire this as the first and last step of the per-file body:

```ts
// cache-first: a hit means the paid client is never constructed for this file
const hit = getCached(db, file.hash)
if (hit) return { filename: file.filename, hash: file.hash, status: 'cached',
                  fields: hit.fields, confidence: hit.confidence,
                  validationFlags: hit.validationFlags, truncated: hit.truncated }

// ... route -> prep -> extractFields -> validateBill -> computeConfidence ...

// cache-last
putCached(db, {
  fileHash: file.hash, originalFilename: file.filename,
  route: decision.route, pageCount: decision.pageCount,
  model: selectedModelId, baseUrl,             // host is derived here; never pass a key
  fields, confidence,
  validationFlags,
  rawResponse: result.rawResponse,             // 03-05: store it, never log it
  parsedAt: new Date().toISOString(),
  truncated: result.truncated                  // 03-05: authoritative over a pageCount rederivation
})
```

Four things to carry forward:

1. **`getCached` can return null for a row that exists** (a `SCHEMA_VERSION` mismatch). Treat null as "parse it" — never as "the file is unknown".
2. **`parse:reparse` (D-14's explicit override) needs no cache API of its own.** It skips the `getCached` call and lets `putCached` upsert over the existing row.
3. **`test/parse-cache.test.ts` exports `makeRow`, `FIELDS`, `HASH_A`, `HASH_B`.** Append a describe block for the pipeline cache-hit-no-recall case; do not rewrite the file.
4. **Pass a real handle explicitly.** `getDatabase()` is the default but it requires Electron's `app` to be ready; the pipeline should thread its handle through `ParseDeps` the way `runScan` does.

**Concerns:** none open. `SCHEMA_VERSION` starts at 1 and should be bumped by whoever changes `BILL_SYSTEM_PROMPT` or `BillSchema` in a way that changes the meaning of stored fields — worth a comment in `prompt.ts` if a later phase edits the prompt.

## Self-Check: PASSED

- All 3 created files exist on disk; all 3 modified files updated.
- Both task commits exist in git (`3620711`, `a6b6e8c`).
- `must_haves` artifacts verified: `0003_parsed_results.ts` contains `parsed_results`; `cache.ts` exports `getCached` and `putCached`.
- `must_haves` key_link verified: `cache.ts` matches `file_hash = ?`, `@file_hash` and `ON CONFLICT(file_hash)` (lines 110, 121, 126).
- All four `must_haves` truths asserted by passing tests.
- Acceptance greps: no SQL template interpolation in `cache.ts` or `0003_parsed_results.ts`; no BOOLEAN-typed column (asserted over declared types).
- `npx vitest run test/migrate.test.ts test/parse-cache.test.ts` — 26 passed.
- `npx vitest run` — 18 files, 248 tests passed.
- `npm run typecheck` — clean.
- `git diff HEAD -- src/shared/ipc-contract.ts src/shared/schemas.ts src/preload/index.ts` — empty.
- No file deletions in either task commit.

---
*Phase: 03-ai-client-and-parse-pipeline*
*Completed: 2026-07-27*
