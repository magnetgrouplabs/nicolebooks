---
phase: 3
slug: ai-client-and-parse-pipeline
status: planned
nyquist_compliant: true
wave_0_complete: true
created: 2026-07-24
updated: 2026-07-27
---

# Phase 3 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.
> Derived from 03-RESEARCH.md "Validation Architecture"; per-task Plan/Wave cells synced to the 7 committed plans (03-01..03-07). Each plan opens with a Wave-0 RED test task; the implementation task turns it GREEN.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest 4.1.10 (unit, `environment: 'node'`) + Playwright 1.61.1 (`_electron` e2e) — both already installed |
| **Config file** | `vitest.config.ts` (`include: ['test/**/*.test.ts']`, `passWithNoTests: true`), `playwright.config.ts` (`testDir: './e2e'`) |
| **Quick run command** | `npx vitest run test/parse-*.test.ts test/ai-*.test.ts` |
| **Full suite command** | `npm test` (`vitest run && playwright test`) |
| **Estimated runtime** | ~seconds (unit); e2e adds Electron launch time |

**Design-for-testability principle (from research):** every `ai/` and `parse/` module takes its side-effecting dependencies as injected params with real defaults, mirroring the Phase 2 `ScanDeps` pattern. A shared fake `OpenAIClientLike` test double (records calls, returns canned schema-valid or throwing responses) drives the whole pipeline with no Electron and no network. Live model calls need a user-supplied key and are covered by the manual gate below, not by CI.

---

## Sampling Rate

- **After every task commit:** Run the touched spec, e.g. `npx vitest run test/parse-validate.test.ts` (< 30s)
- **After every plan wave:** Run `npx vitest run` (all unit)
- **Before `/gsd:verify-work`:** `npm test` green (unit + Playwright), plus the manual live-parse smoke (user-supplied key)
- **Max feedback latency:** ~a few seconds for the unit tier

---

## Per-Task Verification Map

> Plan/Wave synced to the committed plans. Each listed spec is created by the owning plan's Wave-0 RED task and turned GREEN by its implementation task.

| Req / Decision | Behavior proven | Threat Ref | Test Type | Automated Command | File | Plan / Wave | Status |
|----------------|-----------------|------------|-----------|-------------------|------|-------------|--------|
| PARSE-04 / D-10 | money -> integer cents ('1,234.10'->123410; '5.00'->500; float never used) | V5 | unit | `npx vitest run test/parse-validate.test.ts` | ✅ exists | 03-03 / W2 | ✅ green |
| PARSE-04 / D-10 | dates normalize to ISO; unparseable date -> flagged, not thrown | V5 | unit | `npx vitest run test/parse-validate.test.ts` | ✅ exists | 03-03 / W2 | ✅ green |
| PARSE-04 / D-10/D-12 | `subtotal+tax=total` checked ONLY when both present, within ~2c tolerance; null operand -> not-applicable (no flag) | — | unit | `npx vitest run test/parse-validate.test.ts` | ✅ exists | 03-03 / W2 | ✅ green |
| PARSE-04 / D-11/D-12 | per-field confidence: verbatim-grounded field -> high; failed arithmetic -> flagged even at high model self-confidence | Prompt-injection | unit | `npx vitest run test/parse-confidence.test.ts` | ✅ exists | 03-03 / W2 | ✅ green |
| PARSE-01/02 / D-20 | native-vs-scan gate: text-PDF fixture -> native; invisible-OCR-overlay fixture -> image-only; bitmap-heavy -> image-only | V12 | unit | `npx vitest run test/parse-route.test.ts` | ✅ exists | 03-04 / W2 | ✅ green (rungs driven by injected synthetic signals; real `image-only.pdf` covers the end-to-end case) |
| PARSE-02 / D-07 | HEIC decode runs before sharp; sideways EXIF photo auto-oriented; downscaled to long-edge | DoS (bomb guard) | unit | `npx vitest run test/parse-prep-image.test.ts` | ✅ exists | 03-04 / W2 | ✅ green |
| PARSE-02 / D-19 | image-only PDF page renders to a bitmap via pdfjs + @napi-rs/canvas (never fed to sharp) | V12 | unit + e2e-pipeline | `npx vitest run test/parse-route.test.ts test/parse-pipeline.test.ts` | ✅ exists | 03-04 / W2 + 03-07 / W3 | ✅ green (03-07 drives the REAL image-only.pdf end to end through parseBatch with no document collaborators injected: it returns 'parsed', a real JPEG (ffd8ff) reaches the wire, and the injected prepImage is booby-trapped to throw if it is ever reached) |
| PARSE-03 / D-23 | vision call builds text-before-image content; only vendor+total required; fake client schema-valid object -> Zod passes | Prompt-injection | unit (fake client) | `npx vitest run test/parse-extract.test.ts` | ✅ exists | 03-05 / W2 | ✅ green |
| PARSE-03 / D-25 | structured-output fallback ladder + one repair retry; still-invalid -> flag-and-keep | V5 | unit (fake client) | `npx vitest run test/parse-extract.test.ts` | ✅ exists | 03-05 / W2 | ✅ green (all three rungs driven by an injected fake that rejects each `response_format`; the ladder is also proven NOT to descend on a 401 or a connection error) |
| PARSE-05 / D-14 | cache-hit-no-recall: second parse of same hash returns cached row; injected client NEVER called | — | unit (temp DB + spy client) | `npx vitest run test/parse-cache.test.ts` | ✅ exists | 03-06 / W2 + 03-07 / W3 | ✅ green (03-07: a seeded row comes back 'cached' with BOTH the client and the byte reader booby-trapped, so `client.neverCalled()` proves the lookup precedes any read; plus the stale-schema_version re-parse, the D-14 force override, and a mixed batch that makes exactly one paid call) |
| PARSE-05 / D-24 | `migration0003` creates `parsed_results` STRICT (21 cols incl. `truncated`); runner reaches user_version 3 | Tampering (SQLi) | unit (temp DB) | `npx vitest run test/migrate.test.ts` (extend) | ✅ extended | 03-06 / W2 | ✅ green (also proves a real user_version-2 DB upgrades forward to 3 with its Phase 1/2 data intact, and that every value is bound not interpolated) |
| D-21 | over-10-page PDF sets `truncated`; round-trips through the cache (0/1 <-> boolean) | — | unit | `npx vitest run test/parse-cache.test.ts test/parse-pipeline.test.ts` | ✅ exists | 03-06 / W2 + 03-07 / W3 | ✅ green (03-07 caps BOTH pdf branches before rendering — a 14-page native and a 12-page image-only each render only [0,1,2,n-2,n-1] — and the flag round-trips through migration0003) |
| D-22 | second-pass agreement runs on image-only docs only; numeric mismatch -> low-confidence flag; native PDFs skip it | — | unit (fake client) | `npx vitest run test/parse-confidence.test.ts test/parse-pipeline.test.ts` | ✅ exists | 03-03 / W2 + 03-07 / W3 | ✅ green (03-07: an image-only doc makes 2 calls at temperature 0 and a native PDF makes 1; a disputed total yields `agreement:totalCents` AND `confidence.totalCents === 'low'`, which is what proves the flags were merged BEFORE computeConfidence rather than after) |
| AI-03 / D-01/D-02 | vision classification: OpenRouter `input_modalities:['image']`->vision; OpenAI minimal shape->curated fallback; unknown->unbadged (confirm gate) | — | unit | `npx vitest run test/ai-models.test.ts` | ✅ exists | 03-02 / W2 | ✅ green |
| D-15 | batch parse: one file throws -> that file marked failed, others still parsed; `parsing N/M` progress counts correct | DoS (blast-radius) | unit (fake client, one throwing file) | `npx vitest run test/parse-pipeline.test.ts` | ✅ exists | 03-07 / W3 | ✅ green (the fake rejects only the request carrying file two's bytes: [parsed, parse-failed, parsed] with a reason that leaks no stack; progress emits 1/3 2/3 3/3 in order, and a throwing listener cannot abort the batch) |
| AI-01 / D-05 | API key + baseURL stored via secret-store (never SQLite, never renderer); no-secret-leak extends to the AI-key canary | V6 / V8 | unit | `npx vitest run test/no-secret-leak.test.ts` (extend) | ✅ extended | 03-02 / W2 | ✅ green |
| AI-02/AI-04 | model list fetched via `models.list()`; selected model id persisted in `app_settings` (non-secret) and changeable | — | unit (fake client) | `npx vitest run test/ai-models.test.ts` | ✅ exists | 03-02 / W2 | ✅ green |
| D-16 / D-26 | new ai/parse IPC handlers assertTrustedSender first, then Zod-parse payload; channels are stable strings | V4 / V5 | unit + e2e | `npx playwright test e2e/ipc-boundary.spec.ts` | ✅ extended | 03-01 / W1 + 03-02 / W2 + 03-07 / W3 | ✅ green (03-07 took the e2e past a bridge-shape assertion: `parse:parse-batch` is actually INVOKED from the renderer and must resolve, the 64-char hash bound must actually reject on both parse channels, and onProgress must actually return a disposer — the coverage class quick task 260727-fb9 established) |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

New scaffolds are created by the first (RED) task of the plan that owns each behavior:

- [x] `test/fixtures/` — image-only PDF + sideways-EXIF JPEG committed with a provenance README (03-04). The text-PDF, invisible-OCR-overlay PDF and HEIC samples were dropped deliberately: the D-20 rungs are driven by injected synthetic per-page signals (hand-authoring a 0.91-invisible-glyph PDF proves nothing extra and makes the thresholds untunable) and the HEIC ordering is proven by an injected `convert` double. See `test/fixtures/README.md`.
- [x] `test/parse-validate.test.ts` — cents, dates, arithmetic tolerance (03-03 / PARSE-04)
- [x] `test/parse-confidence.test.ts` — deterministic-weighted confidence + second-pass agreement (03-03 / D-11/D-12/D-22)
- [x] `test/parse-route.test.ts` — Docling-style native-vs-scan gate + image-only-PDF render (03-04 / D-20/D-19)
- [x] `test/parse-prep-image.test.ts` — HEIC-before-sharp + EXIF auto-orient + downscale (03-04 / PARSE-02/D-07)
- [x] `test/parse-extract.test.ts` — text-before-image content shape + strict-schema/fallback + Zod re-validate (03-05 / PARSE-03/D-23/D-25). 40 tests; also covers the D-21 page cap applied inside `extractFields`.
- [x] `test/parse-cache.test.ts` — storage layer green (03-06): full round trip, absent-hash miss, JSON blobs, integer cents, the `truncated` 0/1 <-> boolean round trip, hash-alone upsert across a model switch, `schema_version` forced re-parse, host-only base URL, and bound-never-interpolated proofs. Exports `makeRow`/`FIELDS`/`HASH_A`/`HASH_B` so 03-07 appends the pipeline cache-hit-no-recall describe block rather than rewriting the file.
- [x] `test/parse-pipeline.test.ts` — per-file isolation + `parsing N/M` progress + real image-only.pdf end-to-end (03-07 / D-15/D-07). 28 tests; also covers the D-21 cap on both pdf branches, the D-06 text pairing, the inbox-containment guard, and the pre-decode HEIC pixel budget.
- [x] `test/ai-models.test.ts` — vision classification metadata-first + curated fallback + model persist, plus the buildClient https/credential guards (03-02 / AI-02/03/04/D-02/T-03-05)
- [x] Shared fake `OpenAIClientLike` test double (03-01 / records calls; canned schema-valid / throwing responses) — its `.calls` recording is what underwrites the PARSE-05 no-recall proof.
- [x] Extend `test/migrate.test.ts` (✅ done 03-06: parsed_results + user_version 3 + the 2->3 upgrade path), `test/no-secret-leak.test.ts` (✅ done 03-02: AI-key canary), `test/ipc-contract.test.ts` (✅ done 03-01: every channel string pinned) + `e2e/ipc-boundary.spec.ts` (✅ done 03-07: the parse channels invoked, not merely shaped)
- [x] Framework install: none — Vitest + Playwright already present
- [x] Dependency install (03-01): `openai@6.48.0 unpdf@1.6.2 pdfjs-dist@6.1.200 sharp@0.35.3 heic-convert@2.1.0 @napi-rs/canvas@1.0.2` (D-19; versions honor CLAUDE.md pins)

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Live end-to-end parse against a real endpoint | AI-02, PARSE-03 | Requires a user-supplied OpenAI-compatible key (per CLAUDE.md); cannot run in CI. Deterministic layers are fully covered by injected-fake unit tests. | With a real key + base URL entered in Settings: Connect/Test shows "AI connection: OK" and populates the model picker; pick a vision model; drop one native PDF + one photo; confirm both parse, fields populate, cache hit on re-scan (no re-charge). Fold into the phase human-verify gate (`human_verify_mode: end-of-phase`). |
| Real native-vs-scan threshold tuning (A2) | PARSE-01/02, D-20 | The 0.75 bitmap / 0.90 invisible / 50-char thresholds are research starting values, not verified optima; confirm against real vendor bills | On real bills: verify born-digital invoices route `native` and photographed/scanned receipts route `image-only`; adjust thresholds via the committed fixtures if a real bill mis-routes. Owned by the routing plan (03-04). |
| Settings AI-config + Bills parse-status (visual/interaction) | AI-01..04, D-18 | `human_verify_mode: end-of-phase` — visual/interaction checks run at the phase human gate | Launch app; confirm AI-config section renders on Settings (preset dropdown, key field, Connect/Test, model picker with vision badges, "use anyway" confirm on an unbadged model); run a scan; confirm the Bills parse-status surface shows per-file parsed/failed/cached + a `parsing N/M` indicator. |

---

## Validation Sign-Off

- [x] All tasks have `<automated>` verify or Wave 0 dependencies (each plan opens with a Wave-0 RED task)
- [x] Sampling continuity: no 3 consecutive tasks without automated verify
- [x] Wave 0 covers all MISSING references
- [x] No watch-mode flags
- [x] Feedback latency < ~5s (unit tier)
- [x] `nyquist_compliant: true` set in frontmatter

**Approval:** planned 2026-07-24 — requirement->test map synced to plans 03-01..03-07; per-task rows flip to ✅ as execute-phase turns each spec green. `wave_0_complete` flips true once the Wave-0 RED specs exist on disk.
