---
phase: 2
slug: ingestion-and-dedupe
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-07-24
---

# Phase 2 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.
> Derived from 02-RESEARCH.md "Validation Architecture". Per-task rows are filled once plans define task IDs.

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

- **After every task commit:** Run `npm run test:unit` (the ingestion unit specs)
- **After every plan wave:** Run `npm test` (unit + Playwright e2e, including the extended IPC-boundary spec)
- **Before `/gsd:verify-work`:** Full suite must be green, plus the manual real-provider placeholder probe (cross-OS human gate)
- **Max feedback latency:** ~a few seconds for the unit tier

---

## Per-Task Verification Map

> Filled during planning/execution once plan task IDs exist. Requirement→behavior→test-type mapping is already pinned by research (below); the executor maps each task to the row it satisfies.

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 02-XX-XX | XX | 0/1 | ING-05 / D-12 / D-13 | — | Extension accept-set; junk ignored; unsupported surfaced | unit | `vitest run test/ingestion-filetype.test.ts` | ❌ W0 | ⬜ pending |
| 02-XX-XX | XX | 1 | ING-04 / D-07 | V6 | Known bytes → known SHA-256; streaming over a large temp file | unit | `vitest run test/ingestion-hash.test.ts` | ❌ W0 | ⬜ pending |
| 02-XX-XX | XX | 1 | ING-04 / D-08 / D-09 | V5 | Ledger hit → `duplicate-excluded` (+posted date); miss → `loaded`; pending reloads | unit (temp DB) | `vitest run test/ingestion-ledger.test.ts` | ❌ W0 | ⬜ pending |
| 02-XX-XX | XX | 1 | D-10 | — | Two byte-identical files in one batch → one `loaded`, one `duplicate-in-batch` | unit | `vitest run test/ingestion-scan.test.ts` | ❌ W0 | ⬜ pending |
| 02-XX-XX | XX | 1 | ING-03 / D-11 (placeholder) | V12 | Simulated online-only (blocks 0 / offline attr / .icloud) → `not-ready-skipped`, never hashed | unit (injected stat/attr) | `vitest run test/ingestion-materialization.test.ts` | ❌ W0 | ⬜ pending |
| 02-XX-XX | XX | 1 | ING-03 / D-11 (partial write) | V12 | Growing file never settles until writing stops | integration (real fs) | `vitest run test/ingestion-materialization.test.ts` | ❌ W0 | ⬜ pending |
| 02-XX-XX | XX | 1 | ING-01 / D-05 | — | Scan stamps `batchEntryDate` = local day; supported files load | unit + e2e | `vitest run test/ingestion-scan.test.ts` | ❌ W0 | ⬜ pending |
| 02-XX-XX | XX | 1 | ING-02 | V4 | resolveInbox creates + persists default; chooseInbox persists chosen path | unit (temp DB) + e2e | `vitest run test/ingestion-inbox.test.ts` | ❌ W0 | ⬜ pending |
| 02-XX-XX | XX | 1 | D-15 / SC4 | V1 / V5 | `ingestion:scan` rejects untrusted sender; Zod rejects malformed payload; channels stable strings | unit + e2e | `npm run test:e2e` (extend `e2e/ipc-boundary`) | ✅ extend | ⬜ pending |
| 02-XX-XX | XX | 1 | D-04 | — | Inbox read-only: file count + mtimes unchanged after a scan | integration | `vitest run test/ingestion-scan.test.ts` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `test/ingestion-filetype.test.ts` — ING-05, D-12, D-13
- [ ] `test/ingestion-hash.test.ts` — ING-04 (known-vector + large-file streaming)
- [ ] `test/ingestion-ledger.test.ts` — ING-04, D-08/D-09 (temp better-sqlite3 DB, `migration0002`)
- [ ] `test/ingestion-materialization.test.ts` — D-11 placeholder (injected stat/attr) + partial-write (real fs)
- [ ] `test/ingestion-scan.test.ts` — D-10 collapse, D-05 date stamp, D-04 read-only invariant
- [ ] `test/ingestion-inbox.test.ts` — ING-02 resolve/choose/persist
- [ ] Extend `e2e/ipc-boundary.*` — the new `ingestion` channels under the sender/Zod gate
- [ ] Framework install: none — Vitest + Playwright already present

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Real cloud-placeholder detection thresholds (A1/A2) | ING-03 / D-11 | Real OneDrive/iCloud placeholder behavior cannot be produced on a single CI OS; the exact `blocks` value / attribute integer must be observed on the actual deployment machines | On a real Mac: right-click "Remove Download" on a test file in iCloud Drive, log `fs.statSync().blocks`. On real Windows: set a test file to "Free up space" in OneDrive, log the attribute integer. Confirm the scan flags it `not-ready-skipped` and never downloads it. Fold into the existing 01-08 cross-OS human-verify gate. |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < ~5s (unit tier)
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
