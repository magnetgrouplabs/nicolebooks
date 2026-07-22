---
phase: 01-foundation
plan: 06
subsystem: renderer-shell
tags: [electron, renderer, react, base-ui, brand-shell, os-theme-mirror, health-indicator, ipc-round-trip]

# Dependency graph
requires:
  - phase: 01-03
    provides: brand theme (globals.css light/dark palettes, local Jost/DM Sans fonts, base-nova shadcn primitives on @base-ui/react, cn helper)
  - phase: 01-05
    provides: live sender-validated Zod-gated IPC handlers for settings/secrets/theme, plus the nativeTheme theme:changed broadcast
provides:
  - "App.tsx reusable shell: CSS grid (56px header row, 280px sidebar column), header spanning both columns at z-index 20, swappable content region, tree wrapped in Base UI TooltipProvider"
  - "Header.tsx branded 56px bar: plain NicoleBooks wordmark (no logo, BRAND-02) and a neutral Not connected connection-status slot"
  - "Sidebar.tsx 280px nav (Bills/History/Settings) with violet active text plus a violet left-edge indicator bar, default Bills (D-09)"
  - "EmptyState.tsx centered heading plus body with optional icon"
  - "Bills/History/Settings placeholder screens rendering the locked UI-SPEC copy"
  - "HealthIndicator.tsx: the permanent SC2 plus SC4 proof performing a real renderer-to-IPC-to-main-to-keychain canary round trip and surfacing Secret store: OK / unavailable"
  - "main.tsx OS light/dark mirror: window.api.theme.get() toggles the dark class before first paint, then window.api.theme.onChange follows live OS changes (no FOUC)"
affects: [01-07 e2e specs assert against this real DOM, all Phase 2-8 renderer screens mount inside this shell]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Base UI TooltipProvider wraps the whole renderer tree so base-nova (@base-ui/react) tooltip primitives work"
    - "OS theme mirror awaits the async window.api.theme.get() IPC before the first React render, then subscribes to onChange; window stays hidden until ready-to-show, so there is no theme flash"
    - "Permanent health-indicator round trip: set then get a non-sensitive canary through window.api.secrets on mount, render OK only on an exact match, never render or log the secret value (T-01-05)"
    - "Renderer components use only semantic Tailwind classes bound to the brand tokens; zero hardcoded hex, structural radius 0 for header/sidebar"

key-files:
  created:
    - src/renderer/src/App.tsx
    - src/renderer/src/components/Header.tsx
    - src/renderer/src/components/Sidebar.tsx
    - src/renderer/src/components/EmptyState.tsx
    - src/renderer/src/components/HealthIndicator.tsx
    - src/renderer/src/screens/BillsScreen.tsx
    - src/renderer/src/screens/HistoryScreen.tsx
    - src/renderer/src/screens/SettingsScreen.tsx
  modified:
    - src/renderer/src/main.tsx

key-decisions:
  - "The shell wires against @base-ui/react (Base UI, confirmed by 01-03), and App.tsx wraps the tree in TooltipProvider from @/components/ui/tooltip so the base-nova tooltip primitive has its required provider even though Phase 1 renders no tooltip yet."
  - "The OS theme mirror awaits window.api.theme.get() (an async IPC call) and toggles document.documentElement.classList before createRoot, rather than painting light-first and correcting. Combined with the main window's show:false-until-ready posture from 01-01, this yields no FOUC."
  - "HealthIndicator is the permanent SC2 plus SC4 proof surface (D-11): on mount it stores then reads a canary through window.api.secrets and renders Secret store: OK only when the read returns the exact canary value; any thrown error or mismatch renders the unavailable state, and the raw secret is never rendered or logged."
  - "Every renderer component uses only semantic theme classes (text-primary, bg-secondary, text-success/text-destructive, hover:bg-primary/[0.06], focus-visible:ring-ring/[0.32]); no component hardcodes a hex value, and header/sidebar use structural radius 0."

requirements-completed: [BRAND-01, BRAND-02]

# Metrics
duration: 6min
completed: 2026-07-22
---

# Phase 1 Plan 06: Branded App Shell and Secret-Store Health Indicator Summary

**The user-visible Walking Skeleton: a branded two-process shell (56px header with the plain NicoleBooks wordmark and a neutral connection slot, a 280px Bills/History/Settings sidebar with violet active styling, a swappable content region), the three placeholder screens, an OS light/dark mirror with no flash, and a permanent Settings health indicator that proves the real renderer-to-IPC-to-main-to-keychain round trip by showing Secret store: OK.**

## Performance

- **Duration:** ~6 min
- **Started:** 2026-07-22T21:03:47Z
- **Completed:** 2026-07-22T21:09:02Z
- **Tasks:** 2
- **Files:** 8 created, 1 modified

## Accomplishments

- Authored `App.tsx`, the reusable app shell: a CSS grid with `grid-template-rows: 56px 1fr` and `grid-template-columns: 280px 1fr`, the `Header` spanning both columns at z-index 20, the `Sidebar` in the left column below the header, and a 24px-padded content region on the dominant surface that swaps the active screen. Active-destination state lives in `App` and defaults to Bills (D-09). The whole tree is wrapped in Base UI `TooltipProvider` so the base-nova tooltip primitive has its required provider.
- Authored `Header.tsx`: a full-width 56px bar (structural radius 0) on the secondary surface, with the plain `NicoleBooks` wordmark (Jost 20px 600, plain text, no image or logo per BRAND-02) on the left and the neutral connection-status slot (a filled muted-foreground `Circle` dot plus `Not connected` in a shadcn badge) on the right.
- Authored `Sidebar.tsx`: a fixed 280px nav with three items (`Receipt`/Bills, `History`/History, `Settings`/Settings), each min-height 40px with a 20px icon, a 14px label, a 12px gap and 12px padding. The active item gets violet text (`text-primary`), a violet left-edge indicator bar, and semibold weight; hover/pressed use the primary tint at 6% and 16% and focus uses the ring token at 32%, all via semantic classes at 150ms.
- Authored `EmptyState.tsx`: a centered heading (Jost 24px 600) over a supporting body (DM Sans 16px 400) with a 64px top offset and an optional lucide icon, taking heading and body as props.
- Authored the three placeholder screens (`BillsScreen`, `HistoryScreen`, `SettingsScreen`) rendering the verbatim UI-SPEC copy; Settings hosts the section label, the health indicator, and the muted later-update note.
- Authored `HealthIndicator.tsx`, the permanent SC2 plus SC4 proof: on mount it calls `window.api.secrets.set('canary','ok')` then `window.api.secrets.get('canary')` and renders `Secret store: OK` (ShieldCheck, success color) only when the read returns the canary; any error or mismatch renders `Secret store: unavailable` (ShieldAlert, destructive color) with the exact UI-SPEC error copy. The raw secret is never rendered or logged.
- Modified `main.tsx` to render `App`, apply `font-sans antialiased` on the render root, and mirror the OS color scheme: it awaits `window.api.theme.get()` and toggles the `dark` class before the first React render, then subscribes to `window.api.theme.onChange` to follow live OS changes (no FOUC, RESEARCH Pitfall 4).

## Contract Reference (for 01-07 e2e)

The real DOM the e2e specs can assert against:

| Surface | Selector hint | Rendered content |
|---------|---------------|------------------|
| Wordmark | header span, `font-heading` | literal text `NicoleBooks`, no img/svg logo |
| Connection slot | header badge | filled neutral dot + `Not connected` |
| Sidebar | `nav[aria-label="Primary"]`, 280px wide | three buttons `Bills`, `History`, `Settings`; active item has `aria-current="page"` and `text-primary` |
| Default screen | content region | Bills empty state heading `No bills to review` |
| Settings health (healthy) | Settings screen card | `Secret store: OK` after the live round trip |

The health indicator resolves its state from the live `window.api.secrets` round trip, so on a working machine the Settings screen shows `Secret store: OK`; when the OS keychain is unavailable the same surface shows `Secret store: unavailable` with the locked error copy.

## Task Commits

Each task was committed atomically:

1. **Task 1: App shell frame, header, sidebar, empty state, OS theme mirror** - `dc1b9bc` (feat)
2. **Task 2: placeholder screens and Secret store health-indicator round trip** - `0ec6f72` (feat)

**Plan metadata:** committed separately with SUMMARY, STATE, ROADMAP, REQUIREMENTS.

## Files Created/Modified

- `src/renderer/src/App.tsx` (created) - the CSS grid shell, active-destination state, content switch, TooltipProvider wrapper.
- `src/renderer/src/components/Header.tsx` (created) - branded 56px header: wordmark + neutral connection slot.
- `src/renderer/src/components/Sidebar.tsx` (created) - 280px nav with active violet text + left-edge bar.
- `src/renderer/src/components/EmptyState.tsx` (created) - centered heading + body with optional icon.
- `src/renderer/src/components/HealthIndicator.tsx` (created) - the permanent secret-store round-trip proof.
- `src/renderer/src/screens/{BillsScreen,HistoryScreen,SettingsScreen}.tsx` (created) - the three placeholder screens with locked copy.
- `src/renderer/src/main.tsx` (modified) - renders App, applies base typography, mirrors the OS dark class before first paint and on change.

## Decisions Made

- Wired the shell against `@base-ui/react` (Base UI, per the 01-03 carry-forward) and wrapped the tree in `TooltipProvider` so the base-nova tooltip primitive is usable in later phases, even though Phase 1 renders no tooltip.
- The theme mirror awaits the async `window.api.theme.get()` IPC before the first React render, rather than painting light-first and correcting; with the window hidden until ready-to-show, this avoids a theme flash.
- The health indicator resolves the healthy state only on an exact canary match from the live round trip, so a passing IPC boundary is a precondition for `Secret store: OK`.
- All colors come from semantic theme classes and header/sidebar use structural radius 0; no component hardcodes a hex value.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Task 1 App rendered inline branded placeholders so the shell built standalone before the Task 2 screens existed**
- **Found during:** Task 1
- **Issue:** `App.tsx` is a Task 1 file but the dedicated screen components (`BillsScreen`, `HistoryScreen`, `SettingsScreen`) are Task 2 deliverables. If Task 1's `App.tsx` imported those not-yet-created modules, the Task 1 `npm run build` verify would fail.
- **Fix:** Task 1 `App.tsx` rendered the branded content inline (EmptyState placeholders plus a settings note) so the shell built and ran standalone; Task 2 then created the dedicated screen components and rewired the `App` content switch to render them. Both commits build green.
- **Files modified:** src/renderer/src/App.tsx (created Task 1, rewired Task 2)
- **Verification:** `npm run build` and `tsc --build` exit 0 at both commits; no scope change, same rendered output.

**2. [Rule 2 - Missing state] HealthIndicator has a brief neutral checking micro-state**
- **Found during:** Task 2
- **Issue:** The secret round trip is an async IPC call, so the component needs an initial render state before the promise resolves; the locked Copywriting Contract enumerates only the healthy and unavailable states.
- **Fix:** Added a transient `checking` state that shows a muted neutral shield plus `Checking secret store` and, deliberately, no supporting line, so no non-contract status line is ever shown and a false `OK` can never render before the round trip resolves. The state collapses to `OK`/`unavailable` as soon as the IPC returns.
- **Files modified:** src/renderer/src/components/HealthIndicator.tsx
- **Verification:** the healthy branch renders only on an exact canary match; dash/hex scan clean; no personal names.

**Total deviations:** 2 auto-fixed. No architectural changes, no scope creep, no security impact.

## Threat Model Compliance

- **T-01-02 (Elevation of Privilege, renderer components):** every component reaches privilege only through named `window.api` methods; no Node, fs, db, or ipcRenderer access exists in the renderer.
- **T-01-05 (Information Disclosure, HealthIndicator):** only a non-sensitive `canary` flows through the round trip; the UI renders an ok/unavailable state and never the raw secret, and nothing is logged.
- **T-01-11 (Spoofing, branding):** the wordmark is the static product name `NicoleBooks` with no logo and no personal names.

## CLAUDE.md Hard-Rule Compliance

- Wordmark is the plain `NicoleBooks` text with no logo or image asset (BRAND-02 and the project rule).
- No owner, founder, or family-member personal names appear anywhere in the UI copy.
- No em or en dash characters appear in any authored file (verified by scan across all nine files).

## Verification Results

- `npm run build` (electron-vite) - exit 0 at both task commits (main, preload, renderer all built; fonts emitted).
- Task 1 assertion - `SHELL_OK` (Header contains `NicoleBooks`, no img/logo import; main references `window.api.theme`; App contains `280`; no dash chars).
- Task 2 assertion - `SCREENS_OK` (HealthIndicator calls `window.api.secrets.set` and `.get`; BillsScreen contains `No bills to review`; no dash chars).
- `npm run typecheck` (`tsc --build`) - exit 0.
- `npx vitest run` - 36 tests passed across 4 files (no regression from 01-02/01-04/01-05).
- Dash/hex scan across all nine authored files - `CLEAN_NO_DASH_NO_HEX`.

## Requirements

- **BRAND-01 (Magnet Group brand tokens: colors and typography):** completed. The branded window now renders with the tokens (Jost/DM Sans, light and dark palettes) in the user-visible shell, satisfying the requirement's observable criterion (deferred here from 01-03 per its note).
- **BRAND-02 (plain NicoleBooks wordmark, no logo):** completed. The header renders the literal `NicoleBooks` text with no image or logo asset.
- **PLAT-02 (secrets in OS keychain, never in repo or logs):** already completed in 01-05; this plan adds the permanent user-visible proof (the health indicator round trip) without re-opening it.

## Known Stubs

None that block the plan goal. The three screens are intentional Phase 1 placeholders (D-07 ships the frame only); the connection-status slot is a locked neutral `Not connected` placeholder that Phase 4 replaces with real QuickBooks health. Both are documented in the UI-SPEC as Phase 1 contract, not accidental stubs.

## Issues Encountered

None. Build, typecheck, and the full unit suite were green at each commit. The health indicator surfaces the round-trip result live; on this environment the Settings screen shows `Secret store: OK`.

## Next Phase Readiness

- 01-07 e2e specs can assert against the real DOM: the `NicoleBooks` wordmark (no logo), the 280px sidebar with three items and an `aria-current` active item, the Bills default empty state, and `Secret store: OK` on Settings after the live round trip. The interactive launch (`npm run dev`) renders the full branded shell.
- No blockers.

## User Setup Required

None. No external service configuration in this plan.

## Self-Check: PASSED

- All 8 created files plus the modified `main.tsx` verified present on disk - all FOUND.
- Both task commits verified in git history: `dc1b9bc`, `0ec6f72` - both FOUND.
- No file deletions across the two commits; only the pre-existing `.planning/config.json` modification (not authored here) remains unstaged.

---
*Phase: 01-foundation*
*Completed: 2026-07-22*
