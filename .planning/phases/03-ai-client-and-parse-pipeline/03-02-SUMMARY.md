---
phase: 03-ai-client-and-parse-pipeline
plan: 02
subsystem: api
tags: [openai, vision-models, ipc, zod, safestorage, keychain, settings-ui, react, ssrf-guard]

# Dependency graph
requires:
  - phase: 01-foundation
    provides: "secrets safeStorage channel (the AI key + base URL live here), app_settings + settings:get/set (the non-secret model id), assertTrustedSender, the branded Badge/Button/HealthIndicator components"
  - phase: 03-ai-client-and-parse-pipeline
    provides: "03-01's frozen ai:* contract (channel constants, ModelInfo three-state vision, AiTestConnection/AiListModels/AiSetModel schemas, the window.api.ai preload bridge) and the shared OpenAIClientLike fake"
provides:
  - "src/main/ai/client.ts — buildClient(): the ONLY reader of the AI credentials, with the https-only base-URL guard and the D-25 client config"
  - "src/main/ai/models.ts — classifyVision() in D-25 order, listModels() over a lenient local ModelInfoSchema, and set/getSelectedModel() on app_settings"
  - "src/main/ai/vision-families.ts — pure isKnownVisionFamily() over the curated D-02 family regexes"
  - "src/main/ipc/ai.ts — registerAiIpc(): test-connection / list-models / set-model, wired into register.ts"
  - "The Settings AI-config UI: provider presets + custom URL, masked key field, one Connect-and-test action, OK/error status, vision-badged model picker with the D-01 use-anyway confirm"
  - "Proof (unit + running-app probe) that neither the API key nor the base URL reaches SQLite, the renderer, or any log"
affects: [03-05-vision-extraction, 03-07-pipeline-integration, 06-review-table]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Payload-free IPC handlers must Zod-parse `raw ?? {}` — the preload invokes with no argument, so a bare `parse(raw)` on a strict-empty schema always throws"
    - "Opaque error codes at the service layer (AI_CREDENTIALS_MISSING / AI_BASE_URL_INVALID / AI_BASE_URL_INSECURE) mapped to fixed user copy at the IPC layer, so no raw SDK message (which embeds the endpoint URL) can ride out to the renderer"
    - "Credentials are write-only from the renderer's perspective: written through secrets.set, read only main-side, with no read path back into the UI"

key-files:
  created:
    - src/main/ai/vision-families.ts
    - src/main/ai/models.ts
    - src/main/ai/client.ts
    - src/main/ipc/ai.ts
    - test/ai-models.test.ts
  modified:
    - src/main/ipc/register.ts
    - src/renderer/src/screens/SettingsScreen.tsx
    - test/no-secret-leak.test.ts
    - .planning/phases/03-ai-client-and-parse-pipeline/deferred-items.md

key-decisions:
  - "Payload-free ai channels normalize `raw ?? {}` before the strict-empty Zod parse; without it every Connect-and-test press would reject (proven on the running app, and the same latent bug was found in Phase 2's ingestion:scan)"
  - "The IPC layer never forwards a raw error: three known codes map to fixed recoverable copy and everything else falls back to one generic message, because OpenAI SDK errors routinely embed the request URL"
  - "classifyVision still runs the curated-family rung when metadata is present but omits 'image', so a provider that under-reports modalities cannot silently strip the Vision badge off gpt-4o"
  - "listModels skips an entry that fails the lenient schema instead of failing the whole list, so one malformed row from a third-party gateway cannot blank out the picker"
  - "The Settings screen never reads the key or base URL back — not even to show what is configured — so the only AI value with a renderer read path is the non-secret model id"
  - "Selected-model persistence lives in ai/models.ts (injectable db) rather than inline in the handler, so AI-04 is unit-provable against a temp DB with no Electron"

patterns-established:
  - "Service modules expose an injectable collaborator with a real default (client, secretStore, db), so every guard is unit-testable with no Electron and no network"
  - "Security-relevant thrown values are opaque codes, never interpolated user input — the base URL never appears in an error message or a stack"

requirements-completed: [AI-01, AI-02, AI-03, AI-04]

# Metrics
duration: 15min
completed: 2026-07-27
---

# Phase 3 Plan 02: AI Client Configuration Summary

**The complete AI-config vertical slice: a Settings section that writes an OpenAI-compatible key and base URL to the OS keychain, one Connect-and-test press that calls /models exactly once to both validate the credentials and populate a vision-classified model picker, a use-anyway confirm gate on unbadged models, and a persisted model choice, with the credentials provably never crossing IPC or reaching a log.**

## Performance

- **Duration:** 15 min
- **Started:** 2026-07-27T12:41:49Z
- **Completed:** 2026-07-27T12:57:19Z
- **Tasks:** 3
- **Files modified:** 9 (5 created, 4 modified)

## Accomplishments

- **The whole AI-01..AI-04 story works end to end on the running app, not just in unit tests.** A throwaway Playwright probe against the launched Electron build confirmed `ai:test-connection` resolves `{ ok: false, error: "Enter your API key and choose a base URL, then try again." }` with no credentials stored (the recoverable-error path, not a rejection), `ai:set-model` persists, and the id round-trips straight back through `settings:get`. The probe was deleted after the run; the tree is clean.
- **The secret boundary is now proven, not just asserted.** `test/no-secret-leak.test.ts` scans all three surfaces (secrets.enc plaintext, a real migrated app.db, captured stdout/stderr/console) for two distinct AI canaries, then exercises the live path: `buildClient()` reads both credentials main-side, `listModels()` classifies a model list, and neither canary appears in the renderer-bound result, in the thrown error, or in any log. The same suite proves the legitimate write (the model id) DID land in app.db, so the absences are not vacuous.
- **The SSRF / key-exfiltration guard (T-03-05) is real code with a spec behind it.** `buildClient` validates the user-chosen base URL with `new URL()` and rejects anything that is not `https:` *before* the client is constructed, so the key is never handed to an `http://`, `ftp://`, `file://`, or malformed target. The thrown value is an opaque code, so the rejected URL itself never leaks into an error surface.
- **Vision classification handles both real-world response shapes.** The mixed-list spec drives one call through an OpenRouter-rich entry (`architecture.input_modalities` includes `image`), an OpenAI-minimal `gpt-4o` (no capability metadata at all, caught by the curated family list), an unknown id, and a metadata-confirmed text-only model, and asserts `models.list()` fired exactly once (D-04).
- **Zero shared-contract edits.** `src/shared/ipc-contract.ts`, `src/shared/schemas.ts`, and `src/preload/index.ts` are untouched, so the four sibling Wave-2 plans stay conflict-free.

## Task Commits

Each task was committed atomically:

1. **Task 1 (RED): spec vision classification, model list/persist, and the AI-key no-leak canary** - `302dc4d` (test)
2. **Task 2 (GREEN): AI service layer + ai IPC handlers** - `50c767b` (feat)
3. **Task 3: Settings AI-config section** - `cbdbccb` (feat)

**Plan metadata:** see the final `docs(03-02)` commit.

## Files Created/Modified

- `src/main/ai/vision-families.ts` — pure, zero-dependency `isKnownVisionFamily(id)` over 13 curated matchers (gpt-4o, gpt-4.1, gpt-4 turbo/vision, the o-series anchored to a bare-or-provider-qualified id, Claude 3/4 and opus/sonnet/haiku, Gemini 1.5/2/2.5/3 and the flash/pro lines, Llama vision, Qwen-VL, Pixtral, plus an explicit `-vision-` name segment). Follows the `ingestion/hash.ts` tiny-pure-module convention.
- `src/main/ai/models.ts` — `classifyVision()` implementing the D-25 rungs in order; `listModels(deps)` with the **local** lenient `ModelInfoSchema` (loose object, every rich field `.nullish()`) and a `toEntries()` normalizer that accepts either the `.data` array or the async-iterable form of a `/models` page; `setSelectedModel()` / `getSelectedModel()` on the same prepared-statement UPSERT `settings:set` uses, keyed `ai-model`.
- `src/main/ai/client.ts` — `AI_API_KEY_SECRET` / `AI_BASE_URL_SECRET`, the exported `assertHttpsBaseUrl()` guard, and `buildClient(deps)` returning `new OpenAI({ apiKey, baseURL, maxRetries: 3, timeout: 120000 })`. The only module in the codebase that reads either credential; nothing here logs.
- `src/main/ipc/ai.ts` — `registerAiIpc()` with the three handlers, each `assertTrustedSender(event)` first, then Zod, then work. `ai:test-connection` returns `{ ok, models }` or `{ ok: false, error }` with fixed copy; `ai:list-models` re-fetches; `ai:set-model` persists the id.
- `src/main/ipc/register.ts` — one import plus one `registerAiIpc()` call.
- `src/renderer/src/screens/SettingsScreen.tsx` — the AI connection section replacing the placeholder: provider select (OpenAI / OpenRouter / Other with a revealed URL field), masked key input, "Connect and test" button, a HealthIndicator-shaped status card (`text-success` / `text-destructive`, `rounded-xl border border-border bg-card p-4`), the `role="alert"` recoverable-error block, a searchable model list with Vision badges, and the `role="alertdialog"` use-anyway confirm. Zero hardcoded color literals.
- `test/ai-models.test.ts` — 21 specs across classification, family matching, list behavior, persistence, and the buildClient guards.
- `test/no-secret-leak.test.ts` — extended with a four-spec `AI credentials never leak` block and a reusable `captureOutput()` helper.
- `.planning/phases/03-ai-client-and-parse-pipeline/deferred-items.md` — one out-of-scope blocker logged (see Issues Encountered).

## Decisions Made

- **`parse(raw ?? {})` on the payload-free channels.** The preload invokes `ai:test-connection` and `ai:list-models` with no argument, so the handler receives `undefined`, and `z.object({}).strict().parse(undefined)` throws. Normalizing to `{}` keeps the gate fully intact (any real payload still throws, so a credential cannot be smuggled in) while letting the genuine call through. Verified on the running app.
- **Fixed error copy, never a forwarded message.** `recoverableReason()` maps three known codes and falls back to one generic sentence for everything else, because SDK and network errors routinely embed the request URL, which is exactly the value T-03-01 forbids returning.
- **Metadata absence is not a negative signal.** If an endpoint reports `input_modalities` without `image`, the curated-family rung still runs. Only "no metadata match AND no family match" yields `unknown`.
- **A malformed model entry is skipped, not fatal.** One bad row from a third-party gateway degrades the picker by one entry instead of blanking it.
- **The Settings screen has no read path for the credentials.** It does not populate the key or base-URL fields from storage, even though `secrets.get` exists. The trade is that after a restart the fields start empty (with copy explaining the key is saved in the keychain); the gain is that there is no code path at all by which a compromised renderer could read them back.
- **Persistence lives in the service module, not the handler.** `setSelectedModel`/`getSelectedModel` take an injectable `db`, so AI-04 is provable against a temp DB with no Electron. The handler stays a three-line delegate, matching how `ingestion.ts` delegates to `runScan`.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Payload-free handlers had to normalize `raw ?? {}` before the strict-empty Zod parse**
- **Found during:** Task 2 (ai IPC handlers)
- **Issue:** 03-PATTERNS Shared Pattern A (and its source, `src/main/ipc/ingestion.ts:41`) shows `Schema.parse(raw)` on a strict-empty schema. But the preload invokes these channels with no argument, so `raw` is `undefined`, and `z.object({}).strict().parse(undefined)` throws `Invalid input: expected object, received undefined`. Copied verbatim, every "Connect and test" press would have rejected before reaching `buildClient`, and the must-have "a Connect/Test action calls /models exactly once" could never be satisfied.
- **Fix:** `AiTestConnectionSchema.parse(raw ?? {})` and `AiListModelsSchema.parse(raw ?? {})`, with an inline comment explaining that the strict gate is preserved. `ai:set-model` takes a real payload and parses `raw` directly.
- **Files modified:** src/main/ipc/ai.ts
- **Verification:** A throwaway Playwright probe against the launched app: `window.api.ai.testConnection()` RESOLVED `{ok:false,error:"Enter your API key and choose a base URL, then try again."}` and `window.api.ai.setModel('gpt-4o')` RESOLVED `true`, while the un-normalized `window.api.ingestion.scan()` REJECTED with exactly the Zod error above. Probe deleted; `git status` clean.
- **Committed in:** `50c767b` (Task 2 commit)

**2. [Rule 2 - Missing Critical] Added the buildClient guard specs to the Wave-0 RED task**
- **Found during:** Task 1 (RED spec)
- **Issue:** The plan's Task 1 action listed only classification, list, persistence, and the no-leak canary, but Task 2's acceptance criteria require proving that `buildClient` uses `new URL()` and rejects an `http://` base URL. Without a spec, the T-03-05 mitigation would be a code comment rather than a tested behavior, and a later refactor could silently drop it.
- **Fix:** Added a `buildClient` describe block covering the happy path (pinning `maxRetries: 3` / `timeout: 120000`), a missing key, a missing base URL, three non-https protocols, a malformed URL, and a non-vacuous assertion that the thrown error and its stack contain no part of the key.
- **Files modified:** test/ai-models.test.ts
- **Verification:** All 6 buildClient specs fail at import before Task 2 (RED) and pass after (GREEN).
- **Committed in:** `302dc4d` (Task 1 commit)

**3. [Rule 2 - Missing Critical] Added a search filter to the model picker**
- **Found during:** Task 3 (Settings UI)
- **Issue:** The plan says "render the returned `ModelInfo[]`". OpenRouter's `/models` returns well over 300 entries. An unfiltered list is unusable for a non-technical user and would bury the vision-badged models the flow depends on, so the picker would nominally render while failing its actual job.
- **Fix:** A `type="search"` input above the list filtering on id and label, the list capped at `max-h-80` with `overflow-y-auto`, and a "No models match that search." empty line. Built from the same semantic tokens as every other field.
- **Files modified:** src/renderer/src/screens/SettingsScreen.tsx
- **Verification:** `npm run typecheck` clean; production build clean; the hardcoded-color grep gate returns nothing.
- **Committed in:** `cbdbccb` (Task 3 commit)

---

**Total deviations:** 3 auto-fixed (1 blocking, 2 missing-critical)
**Impact on plan:** Deviation 1 was required for the plan's central must-have to function at all. Deviations 2 and 3 protect a declared threat mitigation and the picker's basic usability. No new module, no new channel, no shared-contract edit, no behavior beyond the plan's scope.

## Issues Encountered

**Phase 2's `ingestion:scan` is broken by the same latent bug, and it is app-breaking.** While validating deviation 1, the probe against the running app showed:

```
scan: REJECTED Error: Error invoking remote method 'ingestion:scan':
  { "expected": "object", "code": "invalid_type", "path": [],
    "message": "Invalid input: expected object, received undefined" }
```

`src/main/ipc/ingestion.ts:41` runs `ScanRequestSchema.parse(raw)` while `src/preload/index.ts:40` invokes with no argument, so the Bills screen's "Scan now" button can never succeed. It shipped green because no unit or e2e spec ever invokes `window.api.ingestion.scan()` — the e2e boundary spec only asserts the method's presence on `window.api`.

**Not fixed here, deliberately.** `src/main/ipc/ingestion.ts` is not in this plan's `files_modified` and the bug predates this plan, so touching it would be an out-of-scope edit to another phase's file. It is logged as item 2 in `deferred-items.md` with the exact one-character fix (`parse(raw ?? {})`), and raised as a blocker in STATE.md. **Recommend a `/gsd:quick` fix before the Phase 3 human gate**, since 03-07's parse-status surface sits on top of a working scan.

**Note for 03-07 and any future plan:** every payload-free IPC handler must parse `raw ?? {}`, never bare `raw`.

No other issues. The six Phase 3 libraries were already installed and pinned by 03-01; nothing was installed, bumped, or re-resolved here.

## Requirements Status

| Req | Text | Status | Evidence |
|-----|------|--------|----------|
| AI-01 | User enters an API key and base URL, stored securely | Complete | Settings writes both through `window.api.secrets.set`; `no-secret-leak` proves neither reaches secrets.enc plaintext, app.db, or logs |
| AI-02 | App fetches the model list and lets the user pick one | Complete | `listModels()` + the Settings picker; one `/models` call per Connect-and-test press |
| AI-03 | User cannot unknowingly select a text-only model | Complete | Three-state classification, Vision badges, and the `role="alertdialog"` use-anyway confirm on `unknown` |
| AI-04 | The selected model persists and is changeable | Complete | `setSelectedModel` UPSERT under `ai-model`; round-trip proven in unit tests AND on the running app via `settings:get` |

The live end-to-end check against a real endpoint (a real key populating a real model list) remains a **Manual-Only verification** at the end-of-phase human gate, per 03-VALIDATION row 3. Everything deterministic is covered by injected fakes.

## Known Stubs

None. No hardcoded empty arrays, placeholder text, or unwired components were introduced. The model picker renders only real `ModelInfo[]` returned by the endpoint, and the empty state is a genuine "no models match that search" condition rather than a placeholder.

## Threat Flags

None. Every security-relevant surface this plan added (the outbound HTTPS call to a user-chosen endpoint, the three ai IPC channels, and the key input) is already in the plan's `<threat_model>` as T-03-01, T-03-01b, or T-03-05, and all three are mitigated in code with specs behind them.

## User Setup Required

**One external service, deferred to the phase gate.** To exercise the live path the user needs an OpenAI-compatible API key and base URL (OpenAI at `https://api.openai.com/v1`, or OpenRouter at `https://openrouter.ai/api/v1`), obtained from the provider's dashboard and entered in Settings. No environment variables and no repo configuration; the credentials go straight into the OS keychain through the UI. Everything deterministic runs green without them.

## Next Phase Readiness

**03-05 (vision extraction) and 03-07 (pipeline integration) are unblocked by this plan specifically:**

- `buildClient()` is the single credential-reading entry point for every later model call; `extract-fields.ts` should take the built client as an injected dep rather than reading secrets itself.
- `getSelectedModel()` is how the pipeline learns which model to call, and `ModelInfo.supportedParameters` is already carried through, which is what D-25's structured-output fallback ladder needs to pre-check `structured_outputs` / `response_format` support.
- The `AI_CREDENTIALS_MISSING` / `AI_BASE_URL_INVALID` / `AI_BASE_URL_INSECURE` codes plus the fixed-copy mapping are the template for the parse channels' error surfaces.

**Concerns:**

1. **The `ingestion:scan` blocker above** should be fixed before the Phase 3 human gate, because 03-07's parse-status surface extends a scan result the user cannot currently produce.
2. **Payload-free handlers need `raw ?? {}`.** 03-07 owns `src/main/ipc/parse.ts`; both its handlers take real payloads, so it is only at risk if it adds a payload-free channel.

## Self-Check: PASSED

- All 9 declared files exist on disk (5 created, 4 modified).
- All 3 task commits exist in git: `302dc4d`, `50c767b`, `cbdbccb`.
- must_haves artifacts verified: `models.ts` exports `listModels` + `classifyVision`; `client.ts` exports `buildClient`; `ipc/ai.ts` exports `registerAiIpc`; `SettingsScreen.tsx` contains `testConnection`.
- key_links verified: `SettingsScreen.tsx` matches `window\.api\.ai\.testConnection`; `ipc/ai.ts` reaches the secret store via `buildClient` -> `secretStore.get` in `ai/client.ts`.
- Forbidden-file check: `git diff --stat 302dc4d^..HEAD` shows no change to `src/shared/ipc-contract.ts`, `src/shared/schemas.ts`, or `src/preload/index.ts`.
- `npx vitest run` — 12 files, 101 tests passed (27 in the two AI specs).
- `npm run typecheck` — clean.
- `npm run build` — main, preload, and renderer all built clean.
- `npx playwright test e2e/ipc-boundary.spec.ts` — passed against the running app.
- Logging grep over `src/main/ai/*.ts` and `src/main/ipc/ai.ts` — no `console.` or `logger` anywhere.
- Hardcoded-color grep over `SettingsScreen.tsx` — no matches for `#`, `rgb(`, or `hsl(`.
- Dash grep over `SettingsScreen.tsx` — no em or en dashes in user-facing copy.

---
*Phase: 03-ai-client-and-parse-pipeline*
*Completed: 2026-07-27*
