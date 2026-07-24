---
phase: 2
slug: ingestion-and-dedupe
status: planned
nyquist_compliant: true
wave_0_complete: false
created: 2026-07-24
updated: 2026-07-24
---

# Phase 2 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.
> Derived from 02-RESEARCH.md "Validation Architecture". Per-task rows filled after planning defined task IDs.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest 4.1.10 (unit, `environment: 'node'`) + Playwright 1.61.1 (`_electron` e2e) — both already installed |
| **Config file** | `vitest.config.ts` (`include: ['test/**/*.test.ts']`), `playwright.config.ts` (`testDir: './e2e'`) |
| **Quick run command** | `npm run test:unit` (`vitest run`) |
| **Full suite command** | `npm test` (`vitest run && playwright test`) |
| **Estimated runtime** | ~seconds (unit); e2e adds Electron launch time |

**Design-for-testability principle (from research):** keep risky logic in pure, injectable functions that take a directory path and an explicit `platform` argument, so macOS and Windows branches are exercised on a single CI OS without a real cloud provider. Inject a `stat`-like function and a fake attribute-reader so placeholders are simulated deterministically.

---

## Sampling Rate

- **After every task commit:** Run the task's targeted `npx vitest run test/<spec>.test.ts` (the ingestion unit specs)
- **After every plan wave:** Run `npm test` (unit + Playwright e2e, including the extended IPC-boundary spec)
- **Before `/gsd:verify-work`:** Full suite must be green, plus the manual real-provider placeholder probe (cross-OS human gate)
- **Max feedback latency:** ~a few seconds for the unit tier

---

## Per-Task Verification Map

> Task IDs are `{plan}-{task}`. Plan 02-01 (Wave 1) = walking scan slice; 02-02 (Wave 2) = duplicate catch; 02-03 (Wave 3) = not-ready/materialization skip.
> Every plan opens with a Wave-0 "failing tests (RED)" task; the implementation task turns it GREEN.

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 02-01-1 | 02-01 | 1 | ING-05 / D-12 / D-13 | — | Extension accept-set; junk ignored; unsupported surfaced | unit | `npx vitest run test/ingestion-filetype.test.ts` | ❌ W0 (task 02-01-1) | ⬜ pending |
| 02-01-1 | 02-01 | 1 | ING-04 / D-07 | V6 | Known bytes → known SHA-256; streaming over a large temp file | unit | `npx vitest run test/ingestion-hash.test.ts` | ❌ W0 (task 02-01-1) | ⬜ pending |
| 02-01-1 | 02-01 | 1 | ING-02 | V4 | resolveInbox creates + persists default; chooseInbox persists chosen path | unit (temp DB) | `npx vitest run test/ingestion-inbox.test.ts` | ❌ W0 (task 02-01-1) | ⬜ pending |
| 02-01-1 | 02-01 | 1 | ING-01 / D-05 / D-04 | — | Scan stamps `batchEntryDate` = local day; supported load; unsupported skipped; inbox read-only (count+mtimes unchanged) | unit | `npx vitest run test/ingestion-scan.test.ts` | ❌ W0 (task 02-01-1) | ⬜ pending |
| 02-01-3 | 02-01 | 1 | D-15 / SC4 | V1 / V5 | `ingestion:scan` rejects untrusted sender; Zod rejects malformed payload; channels stable strings; ingestion group exposed | unit + e2e | `npx playwright test e2e/ipc-boundary.spec.ts` | ✅ extend (task 02-01-1/3) | ⬜ pending |
| 02-02-1 | 02-02 | 2 | ING-04 / D-08 / D-09 | V5 | Ledger hit → `duplicate-excluded` (+posted date); miss → `loaded`; pending reloads; SQL-metachar safe | unit (temp DB) | `npx vitest run test/ingestion-ledger.test.ts` | ❌ W0 (task 02-02-1) | ⬜ pending |
| 02-02-1 | 02-02 | 2 | D-10 | — | Two byte-identical files in one batch → one `loaded`, one `duplicate-in-batch`; precedence excluded>in-batch | unit | `npx vitest run test/ingestion-scan.test.ts` | ❌ W0 (task 02-02-1) | ⬜ pending |
| 02-03-1 | 02-03 | 3 | ING-03 / D-11 (placeholder) | V12 | Simulated online-only (blocks 0 / offline attr / .icloud) → `not-ready-skipped`, never hashed; inconclusive→load | unit (injected stat/attr) | `npx vitest run test/ingestion-materialization.test.ts` | ❌ W0 (task 02-03-1) | ⬜ pending |
| 02-03-1 | 02-03 | 3 | ING-03 / D-11 (partial write) | V12 | Growing file never settles until writing stops | integration (real fs) | `npx vitest run test/ingestion-materialization.test.ts` | ❌ W0 (task 02-03-1) | ⬜ pending |
| 02-03-1 | 02-03 | 3 | ING-03 / D-11 (bytes-last) | T-02-08/09 | not-ready file never invokes the hash fn; Windows attr read via execFile args array, shell:false | unit | `npx vitest run test/ingestion-scan.test.ts` | ❌ W0 (task 02-03-1) | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

Wave-0 test scaffolds are created by the first (RED) task of each plan, aligned to the plan that owns the behavior:

- [ ] `test/ingestion-filetype.test.ts` — ING-05, D-12, D-13 (created in 02-01 task 1)
- [ ] `test/ingestion-hash.test.ts` — ING-04 known-vector + large-file streaming (created in 02-01 task 1)
- [ ] `test/ingestion-inbox.test.ts` — ING-02 resolve/choose/persist (created in 02-01 task 1)
- [ ] `test/ingestion-scan.test.ts` — D-05 date, D-04 read-only, supported/unsupported (created in 02-01 task 1; extended in 02-02 task 1 for D-10 collapse + ledger dedupe; extended in 02-03 task 1 for not-ready)
- [ ] `test/ingestion-ledger.test.ts` — ING-04, D-08/D-09 temp better-sqlite3 DB, migration0002 (created in 02-02 task 1)
- [ ] `test/ingestion-materialization.test.ts` — D-11 placeholder (injected stat/attr) + partial-write (real fs) + inconclusive fallback (created in 02-03 task 1)
- [ ] Extend `test/ipc-contract.test.ts` (Channels stable-string) + `test/migrate.test.ts` (D-15 table-set) — 02-01 task 1
- [ ] Extend `e2e/ipc-boundary.*` — the new `ingestion` channels under the sender/Zod gate (02-01 task 3)
- [ ] Framework install: none — Vitest + Playwright already present

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Real cloud-placeholder detection thresholds (A1/A2) | ING-03 / D-11 | Real OneDrive/iCloud placeholder behavior cannot be produced on a single CI OS; the exact `blocks` value / attribute integer must be observed on the actual deployment machines | On a real Mac: right-click "Remove Download" on a test file in iCloud Drive, log `fs.statSync().blocks`. On real Windows: set a test file to "Free up space" in OneDrive, log the attribute integer. Confirm the scan flags it `not-ready-skipped` and never downloads it. Fold into the existing 01-08 cross-OS human-verify gate. Owned by plan 02-03. |
| Bills-screen scan flow (visual/interaction) | ING-01, ING-02, D-14 | `human_verify_mode: end-of-phase` — visual/interaction checks run at the phase human gate, not as a blocking checkpoint | Launch app, confirm default inbox path shows; drop a PDF + a .docx; Scan now; confirm PDF loads with today's date and .docx is under the unsupported-skipped summary; confirm duplicate + not-ready flags render as described in 02-02/02-03. |

---

## Validation Sign-Off

- [x] All tasks have `<automated>` verify or Wave 0 dependencies
- [x] Sampling continuity: no 3 consecutive tasks without automated verify
- [x] Wave 0 covers all MISSING references
- [x] No watch-mode flags
- [x] Feedback latency < ~5s (unit tier)
- [x] `nyquist_compliant: true` set in frontmatter

**Approval:** planned — task IDs mapped to 02-01 / 02-02 / 02-03.
