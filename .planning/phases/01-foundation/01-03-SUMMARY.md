---
phase: 01-foundation
plan: 03
subsystem: brand-theme
tags: [electron, renderer, tailwindcss-v4, shadcn, base-ui, brand-tokens, fonts, css-variables, dark-mode]

# Dependency graph
requires:
  - 01-01 hardened electron-vite scaffold (renderer React 19 plus Tailwind v4 via @tailwindcss/vite, @ and @shared aliases in vite and tsconfig.web)
provides:
  - Vendored canonical brand tokens (src/renderer/brand/tokens.json), byte-identical to the Magnet Group source, as the build-time source of truth (D-02)
  - Themed renderer stylesheet (src/renderer/src/globals.css): Tailwind v4 @theme inline mapping, light :root and net-new .dark palettes, local @font-face for Jost and DM Sans, semantic and chart colors carried forward (D-01 through D-06)
  - Four locally bundled woff2 fonts (src/renderer/src/brand/fonts) served via @font-face, never a CDN (D-04)
  - cn() class helper (src/renderer/src/lib/utils.ts)
  - shadcn config for the Vite renderer (components.json) plus four branded base-nova primitives (button, badge, separator, tooltip) on Base UI
  - Pinned primitive dependency @base-ui/react 1.6.0 (the CLI-resolved base-nova primitive)
affects: [01-06 branded app shell and three screens consume the theme classes and shadcn primitives, all Phase 2-8 renderer UI inherits the tokens]

# Tech tracking
tech-stack:
  added: ["@base-ui/react 1.6.0"]
  patterns: [Tailwind v4 @theme inline token-to-CSS-variable mapping, CSS-variable light and dark palettes with .dark override, locally bundled @font-face woff2 with unicode-range split, shadcn base-nova copy-in components built on Base UI not classic Radix]

key-files:
  created: [src/renderer/brand/tokens.json, src/renderer/src/brand/fonts/jost-latin.woff2, src/renderer/src/brand/fonts/jost-latin-ext.woff2, src/renderer/src/brand/fonts/dm-sans-latin.woff2, src/renderer/src/brand/fonts/dm-sans-latin-ext.woff2, src/renderer/src/lib/utils.ts, components.json, src/renderer/src/components/ui/button.tsx, src/renderer/src/components/ui/badge.tsx, src/renderer/src/components/ui/separator.tsx, src/renderer/src/components/ui/tooltip.tsx, src/renderer/src/globals.css]
  modified: [package.json, package-lock.json, src/renderer/src/main.tsx]

key-decisions:
  - "The base-nova shadcn CLI resolves the Base UI primitive (@base-ui/react), not classic Radix. Every generated component imports from @base-ui/react/* (button, separator, tooltip) or its merge-props/use-render helpers (badge). Pinned @base-ui/react 1.6.0 exact. This confirms plan Caveat A and is the primitive 01-06 must wire against."
  - "shadcn init cannot auto-detect the electron-vite framework (renderer lives under src/renderer/src, config is electron.vite.config.ts), so init exited without writing anything. Followed shadcn's documented manual-config path: hand-authored components.json to the Phase 1 deltas, then drove shadcn add, which fetched the real registry components."
  - "shadcn add wrote the components to a literal ./@/components/ui folder because the root tsconfig.json (a solution-style file) carries no path alias (the @ alias lives in tsconfig.web.json). Relocated the four CLI-generated files verbatim into src/renderer/src/components/ui and removed the stray @ directory; file contents are exactly what the CLI produced."
  - "The CLI-driven dependency install was skipped as a side effect of the failed framework detection, so @base-ui/react was referenced by the components but not installed. Verified the package is legitimate on the npm registry (stable v1.6.0, official homepage base-ui.com; the legacy @base-ui-components/react name is stuck at an RC) before installing, satisfying the package-legitimacy guard. The plan (Caveat A) pre-authorizes pinning whatever primitive the base-nova CLI resolves."
  - "Authored globals.css light values from the vendored tokens.json, not the marketing site's :root: foreground #343434 (D-05, not #1d1d1f) and muted-foreground #6e6e73 (D-01, not #48484a). Added the net-new .dark palette the reference site does not have (D-03), and carried semantic (success/warning/info/destructive) plus the five chart colors into @theme now for later phases (D-06)."
  - "Imported globals.css in main.tsx so the theme seam is actually active and the Tailwind v4 build compiles it (unimported CSS never enters the Vite module graph). This is the minimal activation of the BRAND-01 seam; the full shell wiring and the OS dark-class mirror remain 01-06 work."

requirements-completed: []

# Metrics
duration: 14min
completed: 2026-07-22
---

# Phase 1 Plan 03: Magnet Group Brand Theme Summary

**The BRAND-01 theme seam: the canonical Magnet Group tokens vendored byte-for-byte, rendered into a Tailwind v4 globals.css with both light and dark palettes, Jost and DM Sans served locally via @font-face, and four branded base-nova shadcn primitives on Base UI, all compiling into the renderer build.**

## Performance

- **Duration:** ~14 min
- **Completed:** 2026-07-22
- **Tasks:** 2
- **Files:** 12 created, 3 modified

## Accomplishments

- Vendored the canonical `tokens.json` into `src/renderer/brand/tokens.json` byte-identical to the Magnet Group source (verified with `Buffer.compare === 0`), establishing the build-time source of truth (D-02) with no cross-repo build dependency.
- Bundled the four brand woff2 files (`jost-latin`, `jost-latin-ext`, `dm-sans-latin`, `dm-sans-latin-ext`) under `src/renderer/src/brand/fonts` and wired them via local `@font-face` with `unicode-range` splits, never a Google Fonts import or link (D-04). The build emits all four as hashed assets, proving the `@font-face` URLs resolve.
- Authored `src/renderer/src/globals.css`: a Tailwind v4 `@theme inline` block mapping color, radius, and font tokens to CSS variables; a light `:root` palette with the canonical foreground `#343434` (D-05) and muted-foreground `#6e6e73` (D-01); a net-new `.dark` palette with background `#1a1a1a` and ring `#8f33ff` (D-03); and the semantic plus five chart colors carried forward for later phases (D-06).
- Initialized shadcn for the Vite renderer (`components.json` with `rsc: false`, `style: base-nova`, `baseColor: neutral`, `iconLibrary: lucide`, css pointing at the renderer globals.css) and generated the conservative primitive set (`button`, `badge`, `separator`, `tooltip`) via the shadcn CLI.
- Copied the `cn()` helper verbatim and pinned `@base-ui/react` 1.6.0, the primitive the base-nova CLI resolved (Caveat A confirmed: Base UI, not classic Radix).
- Verified the whole seam compiles: `npm run build` (electron-vite) and `tsc --build` both exit 0, and the compiled `index-*.css` contains the canonical brand values with no CDN reference and no dash characters.

## Task Commits

Each task was committed atomically:

1. **Task 1: Vendor tokens and fonts, copy cn helper, init shadcn, add component set** - `ac27d2f` (feat)
2. **Task 2: Author globals.css (Tailwind v4 theme, light and dark palettes, local fonts)** - `818e85f` (feat)

**Plan metadata:** committed separately with SUMMARY, STATE, ROADMAP, REQUIREMENTS.

## Theme Reference (for 01-06 and every later UI phase)

**Primitive dependency:** `@base-ui/react` 1.6.0 (Base UI, NOT classic Radix). The `tooltip` component requires wrapping the app subtree in `TooltipProvider` from `@/components/ui/tooltip`. Import primitives from `@/components/ui/*`; they resolve the `@` alias through both the Vite `resolve.alias` and `tsconfig.web.json` paths.

**Semantic Tailwind classes available** (resolve to the CSS variables in `:root` / `.dark`):

| Utility family | Classes | Token |
|----------------|---------|-------|
| Background | `bg-background`, `bg-card`, `bg-popover`, `bg-primary`, `bg-secondary`, `bg-muted`, `bg-accent`, `bg-destructive` | surface / brand |
| Foreground | `text-foreground`, `text-card-foreground`, `text-primary`, `text-primary-foreground`, `text-secondary-foreground`, `text-muted-foreground`, `text-accent-foreground` | surface / brand |
| Border / ring / input | `border-border`, `ring-ring`, `border-input` | surface |
| Status (later phases) | `bg-success`/`text-success`, `bg-warning`/`text-warning`, `bg-info`/`text-info` (#28a745, #f59e0b, #6c00ff) | semantic |
| Chart (later phases) | `text-chart-1` through `text-chart-5` (#6c00ff, #c77dff, #343434, #6e6e73, #1d1d1f) | chart |
| Fonts | `font-heading` (Jost), `font-sans` (DM Sans), `font-mono` | font.family |
| Radius ladder | `rounded-sm`/`md`/`lg`/`xl`/`2xl`/`3xl`/`4xl` driven by `--radius: 0.625rem` | radius |

**Structural radius note (from UI-SPEC / tokens.json radiusUsage):** header, sidebar, and workspace panels use radius 0 (never rounded); cards use ~14px, inputs ~7px, badges/buttons are pill. Do not apply a blanket radius in 01-06.

**Dark mode:** the `.dark` class on a parent (documentElement) flips the palette. The class-toggle mirror from `nativeTheme` / `window.api.theme` is net-new 01-06 work; the CSS side is ready now.

## Files Created/Modified

- `src/renderer/brand/tokens.json` (created) - Byte-identical vendored copy of the canonical Magnet Group tokens; the build-time source of truth for all brand values. Not gitignored (committed brand asset, not a secret).
- `src/renderer/src/brand/fonts/{jost-latin,jost-latin-ext,dm-sans-latin,dm-sans-latin-ext}.woff2` (created) - Locally bundled variable fonts served via `@font-face`.
- `src/renderer/src/lib/utils.ts` (created) - `cn()` helper (clsx plus tailwind-merge), copied verbatim.
- `components.json` (created) - shadcn config for the Vite renderer: `rsc: false`, `style: base-nova`, `baseColor: neutral`, `cssVariables: true`, `iconLibrary: lucide`, `registries: {}`, css path `src/renderer/src/globals.css`, standard `@/*` aliases.
- `src/renderer/src/components/ui/{button,badge,separator,tooltip}.tsx` (created) - shadcn base-nova primitives generated by the CLI; import from `@base-ui/react/*` and `@/lib/utils`, variant tables keyed on brand tokens.
- `src/renderer/src/globals.css` (created) - The themed renderer stylesheet (see Theme Reference above).
- `package.json` / `package-lock.json` (modified) - Added `@base-ui/react` 1.6.0 (exact pin), the base-nova primitive dependency.
- `src/renderer/src/main.tsx` (modified) - Added `import './globals.css'` to activate the theme seam so the build compiles the stylesheet (deviation 3 below).

## Decisions Made

- Followed the plan's Caveat A exactly: accepted whatever primitive the base-nova CLI resolved and pinned it, rather than hand-adding a Radix or Base UI dependency. The result is `@base-ui/react`.
- Authored all light-mode values from the vendored `tokens.json`, not the marketing site's `:root`, honoring the D-05 (#343434) and D-01 (#6e6e73) deltas that intentionally diverge from the reference site.
- Kept `@custom-variant dark (&:is(.dark *))` and the `@import "tailwindcss"` / `@import "tw-animate-css"` header verbatim; dropped the marketing-site-only `@import "shadcn/tailwind.css"` (Next-specific) and the website scroll-margin / section rules.
- Left the `body` base rule at `bg-background text-foreground` per the plan; the `font-sans` application to the shell and the dark-class mirror are deliberately deferred to 01-06 to keep the plan boundary clean.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] shadcn init cannot detect the electron-vite framework; used the documented manual-config path**
- **Found during:** Task 1 (running `npx shadcn init`)
- **Issue:** `shadcn init` ran preflight then failed at "Verifying framework" with "We could not detect a supported framework," because the renderer lives under `src/renderer/src` and the config is `electron.vite.config.ts`. It wrote no files (git status unchanged), so components.json and the component set could not be produced by init.
- **Fix:** Followed shadcn's documented manual-configuration path: hand-authored `components.json` with the exact Phase 1 deltas, then ran `npx shadcn add button badge separator tooltip`, which fetched the real base-nova components from the registry.
- **Files modified:** components.json (created)
- **Verification:** `shadcn add` created all four components; contents match the base-nova registry (badge uses `useRender`/`mergeProps`, others import `@base-ui/react/*`).

**2. [Rule 3 - Blocking] CLI wrote components to a literal `@` folder and skipped the primitive install**
- **Found during:** Task 1 (after `shadcn add`)
- **Issue:** (a) Because the root `tsconfig.json` (a solution-style file) has no `paths`, shadcn could not resolve the `@` alias and created `./@/components/ui/*.tsx` at the repo root instead of under the renderer. (b) The failed framework detection also skipped the CLI's dependency install, so the components referenced `@base-ui/react` but it was neither in `package.json` nor `node_modules`.
- **Fix:** (a) Relocated the four CLI-generated files verbatim into `src/renderer/src/components/ui` and removed the stray `@` directory. (b) Verified `@base-ui/react` is legitimate on the npm registry (stable v1.6.0, homepage base-ui.com; the legacy `@base-ui-components/react` name is only at an RC) and installed it exact-pinned, completing the CLI's own resolution as the plan's Caveat A directs.
- **Files modified:** src/renderer/src/components/ui/*.tsx (created), package.json, package-lock.json
- **Verification:** `tsc --build` exits 0 (the base-ui component imports resolve against v1.6.0); no literal `@` directory remains.

**3. [Rule 3 - Blocking] globals.css must be imported to enter the Tailwind build graph**
- **Found during:** Task 2 (running the `npm run build` verify)
- **Issue:** The plan's Task 2 verify runs `npm run build` and expects the renderer CSS to compile with no Tailwind errors. `main.tsx` did not import `globals.css`, so Vite/`@tailwindcss/vite` would not process it and the verify would be hollow; the theme seam would also be inert.
- **Fix:** Added a single `import './globals.css'` to `src/renderer/src/main.tsx` with a comment scoping it as the seam activation. The full shell wiring and dark-class mirror remain 01-06 work.
- **Files modified:** src/renderer/src/main.tsx
- **Verification:** `npm run build` exits 0; the emitted `index-*.css` (33.4 kB) contains `#343434`, `#8f33ff`, `#6c00ff`, `#6e6e73`, `#1a1a1a`, an `@font-face`, no `googleapis`, and no dash characters; all four woff2 fonts are emitted as bundled assets.

---

**Total deviations:** 3 auto-fixed, all blocking, all stemming from the non-standard electron-vite layout the shadcn CLI does not natively support. No scope creep and no security impact: tokens.json and the fonts are non-secret brand assets committed intentionally (threat T-01-10: accept), and all fonts are local with zero remote fetch (threat T-01-09: mitigate).

## Package Legitimacy Note (package-manager install)

`@base-ui/react` 1.6.0 was installed by me (the CLI skipped its own install). Per the executor's package-manager exclusion, I verified legitimacy before installing rather than substituting any alternative: it is the exact name the official shadcn base-nova CLI wrote into the components, it is a stable release on npm (`npm view @base-ui/react` -> 1.6.0), and its homepage is the official `base-ui.com`. This is the primitive the plan's Caveat A explicitly anticipates and directs to pin.

## Requirements

- **BRAND-01 (Magnet Group brand tokens: colors and typography):** advanced, not completed. This plan lays the complete theme seam (vendored tokens, both palettes, local fonts, branded primitives) but the user-visible branded window and wordmark, which is the requirement's observable success criterion, land when the shell renders in 01-06. Marked complete there, following the 01-02 precedent for advanced-but-not-observable requirements.

## Issues Encountered

- The shadcn CLI does not support the electron-vite renderer layout; all three deviations above trace to that. Resolved via the documented manual-config path plus a verified primitive install. Build, typecheck, and the token byte-compare are all green.

## Verification Results

- Token vendor: `Buffer.compare(vendored, canonical) === 0` -> `TOKENS_VENDORED_OK`.
- `tsc --build` -> exit 0 (base-ui component imports resolve).
- `npm run build` (electron-vite) -> exit 0; `globals.css` compiles to `out/renderer/assets/index-*.css` and all four woff2 fonts emit as assets.
- globals.css assertion: contains `:root`, `.dark`, `#343434`, `#8f33ff`, `@font-face`; no `googleapis`; no em/en dash -> `GLOBALS_OK`.
- Compiled CSS spot-check: `#343434`, `#8f33ff`, `#6c00ff`, `#6e6e73`, `#1a1a1a` present, no `googleapis`, no dashes.
- Dash scan across all authored files -> clean.

## User Setup Required

None. No external service configuration in this plan.

## Next Phase Readiness

- 01-06 (branded app shell) can import the shadcn primitives from `@/components/ui/*`, wrap the tree in `TooltipProvider`, and consume the semantic classes in the Theme Reference table above. It must (a) apply `font-sans` / `font-heading` where the UI-SPEC typography roles require, (b) use structural radius 0 for header/sidebar/panels, and (c) implement the `nativeTheme` -> `documentElement.classList.toggle('dark', ...)` mirror plus the `window.api.theme.onChange` subscription (the CSS `.dark` palette is already wired).
- All later UI phases inherit the tokens with zero hardcoded hex; semantic status and chart utilities are pre-wired for confidence flags and any later charts (D-06).

## Self-Check: PASSED

- All 12 created files plus the SUMMARY verified present on disk (tokens.json, four woff2 fonts, utils.ts, components.json, four ui components, globals.css).
- Both task commits verified in git history (ac27d2f, 818e85f).
