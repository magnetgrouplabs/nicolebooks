# Phase 1: Foundation - Pattern Map

**Mapped:** 2026-07-22
**Files analyzed:** 40 (new; greenfield repo, zero modified)
**Analogs found:** 6 external-reference analogs + 9 RESEARCH-reference blueprints / 40 total

> Plain hyphens only; no em or en dashes in this file (project rule).

## Orientation (read first)

NicoleBooks is a **greenfield repo**: it currently holds only `CLAUDE.md` and `.planning/`. There is no internal NicoleBooks source to copy from, so "closest analog" resolves to one of three kinds, and every row below is tagged with which kind it is:

- **EXTERNAL-ANALOG** - a real file in a sibling repo that the planner adapts (copy the shape, apply the Phase 1 deltas). Read-only reference; never imported at runtime. All external paths were confirmed present on 2026-07-22.
- **RESEARCH-BLUEPRINT** - no existing repo file, but `01-RESEARCH.md` supplies worked, citation-backed reference code the planner should transcribe and adapt. Cited as "RESEARCH Pattern N" or "RESEARCH Code Example: <name>".
- **NET-NEW** - no analog anywhere; Phase 1 itself establishes the pattern that Phases 2 through 8 will copy. Planner invents from CONTEXT + UI-SPEC + stack docs.

Confirmed external reference files (all exist):
- `../themagnetgroup_website/src/app/globals.css` (5863 bytes) - Tailwind v4 `@theme inline` + `:root` wiring
- `../themagnetgroup_website/components.json` (520 bytes) - shadcn config shape
- `../themagnetgroup_website/src/lib/utils.ts` - the `cn()` helper (copy verbatim)
- `../themagnetgroup_website/src/app/layout.tsx` - local-font wiring pattern (Next.js `next/font/local`; adapt to `@font-face`)
- `../themagnetgroup_website/src/components/ui/badge.tsx` - a `base-nova` shadcn copy-in (note: base-ui, not classic Radix; see Caveat A)
- `../themagnetgroup_website/public/fonts/{jost-latin,jost-latin-ext,dm-sans-latin,dm-sans-latin-ext}.woff2` - the actual bundled font binaries to vendor (D-04)
- `../themagnetgroup/brand-guide/agents/tokens.json` (13419 bytes) - canonical token values to vendor (D-02) and to author `globals.css` from

## File Classification

Buckets follow the RESEARCH "Recommended Project Structure" (RESEARCH.md lines 222-261), reconciled with UI-SPEC and CONTEXT. Match Quality: `external` = real sibling file to adapt; `blueprint` = RESEARCH worked code; `net-new` = Phase 1 originates it.

### Build / scaffold config

| New File | Role | Data Flow | Closest Analog | Match Quality |
|----------|------|-----------|----------------|---------------|
| `package.json` | config | n/a | electron-vite `react-ts` scaffold + RESEARCH install block (lines 120-139) | blueprint |
| `electron.vite.config.ts` | config | build | RESEARCH Pattern 1 (lines 267-291) | blueprint |
| `tsconfig.json` / `tsconfig.node.json` / `tsconfig.web.json` | config | n/a | electron-vite scaffold defaults | net-new |
| `components.json` | config | n/a | `../themagnetgroup_website/components.json` | external |
| `.gitignore` | config | n/a | RESEARCH Security Domain (must list `secrets.enc`, `*.db`, env files) | net-new |

### Main process (privileged; Node)

| New File | Role | Data Flow | Closest Analog | Match Quality |
|----------|------|-----------|----------------|---------------|
| `src/main/index.ts` | main-entry | event-driven | RESEARCH Pattern 2 (lines 297-315) + single-instance example (lines 555-565) | blueprint |
| `src/main/ipc/settings.ts` | ipc-handler | request-response / CRUD | RESEARCH Code Example: settings.ts (lines 568-586) | blueprint |
| `src/main/ipc/secrets.ts` | ipc-handler | request-response | RESEARCH Pattern 2: secrets.ts handler (lines 342-365) | blueprint |
| `src/main/ipc/theme.ts` | ipc-handler | pub-sub / event-driven | RESEARCH Code Example: theme.ts (lines 542-552) | blueprint |
| `src/main/db/connection.ts` | service | file-I/O | RESEARCH structure + `app.getPath('userData')` anti-pattern note (line 476) | net-new |
| `src/main/db/migrate.ts` | service | batch / transform | RESEARCH Pattern 6 (lines 435-470) | blueprint |
| `src/main/db/migrations/0001_init.ts` | migration | transform | RESEARCH Pattern 6 `up()` (lines 444-456) | blueprint |
| `src/main/secrets/secret-store.ts` | service | file-I/O | RESEARCH Pattern 3 (lines 372-411) | blueprint |

### Preload (sandbox-safe bridge)

| New File | Role | Data Flow | Closest Analog | Match Quality |
|----------|------|-----------|----------------|---------------|
| `src/preload/index.ts` | bridge / provider | request-response | RESEARCH Pattern 2: preload (lines 317-340) | blueprint |

### Shared (types only; imported by both sides)

| New File | Role | Data Flow | Closest Analog | Match Quality |
|----------|------|-----------|----------------|---------------|
| `src/shared/ipc-contract.ts` | contract | n/a | RESEARCH structure (line 246) + "Don't Hand-Roll" cross-boundary types (line 486) | net-new |
| `src/shared/schemas.ts` | validation | n/a | Zod schemas inline across RESEARCH Patterns 2/settings (lines 347, 573) | blueprint |

### Renderer (React UI)

| New File | Role | Data Flow | Closest Analog | Match Quality |
|----------|------|-----------|----------------|---------------|
| `src/renderer/index.html` | config | n/a | electron-vite scaffold default | net-new |
| `src/renderer/src/main.tsx` | entry / provider | event-driven | `../themagnetgroup_website/src/app/layout.tsx` (body font-var + class pattern, lines 116-118) | external (partial) |
| `src/renderer/src/App.tsx` | component (shell) | request-response | UI-SPEC Layout Frame + RESEARCH Pattern 4 (lines 413-416) | net-new |
| `src/renderer/src/globals.css` | config (theme) | n/a | `../themagnetgroup_website/src/app/globals.css` | external |
| `src/renderer/src/lib/utils.ts` | utility | n/a | `../themagnetgroup_website/src/lib/utils.ts` | external (verbatim) |
| `src/renderer/src/env.d.ts` | contract | n/a | RESEARCH Code Example: env.d.ts (lines 531-539) | blueprint |
| `src/renderer/brand/tokens.json` (vendored) | config | n/a | `../themagnetgroup/brand-guide/agents/tokens.json` | external (copy) |
| `src/renderer/src/brand/fonts/*.woff2` | asset | file-I/O | `../themagnetgroup_website/public/fonts/*.woff2` | external (copy binaries) |
| `src/renderer/src/components/Header.tsx` | component | request-response | UI-SPEC Component Inventory; RESEARCH Pattern 4 | net-new |
| `src/renderer/src/components/Sidebar.tsx` | component (nav) | event-driven | UI-SPEC Layout Frame + Nav item spec | net-new |
| `src/renderer/src/components/EmptyState.tsx` | component | n/a | UI-SPEC Copywriting Contract + Component Inventory | net-new |
| `src/renderer/src/components/HealthIndicator.tsx` | component | request-response | UI-SPEC Settings health indicator + D-11 round trip | net-new |
| `src/renderer/src/components/ui/{button,badge,separator,tooltip}.tsx` | component (shadcn copy-in) | n/a | `../themagnetgroup_website/src/components/ui/badge.tsx` (base-nova shape) | external (regenerate via CLI) |
| `src/renderer/src/screens/BillsScreen.tsx` | component (screen) | n/a | UI-SPEC per-screen copy (Bills) | net-new |
| `src/renderer/src/screens/HistoryScreen.tsx` | component (screen) | n/a | UI-SPEC per-screen copy (History) | net-new |
| `src/renderer/src/screens/SettingsScreen.tsx` | component (screen) | request-response | UI-SPEC per-screen copy (Settings) + D-11 | net-new |

### Tests (Wave 0; RESEARCH Validation Architecture lines 640-681)

| New File | Role | Data Flow | Closest Analog | Match Quality |
|----------|------|-----------|----------------|---------------|
| `vitest.config.ts` | config | n/a | RESEARCH Test Framework table (lines 645-650) | net-new |
| `playwright.config.ts` | config | n/a | Playwright `_electron` harness (RESEARCH line 647) | net-new |
| `test/migrate.test.ts` | test (unit) | n/a | RESEARCH map SC3 migration (line 662) | net-new |
| `test/secret-store.test.ts` | test (unit) | n/a | RESEARCH map SC2, mocked safeStorage (line 659) | net-new |
| `test/no-secret-leak.test.ts` | test (unit) | n/a | RESEARCH map SC2 negative (line 660) | net-new |
| `test/ipc-contract.test.ts` | test (unit) | n/a | RESEARCH map SC4 (line 663) | net-new |
| `e2e/{launch,theme,secret-roundtrip,persistence,ipc-boundary}.spec.ts` | test (e2e) | n/a | RESEARCH Phase-Requirements-to-Test map (lines 656-663) | net-new |
| `.github/workflows/ci.yml` | config | n/a | RESEARCH Wave 0 CI note (line 678); matrix windows + macos | net-new |

## Pattern Assignments

Only files with a concrete external analog get code excerpts here. Blueprint files should transcribe the cited RESEARCH pattern directly (the code is already in `01-RESEARCH.md`; do not duplicate it into every plan). Net-new files are governed by the UI-SPEC.

---

### `src/renderer/src/globals.css` (config / theme) - PRIMARY THEME SEAM

**Analog:** `../themagnetgroup_website/src/app/globals.css` (EXTERNAL). This is the single most load-bearing adaptation in Phase 1 (BRAND-01). Copy the file's structure, then apply the six Phase 1 deltas below. Author values from the vendored `tokens.json`, not from the reference `:root` (the reference site intentionally diverges on `--foreground` and `--muted-foreground`; see D-05).

**Top-of-file imports and custom-variant to REPLACE** (reference lines 1-5):
```css
@import "tailwindcss";
@import "tw-animate-css";
@import "shadcn/tailwind.css";        /* reference (Next.js) */
@custom-variant dark (&:is(.dark *));
```
Delta for the Vite/Electron renderer: keep `@import "tailwindcss";` and `@import "tw-animate-css";`, and keep `@custom-variant dark (&:is(.dark *));` verbatim. Replace `@import "shadcn/tailwind.css";` with whatever base layer `npx shadcn init` writes into the renderer `globals.css` (do not hand-copy the Next-specific import).

**`@theme inline` token mapping to KEEP** (reference lines 7-35): reuse the full `--color-*` mapping block verbatim (background, foreground, card, popover, primary, secondary, muted, accent, destructive, border, input, ring, and the `--radius-*` calc ladder). Add `--font-heading`, `--font-sans`, `--font-mono` mappings (reference lines 10-12 already map these to `var(--font-*)`). Carry the semantic + chart colors from `tokens.json` (success/warning/info + chart 1-5) into `@theme` now, per D-06, even though nothing consumes them in Phase 1.

**`:root` light palette - AUTHOR FROM tokens.json, NOT from the reference** (reference lines 49-73 show the shape; the values differ). Correct Phase 1 light values from `tokens.json`:
```css
:root {
  --background: #ffffff;          /* surface.bg */
  --foreground: #343434;          /* surface.fg  -- D-05 delta: NOT the site's #1d1d1f */
  --card: #ffffff;                /* surface.card */
  --card-foreground: #343434;
  --popover: #ffffff;
  --popover-foreground: #343434;
  --primary: #6c00ff;             /* brand.primary */
  --primary-foreground: #ffffff;
  --secondary: #f5f5f7;           /* surface.secondary */
  --secondary-foreground: #343434;
  --muted: #f5f5f7;
  --muted-foreground: #6e6e73;    /* surface.mutedFg -- D-01 delta: NOT the site's #48484a */
  --accent: #c77dff;              /* brand.accent (reserved for later phases) */
  --accent-foreground: #343434;
  --destructive: #ff3b30;
  --border: #e5e5ea;
  --input: #e5e5ea;
  --ring: #6c00ff;                /* surface.ring */
  --radius: 0.625rem;             /* radius.lg; shadcn --radius drives card/input ladder */
}
```

**`.dark {}` block - NET-NEW (the reference file has NO dark block; NicoleBooks must add one per D-03).** Author from `tokens.json` `color.dark.*`:
```css
.dark {
  --background: #1a1a1a;          /* dark.bg */
  --foreground: #f0f0f0;          /* dark.fg */
  --card: #242424;               /* dark.card */
  --card-foreground: #f0f0f0;
  --popover: #2a2a2a;            /* dark.popover */
  --popover-foreground: #f0f0f0;
  --secondary: #2a2a2a;
  --secondary-foreground: #e0e0e0;
  --muted: #2a2a2a;
  --muted-foreground: #a0a0a0;
  --border: #3a3a3a;
  --input: #3a3a3a;
  --ring: #8f33ff;               /* dark.ring -- lighter primary for dark visibility */
}
```

**`@font-face` blocks - NET-NEW wiring (the reference uses Next.js `next/font/local`, which does NOT exist in a Vite renderer).** The reference's `layout.tsx` (lines 16-46) shows the intent (two families, variable names `--font-heading` / `--font-sans`, local woff2 sources) but its mechanism is Next-only. In the renderer, hand-author `@font-face` in `globals.css` pointing at the vendored `src/renderer/src/brand/fonts/*.woff2`. Never a Google Fonts `@import` or `<link>` (D-04). Set the family strings from `tokens.json font.family`:
- `--font-heading: 'Jost', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;`
- `--font-sans: 'DM Sans', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;`
- `--font-mono: ui-monospace, 'SF Mono', 'Cascadia Mono', Consolas, monospace;`

**`@layer base` - KEEP with adaptation** (reference lines 75-94): reuse the `* { @apply border-border outline-ring/50; }` and `body { @apply bg-background text-foreground; }` base. Drop the website-specific `scroll-margin` / `section[id]` rules (no anchored sections in an app shell).

**`prefers-reduced-motion` - KEEP verbatim** (reference lines 127-134); UI-SPEC Motion section requires honoring it.

**Structural-radius note:** header, sidebar, and workspace panels use radius 0 (`tokens.json radiusUsage.structural`); the shadcn `--radius` ladder still drives cards (14px) and inputs (7px). Do not apply a blanket radius.

---

### `components.json` (config)

**Analog:** `../themagnetgroup_website/components.json` (EXTERNAL, verbatim shape). Full reference file:
```json
{
  "$schema": "https://ui.shadcn.com/schema.json",
  "style": "base-nova",
  "rsc": true,                       /* DELTA -> false (Vite renderer, not RSC) */
  "tsx": true,
  "tailwind": {
    "config": "",
    "css": "src/app/globals.css",    /* DELTA -> renderer globals.css path */
    "baseColor": "neutral",
    "cssVariables": true,
    "prefix": ""
  },
  "iconLibrary": "lucide",
  "rtl": false,
  "aliases": {
    "components": "@/components",
    "utils": "@/lib/utils",
    "ui": "@/components/ui",
    "lib": "@/lib",
    "hooks": "@/hooks"
  },
  "menuColor": "default",
  "menuAccent": "subtle",
  "registries": {}
}
```
**Phase 1 deltas (from RESEARCH Pattern 5, lines 429, and UI-SPEC Design System):** set `"rsc": false`; point `"tailwind.css"` at the renderer `globals.css` (for example `src/renderer/src/globals.css`); keep `"style": "base-nova"`, `"baseColor": "neutral"`, `"cssVariables": true`, `"iconLibrary": "lucide"`, `"registries": {}`. The `@/*` aliases must resolve through BOTH the Vite `resolve.alias` (RESEARCH Pattern 1, line 286) and the renderer `tsconfig` `paths`.

---

### `src/renderer/src/lib/utils.ts` (utility)

**Analog:** `../themagnetgroup_website/src/lib/utils.ts` (EXTERNAL, copy verbatim). Entire file:
```typescript
import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
```
No deltas. `clsx` and `tailwind-merge` are already in the RESEARCH stack (lines 100-101).

---

### `src/renderer/src/components/ui/{button,badge,separator,tooltip}.tsx` (shadcn copy-ins)

**Analog:** `../themagnetgroup_website/src/components/ui/badge.tsx` (EXTERNAL, shape reference only). **Do not hand-copy these; regenerate with the CLI** so they match the installed shadcn version: `npx shadcn@latest add button badge separator tooltip` (RESEARCH lines 133-135). The reference `badge.tsx` shows what a `base-nova` copy-in looks like in practice - note the `cva` variant table keyed on brand tokens (`bg-primary text-primary-foreground`, `bg-destructive/10 text-destructive`, etc., reference lines 7-28) which is exactly the token wiring the health indicator and status pills will consume. See **Caveat A** about base-ui vs Radix before wiring imports.

---

### `src/renderer/src/main.tsx` (renderer entry / theme provider)

**Analog (partial):** `../themagnetgroup_website/src/app/layout.tsx` lines 116-118 - the body applies font variables plus a base font class:
```tsx
<body className={`${jost.variable} ${dmSans.variable} font-sans antialiased`}>
```
Adapt: the Vite renderer has no Next `<body>` layout, so apply `font-sans antialiased` on the root element and, critically, drive the `dark` class NET-NEW. On boot, call `window.api.theme.get()` and toggle `document.documentElement.classList.toggle('dark', isDark)` synchronously before first meaningful paint, then subscribe via `window.api.theme.onChange(...)` (RESEARCH Pitfall 4, lines 516-520). The reference site is light-only and has no class toggling, so this mirror logic is invented in Phase 1.

---

### Blueprint files (transcribe from RESEARCH; no external analog)

These have no sibling-repo analog. The planner should lift the cited RESEARCH code near-verbatim and adapt names. Do not re-derive.

| File | Transcribe from | Load-bearing details to preserve |
|------|-----------------|----------------------------------|
| `electron.vite.config.ts` | RESEARCH Pattern 1 (267-291) | `externalizeDepsPlugin()` on `main` only; preload `rollupOptions.output.format='cjs'` and NO externalize; renderer aliases `@` and `@shared`; `react()` + `tailwindcss()` plugins |
| `src/main/index.ts` | RESEARCH Pattern 2 (297-315) + examples (555-565) | `contextIsolation/sandbox/nodeIntegration=false/webSecurity` posture; `show:false` until `ready-to-show`; `setWindowOpenHandler(deny)` + `will-navigate` preventDefault; single-instance lock; window 1200x800 min 940x600 (Discretion, A2) |
| `src/preload/index.ts` | RESEARCH Pattern 2 (317-340) | Expose ONLY named `settings`/`secrets`/`theme` methods; never expose raw `ipcRenderer`; `export type Api = typeof api` for renderer augmentation |
| `src/main/ipc/secrets.ts` | RESEARCH Pattern 2 (342-365) | `assertTrustedSender(event)` then Zod `.parse` before the privileged call, on every handler |
| `src/main/ipc/settings.ts` | RESEARCH Code Example (568-586) | Prepared statements; UPSERT via `ON CONFLICT(key) DO UPDATE`; Zod-gate payloads |
| `src/main/ipc/theme.ts` | RESEARCH Code Example (542-552) | `theme:get` returns `nativeTheme.shouldUseDarkColors`; broadcast `theme:changed` to all windows on `nativeTheme 'updated'` |
| `src/main/secrets/secret-store.ts` | RESEARCH Pattern 3 (372-411) | `safeStorage.isEncryptionAvailable()` guard; base64 ciphertext map in `userData/secrets.enc`; write `{ mode: 0o600 }`; NEVER touch SQLite (D-12) |
| `src/main/db/migrate.ts` + `migrations/0001_init.ts` | RESEARCH Pattern 6 (435-470) | `PRAGMA user_version` gate; forward-only; wrap in `db.transaction`; `0001` creates `app_settings(key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT`; NO feature tables (D-15) |
| `src/renderer/src/env.d.ts` | RESEARCH Code Example (531-539) | `interface Window { api: Api }` reusing the preload's exported `Api` type |
| `src/shared/schemas.ts` | Zod schemas inline in RESEARCH (347, 573) | Single source of truth for channel payload/return schemas; `.max()` bounds on key/value lengths |

---

### Net-new renderer components (governed by UI-SPEC, no analog)

`App.tsx`, `Header.tsx`, `Sidebar.tsx`, `EmptyState.tsx`, `HealthIndicator.tsx`, and the three screens are pure Phase 1 originals. Build them from:
- **Layout Frame** (UI-SPEC lines 42-56): CSS grid `rows: 56px 1fr; cols: 280px 1fr;` header spanning both columns at `elevation.nav` z-index 20, structural radius 0.
- **Copywriting Contract** (UI-SPEC lines 168-193): every string is locked; copy verbatim (wordmark `NicoleBooks`, Bills `No bills to review`, etc.). No personal names (project rule).
- **Color / status** (UI-SPEC lines 96-138): active nav = violet text + violet left-edge bar + focus ring; health indicator success `#28a745` / destructive `#ff3b30`; connection slot neutral `#6e6e73`.
- **Icons** (UI-SPEC line 193): lucide `Receipt`, `History`, `Settings`, `ShieldCheck`, `ShieldAlert`, `Circle`.
- **HealthIndicator** is the SC2 + SC4 proof surface: on mount it must call `window.api.secrets.set('canary','ok')` then `.get('canary')` and render `Secret store: OK` / `unavailable` from the real round trip (D-11; RESEARCH diagram lines 176-220).

## Shared Patterns

Cross-cutting patterns the planner should apply across multiple plans rather than re-specify per file.

### Sender validation + Zod gate (apply to ALL `src/main/ipc/*` handlers)
**Source:** RESEARCH Pattern 2, `src/main/ipc/secrets.ts` (lines 349-364) and Security Domain (lines 705-706).
Every `ipcMain.handle` runs `assertTrustedSender(event)` first, then `Schema.parse(raw)` before the privileged action. A thrown parse becomes a rejected promise in the renderer. This is the SC4 boundary control and is `security_block_on: high` - a handler missing either step fails the security gate.

### Typed IPC contract (apply to preload + all handlers + renderer `env.d.ts`)
**Source:** RESEARCH structure (line 246) + "Don't Hand-Roll" (line 486).
Channel names and payload/return types live once in `src/shared/ipc-contract.ts`; the preload's `export type Api` and the renderer's `Window` augmentation both derive from it. Three channel groups only: `settings` (get/set), `secrets` (set/get/delete), `theme` (get/onChange).

### Brand-token consumption (apply to globals.css + every renderer component)
**Source:** `tokens.json` (vendored) + `globals.css` theme block.
Components reference semantic Tailwind classes (`bg-secondary`, `text-foreground`, `text-primary`, `ring-ring`) that resolve to the CSS variables; they never hardcode hex. Structural surfaces (header/sidebar/panels) use radius 0; cards/badges/inputs use the `radiusUsage` ladder. Status colors (success/destructive/neutral) are semantic, distinct from the 10% brand accent (UI-SPEC lines 120-138).

### safeStorage-only secrets, never SQLite, never logs (apply to secret-store + db + logging)
**Source:** D-12, RESEARCH Pattern 3, Security Domain (lines 695-708).
Ciphertext goes only to `secrets.enc` (`0o600`) under `userData`; `app_settings` and any log line hold zero secret material. `.gitignore` must exclude `secrets.enc`, `*.db`, and env files.

### Native ABI rebuild (apply to package.json + CI)
**Source:** RESEARCH Pitfall 1 (lines 497-502), Open Question 1.
`better-sqlite3` stays in `dependencies`; a `postinstall`/`rebuild` script runs `npx electron-rebuild -f -w better-sqlite3` so a clean clone on the Mac and CI works. Treat a source-compile fallback (needs MSVC + Python 3.11/3.12 on Windows, Xcode CLT on Mac) as an expected branch, not a surprise.

## Caveats for the Planner

**Caveat A - base-nova pulls base-ui, not classic Radix.** The reference `components/ui/badge.tsx` imports from `@base-ui/react` (`useRender`, `mergeProps`), because `style: "base-nova"` shadcn components are built on Base UI, not the classic `@radix-ui/*` primitives. RESEARCH's supporting-libs table (lines 98-99) lists `@radix-ui/react-slot` and `class-variance-authority` as the transitive deps. Resolution: let `npx shadcn init` + `add` (style base-nova) write whatever primitive deps it chooses; do not hardcode either `@radix-ui/react-slot` or `@base-ui/react` in `package.json` by hand - accept the CLI's resolution and pin what it installs. Flag this in the plan so the executor is not surprised when base-ui appears instead of Radix.

**Caveat B - fonts change mechanism, not source.** Copy the four woff2 binaries from `../themagnetgroup_website/public/fonts/` into `src/renderer/src/brand/fonts/`, but the loader is `@font-face` in `globals.css`, NOT the reference's `next/font/local`. The reference `layout.tsx` (lines 16-46) is a shape reference for family/variable naming only.

**Caveat C - `globals.css` values must come from `tokens.json`, not the reference `:root`.** The reference site deliberately uses `#1d1d1f` foreground and `#48484a` muted-foreground; D-05 and D-01 require `#343434` and `#6e6e73`. Author light values from the vendored token file and cross-check against UI-SPEC Color; use the reference `:root` for structure only.

**Caveat D - the reference has no dark palette and no theme toggle.** The `.dark {}` block and the `nativeTheme` -> `documentElement.classList` mirror are net-new to NicoleBooks (D-03). There is no analog to copy for dark-mode wiring; build it from the tokens `dark.*` values and RESEARCH Pitfall 4.

## No Analog Found (pure NET-NEW - use RESEARCH/UI-SPEC, not a sibling file)

| File(s) | Role | Data Flow | Reason |
|---------|------|-----------|--------|
| `src/main/db/connection.ts` | service | file-I/O | No existing better-sqlite3 connection code; open at `app.getPath('userData')/app.db` |
| `src/shared/ipc-contract.ts` | contract | n/a | No existing IPC contract; Phase 1 defines the seam all later phases import |
| `src/renderer/src/{App,components/*,screens/*}.tsx` | component | mixed | Reference is a marketing site with a different frame; app-shell composition is original to Phase 1 (UI-SPEC governs) |
| `tsconfig*.json`, `src/renderer/index.html` | config | n/a | electron-vite scaffold emits these; no brand/reference content |
| `vitest.config.ts`, `playwright.config.ts`, `test/**`, `e2e/**`, `.github/workflows/ci.yml` | test / config | n/a | No test harness exists yet; Wave 0 originates the whole VALIDATION surface |

## Metadata

**Analog search scope:** repo root (greenfield, confirmed only `CLAUDE.md` + `.planning/`); sibling refs `../themagnetgroup_website/{src/app,src/lib,src/components/ui,public/fonts}` and `../themagnetgroup/brand-guide/agents/`.
**External files scanned:** 6 (globals.css, components.json, utils.ts, layout.tsx, badge.tsx, tokens.json) + font-dir + repo listings.
**Blueprint source:** `01-RESEARCH.md` (Patterns 1-6, Code Examples, Validation Architecture).
**Pattern extraction date:** 2026-07-22
