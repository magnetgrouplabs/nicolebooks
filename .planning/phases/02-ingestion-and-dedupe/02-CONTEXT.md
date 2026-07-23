# Phase 2: Ingestion and Dedupe - Context

**Gathered:** 2026-07-23
**Status:** Ready for planning

<domain>
## Phase Boundary

Phase 2 delivers the ingestion front-door. Nicole drops bill files into one flat `Inbox` folder, hits a manual "Scan now", and the app loads every supported file, stamps the batch with today's date, computes a SHA-256 hash per file to skip-and-flag exact duplicates it has already posted to QuickBooks, and only touches files that have fully landed on disk (guarding against cloud-sync placeholders and partial writes). The scan is read-only on the inbox: no moving, renaming, or deleting. The phase ends at "loaded for processing."

Downstream is out of scope here: parsing/field extraction (Phase 3), reconciliation (Phase 5), the rich editable review table (Phase 6), posting/audit/archiving (Phase 7).

**Requirements in scope:** ING-01, ING-02, ING-03, ING-04, ING-05 — this discussion deliberately reshaped the ingestion model (flat inbox + processing-date instead of user-dated folders), and REQUIREMENTS.md + ROADMAP.md have already been revised to match (done 2026-07-23, commit f184d0a). ING-01..04 and Phase 2 goal/success-criteria now reflect the flat-inbox / processing-date model; IDs and the 48/48 count are preserved. Plan and verify against the current ROADMAP/REQUIREMENTS.

</domain>

<decisions>
## Implementation Decisions

### Ingestion Model and Scan Trigger
- **D-01:** Single flat inbox folder — no date-named input subfolders. Nicole just dumps every bill in. Configured once in Settings. On first run the app offers a default it creates under the OS documents dir (e.g. `Documents/NicoleBooks/Inbox`) which she can repoint anywhere. The chosen path persists in the Phase 1 `app_settings` table (e.g. key `inbox_path`), reusing the existing `settings:get/set` IPC channel — no new settings plumbing.
- **D-02:** The inbox folder is named `Inbox` (under a `NicoleBooks` parent). Chosen for a clean pairing with a future `Posted`/`Archive` output folder.
- **D-03:** The scan is manual, triggered by a "Scan now" button on the Bills screen. One-shot snapshot of the inbox at click time. No background watcher (that is V2-03).
- **D-04:** Phase 2 is strictly read-only on the inbox. Files are never moved, renamed, or deleted here. (Moving to a dated archive is deferred to Phase 7 — see Deferred Ideas.)

### Entry Date
- **D-05:** The entry date for a scanned batch is the processing date (the day the scan runs), assigned by the app. Phase 2 does NOT parse any date from folder or file names and does NOT prompt for a date. This intentionally drops ING-03 and Success Criterion 2, and rewrites ING-01 / Success Criterion 1.
- **D-06:** The entry date is editable per row later, in the Phase 6 review table. The bill's own printed date (extracted in Phase 3) can inform that edit, but the app does not auto-derive the entry date from parsed content in Phase 2.

### Deduplication
- **D-07:** Dedupe is exact-file only: SHA-256 over file bytes. Content near-duplicates (same vendor/amount/date but different bytes, e.g. a receipt photographed twice) are explicitly NOT this phase — that is Phase 6's duplicate warning (REVIEW-08).
- **D-08:** "Already processed" means already sent/posted to QuickBooks. Phase 2 builds the persistent dedupe-hash ledger table (new `migration0002`), computes each scanned file's hash, and checks it against the ledger. The write that marks a hash as sent/posted happens at post time in Phase 7. Consequence: re-scanning an inbox that still holds un-sent (pending) bills reloads them, because pending is not "processed."
- **D-09:** Duplicate presentation: a caught duplicate appears in the loaded results list, visibly flagged (e.g. "Already entered on <date>"), and is excluded from the batch by default, with a one-click "include anyway" override. Nothing silently dropped, nothing silently re-processed.
- **D-10:** Within-scan duplicates (two byte-identical copies in a single scan) are collapsed/flagged within that batch regardless of ledger state.

### Edge Cases — File Stability and Formats
- **D-11:** File materialization (SC4): the scan waits a brief bounded window for files that are actively settling (partial writes finish fast), then hashes/loads them. Files still not fully local (online-only cloud-sync placeholders on OneDrive/iCloud/Dropbox) are flagged "not downloaded yet, re-scan shortly" and skipped from the batch. The app does NOT attempt to force-download placeholders. A file is never hashed half-complete and never silently dropped.
- **D-12:** Supported formats (ING-05): text/scanned PDF, JPEG, PNG, HEIC. (Image-only-PDF vs text-PDF routing is Phase 3's concern; ingestion accepts all PDFs.) Unsupported user files (.docx, .zip, stray .txt, random screenshots) are not loaded but are surfaced in a "N files skipped (unsupported type)" summary listing their names, so a mis-saved bill is visible rather than lost.
- **D-13:** OS/system junk (`.DS_Store`, `Thumbs.db`, AppleDouble `._*`, hidden dotfiles) is silently ignored and does NOT appear in the unsupported-skipped summary.

### Post-Scan Results Surface (Phase 2 vs Phase 6)
- **D-14:** Phase 2 renders a minimal loaded-results surface on the Bills screen: a list of scanned files each with a status (loaded / duplicate-excluded / not-ready-skipped / unsupported-skipped) plus a one-line scan summary (e.g. "12 files: 9 loaded, 1 duplicate, 1 not downloaded, 1 unsupported") and the batch entry date. The rich editable review table (searchable vendor/category dropdowns, Bill/Expense toggle, amount editing) stays in Phase 6. Phase 2's job ends at "loaded for processing."

### Architecture / Trust Boundary (carried from Phase 1)
- **D-15:** All filesystem access, hashing, stability checks, and DB writes run in the Electron main process. The renderer touches none of it directly — it calls a new typed IPC channel group added to `src/shared/ipc-contract.ts`, handled following the `src/main/ipc/settings.ts` pattern (assertTrustedSender → Zod-parse payload with a shared schema → prepared statements). The native folder picker for "choose inbox" uses Electron `dialog.showOpenDialog` in main.
- **D-16:** The dedupe ledger is added via a new forward-only migration appended to `src/main/db/migrate.ts` (`migration0002`), mirroring the `0001_init.ts` STRICT-table pattern. Node's built-in `crypto.createHash('sha256')` is the hasher — no new dependency.

### Claude's Discretion
Standard approaches expected; research and planning may decide:
- Exact IPC channel names and payload/return shapes for the scan/dedupe group (follow the Phase 1 contract conventions).
- Exact dedupe-ledger schema (SHA-256 column plus provenance: first-seen timestamp, original filename, and a sent/posted marker or a reference the Phase 7 "mark sent" write targets). Phase 7 owns that write; Phase 2 defines the table and the read/check.
- The bounded-wait strategy and cross-platform detection mechanism for file stability — size-settling poll for partial writes; placeholder detection differs by OS (Windows `FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS` / offline attribute vs macOS `.icloud` sentinel / dataless files). Durations included. This is research territory.
- HEIC at ingestion vs Phase 3: default is Phase 2 recognizes the `.heic`/`.heif` type only and records it; the decode (heic-convert) is Phase 3.
- Minimal Bills-screen results UI (reuse Phase 1 shadcn components: EmptyState, Badge, Button).
- Empty-inbox / all-duplicates / all-skipped empty states and messaging.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

Paths are relative to the NicoleBooks repo root (`C:/Users/anthony/claude-projects/nicole_quickbooks`).

### Phase Requirements and Scope
- `.planning/ROADMAP.md` (Phase 2 section) — phase goal and the four success criteria. NOTE: SC1-SC2 need revision per D-05 (see Deferred → Requirements/roadmap revision).
- `.planning/REQUIREMENTS.md` — ING-01 through ING-05. ING-01 and ING-03 need revision per D-05.

### Foundation Seams (Phase 1 — MUST read before implementing)
- `.planning/phases/01-foundation/01-CONTEXT.md` — Phase 1 decisions: IPC trust boundary, migration mechanism (D-13/D-15), `app_settings` as the home for folder paths, Bills screen as Phase 2's UI home (D-09).
- `src/shared/ipc-contract.ts` — single source of truth for the IPC boundary; add the new scan/dedupe channel group here (types + channel-name constants only, zero runtime imports).
- `src/main/ipc/settings.ts` — the canonical handler pattern to copy (assertTrustedSender → Zod-parse → prepared statements); also shows the `app_settings` get/set the inbox path reuses.
- `src/shared/schemas.ts` — shared Zod schemas; add scan/dedupe payload schemas alongside `SettingsSetSchema`/`SettingsKeySchema`.
- `src/main/db/migrate.ts` — forward-only `user_version` migration runner; append `migration0002` to the `migrations` array (never renumber 0001).
- `src/main/db/migrations/0001_init.ts` — the STRICT-table migration pattern to mirror for the dedupe-hash table.
- `src/main/ipc/register.ts` — where IPC channel groups are registered after app 'ready'; register the new group here.
- `src/renderer/src/screens/BillsScreen.tsx` — currently an `EmptyState` placeholder; Phase 2's scan trigger + loaded-results surface replace/extend it.
- `src/renderer/src/components/` — reusable branded components (`EmptyState`, `HealthIndicator`, `ui/badge`, `ui/button`) for the results surface.

### Stack / Libraries
- `CLAUDE.md` (Technology Stack section) — locked libs relevant here: `better-sqlite3` (ledger), Node `crypto` (SHA-256, built in), `unpdf`/`pdfjs-dist` and `sharp`/`heic-convert` (PDF/image handling, mostly Phase 3), Electron `dialog` (folder picker). No new dependency needed for dedupe.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- **IPC contract + handler pattern** (`ipc-contract.ts`, `settings.ts`): add a scan/dedupe channel group; do not invent a new pattern.
- **`app_settings` table + `settings:get/set`**: stores the configured inbox path; no new settings storage needed.
- **Migration runner** (`migrate.ts`) + **`0001_init` STRICT pattern**: the dedupe-hash ledger is `migration0002`.
- **BillsScreen placeholder + EmptyState/Badge/Button**: build the loaded-results surface from these.
- **Node `crypto`** (built into Electron main): SHA-256 hashing, zero dependency.

### Established Patterns
- Renderer does zero direct fs/db/network; everything routes through typed IPC to main (Phase 1 trust boundary). Phase 2 honors this — all scanning/hashing/stability/DB work lives in main.
- Zod validation at the IPC boundary before any fs/DB work.
- Feature tables are added by their owning phase's own migration (D-15 from Phase 1); Phase 2 owns the dedupe-hash table.
- Forward-only, `user_version`-ratcheted migrations.

### Integration Points
- New IPC channel group (scan/dedupe) in `ipc-contract.ts`, registered in `register.ts`, handled in a new `src/main/ipc/` file (e.g. `ingestion.ts`) backed by a new `src/main/ingestion/` module for scan/hash/stability logic.
- New `migration0002` in `migrate.ts` for the dedupe-hash ledger.
- Bills screen (renderer) consumes the new channel to trigger a scan and render results.
- `app_settings` stores `inbox_path`.
- **Forward hook to Phase 7:** the ledger's "mark as sent/posted" write is a Phase 7 responsibility; Phase 2 defines the table and the read/check only.
- **Forward hook to Phase 3:** loaded files (with their processing-date stamp and file hash) are the input to the parse pipeline.

</code_context>

<specifics>
## Specific Ideas

- Anthony reframed the ingestion model mid-discussion: away from user-dated input folders toward a single flat inbox the user just dumps into, with dating and archiving handled by the app on the output side after posting. Mental model: "drop everything in one place, the app sorts it out."
- The inbox should feel zero-effort for Nicole: set once, then just "drop and scan." No folder-naming discipline required of her.
- Visibility over silence is a throughline: duplicates, not-ready files, and unsupported files are all surfaced (flagged or summarized), never silently dropped — a silently-lost bill is the worst outcome for a non-technical accounts-payable user.

</specifics>

<deferred>
## Deferred Ideas

- **App-created dated-subfolder archive (Phase 7):** after a bill posts to QuickBooks, move its source file into a `Posted`/`Archive` folder under an app-created dated subfolder. Belongs in Phase 7 (post/audit), because "processed" only truly means "in the books" after posting. Pairs with the `Inbox` naming chosen here (D-02).
- **Requirements/roadmap revision (DONE 2026-07-23, commit f184d0a):** REQUIREMENTS.md and ROADMAP.md were updated to match the flat-inbox / processing-date model — repurposed ING-03 from folder-name date parse/prompt to the skip/materialization guarantee, rewrote ING-01/ING-02/ING-04, and revised the Phase 2 goal and Success Criteria 1-3. Entry date is now the processing date. IDs and the 48/48 mapping are preserved, so `gsd-verifier` will check Phase 2 against the correct criteria. No open action remains here.
- **Background auto-watcher (already tracked as V2-03):** explicitly not this phase; the scan stays manual.

</deferred>

---

*Phase: 2-Ingestion and Dedupe*
*Context gathered: 2026-07-23*
