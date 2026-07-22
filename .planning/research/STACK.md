# Stack Research

**Domain:** Cross-platform desktop bill-entry app (document parsing + vision LLM + QuickBooks Online automation)
**Researched:** 2026-07-22
**Confidence:** HIGH on library/version choices, MEDIUM on the framework decision (judgment call that depends partly on builder skill)

## Headline Recommendation

**Build this as an Electron app (Electron 43.x) with a React 19 + Vite + TypeScript front end.**

The single most important reason: every backend capability this app needs (QuickBooks OAuth, an OpenAI-compatible client, PDF text extraction, image/HEIC preprocessing, SQLite, and OS-keychain secret storage) is a first-class, mature Node.js library, and Electron's own toolchain (`electron-builder` + `electron-updater` + `safeStorage`) gives you signing, private-GitHub auto-update, and OS-backed secret encryption out of the box. Tauri v2 is excellent and produces a far smaller, more secure binary, but it would force the entire backend to be rewritten in Rust for a single internal user, which raises build risk and slows a JS/TS-centric builder. For this specific app, Electron minimizes total build-and-ship headache. Full rationale in the Framework Decision section below.

---

## Recommended Stack

### Core Technologies

| Technology | Version | Purpose | Why Recommended |
|------------|---------|---------|-----------------|
| Electron | 43.2.0 (latest stable) | Cross-platform desktop shell (Chromium UI + Node.js backend) | Bundled Chromium gives identical rendering on Win/Mac (matters for a pixel-branded UI); Node main process runs the entire required library ecosystem natively; `safeStorage` + `electron-builder` + `electron-updater` solve secrets, signing, and auto-update with no extra native deps |
| React | 19.2.8 | UI framework for the review screen | Mature, huge component ecosystem, first-class TypeScript; the review grid is the heart of the product and React has the richest table/combobox tooling |
| Vite | 8.1.5 | Dev server + renderer bundler | Fast HMR, standard pairing with Electron via `electron-vite`; Tailwind v4 has a first-party Vite plugin |
| TypeScript | 7.0.x | Language across main + renderer | Type-safety across IPC boundary and around LLM/QBO payloads is high-value for a financial tool; 7.x is the current native-compiler release |
| TanStack Table | 8.21.3 | Headless engine for the editable review grid | Free (MIT), fully controllable; lets you build searchable per-row dropdowns + a Bill/Expense toggle + confidence flags with exact Magnet Group branding, without AG Grid Enterprise licensing |
| Tailwind CSS | 4.3.3 | Styling + design tokens | v4's CSS-first `@theme` maps cleanly to Magnet Group brand tokens (colors/fonts); pairs with shadcn/ui for accessible branded components |
| Zod | 4.4.3 | Deterministic validation layer | Schema-validate and coerce the LLM's structured output (amounts, dates, line items) before it ever reaches the review grid or QBO; this IS the "deterministic validation layer" in the pipeline |

### Supporting Libraries

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| shadcn/ui (+ Radix primitives) | current (copy-in components) | Accessible, brandable Combobox / Select / Dialog / Toggle | Vendor + category cells (searchable combobox), Bill-vs-Expense toggle, "Paid from" account picker, confirmation dialogs |
| unpdf | 1.6.2 | Digital-PDF text extraction (fast path) | Primary text extractor; clean `extractText` API, bundles PDF.js, zero native deps. Use its output length as the deterministic gate: near-empty text ⇒ treat PDF as image-based and route to vision |
| pdfjs-dist | 6.1.200 | Lower-level PDF.js (positions, page rendering) | Fall back here when you need coordinate/layout detail, or to render an image-only PDF page to a bitmap for the vision model |
| sharp | 0.35.3 | Image resize / EXIF auto-orient / re-encode | Downscale phone photos to ~1600-2048px on the long edge, fix rotation, re-encode to JPEG q~80 before base64-encoding for the vision model (cuts tokens and fixes sideways receipts) |
| heic-convert | 2.1.0 | HEIC/HEIF → JPEG (pure JS/WASM) | iPhones shoot HEIC by default and sharp's prebuilt binary cannot decode HEIC; run HEIC files through this first, then sharp. Avoids a custom libvips build |
| openai (official SDK) | 6.48.0 | OpenAI-compatible client (chat + vision + model list) | Point `baseURL` at OpenAI or OpenRouter; use `client.models.list()` for the dynamic model picker and image_url content parts for vision. Works unchanged against any OpenAI-compatible endpoint |
| intuit-oauth | 4.2.5 | Official Intuit OAuth 2.0 client | Handles the auth-code exchange and automatic token refresh for QuickBooks Online; the one piece of the QBO stack that is genuinely official and maintained |
| better-sqlite3 | 13.0.1 | Local SQLite (audit log, dedupe hashes, sent-txn ledger, undo state) | Synchronous, fastest, and by far the most ergonomic SQLite API; `electron-builder` auto-rebuilds it. (You already ship one native module, sharp, so this adds little marginal build cost) |
| Zod + a thin fetch wrapper | (Zod above) | Raw REST client for the QBO Accounting API | There is no official Node data SDK; call the v3 REST endpoints directly with `fetch` and validate responses with Zod. Cleaner and better-maintained than the community `node-quickbooks` package |

### Development Tools

| Tool | Purpose | Notes |
|------|---------|-------|
| electron-vite | Wires Vite (renderer) + esbuild (main/preload) for Electron | Standard modern scaffold; handles the main/preload/renderer split and HMR |
| electron-builder | 26.15.3 | Packaging, signing, notarization, installer generation | One config for NSIS (Win) + DMG/zip (Mac universal); auto-runs `@electron/rebuild` for native modules |
| electron-updater | 6.8.9 | Auto-update client | Supports a **private GitHub** provider via a `GH_TOKEN`/`token` on the client; the most battle-tested private-repo update path |
| @electron/notarize | 3.1.1 | Apple notarization step | Invoked by electron-builder during Mac builds |
| @electron/rebuild | 4.2.0 | Rebuild native modules against Electron ABI | Invoked automatically by electron-builder's `install-app-deps`; only relevant for sharp + better-sqlite3 |

---

## Framework Decision: Electron vs Tauri v2 (the load-bearing choice)

Current stable versions: **Electron 43.2.0** (Jul 2026, ~2-month cadence) and **Tauri 2.10.1** (Mar 2026).

### Decision: Electron. Confidence: MEDIUM-HIGH for this app.

| Criterion | Electron 43 | Tauri v2.10 | Edge for THIS app |
|-----------|-------------|-------------|-------------------|
| Backend library ecosystem | Full Node.js: intuit-oauth, openai SDK, unpdf/pdfjs, sharp+heic-convert, better-sqlite3, safeStorage | Rust crates: reqwest, oauth2, pdfium/lopdf, image, rusqlite, keyring, async-openai (no QBO SDK, HEIC in Rust is painful) | **Electron, strongly.** Everything needed already exists and is maintained in Node |
| Secret storage | `safeStorage` built in (Keychain on Mac, DPAPI on Win), no native dep | `tauri-plugin-stronghold` or `keyring` crate | Electron (built in, zero extra deps) |
| Auto-update (private GitHub) | electron-updater private-GitHub provider, very mature | Updater plugin needs a JSON endpoint + signed artifacts; private repo needs an auth'd feed/proxy | Electron (most proven private-repo path) |
| Code signing + notarization | electron-builder + @electron/notarize, mature | Built into tauri bundler, also good | Roughly even; both require Apple Developer ($99/yr) + Authenticode/Azure Trusted Signing |
| UI consistency across OS | Bundled Chromium ⇒ identical render | System WebView2 (Win) / WKWebView (Mac) ⇒ minor differences | Electron (better for a pixel-branded UI) |
| Bundle size | ~100-150 MB installed | ~3-10 MB installed | Tauri, but **irrelevant** for one internal user |
| Idle memory / footprint | Higher | Lower | Tauri, but irrelevant at this scale |
| Security surface | Larger; needs contextIsolation on, nodeIntegration off, strict IPC | Smaller by default | Tauri, but Electron is safe with standard hardening |
| Builder velocity (JS/TS builder) | High | Lower (Rust backend for OAuth, PDF, image, DB) | Electron |

### Why Electron wins here specifically

1. **The whole backend already exists in Node and is maintained.** QBO OAuth (`intuit-oauth`), the OpenAI-compatible client (`openai`), PDF text (`unpdf`/`pdfjs-dist`), image + HEIC (`sharp` + `heic-convert`), and SQLite (`better-sqlite3`) are all first-class. In Tauri you would reimplement each in Rust, including HEIC decode and raw QBO REST, for one internal user. That is pure build risk with no user-visible payoff.
2. **"Low deployment headache" is best served by the Electron toolchain.** `electron-builder` (signing/notarization/installers) + `electron-updater` (private-GitHub auto-update) + `safeStorage` (OS-keychain secrets) are the three exact pain points called out in the requirements, and they are batteries-included.
3. **The one advantage Tauri clearly wins (tiny binary) does not matter** for a single non-technical user installing an internal tool. Memory and disk are non-constraints here.
4. **The builder is JS/TS-centric.** For a financial tool where correctness of token refresh, dedupe, and posting matters, staying in a familiar ecosystem reduces the chance of subtle bugs.

### When Tauri v2 would be the right call instead

- If the builder were fluent in Rust (the backend crates all exist: `oauth2`, `reqwest`, `rusqlite`, `keyring`, `image`, `pdfium-render`, `async-openai`).
- If end-user footprint, memory, or a hardened security posture were primary goals (e.g., wide public distribution).
- If you wanted the smallest possible attack surface for handling financial credentials and were willing to pay the Rust build cost.

Neither condition holds for NicoleBooks, so Electron is the recommendation.

---

## Area-by-Area Detail (answers the 9 sub-questions)

### 1. Desktop framework
Electron 43.2.0. See the decision table above. Harden it: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, a narrow `contextBridge` preload exposing only typed IPC channels, and a strict CSP. All network + filesystem + DB + secrets work happens in the main process; the renderer is pure UI.

### 2. Front-end UI layer
React 19 + Vite 8 + TypeScript 7 + Tailwind 4 + shadcn/ui, with **TanStack Table 8.21.3** driving the review grid.
- Vendor / category / "Paid from" account cells: a searchable **Combobox** (shadcn/ui on Radix) fed by lists pulled from QBO.
- Transaction-type control: a per-row **Toggle / SegmentedControl** (Bill vs Expense); Expense rows reveal the "Paid from" account combobox.
- Amount: an inline numeric input validated by Zod.
- Low-confidence fields: render a warning badge/row highlight driven by the confidence score attached during validation.
- Data volume is tiny (5-20 bills/week, a handful of rows visible), so you do **not** need heavy grid virtualization. If you later want it, add `@tanstack/react-virtual` (3.14.8).

Why not AG Grid: AG Grid Community (36.0.2) is batteries-included and has an editable `agSelectCellEditor`, but that editor is a plain non-searchable HTML `<select>`; the **searchable** Rich Select editor is AG Grid **Enterprise** (paid per-developer license). For long vendor/category lists you want search, and TanStack + a Combobox gives that for free with full branding control. AG Grid Community remains a fine alternative if you accept plain-select dropdowns.

### 3. Digital PDF text extraction (fast path)
**unpdf 1.6.2** as the primary extractor (clean `extractText`, bundles PDF.js, no native build). Use extracted-text length as the deterministic router: if a "digital" PDF yields near-empty text, it is actually a scan, so fall back to the vision path. Keep **pdfjs-dist 6.1.200** available for position/layout-aware extraction and for rendering image-only PDF pages to bitmaps to feed the vision model. Avoid `pdf-parse` (wraps an old PDF.js build, weakly maintained).

### 4. Image handling / preprocessing before vision
Pipeline: detect HEIC by magic bytes/extension → if HEIC, `heic-convert 2.1.0` (pure-JS/WASM) to JPEG → `sharp 0.35.3` to EXIF auto-orient, downscale to ~1600-2048px long edge, re-encode JPEG q~80 → base64 for the model. This fixes sideways phone receipts, strips huge dimensions (token cost), and sidesteps the fact that sharp's prebuilt binary cannot decode HEIC. Electron's built-in `nativeImage` can resize JPEG/PNG if you ever want to drop the sharp native dependency, but it also cannot decode HEIC, so `heic-convert` stays either way.

### 5. Vision + OpenAI-compatible LLM access
Use the official **openai 6.48.0** SDK with a configurable `baseURL` (OpenAI: `https://api.openai.com/v1`; OpenRouter: `https://openrouter.ai/api/v1`) and the user's key.
- **Dynamic model listing:** `await client.models.list()` (GET `/models`) populates the picker.
- **Vision input:** send chat messages whose `content` is an array mixing `{type:"text"}` and `{type:"image_url", image_url:{url:"data:image/jpeg;base64,..."}}` parts. Identical shape on OpenAI and OpenRouter.
- **Vision-capability detection differs by provider, and this is the key gotcha:**
  - **OpenRouter** returns rich metadata per model. Check `architecture.input_modalities` for `"image"` (values look like `["text","image","file"]`); `supported_parameters` also tells you about `tools`, `structured_outputs`, `response_format`, etc. So on OpenRouter you can filter the picker to vision-capable models automatically and even flag structured-output support.
  - **OpenAI's** `GET /v1/models` returns only minimal fields per model (`id`, `object`, `created`, `owned_by`) with **no capability metadata**. You cannot detect vision from the list response. Handle this with a curated allowlist/regex of known vision families (e.g., `gpt-4o*`, `gpt-4.1*`, `gpt-5*`, `chatgpt-4o*`, vision-capable `o`-series), or a probe-and-fallback, and surface an "unknown capability" state rather than guessing.
  - Design the model picker around a `detectVision(model)` function that uses OpenRouter metadata when present and falls back to the allowlist otherwise; store the chosen model and its detected capability in settings.
- Prefer JSON/structured outputs (Zod-validated) so the deterministic layer has a firm schema to check.

### 6. QuickBooks Online API access
- **Base URLs:** production `https://quickbooks.api.intuit.com/v3/company/{realmId}/...`, sandbox `https://sandbox-quickbooks.api.intuit.com/v3/company/{realmId}/...`. Build and test against **sandbox first** (matches the project's gated-credentials plan).
- **Always pass an explicit `minorversion` query param** (pin the latest documented value, ~70+ as of 2025-2026; verify against Intuit's "minor versions" changelog) so response shapes are stable.
- **SDK reality:** Intuit's only genuinely official, maintained Node package is **`intuit-oauth` 4.2.5** (OAuth 2.0 + token refresh). There is **no official Node data SDK**. The community `node-quickbooks` (2.0.50) exists and still gets occasional updates but is a callback-era wrapper; the newer TypeScript `quickbooks-api` (0.12.0) is promising but young/low-adoption. **Recommendation: use `intuit-oauth` for auth and call the v3 REST endpoints directly with `fetch`, validating responses with Zod.** You touch a small surface (Bill, Purchase, Vendor, Account, Item, plus the SQL-like `query` endpoint, and void for undo), so raw REST is cleaner and lower-risk than adopting a stale wrapper.
- **OAuth flow for a desktop app:** authorization-code grant, scope `com.intuit.quickbooks.accounting`. Catch the redirect with a short-lived localhost loopback HTTP server (or a registered custom protocol). `intuit-oauth` performs the token exchange and refresh. Access token lives ~1 hour; the refresh token rolls (~100 days, reissued periodically) so **persist the newest refresh token after every refresh**.
- **Token storage:** encrypt tokens with `safeStorage` and persist the ciphertext in the local SQLite DB or app-data file (see areas 7-8). Never write tokens to the repo or plaintext config.

### 7. Local persistence
**better-sqlite3 13.0.1.** Synchronous, fastest, most ergonomic SQLite binding; ideal for the audit log, file-hash dedupe table, sent-transaction ledger (with returned QBO IDs for undo), and undo/last-batch state. `electron-builder`'s `install-app-deps` auto-rebuilds it against Electron's ABI. Alternative: Node's built-in **`node:sqlite`** (stabilized in recent Node, shipped inside Electron) needs no native rebuild, but is more verbose and less mature; choose it only if you drop sharp and want a zero-native-module build. Since sharp already forces native-module handling, better-sqlite3's ergonomics win.

### 8. Secure secret storage
**Electron `safeStorage`** (built in). It encrypts via OS-provided crypto: Keychain on macOS, DPAPI on Windows. Use the async API (`encryptStringAsync`/`decryptStringAsync`) and store only ciphertext (in SQLite or app-data). This covers both the QBO tokens and the OpenAI-compatible key with **no extra native dependency**. **Do NOT use `keytar`** (7.9.0) - it was archived/unmaintained since Dec 2022 (the same reason VS Code migrated off it). Do not use `electron-store` for secrets (its "encryption" is obfuscation, not OS-backed). Never commit secrets or write them to plaintext config.

### 9. Packaging / distribution / auto-update (private GitHub, magnetgrouplabs org)
**electron-builder 26.15.3 + electron-updater 6.8.9.**
- Targets: NSIS installer (Windows), DMG + zip (macOS, build a universal arm64+x64 binary so any Mac works).
- **Signing/notarization:** Apple Developer ID + notarization via `@electron/notarize` (needs Apple Developer, $99/yr); Windows Authenticode via a cert. **Azure Trusted Signing** is the low-cost modern option for the Windows cert (post-2023 rules require HSM/cloud signing rather than a plain `.pfx`).
- **Private-repo auto-update:** set publish `provider: "github"`, `private: true`, `owner: "magnetgrouplabs"`, and supply a fine-grained GitHub token to the updater on the client (`GH_TOKEN`/`token`). For a single trusted user this is acceptable; if you want to avoid shipping a token, front the release feed with a tiny authenticated proxy. Update checks cost ~3 GitHub API requests each (5000/hr limit), a non-issue at this volume.
- Automate builds with GitHub Actions (matrix: macos + windows runners) so signed, notarized artifacts publish to the private repo's Releases on tag.

---

## Installation

```bash
# Scaffold (electron-vite gives the main/preload/renderer split)
npm create @quick-start/electron@latest nicolebooks -- --template react-ts

# UI layer
npm install react@19 react-dom@19 @tanstack/react-table@8 zod@4
npm install -D tailwindcss@4 @tailwindcss/vite
# shadcn/ui components are added via its CLI (copy-in), built on Radix

# Backend capabilities (run in the Electron main process)
npm install openai@6 intuit-oauth@4 unpdf@1 pdfjs-dist@6 sharp@0.35 heic-convert@2 better-sqlite3@13

# Packaging / update / signing
npm install -D electron@43 electron-builder@26 electron-updater@6 @electron/notarize@3

# Optional
npm install @tanstack/react-virtual@3   # only if the grid ever needs virtualization
```

## Alternatives Considered

| Recommended | Alternative | When to Use Alternative |
|-------------|-------------|-------------------------|
| Electron 43 | Tauri v2.10 (Rust) | Builder is Rust-fluent, or tiny binary / hardened footprint is a primary goal (not the case here) |
| TanStack Table + shadcn Combobox | AG Grid Community 36 | You prefer batteries-included and accept a non-searchable plain-`select` dropdown editor |
| TanStack Table + shadcn Combobox | AG Grid Enterprise 36 | You want a searchable rich-select editor out of the box and will pay the per-developer license |
| Raw QBO REST + intuit-oauth | node-quickbooks 2.0.50 | You want a higher-level wrapper and accept callback-era, thinly-maintained code |
| Raw QBO REST + intuit-oauth | quickbooks-api 0.12.0 (TS) | You want a typed SDK and accept a young, low-adoption dependency |
| better-sqlite3 13 | node:sqlite (built-in) | You drop sharp and want zero native modules to rebuild |
| unpdf | pdfjs-dist directly | You need coordinate/layout-level extraction or PDF-to-image rendering |
| safeStorage | tauri-stronghold / keyring crate | Only relevant if you pick Tauri instead |

## What NOT to Use

| Avoid | Why | Use Instead |
|-------|-----|-------------|
| keytar (7.9.0) | Archived/unmaintained since Dec 2022; the reason major apps migrated off it | Electron `safeStorage` (built in, OS keychain/DPAPI) |
| electron-store for secrets | Its "encryption" is obfuscation with a discoverable key, not OS-backed | `safeStorage` ciphertext persisted in SQLite/app-data |
| pdf-parse | Wraps an old PDF.js build, weak maintenance | unpdf (modern PDF.js wrapper) |
| node-quickbooks as the primary API layer | Callback-era, thin maintenance, not official | intuit-oauth (official OAuth) + raw v3 REST validated by Zod |
| AG Grid Enterprise (by default) | Paid per-dev license for the searchable editor you can build free | TanStack Table + shadcn Combobox |
| Tauri for this app (default) | Forces a full Rust backend reimplementation for one internal user | Electron |
| sharp's prebuilt binary for HEIC | Prebuilt libvips cannot decode HEIC (patent-encumbered) | heic-convert (WASM) for decode, then sharp for resize/orient |
| nodeIntegration in the renderer | Security hole for an app handling financial credentials | contextIsolation + sandbox + narrow contextBridge IPC |

## Stack Patterns by Variant

**If the builder later becomes Rust-comfortable or wants a tiny/hardened binary:**
- Switch the shell to Tauri v2.10; back it with `oauth2` + `reqwest` (QBO), `async-openai` (LLM), `pdfium-render` (PDF), `image` + a HEIC decoder (preprocessing), `rusqlite` (DB), `keyring` (secrets), and the Tauri updater plugin.
- Because you lose ~90 MB and gain a smaller attack surface, at the cost of reimplementing all backend logic.

**If searchable dropdowns are not required (short, fixed lists):**
- AG Grid Community 36 with `agSelectCellEditor` gives editable dropdowns and a Bill/Expense toggle with far less custom code.
- Because the plain-select editor is fine for short lists and virtualization/editing come free.

**If you want the absolute-lowest native-module count:**
- Use `node:sqlite` instead of better-sqlite3 and Electron `nativeImage` for resizing, keeping only `heic-convert` (WASM, no native build) for HEIC.
- Because it removes better-sqlite3 and sharp rebuild steps, at the cost of a more verbose DB API and losing sharp's speed/EXIF features.

## Version Compatibility

| Package A | Compatible With | Notes |
|-----------|-----------------|-------|
| electron@43 | better-sqlite3@13, sharp@0.35 | Both are native; electron-builder's `install-app-deps` rebuilds them against Electron's ABI. Re-run on every Electron major bump |
| electron-builder@26 | electron-updater@6 | Same maintainer; keep versions in step. app-update.yml is generated at build time |
| openai@6 | OpenAI + OpenRouter | Same SDK, just change `baseURL`; model-list metadata differs by provider (see area 5) |
| tailwindcss@4 | vite@8 (via @tailwindcss/vite) | v4 is CSS-first; use the Vite plugin, not the old PostCSS config |
| react@19 | @tanstack/react-table@8 | Fully supported; TanStack Table is version-agnostic to React 18/19 |
| sharp@0.35 | HEIC input | Not supported by the prebuilt binary; pre-convert HEIC with heic-convert first |

## Sources

- npm registry (`npm view <pkg> version`, 2026-07-22) - verified current versions for electron 43.2.0, electron-builder 26.15.3, electron-updater 6.8.9, @tanstack/react-table 8.21.3, sharp 0.35.3, better-sqlite3 13.0.1, intuit-oauth 4.2.5, node-quickbooks 2.0.50, openai 6.48.0, unpdf 1.6.2, pdfjs-dist 6.1.200, heic-convert 2.1.0, react 19.2.8, vite 8.1.5, tailwindcss 4.3.3, zod 4.4.3, @electron/notarize 3.1.1 - HIGH
- Tauri v2 docs (updater, macOS code signing) + release info (v2.10.1, Mar 2026) - HIGH
- Electron release timelines/endoflife + electron-builder Auto Update docs (private GitHub provider) - HIGH
- OpenRouter models API docs (`architecture.input_modalities` contains `"image"`; `supported_parameters` array) - HIGH for the field shape
- OpenAI models endpoint - minimal fields, no capability metadata (well-established; docs page was a UI, not schema) - MEDIUM-HIGH
- Intuit developer portal + npm (intuit-oauth official; no official Node data SDK; node-quickbooks community) - HIGH
- Electron safeStorage docs + keytar-archived reports (VS Code / others migrating off keytar) - HIGH
- Node.js `node:sqlite` built-in status vs better-sqlite3 rebuild tradeoff - HIGH
- sharp docs + issues (prebuilt binary lacks HEIC decode; needs custom libvips) - HIGH
- QBO base URLs (production/sandbox v3) from Intuit + multiple guides - HIGH; exact current `minorversion` number - MEDIUM (verify on Intuit changelog)

---
*Stack research for: cross-platform desktop bill-entry app with vision-LLM parsing + QuickBooks Online automation*
*Researched: 2026-07-22*
