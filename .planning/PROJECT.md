# NicoleBooks

## What This Is

NicoleBooks is a cross-platform (Windows and Mac) desktop app that automates bill entry into QuickBooks Online. The user drops bill documents (digital PDFs and photos of paper receipts) into a folder named for the intended entry date. The app parses each document for vendor, amount, category, and line items, reconciles those against records that already exist in the connected QuickBooks company, and presents a branded review table with editable dropdowns. After the user adjusts anything and approves, the app posts the entries to QuickBooks Online as Bills or Expenses.

It is built for a single non-technical end user (Nicole) who currently enters her stepdad's service-business bills into QuickBooks Online by hand. Anthony is the builder and deployer.

## Core Value

Turn a folder of mixed bill documents into correctly categorized, non-duplicate QuickBooks Online entries that a non-technical user can review and approve with confidence, in a fraction of the time manual entry takes.

## Requirements

### Validated

(None yet, ship to validate)

### Active

- [ ] User drops bill files (PDF and image) into a folder named for the entry date, and the app loads them on a manual scan
- [ ] App extracts vendor, amount, category, and line items from each document (mixed digital PDFs and photos)
- [ ] Parsing uses programmatic text extraction for digital PDFs plus a vision-capable model for structuring, with a deterministic validation layer
- [ ] App reconciles extracted vendor, category, and items against existing QuickBooks records and prefers existing matches over creating new ones when a reasonable fit exists
- [ ] Each parsed bill is presented in a review table with editable dropdowns for vendor and category and an editable amount field
- [ ] Each row supports a transaction type control (unpaid Bill vs already-paid Expense), and Expense rows expose a "Paid from" account picker
- [ ] Review table codes each bill to a single expense category (multi-line itemized splitting deferred to v2)
- [ ] Low-confidence parsed fields are flagged so the user double-checks them
- [ ] User clicks "Send to QuickBooks" and approved entries post to QuickBooks Online via the API
- [ ] Strong duplicate guardrails: file-hash dedupe, warnings on likely duplicates (vendor plus amount plus date), and an audit log of everything sent with returned QuickBooks IDs
- [ ] Undo-last-batch: one-click void in QuickBooks of the most recent batch if something went wrong
- [ ] After sending, the app produces a batch summary the user can save or print
- [ ] Settings: user enters an OpenAI-compatible API key, the app pulls available models, and the user picks the model to use
- [ ] App is branded with the real NicoleBooks logo (a crimson stiletto over stacked pages) in the header, on a color scheme taken from that logo. Type and the surface/spacing scales are still the Magnet Group tokens; the accent colors are not.
- [ ] User connects the app to QuickBooks Online via OAuth and the connection stays alive through automatic token refresh

### Out of Scope

- Attaching the original source file to the QuickBooks entry: deferred to a later version to keep v1 API surface smaller (easy to add later via the Attachable API)
- Multi-company or multi-user support: this serves one user and one QuickBooks company
- Payroll, invoicing, or any QuickBooks feature beyond bill and expense entry: out of scope, the tool is focused on accounts-payable data entry
- Mobile app: this is a desktop tool
- Accounting judgment beyond category suggestion: the app suggests and reconciles, the human approves; it does not make final accounting decisions unattended

## Context

- The current manual process: Nicole opens each bill and types the vendor, amount, and category into QuickBooks Online by hand. Low volume (roughly 5 to 20 bills per week, about once a week), so reliability and clarity matter more than raw throughput.
- The stepdad's business is a service business, so most bills map to expense categories rather than inventory items, though some bills are itemized across multiple lines.
- Documents are a mix of real-text digital PDFs (emailed or downloaded invoices) and photos or scans of paper receipts, so the parser cannot rely on text extraction alone and needs vision.
- Anthony intends to point the OpenAI-compatible key at OpenAI or OpenRouter, both of which expose vision-capable models. The model picker should surface available models and ideally indicate vision capability.
- QuickBooks access is not available yet. When wiring and testing time comes, Anthony will sign up for a QuickBooks Online trial, register an Intuit developer app, and provide client ID, client secret, and redirect URI. Development should target the QuickBooks sandbox company first.
- Deployment target: a private repository on the magnetgrouplabs GitHub organization.
- Anthony's end user's actual OS is not confirmed, so both Windows and Mac are treated as equal priority from day one.

## Constraints

- **Compatibility**: Must run on both Windows and Mac. Cross-platform is a hard requirement, not a preference.
- **Tech stack**: Desktop app framework to be chosen during research (Tauri/Rust vs Electron were both floated by Anthony). Priority is low deployment headache across both platforms, including code signing and updates.
- **AI**: Parsing must handle image-based documents, so the configured model must be vision-capable. The AI layer is an OpenAI-compatible client with user-supplied key, dynamic model listing, and user model selection.
- **Dependencies**: QuickBooks Online API (OAuth 2.0, Bill and Purchase entities, vendor/account/item lookups, attachments deferred). Intuit developer app required. Live testing is gated on Anthony providing credentials.
- **Security**: Handles financial documents and API credentials (QuickBooks tokens, OpenAI-compatible key). Secrets must be stored securely on the local machine, never committed to the repo.
- **Data**: Local persistence (audit log, dedupe hashes, sent-transaction records) so guardrails and undo work across runs.
- **Budget**: Low volume means AI cost is negligible; optimize for accuracy and clarity over cost.

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Hybrid parse pipeline (programmatic text extraction for digital PDFs, vision model for structuring, deterministic validation and reconciliation) | Mixed PDF and photo inputs make pure programmatic parsing unreliable; always structuring with a vision model is robust, while programmatic extraction keeps digital PDFs cheap and accurate and deterministic checks catch errors | Pending |
| Support both Bill and Expense QuickBooks objects with a per-row type control | User confirmed a mix of unpaid bills and already-paid receipts, which are distinct QuickBooks entities | Pending |
| Per-row "Paid from" account picker for Expense rows | QuickBooks requires a source account for already-paid purchases | Pending |
| Local SQLite ledger for dedupe, audit log, and undo support | User chose strong guardrails; durable local state is needed for duplicate detection and one-click undo across runs | Pending |
| OpenAI-compatible AI client with dynamic model listing and user selection | Explicit user requirement; keeps provider flexible (OpenAI, OpenRouter) and future-proof | Pending |
| QuickBooks integration built and tested against sandbox first, with a hard pause for live credentials | Anthony lacks QuickBooks access now; sandbox lets everything else proceed and de-risks the live wire-up | Pending |
| Defer source-file attachment to QuickBooks entries | User did not select it for v1; reduces initial API surface | Pending |
| Electron chosen over Tauri/Rust for the desktop framework | Node backend ecosystem covers every dependency (intuit-oauth, OpenAI SDK, PDF, sharp+HEIC, better-sqlite3, safeStorage); builder is JS/TS not Rust; safeStorage plus electron-builder plus electron-updater give the lowest deployment headache. User confirmed 2026-07-22 after reviewing the research reasoning. | Confirmed |
| Brand the app on the NicoleBooks logo rather than Magnet Group (2026-07-27) | The user supplied a real NicoleBooks logo, a crimson stiletto over stacked pages, which retires two earlier assumptions: that the product had no logo and would ship a plain text wordmark, and that it would carry Magnet Group's colors. Magnet Group is the builder, not the client, so its electric violet was only ever a placeholder. The header now renders the logo lockup and the accent palette is taken from the artwork: primary, ring, info and chart-1 move from #6c00ff to the logo's #910023 crimson, and the accent moves from lavender to a rose tint of it. Type, surfaces, spacing and radius stay on the inherited Magnet Group scales. | Confirmed |
| Dark mode needs a second logo asset (2026-07-27, open) | The supplied lockup is light-background only. Its wordmark uses just two inks, #910023 and #000000, which measure 1.52:1 and 1.46:1 on the dark header surface, so the wordmark vanishes when the OS is in dark mode and the theme follows the OS live. Shipped a white knockout as a stopgap; CSS filter alternatives either recolor the crimson to the wrong hue or come out lopsided against the artwork's dead canvas. Wants a proper dark variant from the designer. | Open |

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `/gsd-transition`):
1. Requirements invalidated? Move to Out of Scope with reason
2. Requirements validated? Move to Validated with phase reference
3. New requirements emerged? Add to Active
4. Decisions to log? Add to Key Decisions
5. "What This Is" still accurate? Update if drifted

**After each milestone** (via `/gsd:complete-milestone`):
1. Full review of all sections
2. Core Value check, still the right priority?
3. Audit Out of Scope, reasons still valid?
4. Update Context with current state

---
*Last updated: 2026-07-22 after initialization*
