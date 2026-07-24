---
phase: 3
slug: ai-client-and-parse-pipeline
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-07-24
---

# Phase 3 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.
> Derived from 03-RESEARCH.md "Validation Architecture". Per-task `Plan`/`Task`/`Wave` cells are TBD until the planner defines task IDs; the requirement -> behavior -> command mapping below is authoritative now.

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

> Requirement -> behavior -> automated command, seeded from 03-RESEARCH.md. `Plan`/`Task`/`Wave` are assigned when the planner writes the plans; every plan should open with a Wave-0 RED task that creates the listed spec, turned GREEN by the implementation task.

| Req / Decision | Behavior proven | Threat Ref | Test Type | Automated Command | File Exists | Plan/Task/Wave | Status |
|----------------|-----------------|------------|-----------|-------------------|-------------|----------------|--------|
| PARSE-04 / D-10 | money -> integer cents ('1,234.10'->123410; '5.00'->500; float never used) | V5 | unit | `npx vitest run test/parse-validate.test.ts` | ❌ W0 | TBD | ⬜ pending |
| PARSE-04 / D-10 | dates normalize to ISO; unparseable date -> flagged, not thrown | V5 | unit | `npx vitest run test/parse-validate.test.ts` | ❌ W0 | TBD | ⬜ pending |
| PARSE-04 / D-10/D-12 | `subtotal+tax=total` checked ONLY when both present, within ~2c tolerance; null operand -> not-applicable (no flag) | — | unit | `npx vitest run test/parse-validate.test.ts` | ❌ W0 | TBD | ⬜ pending |
| PARSE-04 / D-11/D-12 | per-field confidence: verbatim-grounded field -> high; failed arithmetic -> flagged even at high model self-confidence | Prompt-injection | unit | `npx vitest run test/parse-confidence.test.ts` | ❌ W0 | TBD | ⬜ pending |
| PARSE-01/02 / D-20 | native-vs-scan gate: text-PDF fixture -> native; invisible-OCR-overlay fixture -> image-only; bitmap-heavy -> image-only | V12 | unit | `npx vitest run test/parse-route.test.ts` | ❌ W0 | TBD | ⬜ pending |
| PARSE-02 / D-07 | HEIC decode runs before sharp; sideways EXIF photo auto-oriented; downscaled to long-edge | DoS (bomb guard) | unit | `npx vitest run test/parse-prep-image.test.ts` | ❌ W0 | TBD | ⬜ pending |
| PARSE-02 / D-19 | image-only PDF page renders to a bitmap via pdfjs + @napi-rs/canvas | V12 | unit (fixture) | `npx vitest run test/parse-route.test.ts` | ❌ W0 | TBD | ⬜ pending |
| PARSE-03 / D-23 | vision call builds text-before-image content; only vendor+total required; fake client schema-valid object -> Zod passes | Prompt-injection | unit (fake client) | `npx vitest run test/parse-extract.test.ts` | ❌ W0 | TBD | ⬜ pending |
| PARSE-03 / D-25 | structured-output fallback ladder + one repair retry; still-invalid -> flag-and-keep | V5 | unit (fake client) | `npx vitest run test/parse-extract.test.ts` | ❌ W0 | TBD | ⬜ pending |
| PARSE-05 / D-14 | cache-hit-no-recall: second parse of same hash returns cached row; injected client NEVER called | — | unit (temp DB + spy client) | `npx vitest run test/parse-cache.test.ts` | ❌ W0 | TBD | ⬜ pending |
| PARSE-05 / D-24 | `migration0003` creates `parsed_results` STRICT with documented columns; runner reaches user_version 3 | Tampering (SQLi) | unit (temp DB) | `npx vitest run test/migrate.test.ts` (extend) | ⚠ extend | TBD | ⬜ pending |
| D-22 | second-pass agreement runs on image-only docs only; numeric mismatch -> low-confidence flag; native PDFs skip it | — | unit (fake client) | `npx vitest run test/parse-confidence.test.ts` | ❌ W0 | TBD | ⬜ pending |
| AI-03 / D-01/D-02 | vision classification: OpenRouter `input_modalities:['image']`->vision; OpenAI minimal shape->curated fallback; unknown->unbadged (confirm gate) | — | unit | `npx vitest run test/ai-models.test.ts` | ❌ W0 | TBD | ⬜ pending |
| D-15 | batch parse: one file throws -> that file marked failed, others still parsed; `parsing N/M` progress counts correct | DoS (blast-radius) | unit (fake client, one throwing file) | `npx vitest run test/parse-pipeline.test.ts` | ❌ W0 | TBD | ⬜ pending |
| AI-01 / D-05 | API key + baseURL stored via secret-store (never SQLite, never renderer); no-secret-leak extends to the AI-key canary | V6 / V8 | unit | `npx vitest run test/no-secret-leak.test.ts` (extend) | ⚠ extend | TBD | ⬜ pending |
| AI-02/AI-04 | model list fetched via `models.list()`; selected model id persisted in `app_settings` (non-secret) and changeable | — | unit (fake client) | `npx vitest run test/ai-models.test.ts` | ❌ W0 | TBD | ⬜ pending |
| D-16 / D-26 | new ai/parse IPC handlers assertTrustedSender first, then Zod-parse payload; channels are stable strings | V4 / V5 | unit + e2e | `npx playwright test e2e/ipc-boundary.spec.ts` (extend) | ⚠ extend | TBD | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

New scaffolds are created by the first (RED) task of the plan that owns each behavior:

- [ ] `test/fixtures/` — text-PDF, invisible-OCR-overlay PDF, image-only PDF, sideways-EXIF JPEG, small HEIC sample (committed fixtures for the route + prep tests)
- [ ] `test/parse-validate.test.ts` — cents, dates, arithmetic tolerance (PARSE-04 / D-10)
- [ ] `test/parse-confidence.test.ts` — deterministic-weighted confidence + second-pass agreement (D-11/D-12/D-22)
- [ ] `test/parse-route.test.ts` — Docling-style native-vs-scan gate + image-only-PDF render (D-20/D-19)
- [ ] `test/parse-prep-image.test.ts` — HEIC-before-sharp + EXIF auto-orient + downscale (PARSE-02/D-07)
- [ ] `test/parse-extract.test.ts` — text-before-image content shape + strict-schema/fallback + Zod re-validate (PARSE-03/D-23/D-25)
- [ ] `test/parse-cache.test.ts` — cache-hit-no-recall proof (PARSE-05/D-14)
- [ ] `test/parse-pipeline.test.ts` — per-file isolation + `parsing N/M` progress (D-15)
- [ ] `test/ai-models.test.ts` — vision classification metadata-first + curated fallback + model persist (AI-02/03/04/D-02)
- [ ] Shared fake `OpenAIClientLike` test double (records calls; canned schema-valid / throwing responses)
- [ ] Extend `test/migrate.test.ts` (parsed_results table + user_version 3), `test/no-secret-leak.test.ts` (AI-key canary), `test/ipc-contract.test.ts` + `e2e/ipc-boundary.spec.ts` (new ai/parse channels)
- [ ] Framework install: none — Vitest + Playwright already present
- [ ] Dependency install: `openai unpdf pdfjs-dist sharp heic-convert @napi-rs/canvas` (D-19)

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Live end-to-end parse against a real endpoint | AI-02, PARSE-03 | Requires a user-supplied OpenAI-compatible key (per CLAUDE.md); cannot run in CI. Deterministic layers are fully covered by injected-fake unit tests. | With a real key + base URL entered in Settings: Connect/Test shows "AI connection: OK" and populates the model picker; pick a vision model; drop one native PDF + one photo; confirm both parse, fields populate, cache hit on re-scan (no re-charge). Fold into the phase human-verify gate (`human_verify_mode: end-of-phase`). |
| Real native-vs-scan threshold tuning (A2) | PARSE-01/02, D-20 | The 0.75 bitmap / 0.90 invisible / 50-char thresholds are research starting values, not verified optima; confirm against real vendor bills | On real bills: verify born-digital invoices route `native` and photographed/scanned receipts route `image-only`; adjust thresholds via the committed fixtures if a real bill mis-routes. Owned by the routing plan. |
| Settings AI-config + Bills parse-status (visual/interaction) | AI-01..04, D-18 | `human_verify_mode: end-of-phase` — visual/interaction checks run at the phase human gate | Launch app; confirm AI-config section renders on Settings (preset dropdown, key field, Connect/Test, model picker with vision badges, "use anyway" confirm on an unbadged model); run a scan; confirm the Bills parse-status surface shows per-file parsed/failed/cached + a `parsing N/M` indicator. |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies *(finalize when planner assigns task IDs)*
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < ~5s (unit tier)
- [ ] `nyquist_compliant: true` set in frontmatter *(set once per-task map has real task IDs)*

**Approval:** draft — requirement->test map derived from 03-RESEARCH.md; per-task IDs pending planner output.
