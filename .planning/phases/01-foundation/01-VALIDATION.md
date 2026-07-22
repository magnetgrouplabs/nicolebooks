---
phase: 1
slug: foundation
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-07-22
---

# Phase 1 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution. Derived from 01-RESEARCH.md "Validation Architecture" (Vitest for main-process units, Playwright `_electron` for launch/IPC/DB end-to-end). Proves the four Phase 1 Success Criteria.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest (unit, main-process logic) + Playwright `_electron` (end-to-end launch / IPC / DB round-trip) |
| **Config file** | none yet — Wave 0 creates `vitest.config.ts` and `playwright.config.ts` |
| **Quick run command** | `npx vitest run` |
| **Full suite command** | `npx vitest run && npx playwright test` |
| **Estimated runtime** | ~30-60 seconds (units fast; e2e launch dominates) |

---

## Sampling Rate

- **After every task commit:** Run `npx vitest run` (fast main-process units: migration runner, secret-store with mocked safeStorage, Zod schemas)
- **After every plan wave:** Run `npx vitest run && npx playwright test` (adds the Electron launch / round-trip e2e)
- **Before `/gsd:verify-work`:** Full suite must be green on BOTH Windows and Mac (the cross-OS run is the load-bearing gate for PLAT-01)
- **Max feedback latency:** ~60 seconds

---

## Per-Task Verification Map

> The planner expands this table so every task maps to a Success Criterion, a threat reference, and an automated command. Rows below are the SC-level coverage from research; the planner refines to task granularity.

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| SC1-launch | TBD | TBD | BRAND-01/02, PLAT-01 | — | Branded window renders wordmark + sidebar (Bills/History/Settings), no logo | e2e | `npx playwright test e2e/launch.spec.ts` | ❌ W0 | ⬜ pending |
| SC1-theme | TBD | TBD | BRAND-01 | — | Window follows OS color scheme (light/dark class applied) | e2e + unit | `npx playwright test e2e/theme.spec.ts` | ❌ W0 | ⬜ pending |
| SC2-roundtrip | TBD | TBD | PLAT-02 | T-secret-store | Store + retrieve canary secret via keychain; ciphertext in `secrets.enc` | e2e + unit | `npx vitest run test/secret-store.test.ts` | ❌ W0 | ⬜ pending |
| SC2-noleak | TBD | TBD | PLAT-02 | T-secret-leak | No secret material in `app.db` or logs | unit/e2e | `npx vitest run test/no-secret-leak.test.ts` | ❌ W0 | ⬜ pending |
| SC3-persist | TBD | TBD | PLAT-01 | — | Write app_settings, restart, read back same value | e2e (relaunch) | `npx playwright test e2e/persistence.spec.ts` | ❌ W0 | ⬜ pending |
| SC3-migrate | TBD | TBD | PLAT-01 | T-sql-injection | Fresh DB `user_version` 0->1; app_settings exists; idempotent | unit | `npx vitest run test/migrate.test.ts` | ❌ W0 | ⬜ pending |
| SC4-ipc | TBD | TBD | PLAT-01 | T-ipc-tamper, T-preload-exposure | Renderer has no fs/db/keychain/net; only `window.api`; Zod rejects malformed payloads | unit + e2e | `npx vitest run test/ipc-contract.test.ts` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

Greenfield repo — no test infrastructure exists. Wave 0 must create it:

- [ ] `npm install -D vitest @playwright/test` — install both runners
- [ ] `vitest.config.ts` — unit runner for main-process modules
- [ ] `playwright.config.ts` + `e2e/` — Electron `_electron.launch` harness pointing at the built main entry
- [ ] `test/migrate.test.ts` — covers SC3 migration idempotency
- [ ] `test/secret-store.test.ts` — covers SC2 with a mocked `safeStorage`
- [ ] `test/no-secret-leak.test.ts` — asserts DB file and logs contain no secret material
- [ ] `test/ipc-contract.test.ts` — Zod schema accept/reject cases for every channel
- [ ] `e2e/launch.spec.ts`, `theme.spec.ts`, `secret-roundtrip.spec.ts`, `persistence.spec.ts`, `ipc-boundary.spec.ts`
- [ ] CI workflow (matrix windows + macos) that installs, runs `electron-rebuild`, and executes both suites

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Keychain round-trip on a real Mac | PLAT-02 | GitHub macOS runners provide a Keychain, but a locked/absent login keychain is the realistic "unavailable" case; confirm on Anthony's real Mac at least once | Launch app on Mac, open Settings, confirm "Secret store: OK"; lock/remove login keychain and confirm graceful "unavailable" copy |
| Native `better-sqlite3` rebuild success on both OSes | PLAT-01 | Prebuild availability for Electron 43 is unverified (RESEARCH Open Question 1); local Windows lacks MSVC and has Python 3.14, so source-compile is a real branch | Run `electron-rebuild` on Windows and Mac; app must query the DB without `NODE_MODULE_VERSION` error |
| Visual brand fidelity vs UI-SPEC | BRAND-01/02 | Pixel/color/typography fidelity to the Magnet Group tokens is a human visual judgment | Launch on both OSes, compare header/sidebar/empty-states against 01-UI-SPEC.md in light and dark |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 60s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
