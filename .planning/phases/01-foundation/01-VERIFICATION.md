---
phase: 01-foundation
verified: 2026-07-23T18:14:07Z
status: human_needed
score: 4/4 success criteria met in code (all 4 requirements met in code; PLAT-01 real-machine half deferred to 01-08 human UAT)
overrides_applied: 0
verdict: GOAL MET (code), pending human UAT sign-off
re_verification:
  previous_status: none
  note: Initial verification. No prior VERIFICATION.md existed.
human_verification:
  - test: "better-sqlite3 native rebuild and load on a real Mac"
    expected: "From a clean clone, `npm ci` then `npx electron-rebuild -f -w better-sqlite3` exits 0 with no NODE_MODULE_VERSION error; app queries the DB. Record whether a prebuild was downloaded or a source compile ran (run `xcode-select --install` first if a source compile is triggered). Then `npm run build && npx vitest run && npx playwright test` all green."
    why_human: "Prebuild availability for Electron 43 on macOS arm64 is unverified (RESEARCH Open Question 1); CI proves the automatable leg but Anthony's real Mac toolchain is the load-bearing confirmation. Needs a real Mac."
  - test: "Keychain OK path AND locked/absent-keychain unavailable path on a real Mac"
    expected: "`npm run dev`, open Settings, confirm the HealthIndicator reads `Secret store: OK` with the supporting line. Then lock or temporarily remove the login keychain, relaunch, and confirm the app renders the exact `Secret store: unavailable` copy from the UI-SPEC gracefully (no crash, no stack trace)."
    why_human: "GitHub macOS runners provide a Keychain, but a locked/absent login keychain (the realistic unavailable case) cannot be reproduced in CI. Needs a real Mac; re-confirm the OK path on real Windows."
  - test: "Visual brand fidelity vs 01-UI-SPEC.md in light AND dark on both a real Mac and a real Windows machine"
    expected: "In OS light and OS dark, compare the header (NicoleBooks wordmark, no logo), the 280px sidebar (Bills/History/Settings, active violet text plus left-edge bar), and the Bills/History empty states against 01-UI-SPEC.md. Foreground reads #343434 in light, the dark palette matches, and there is no theme flash on launch."
    why_human: "Pixel/color/typography fidelity to the Magnet Group tokens is a human visual judgment. Needs a real Mac and a real Windows machine, light and dark."
---

# Phase 1: Foundation Verification Report

**Phase Goal:** The app launches on both Windows and Mac as a branded two-process shell with a strict IPC trust boundary, local SQLite persistence, and OS-keychain secret storage in place.

**Verified:** 2026-07-23T18:14:07Z
**Status:** human_needed
**Overall Verdict:** **GOAL MET (code), pending human UAT sign-off.** Every phase-goal capability is present as substantive, correctly-wired source and is proven green by automated tests on Windows. The phase is NOT declared fully complete: the three real-machine checks (01-08) remain open by explicit user decision.
**Re-verification:** No — initial verification.

---

## Goal Achievement

### Observable Truths (Success Criteria)

| # | Truth (SC) | Status | Evidence |
|---|-----------|--------|----------|
| 1 | User can launch NicoleBooks on both OSes and see a branded window (Magnet Group colors + typography, plain "NicoleBooks" wordmark, no logo) | VERIFIED (code); visual fidelity in both palettes on both OSes pending 01-08 | `src/renderer/src/components/Header.tsx:18-20` renders literal `NicoleBooks` (Jost 20px 600) with no `img`/`svg`/logo import. `src/renderer/src/globals.css` carries `:root` (fg `#343434`, primary `#6c00ff`) and `.dark` (bg `#1a1a1a`, fg `#f0f0f0`, ring `#8f33ff`) palettes plus four local `@font-face` woff2. `src/renderer/src/main.tsx:27-38` mirrors OS scheme before first paint. `e2e/theme.spec.ts` + `e2e/launch.spec.ts` green on Windows (01-07-SUMMARY). Build emits all four fonts + `index-*.css` (39.10 kB). |
| 2 | App stores/retrieves a secret from the OS keychain; no secret ever written to SQLite, a plaintext file, or logs | VERIFIED (code, Windows/DPAPI-proven); real-Mac Keychain + locked-keychain path pending 01-08 | `src/main/secrets/secret-store.ts` uses `safeStorage.encryptString` → base64 ciphertext to `secrets.enc` (mode 0o600), imports no SQLite driver. `src/main/ipc/secrets.ts` delegates only to `secretStore`, graceful-null when unavailable, never logs values. `src/renderer/src/components/HealthIndicator.tsx` performs the live canary round trip. `e2e/secret-roundtrip.spec.ts` asserts ciphertext-only in `secrets.enc` and plaintext absent from `app.db`; `test/no-secret-leak.test.ts` + `test/secret-store.test.ts` green (in the 36-test run). |
| 3 | App creates its local SQLite DB on first run and applies schema migrations, so data survives a restart | VERIFIED (code); Mac native-rebuild confirmation pending 01-08 (PLAT-01) | `src/main/db/connection.ts` opens `userData/app.db` (WAL) and migrates on first access; `src/main/db/migrate.ts` is a forward-only `PRAGMA user_version` ratchet in one transaction; `src/main/db/migrations/0001_init.ts` creates `app_settings STRICT`. `src/main/index.ts:57-58` runs `getDatabase()`+`migrate(db)` before the window. `e2e/persistence.spec.ts` (relaunch durability) + `test/migrate.test.ts` (idempotency) green on Windows. |
| 4 | Renderer performs no direct fs/db/keychain/network access; every such action routes through the typed IPC boundary | VERIFIED (code) — OS-agnostic | Hardened window `src/main/index.ts:18-24` (contextIsolation, sandbox, nodeIntegration:false, webSecurity). `src/preload/index.ts` exposes ONLY named `settings`/`secrets`/`theme` methods, never `ipcRenderer`/`invoke`. Every handler calls `assertTrustedSender(event)` then `Schema.parse(raw)` (`src/main/ipc/{settings,secrets,theme}.ts`). `e2e/ipc-boundary.spec.ts` asserts `window.require/process/module/ipcRenderer` all undefined, `window.api` exposes exactly the three groups, and an over-long payload rejects at the Zod gate. Green on Windows. |

**Score:** 4/4 success criteria met in code. Visual-fidelity (SC1), real-Mac keychain incl. locked path (SC2), and Mac native rebuild (SC3, via PLAT-01) are confirmed-in-code and deferred to 01-08 human UAT.

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `src/main/index.ts` | Hardened single BrowserWindow + ready-time ordering | VERIFIED | contextIsolation/sandbox/nodeIntegration:false/webSecurity; single-instance lock; window-open deny; will-navigate preventDefault; DB+migrate before window, registerIpc after. |
| `src/preload/index.ts` | Sandbox-safe named-method contextBridge | VERIFIED | Exposes only `settings/secrets/theme`; imports only electron built-ins + dependency-free contract. Built artifact 1.49 kB emits `require("electron")` (01-07 externalize fix confirmed by build output). |
| `src/shared/ipc-contract.ts` + `schemas.ts` | Single-source channel constants + Zod bounds | VERIFIED | 7 channel constants; SettingsSet/Key + SecretSet/Key schemas with 1-128 key / 4096 (settings) / 8192 (secret) value bounds. |
| `src/main/ipc/trusted-sender.ts` | Frame-origin sender gate | VERIFIED | Rejects missing/unparseable frame URL; accepts `file:` (packaged) or exact `ELECTRON_RENDERER_URL` origin (dev). Imported by all three handler groups. |
| `src/main/ipc/{settings,secrets,theme,register}.ts` | Zod-gated, sender-validated handlers + aggregator | VERIFIED | Prepared-statement UPSERT (settings); safeStorage delegation (secrets); nativeTheme get + broadcast (theme); `registerIpc()` wires all three, called from `index.ts`. |
| `src/main/db/{connection,migrate}.ts` + `migrations/0001_init.ts` | SQLite + forward-only migrations | VERIFIED | See SC3. `app_settings STRICT` only; no feature tables (D-15). |
| `src/main/secrets/secret-store.ts` | safeStorage secret store | VERIFIED | See SC2. No SQLite coupling; 0o600; throws `SECRET_STORE_UNAVAILABLE` when encryption unavailable. |
| `src/renderer/src/globals.css` + brand tokens/fonts | Brand theme, light+dark palettes, local fonts | VERIFIED | `:root` + `.dark` palettes with canonical hex; four `@font-face` woff2; no CDN. `tokens.json` vendored byte-identical (01-03). |
| `src/renderer/src/{App,components,screens}.tsx` | Branded shell, 3 screens, health indicator | VERIFIED | 280px sidebar (violet active + left bar, `aria-current`), 56px header, swappable content, HealthIndicator, three placeholder screens with verbatim UI-SPEC copy. |
| `e2e/*.spec.ts` (5) | Launch, theme, secret-roundtrip, persistence, ipc-boundary | VERIFIED (exist + substantive; green on Windows per 01-07) | All five present with real assertions against the running build. Re-run of Playwright skipped per verification scope; cited 01-07-SUMMARY. |
| `.github/workflows/ci.yml` | Cross-OS matrix | VERIFIED | `os: [windows-latest, macos-latest]`, explicit `electron-rebuild` step, `vitest`, `playwright`; no embedded token/secret (`contents: read`). |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|----|--------|---------|
| Renderer `window.api` | Preload bridge | `contextBridge.exposeInMainWorld('api', api)` | WIRED | Named methods only; `env.d.ts` augments `Window` from the preload-exported `Api`. |
| Preload | Main handlers | `ipcRenderer.invoke(Channels.*)` → `ipcMain.handle(Channels.*)` | WIRED | Both sides import the same `Channels` constants; every handler validates sender + Zod-parses. |
| Settings handler | SQLite | `getDatabase()` prepared UPSERT/SELECT | WIRED | `app_settings` round-trips; `e2e/persistence.spec.ts` proves durability. |
| Secrets handler | OS keychain | `secretStore` → `safeStorage` → `secrets.enc` | WIRED | `e2e/secret-roundtrip.spec.ts` proves ciphertext-only, no plaintext in `app.db`. |
| Main `nativeTheme` | Renderer | `theme:changed` broadcast + `window.api.theme.onChange` | WIRED | `main.tsx` toggles `.dark` before first paint and subscribes to live changes. |
| Main bootstrap | IPC registration | `registerIpc()` after `whenReady()` + window | WIRED | `src/main/index.ts:65`. |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
|----------|---------------|--------|--------------------|--------|
| `HealthIndicator.tsx` | `state` (ok/unavailable) | live `window.api.secrets.set`/`get` canary round trip → main → safeStorage | Yes (real keychain round trip; `ok` only on exact byte-match read-back) | FLOWING |
| `SettingsScreen` / `App` | active screen + health | real component state; no hardcoded empty props at call sites | Yes | FLOWING |
| `main.tsx` theme | `isDark` | `await window.api.theme.get()` → `nativeTheme.shouldUseDarkColors` | Yes (real OS preference) | FLOWING |

Note: Bills/History screens render intentional Phase 1 empty states (D-07 ships the frame only) with verbatim UI-SPEC copy — documented contract, not hollow data.

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| Project builds (3 artifacts) | `npm run build` | exit 0; `out/main` (9.64 kB), `out/preload` (1.49 kB), `out/renderer` (fonts + 39.10 kB css) emitted | PASS |
| Unit suite green | `npx vitest run` | `Test Files 4 passed (4)`, `Tests 36 passed (36)`, exit 0 | PASS |
| Typecheck clean | `npm run typecheck` (`tsc --build`) | exit 0 | PASS |
| Preload externalizes electron (01-07 fix) | build output inspection | preload 1.49 kB (down from 3.26 kB); emits `require("electron")` | PASS |
| Playwright e2e (5 specs) | `npx playwright test` | Skipped locally per verification scope; green on Windows per 01-07-SUMMARY (launch, theme, secret-roundtrip, persistence, ipc-boundary) | CITED / deferred cross-OS to 01-08 |

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|-------------|-------------|--------|----------|
| BRAND-01 | 01-03, 01-06 | Magnet Group brand tokens (colors + typography) | MET (code); visual fidelity pending 01-08 | `globals.css` palettes + local Jost/DM Sans; shell consumes semantic classes; marked complete 01-06. |
| BRAND-02 | 01-06 | Plain "NicoleBooks" wordmark, no logo | MET (code) | `Header.tsx` renders literal text, zero image/logo asset. |
| PLAT-01 | 01-01, 04, 05, 07 | App runs on both Windows and Mac | MET-PENDING-HUMAN-UAT (see reconciliation) | Automatable half verified (Windows native rebuild + launch + full suite green; CI matrix authored for both OSes). Real-machine Mac half deferred to 01-08. |
| PLAT-02 | 01-04, 05, 07 | Secrets in OS keychain, never in repo or logs | MET (code, Windows-proven); real-Mac keychain pending 01-08 | safeStorage store + Zod-gated handlers + e2e no-leak proof green on Windows (DPAPI). |

### PLAT-01 Reconciliation (explicit)

The SUMMARY frontmatter is **inconsistent** on PLAT-01:
- 01-01, 01-02, 01-07 correctly treat PLAT-01 as **advanced, NOT completed** (deferred to the cross-OS gate).
- 01-04 and 01-05 frontmatter **prematurely list `requirements-completed: [PLAT-01, PLAT-02]`**. The code those plans delivered (SQLite persistence, IPC handlers) is genuinely complete and OS-neutral, but marking the full cross-OS requirement closed at that point was premature.

**Reconciled status — PLAT-01 is split:**
- **VERIFIED (automatable half):** the Windows native `better-sqlite3` rebuild against the Electron 43 ABI is proven (prebuild, no source compile); the cross-OS CI matrix is authored for `windows-latest` + `macos-latest` with an explicit `electron-rebuild` step; the full Vitest + Playwright suite is observed green on Windows.
- **DEFERRED to 01-08 human UAT (real-machine half):** the Mac native rebuild and load, the locked/absent-keychain "unavailable" path, and visual brand fidelity in both palettes on both OSes. Per 01-07-SUMMARY "Honest Execution Scope," the macOS CI leg was **authored, not executed** on this Windows machine.

The authoritative status is therefore **MET-PENDING-HUMAN-UAT**, not "complete." The 01-04/01-05 "complete" markings should be read as advanced-not-closed.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| (none) | - | No `TODO`/`FIXME`/`XXX`/`HACK` debt markers in any `src/` file | - | Clean. The five "placeholder" matches are code comments describing the intentional Phase 1 placeholder screens (D-07 ships the frame only) and the "Not connected" slot (Phase 4 replaces) — documented contract, not accidental stubs. |

No blockers. No orphaned artifacts. No hollow data flows. No embedded secrets in CI (`ci.yml` references no token; comment explicitly notes packaging/signing tokens arrive in Phase 8).

### Disconfirmation Pass (Confirmation Bias Counter)

1. **Partially-met requirement:** PLAT-01 — the cross-OS claim rests on Windows-observed + Mac-authored-but-unexecuted. This is genuinely partial, which is exactly why 01-08 exists; the partial part is deferred by explicit user decision, not a defect.
2. **Test that passes but does not fully test the stated behavior:** the macOS CI matrix leg has never actually run (01-07 ran on Windows only). It is honestly disclosed in 01-07-SUMMARY and routed to 01-08 — no dishonest pass.
3. **Error path with limited coverage:** the real locked/absent-keychain "unavailable" branch. The code path IS unit-covered (`test/secret-store.test.ts` exercises the `SECRET_STORE_UNAVAILABLE` guard with a mocked safeStorage, and handlers return null when unavailable), but the true locked-hardware case is only confirmable on a real Mac — deferred to 01-08.

None of the three rise to a defect; all are the deliberately-deferred real-machine scope.

### Human Verification Required

The three real-machine checks below are the 01-08 `checkpoint:human-verify` gate, deferred to human UAT by explicit user decision. They are NOT failures — they need a **real Mac + real Windows machine, light and dark**. Actionable by `/gsd:audit-uat`:

1. **Mac native `better-sqlite3` rebuild** — From a clean clone: `npm ci`, then `npx electron-rebuild -f -w better-sqlite3` (run `xcode-select --install` first if a source compile triggers). Expect exit 0, no `NODE_MODULE_VERSION` error; record prebuild-vs-source-compile. Then `npm run build && npx vitest run && npx playwright test` all green. (Needs a real Mac.)

2. **Keychain OK + locked/absent unavailable path** — `npm run dev`, open Settings, confirm `Secret store: OK` with its supporting line. Then lock/remove the login keychain, relaunch, and confirm the exact `Secret store: unavailable` UI-SPEC copy renders gracefully (no crash, no stack trace). (Needs a real Mac; re-confirm OK path on real Windows.)

3. **Visual brand fidelity vs 01-UI-SPEC.md in light + dark on both OSes** — Compare the header (NicoleBooks wordmark, no logo), 280px sidebar (Bills/History/Settings, active violet text + left-edge bar), and Bills/History empty states. Confirm foreground `#343434` in light, the dark palette matches, and no theme flash on launch. (Needs a real Mac and a real Windows machine, both palettes.)

### Gaps Summary

**No gaps blocking goal achievement.** All four success criteria and all four requirements are satisfied in substantive, correctly-wired committed code, and are proven green on Windows by the automated build (exit 0), the 36-test Vitest suite (exit 0), the typecheck (exit 0), and the five Playwright e2e specs (green on Windows per 01-07). No real defects were found in the committed code.

The phase goal is **MET in code**. The phase is **not declared fully complete** only because the three real-machine confirmations (native rebuild on Mac, locked-keychain path, visual fidelity on both OSes in both palettes) are the 01-08 human-verify gate, which the user has explicitly chosen to keep open for UAT. Status is therefore `human_needed`, not `passed` and not `gaps_found`.

---

_Verified: 2026-07-23T18:14:07Z_
_Verifier: Claude (gsd-verifier)_
