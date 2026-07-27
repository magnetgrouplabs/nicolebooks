# Requirements: NicoleBooks

**Defined:** 2026-07-22
**Core Value:** Turn a folder of mixed bill documents into correctly categorized, non-duplicate QuickBooks Online entries that a non-technical user can review and approve with confidence, in a fraction of the time manual entry takes.

## v1 Requirements

Requirements for the initial release. Each maps to a roadmap phase.

### Ingestion (ING)

- [x] **ING-01**: User can drop bill files (PDF and image) into a single flat inbox folder, and the app loads them on a manual scan and stamps the batch with the processing date as its entry date
- [x] **ING-02**: User configures the inbox once in Settings (the app creates a sensible default), then triggers a manual "Scan now" to load its supported bill files for processing
- [x] **ING-03**: App skips files that are unsupported or not fully materialized (cloud-sync placeholders, partial writes) and surfaces skipped files in a summary rather than silently dropping them
- [x] **ING-04**: App computes a SHA-256 file hash for each document and skips-and-flags any exact file it has already posted to QuickBooks (excluded by default, with an override)
- [x] **ING-05**: App accepts common bill formats: text PDFs, scanned or photographed images (JPEG, PNG), and iPhone HEIC photos

### AI Configuration (AI)

- [x] **AI-01**: User can enter an OpenAI-compatible API key and base URL in settings, stored securely in the OS keychain
- [x] **AI-02**: App fetches the list of available models from the configured endpoint and lets the user pick one
- [x] **AI-03**: App flags or filters for vision-capable models so the user does not select a text-only model for image parsing
- [x] **AI-04**: User can change the selected model at any time from settings

### Parsing (PARSE)

- [x] **PARSE-01**: For text PDFs, app extracts embedded text programmatically before calling the model
- [x] **PARSE-02**: For photos and scans, app prepares the image (orient, resize, HEIC decode) before calling the model
- [x] **PARSE-03**: App uses the configured vision model to extract structured fields from each bill: vendor, date, due date, reference or invoice number, subtotal, tax, total, and a suggested category
- [x] **PARSE-04**: App validates parsed data deterministically (subtotal plus tax equals total, dates parse, money stored as integer cents) and records per-field confidence signals
- [x] **PARSE-05**: App persists parsed results so a reload or crash never re-calls the paid model for the same document

### QuickBooks Connection (QBO)

- [ ] **QBO-01**: User can connect the app to a QuickBooks Online company through a guided OAuth sign-in
- [ ] **QBO-02**: App stores QuickBooks tokens securely in the OS keychain, never in plaintext or the local database
- [ ] **QBO-03**: App refreshes the access token proactively and persists the rotated refresh token on every refresh
- [ ] **QBO-04**: App shows a clear connection-health status and a one-click "Reconnect to QuickBooks" action when re-authorization is needed
- [ ] **QBO-05**: App reads the company's vendors, expense accounts, payment accounts, and items, cached per company (realm)

### Reconciliation (RECON)

- [ ] **RECON-01**: App matches each parsed vendor to existing QuickBooks vendors and pre-selects a confident match instead of creating a new vendor
- [ ] **RECON-02**: App maps each suggested category to an existing QuickBooks expense account, preferring existing accounts over creating new ones
- [ ] **RECON-03**: App creates a new vendor or account only when the user explicitly confirms it, never silently
- [ ] **RECON-04**: Category and "Paid from" dropdowns are filtered by the correct QuickBooks account type (expense categories vs bank or credit-card payment sources)

### Review (REVIEW)

- [ ] **REVIEW-01**: App presents all parsed bills in a single editable review table before anything is sent
- [ ] **REVIEW-02**: User can change the vendor for any row via a searchable dropdown of existing QuickBooks vendors
- [ ] **REVIEW-03**: User can change the category for any row via a searchable dropdown of existing QuickBooks expense accounts
- [ ] **REVIEW-04**: User can manually edit the amount for any row
- [ ] **REVIEW-05**: User can set each row's transaction type to unpaid Bill or already-paid Expense
- [ ] **REVIEW-06**: For Expense rows, user can select the "Paid from" bank or credit-card account
- [ ] **REVIEW-07**: App visually flags low-confidence fields and lets the user filter to the flagged rows
- [ ] **REVIEW-08**: App warns on likely duplicates (matching vendor, amount, and date against previously sent entries) before sending
- [ ] **REVIEW-09**: User can exclude or remove a row from the batch before sending

### Posting (POST)

- [ ] **POST-01**: User can click "Send to QuickBooks" to post all approved rows
- [ ] **POST-02**: App posts unpaid rows as QuickBooks Bill entities and already-paid rows as Purchase (Expense) entities, each coded to a single expense category
- [ ] **POST-03**: App attaches a persisted idempotency key (requestid) to every create so a retry never double-posts
- [ ] **POST-04**: App tracks per-row send state (pending, sent, confirmed, failed) and can resume a batch after a partial failure
- [ ] **POST-05**: App stores the returned QuickBooks Id and SyncToken for every posted entry

### Audit and Undo (AUDIT)

- [ ] **AUDIT-01**: App keeps a local audit log of every entry sent, including QuickBooks Id, entity type, company, and batch
- [ ] **AUDIT-02**: User can view the history of past batches and the entries in each
- [ ] **AUDIT-03**: User can reverse the most recent batch, removing each entry in QuickBooks (delete for Bills, void or delete for Expenses) after re-checking its current state
- [ ] **AUDIT-04**: App refuses to reverse an entry that was modified or linked to other transactions since posting, and reports why

### Reporting (REPORT)

- [ ] **REPORT-01**: After a batch is sent, app produces a summary of what was posted that the user can save or print

### Branding (BRAND)

- [x] **BRAND-01**: App is styled with the Magnet Group brand tokens (colors and typography)
- [x] **BRAND-02**: App displays a plain "NicoleBooks" wordmark and uses no logo

### Platform and Security (PLAT)

- [x] **PLAT-01**: App runs on both Windows and Mac
- [x] **PLAT-02**: All secrets (QuickBooks tokens, AI key) are stored in the OS keychain and are never committed to the repo or written to logs
- [ ] **PLAT-03**: App ships as a signed, installable build for Windows and Mac
- [ ] **PLAT-04**: App can update itself from the private release channel

## v2 Requirements

Deferred to a future release. Tracked but not in the current roadmap.

### Parsing and Coding

- **V2-01**: Split a single bill across multiple itemized category lines in the review grid
- **V2-02**: Split multiple separate invoices out of one multi-page PDF
- **V2-05**: Learn vendor-to-category rules over time to pre-fill future bills (pre-fill only, never auto-post)

### Ingestion

- **V2-03**: Persistent background folder watcher that picks up new files automatically

### QuickBooks

- **V2-04**: Attach the original source file to the QuickBooks entry via the Attachable API

### Undo

- **V2-06**: Reverse older batches beyond the single most recent one

## Out of Scope

Explicitly excluded. Documented to prevent scope creep. Anti-features drawn from research.

| Feature | Reason |
|---------|--------|
| Multi-approver / approval routing | Single-user tool, no approval chain needed |
| Bill payment execution | Record-only tool, not a payments product |
| Supplier-portal auto-fetch and email-in ingestion | Extra input channels add surface area with no v1 payoff; folder drop is the channel |
| Bank-feed reconciliation | Reconciliation is QuickBooks' job, not this tool's |
| Auto-publish / unattended posting | Directly contradicts the core value of a trustworthy human review gate |
| OCR model-training UI | Uses a hosted vision model; nothing to train |
| Multi-company support | Serves one company and one user |
| Mobile app | This is a desktop tool |
| Spend analytics / dashboards | Not core to the data-entry value |

## Traceability

Each v1 requirement maps to exactly one phase. See .planning/ROADMAP.md for phase detail.

| Requirement | Phase | Status |
|-------------|-------|--------|
| ING-01 | Phase 2 | Complete |
| ING-02 | Phase 2 | Complete |
| ING-03 | Phase 2 | Complete |
| ING-04 | Phase 2 | Complete |
| ING-05 | Phase 2 | Complete |
| AI-01 | Phase 3 | Complete |
| AI-02 | Phase 3 | Complete |
| AI-03 | Phase 3 | Complete |
| AI-04 | Phase 3 | Complete |
| PARSE-01 | Phase 3 | Complete |
| PARSE-02 | Phase 3 | Complete |
| PARSE-03 | Phase 3 | Complete |
| PARSE-04 | Phase 3 | Complete |
| PARSE-05 | Phase 3 | Complete |
| QBO-01 | Phase 4 | Pending |
| QBO-02 | Phase 4 | Pending |
| QBO-03 | Phase 4 | Pending |
| QBO-04 | Phase 4 | Pending |
| QBO-05 | Phase 4 | Pending |
| RECON-01 | Phase 5 | Pending |
| RECON-02 | Phase 5 | Pending |
| RECON-03 | Phase 5 | Pending |
| RECON-04 | Phase 5 | Pending |
| REVIEW-01 | Phase 6 | Pending |
| REVIEW-02 | Phase 6 | Pending |
| REVIEW-03 | Phase 6 | Pending |
| REVIEW-04 | Phase 6 | Pending |
| REVIEW-05 | Phase 6 | Pending |
| REVIEW-06 | Phase 6 | Pending |
| REVIEW-07 | Phase 6 | Pending |
| REVIEW-08 | Phase 6 | Pending |
| REVIEW-09 | Phase 6 | Pending |
| POST-01 | Phase 7 | Pending |
| POST-02 | Phase 7 | Pending |
| POST-03 | Phase 7 | Pending |
| POST-04 | Phase 7 | Pending |
| POST-05 | Phase 7 | Pending |
| AUDIT-01 | Phase 7 | Pending |
| AUDIT-02 | Phase 7 | Pending |
| AUDIT-03 | Phase 7 | Pending |
| AUDIT-04 | Phase 7 | Pending |
| REPORT-01 | Phase 7 | Pending |
| BRAND-01 | Phase 1 | Complete |
| BRAND-02 | Phase 1 | Complete |
| PLAT-01 | Phase 1 | Complete |
| PLAT-02 | Phase 1 | Complete |
| PLAT-03 | Phase 8 | Pending |
| PLAT-04 | Phase 8 | Pending |

**Coverage:**

- v1 requirements: 48 total
- Mapped to phases: 48
- Unmapped: 0

---
*Requirements defined: 2026-07-22*
*Last updated: 2026-07-23 after Phase 2 discuss reshape (ING-01..04 revised for the flat-inbox / processing-date model; IDs and 48/48 mapping preserved)*
