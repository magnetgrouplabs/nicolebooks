# Phase 1: Foundation - Context

**Gathered:** 2026-07-22
**Status:** Ready for planning

<domain>
## Phase Boundary

Phase 1 delivers the desktop-app skeleton: a branded, cross-platform Electron shell that launches on Windows and Mac, with the security and persistence spine in place. Concretely, this phase builds the two-process shell, a strict main/renderer IPC trust boundary, local SQLite persistence with a migration mechanism, and OS-keychain secret storage. It ships no product features. It creates the integration points (theme, IPC boundary, DB layer, secret store) that Phases 2 through 8 plug into.

Requirements in scope: BRAND-01, BRAND-02, PLAT-01, PLAT-02.

</domain>

<decisions>
## Implementation Decisions

### Brand and Theming
- **D-01:** Canonical brand source is the Magnet Group W3C design-token file `tokens.json` (v2026.06.1, self-described "source of truth for brand and platform UI"). Its values are rendered into the app's Tailwind v4 `@theme`. The live website's `globals.css` is a secondary cross-check, not the source.
- **D-02:** Vendor a copy of `tokens.json` into the NicoleBooks repo during Phase 1 as the build-time source of truth (for example under a `design/` or `src/renderer/brand/` location). Do NOT reference the sibling `themagnetgroup` repo at build time: it will not exist on Anthony's Mac, on a clean machine, or in CI.
- **D-03:** Wire both light and dark palettes. The window follows the OS color-scheme preference (Electron `nativeTheme` plus `prefers-color-scheme`). No in-app theme toggle in v1.
- **D-04:** Fonts (Jost for headings, DM Sans for body) are bundled with the app and served locally. They are never fetched from Google's CDN, because this is an offline desktop tool.
- **D-05:** Foreground text color normalizes to `#343434` (the TMG logo dark), per `tokens.json`, rather than the website's `#1d1d1f`.
- **D-06:** Plain "NicoleBooks" wordmark, no logo (BRAND-02, restated). The token file's semantic colors (success, warning, info) and chart colors are carried into the theme now for reuse by later phases (confidence flags in Phase 6, and so on), even though nothing consumes them in Phase 1.

### App Shell
- **D-07:** Phase 1 renders a real, reusable app frame, not a proof-of-life splash: a persistent branded header plus persistent left navigation, with a swappable content region.
- **D-08:** The header carries the "NicoleBooks" wordmark and a connection-status slot. The slot shows a neutral placeholder in Phase 1 and is later populated by QuickBooks connection health (Phase 4).
- **D-09:** Navigation is a labeled left sidebar (280px width, structural radius 0 per `tokens.json`), icon plus text, with three destinations: Bills, History, Settings. Each renders a placeholder empty-state screen in Phase 1; later phases fill them (Bills: Phases 2/6/7, History: Phase 7, Settings: Phases 3/4).

### Secret Storage
- **D-10:** Build a keychain service backed by Electron `safeStorage`, exposed to the renderer through a typed `secrets` IPC channel (set / get / delete). This is the locked stack choice (not keytar, not electron-store).
- **D-11:** Prove the round-trip end-to-end in Phase 1 by storing and reading back a non-sensitive canary value through the real renderer to IPC to main to keychain path, surfaced as a permanent "Secret store: OK / unavailable" health indicator on the Settings screen. This is permanent, not throwaway, and it doubles as the Success-Criteria-4 IPC-boundary proof.
- **D-12:** The `safeStorage` ciphertext blob is persisted in a dedicated app-data file under the OS userData directory (for example `secrets.enc`). No secret material, not even OS-encrypted ciphertext, is ever written to the SQLite database. This satisfies Success Criteria 2 ("no secret in the SQLite database") literally and keeps audits unambiguous for a financial tool.

### Local Persistence (SQLite)
- **D-13:** Phase 1 establishes the migration mechanism plus only the minimal schema it needs: a schema-version table and a small non-secret `app_settings` key-value table (the natural home for last-scanned-folder path, window size and position, and similar non-secret preferences).
- **D-14:** The "data survives a restart" criterion (SC3) is demonstrated by writing to and reading back from `app_settings` across an app restart.
- **D-15:** Feature tables (dedupe hashes, parsed-results cache, sent-transaction ledger, audit log) are NOT created in Phase 1. Each is added by its owning phase via that phase's own migration, when the column shape is actually understood. This avoids designing Phase 7's audit schema before Phase 7 exists.

### Claude's Discretion
These were offered for discussion but Anthony chose to lock context instead. Standard approaches are expected; research and planning may decide:
- Migration engine mechanics: default to forward-only, `user_version`-pragma-based, hand-rolled against better-sqlite3 (no heavy migration dependency) unless research surfaces a strong reason otherwise.
- Exact IPC channel naming and organization conventions.
- Window default size, minimum size, and single-instance-lock behavior.
- The Windows plus Mac dev and build scaffolding via electron-vite (packaging and signing are Phase 8, not here).
- The testing approach that proves the app launches and the keychain round-trips on both Windows and Mac.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

Paths are relative to the NicoleBooks repo root (`C:/Users/anthony/claude-projects/nicole_quickbooks`). The brand files live in sibling repos under `claude-projects/`.

### Brand and Design Tokens (highest priority)
- `../themagnetgroup/brand-guide/agents/tokens.json` : Canonical Magnet Group design tokens. Colors (light, dark, semantic, chart), typography (Jost heading, DM Sans body, weights, sizes, tracking), radius plus radiusUsage rules, spacing, shadow, motion, elevation, and app layout tokens (sidebar width 280px, nav height 56px, structural radius 0). This is the source of truth for ALL NicoleBooks theming. Vendor a copy into the repo per D-02.
- `../themagnetgroup_website/src/app/globals.css` : The live website's Tailwind v4 `@theme inline` plus `:root` token rendering. Reference implementation for wiring the tokens into Tailwind v4 and shadcn. Secondary cross-check for values.
- `../themagnetgroup_website/components.json` : shadcn/ui config shape used in the reference implementation.
- `../themagnetgroup/brand-guide/brand/04-color.html`, `../themagnetgroup/brand-guide/brand/05-typography.html`, `../themagnetgroup/brand-guide/brand/13-spacing.html` : Human-readable brand guide pages, if visual reference is needed.

### Phase Requirements and Stack
- `.planning/ROADMAP.md` (Phase 1 section) : Phase goal and the four success criteria.
- `.planning/REQUIREMENTS.md` : BRAND-01, BRAND-02, PLAT-01, PLAT-02 requirement text.
- `CLAUDE.md` (Technology Stack section) : Locked stack (Electron 43, React 19, electron-vite, TypeScript, Tailwind 4, shadcn/ui, better-sqlite3, safeStorage, Zod) and the "What NOT to Use" table.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- No NicoleBooks code exists yet. This is a greenfield repo (only `CLAUDE.md` and `.planning/`). Phase 1 creates the first code.
- External reference (not the same repo, do not import at runtime): `../themagnetgroup_website` is a production app on the exact target UI stack (Tailwind v4 `@theme inline`, shadcn/ui via `components.json`, `tw-animate-css`). Use it as a worked example for wiring tokens plus shadcn in Tailwind v4.

### Established Patterns
- None internal yet. Phase 1 sets the patterns (IPC boundary shape, DB access layer, secret-store service, theme wiring) that every later phase follows.

### Integration Points
- This phase builds the seams, it does not connect to anything. It creates: the typed IPC boundary (consumed by all later phases), the SQLite access layer and migration runner (Phases 2, 3, 7 add tables), the secret store (Phase 3 stores the AI key, Phase 4 stores QuickBooks tokens), the theme (all UI phases), and the app-frame nav slots (Bills, History, Settings).

</code_context>

<specifics>
## Specific Ideas

- The Magnet Group brand system is one Anthony already built ("you created it lol it should be in the magnet group website directory"). Use it verbatim. Do not invent new brand colors, fonts, or values; extract them from `tokens.json`.
- The header's connection-status slot is deliberately shaped now to anticipate Phase 4's QuickBooks connection-health indicator, so the frame does not need restructuring later.
- The Settings "Secret store: OK" health check is intended to become the permanent home that Phase 3 (AI key/model) and Phase 4 (QuickBooks) build their real settings onto.

</specifics>

<deferred>
## Deferred Ideas

None. The discussion stayed within Phase 1 scope; no new capabilities or cross-phase ideas surfaced.

</deferred>

---

*Phase: 1-Foundation*
*Context gathered: 2026-07-22*
