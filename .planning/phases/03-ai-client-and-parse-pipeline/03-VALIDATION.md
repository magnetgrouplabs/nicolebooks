---
phase: 3
slug: ai-client-and-parse-pipeline
status: planned
nyquist_compliant: true
wave_0_complete: false
created: 2026-07-24
updated: 2026-07-24
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
| PARSE-02 / D-19 | image-only PDF page renders to a bitmap via pdfjs + @napi-rs/canvas (never fed to sharp) | V12 | unit + e2e-pipeline | `npx vitest run test/parse-route.test.ts test/parse-pipeline.test.ts` | ⚠ half exists | 03-04 / W2 + 03-07 / W3 | ⬜ pending (03-04 half ✅ green: real JPEG render + "sharp rejects PDF bytes"; awaits 03-07 wiring the route into the pipeline) |
| PARSE-03 / D-23 | vision call builds text-before-image content; only vendor+total required; fake client schema-valid object -> Zod passes | Prompt-injection | unit (fake client) | `npx vitest run test/parse-extract.test.ts` | ❌ W0 | 03-05 / W2 | ⬜ pending |
| PARSE-03 / D-25 | structured-output fallback ladder + one repair retry; still-invalid -> flag-and-keep | V5 | unit (fake client) | `npx vitest run test/parse-extract.test.ts` | ❌ W0 | 03-05 / W2 | ⬜ pending |
| PARSE-05 / D-14 | cache-hit-no-recall: second parse of same hash returns cached row; injected client NEVER called | — | unit (temp DB + spy client) | `npx vitest run test/parse-cache.test.ts` | ❌ W0 | 03-06 / W2 + 03-07 / W3 | ⬜ pending |
| PARSE-05 / D-24 | `migration0003` creates `parsed_results` STRICT (21 cols incl. `truncated`); runner reaches user_version 3 | Tampering (SQLi) | unit (temp DB) | `npx vitest run test/migrate.test.ts` (extend) | ⚠ extend | 03-06 / W2 | ⬜ pending |
| D-21 | over-10-page PDF sets `truncated`; round-trips through the cache (0/1 <-> boolean) | — | unit | `npx vitest run test/parse-cache.test.ts test/parse-pipeline.test.ts` | ❌ W0 | 03-06 / W2 + 03-07 / W3 | ⬜ pending |
| D-22 | second-pass agreement runs on image-only docs only; numeric mismatch -> low-confidence flag; native PDFs skip it | — | unit (fake client) | `npx vitest run test/parse-confidence.test.ts test/parse-pipeline.test.ts` | ⚠ half exists | 03-03 / W2 + 03-07 / W3 | ⬜ pending (03-03 `agreementFlags` half ✅ green; awaits 03-07 wiring the second call and merging the flags) |
| AI-03 / D-01/D-02 | vision classification: OpenRouter `input_modalities:['image']`->vision; OpenAI minimal shape->curated fallback; unknown->unbadged (confirm gate) | — | unit | `npx vitest run test/ai-models.test.ts` | ✅ exists | 03-02 / W2 | ✅ green |
| D-15 | batch parse: one file throws -> that file marked failed, others still parsed; `parsing N/M` progress counts correct | DoS (blast-radius) | unit (fake client, one throwing file) | `npx vitest run test/parse-pipeline.test.ts` | ❌ W0 | 03-07 / W3 | ⬜ pending |
| AI-01 / D-05 | API key + baseURL stored via secret-store (never SQLite, never renderer); no-secret-leak extends to the AI-key canary | V6 / V8 | unit | `npx vitest run test/no-secret-leak.test.ts` (extend) | ✅ extended | 03-02 / W2 | ✅ green |
| AI-02/AI-04 | model list fetched via `models.list()`; selected model id persisted in `app_settings` (non-secret) and changeable | — | unit (fake client) | `npx vitest run test/ai-models.test.ts` | ✅ exists | 03-02 / W2 | ✅ green |
| D-16 / D-26 | new ai/parse IPC handlers assertTrustedSender first, then Zod-parse payload; channels are stable strings | V4 / V5 | unit + e2e | `npx playwright test e2e/ipc-boundary.spec.ts` (extend) | ⚠ extend | 03-01 / W1 + 03-02 / W2 + 03-07 / W3 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

New scaffolds are created by the first (RED) task of the plan that owns each behavior:

- [x] `test/fixtures/` — image-only PDF + sideways-EXIF JPEG committed with a provenance README (03-04). The text-PDF, invisible-OCR-overlay PDF and HEIC samples were dropped deliberately: the D-20 rungs are driven by injected synthetic per-page signals (hand-authoring a 0.91-invisible-glyph PDF proves nothing extra and makes the thresholds untunable) and the HEIC ordering is proven by an injected `convert` double. See `test/fixtures/README.md`.
- [x] `test/parse-validate.test.ts` — cents, dates, arithmetic tolerance (03-03 / PARSE-04)
- [x] `test/parse-confidence.test.ts` — deterministic-weighted confidence + second-pass agreement (03-03 / D-11/D-12/D-22)
- [x] `test/parse-route.test.ts` — Docling-style native-vs-scan gate + image-only-PDF render (03-04 / D-20/D-19)
- [x] `test/parse-prep-image.test.ts` — HEIC-before-sharp + EXIF auto-orient + downscale (03-04 / PARSE-02/D-07)
- [ ] `test/parse-extract.test.ts` — text-before-image content shape + strict-schema/fallback + Zod re-validate (03-05 / PARSE-03/D-23/D-25)
- [ ] `test/parse-cache.test.ts` — cache-hit-no-recall proof + truncated round-trip (03-06 storage; extended in 03-07 for the pipeline no-recall case)
- [ ] `test/parse-pipeline.test.ts` — per-file isolation + `parsing N/M` progress + real image-only.pdf end-to-end (03-07 / D-15/D-07)
- [x] `test/ai-models.test.ts` — vision classification metadata-first + curated fallback + model persist, plus the buildClient https/credential guards (03-02 / AI-02/03/04/D-02/T-03-05)
- [ ] Shared fake `OpenAIClientLike` test double (03-01 / records calls; canned schema-valid / throwing responses)
- [ ] Extend `test/migrate.test.ts` (parsed_results table + user_version 3), `test/no-secret-leak.test.ts` (AI-key canary), `test/ipc-contract.test.ts` + `e2e/ipc-boundary.spec.ts` (new ai/parse channels)
- [ ] Framework install: none — Vitest + Playwright already present
- [ ] Dependency install (03-01): `openai@6.48.0 unpdf@1.6.2 pdfjs-dist@6.1.200 sharp@0.35.3 heic-convert@2.1.0 @napi-rs/canvas@1.0.2` (D-19; versions honor CLAUDE.md pins)

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
