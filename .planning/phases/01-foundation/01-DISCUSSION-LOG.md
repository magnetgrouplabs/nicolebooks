# Phase 1: Foundation - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md; this log preserves the alternatives considered.

**Date:** 2026-07-22
**Phase:** 1-Foundation
**Areas discussed:** Brand tokens, App shell shape, Secret-store proof, SQLite schema scope

---

## Brand tokens

### Q1: Where should the Magnet Group brand tokens come from?

| Option | Description | Selected |
|--------|-------------|----------|
| Brand file / path | You point me at an existing brand/token file to extract exact values | ✓ |
| Pull from website | Scrape a live Magnet Group site for colors and fonts | |
| You'll paste values | You hand me hex codes and font names directly | |
| Placeholders for now | Set up token architecture with neutral placeholders, swap later | |

**User's choice:** "you created it lol it should be in the magnet group website directory"
**Notes:** Located a complete, versioned Magnet Group design system. Chose `../themagnetgroup/brand-guide/agents/tokens.json` (W3C tokens v2026.06.1, "source of truth for brand and platform UI") as canonical, with `../themagnetgroup_website/src/app/globals.css` as a secondary reference. Use the existing system verbatim, do not invent values.

### Q2: How should NicoleBooks handle theming in v1?

| Option | Description | Selected |
|--------|-------------|----------|
| Light only | Ship light mode only, dark tokens stay unwired | |
| Light + dark (toggle) | Wire both palettes with an in-app toggle | |
| Light + follow OS | Support both palettes, follow the OS setting, no in-app toggle | ✓ |

**User's choice:** Light + follow OS
**Notes:** Window follows `prefers-color-scheme` / Electron `nativeTheme`. Tokens.json fully defines the dark palette, so this is mostly plumbing.

---

## App shell shape

### Q1: What should the Phase 1 window actually render?

| Option | Description | Selected |
|--------|-------------|----------|
| App frame scaffold | Persistent branded chrome (header + nav to Bills/History/Settings) with placeholder screens | ✓ |
| Minimal proof-of-life | A single centered branded window that just proves it launches | |
| Frame, no nav yet | Branded header plus one content region, nav added later | |

**User's choice:** App frame scaffold
**Notes:** UI hint is yes for this phase; the token system already ships app-layout primitives. Establishing the branded frame once means later phases drop into a consistent shell.

### Q2: How should the app frame present navigation?

| Option | Description | Selected |
|--------|-------------|----------|
| Left sidebar (labeled) | Persistent 280px labeled sidebar, content region to the right | ✓ |
| Top tab bar | Horizontal nav row under the header | |
| Compact icon rail | Narrow icon-only rail with hover labels | |

**User's choice:** Left sidebar (labeled)
**Notes:** Standard desktop-bookkeeping convention (QuickBooks uses a left nav), clearest for a non-technical user, matches the token system's sidebarWidth and structural tokens. Destinations: Bills, History, Settings.

---

## Secret-store proof

### Q1: How should Phase 1 prove the OS-keychain round-trip works?

| Option | Description | Selected |
|--------|-------------|----------|
| Real path + health check | Keychain service + typed secrets IPC, proven with a canary and a permanent "Secret store: OK" indicator on Settings | ✓ |
| Internal test only | Proven by an automated main-process test, no UI/IPC path in Phase 1 | |
| Throwaway dev field | Temporary "store test secret" input, removed in Phase 3 | |

**User's choice:** Real path + health check
**Notes:** Also exercises the IPC trust boundary (Success Criteria 4). Nothing built here is thrown away; the health check is permanent and becomes the home for Phase 3/4 settings.

### Q2: Where should the safeStorage ciphertext blob be persisted?

| Option | Description | Selected |
|--------|-------------|----------|
| Dedicated app-data file | Ciphertext in userData/secrets.enc, SQLite stays secret-free | ✓ |
| SQLite table (ciphertext) | Encrypted blob in a SQLite table, one transactional store | |
| You decide | Default to the app-data file unless research says otherwise | |

**User's choice:** Dedicated app-data file
**Notes:** Resolves the tension between the stack's "safeStorage ciphertext in SQLite/app-data" and Success Criteria 2's "no secret in the SQLite database." Keeping SQLite completely secret-free satisfies SC2 literally and removes audit ambiguity for a financial tool.

---

## SQLite schema scope

### Q1: How much SQLite schema should Phase 1 lay down?

| Option | Description | Selected |
|--------|-------------|----------|
| Plumbing + grow per phase | Migration runner + version table + minimal app_settings table; feature tables added by their owning phases | ✓ |
| Pre-provision known tables | Also create audit log, ledger, dedupe, parsed-results tables now | |
| You decide | Default to plumbing + grow-per-phase | |

**User's choice:** Plumbing + grow per phase
**Notes:** Avoids designing later phases' schemas (for example Phase 7's audit log) before those phases understand the shape. The app_settings table gives SC3 ("data survives a restart") a real thing to write and read back.

---

## Claude's Discretion

Offered under "Explore more gray areas" but not discussed; left to research and planning:
- Migration engine mechanics (default: forward-only, user_version-based, hand-rolled with better-sqlite3).
- IPC channel naming and organization conventions.
- Window default/minimum size and single-instance-lock behavior.
- Cross-platform dev and build scaffolding via electron-vite.
- The testing approach that proves launch and keychain round-trip on both Windows and Mac.

## Deferred Ideas

None. The discussion stayed within Phase 1 scope.
