# Roadmap: NicoleBooks

## Overview

NicoleBooks turns a folder of mixed bill documents into reviewed, non-duplicate QuickBooks Online entries. The build is dependency-driven and sandbox-first: a two-process desktop shell with secure local persistence comes first, then the two independent tracks that need no live QuickBooks access (ingestion plus dedupe, and the AI parse pipeline), then the single live-credentials seam where QuickBooks is wired and exercised entirely against the sandbox, then reconciliation and the review trust gate on top of that, then idempotent batch posting with audit, undo, and reporting proven end-to-end in sandbox, and finally a deliberately thin production cutover with signed, auto-updating installers. The one hard external gate (live QuickBooks credentials) lands as late and as narrow as possible so nearly the entire app is buildable and testable today.

## Phases

**Phase Numbering:**
- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

Decimal phases appear between their surrounding integers in numeric order.

**Parallelism:** Phases 2, 3, and 4 each depend only on Phase 1, so ingestion (Phase 2), the AI parse pipeline (Phase 3), and the QuickBooks sandbox connection (Phase 4) have no hard ordering dependency on one another. Phase 4 is gated on sandbox credentials, which are available immediately, unlike production credentials.

- [ ] **Phase 1: Foundation** - Two-process app shell, IPC trust boundary, SQLite persistence, OS-keychain secret store, and Magnet Group brand tokens
- [ ] **Phase 2: Ingestion and Dedupe** - Date-named folder scan, supported formats, folder-name date parsing, and SHA-256 file-hash dedupe
- [ ] **Phase 3: AI Client and Parse Pipeline** - OpenAI-compatible model config, text extraction plus image prep, vision structuring, deterministic validation with confidence signals
- [ ] **Phase 4: QuickBooks Connection (Sandbox)** - Guided OAuth, rotated-refresh-token handling, reconnect state, and realm-scoped reference cache (LIVE-CREDENTIALS PAUSE)
- [ ] **Phase 5: Reconciliation and Matching** - Prefer-existing fuzzy matching for vendors and categories with account-type-filtered candidates
- [ ] **Phase 6: Review UI** - Editable review table with searchable dropdowns, Bill/Expense toggle, "Paid from" picker, confidence flags, and duplicate warnings
- [ ] **Phase 7: Posting, Audit, Undo, and Reporting (Sandbox)** - Idempotent batch posting with per-row state, audit log, safe undo-last-batch, and a saveable batch summary
- [ ] **Phase 8: Production Cutover and Packaging** - Production QuickBooks flip behind the environment seam, signed and notarized installers, and private-channel auto-update

## Phase Details

### Phase 1: Foundation
**Goal**: The app launches on both Windows and Mac as a branded two-process shell with a strict IPC trust boundary, local SQLite persistence, and OS-keychain secret storage in place.
**Mode:** mvp
**Depends on**: Nothing (first phase)
**Requirements**: BRAND-01, BRAND-02, PLAT-01, PLAT-02
**Success Criteria** (what must be TRUE):
  1. User can launch NicoleBooks on both Windows and Mac and see a branded window using Magnet Group colors and typography, a plain "NicoleBooks" wordmark, and no logo.
  2. The app stores and retrieves a secret from the OS keychain (Windows Credential Manager, macOS Keychain), and no secret is ever written to the SQLite database, a plaintext file, or logs.
  3. The app creates its local SQLite database on first run and applies schema migrations, so data survives a restart.
  4. The renderer performs no direct filesystem, database, keychain, or network access; every such action routes through the typed IPC boundary.
**Plans**: 8 plans
Plans:
- [ ] 01-01-PLAN.md - Scaffold, hardened shell, native rebuild (Windows), and test harness
- [ ] 01-02-PLAN.md - Typed IPC contract, Zod schemas, and sandbox-safe preload bridge
- [ ] 01-03-PLAN.md - Magnet Group brand theme: vendored tokens, local fonts, shadcn
- [ ] 01-04-PLAN.md - SQLite persistence with migrations and the safeStorage secret store
- [ ] 01-05-PLAN.md - Zod-gated IPC handlers and main-process registration
- [ ] 01-06-PLAN.md - Branded app shell, three screens, and the Secret store health round trip
- [ ] 01-07-PLAN.md - End-to-end validation suite and cross-OS CI
- [ ] 01-08-PLAN.md - Cross-OS real-machine verification checkpoint
**UI hint**: yes

### Phase 2: Ingestion and Dedupe
**Goal**: The user can point the app at a date-named folder and load its bill files on a manual scan, with exact duplicates caught before any processing.
**Mode:** mvp
**Depends on**: Phase 1
**Requirements**: ING-01, ING-02, ING-03, ING-04, ING-05
**Success Criteria** (what must be TRUE):
  1. User can place bill files (text PDFs, JPEG, PNG, and iPhone HEIC photos) into a folder named for the entry date and trigger a manual scan that loads them for processing.
  2. The app reads the entry date from the folder name and, when the name cannot be parsed as a date, prompts the user instead of silently defaulting to today.
  3. The app computes a file hash for each document and skips-and-flags any exact file it has already processed, so re-dropping the same file creates no duplicate work.
  4. The app waits for files to fully materialize before hashing, so cloud-sync placeholder files and partially written files are not processed as if complete.
**Plans**: TBD

### Phase 3: AI Client and Parse Pipeline
**Goal**: The app turns each bill document into validated, structured fields using a user-configured vision model, emitting per-field confidence signals, with no QuickBooks dependency.
**Mode:** mvp
**Depends on**: Phase 1
**Requirements**: AI-01, AI-02, AI-03, AI-04, PARSE-01, PARSE-02, PARSE-03, PARSE-04, PARSE-05
**Success Criteria** (what must be TRUE):
  1. User can enter an OpenAI-compatible API key and base URL in a settings screen (stored in the OS keychain), pick a model from the endpoint's live model list, and change the selected model at any time.
  2. The app flags or filters vision-capable models so the user cannot unknowingly select a text-only model for image parsing.
  3. For a text PDF the app extracts embedded text programmatically, and for a photo or scan it prepares the image (orient, resize, HEIC decode) before calling the model.
  4. The app extracts structured fields (vendor, date, due date, reference number, subtotal, tax, total, suggested category) and validates them deterministically (subtotal plus tax equals total, dates parse, money stored as integer cents), recording per-field confidence signals.
  5. The app persists parsed results so a reload or crash never re-calls the paid model for the same document.
**Plans**: TBD
**UI hint**: yes

### Phase 4: QuickBooks Connection (Sandbox)
**Goal**: The app connects to a QuickBooks Online company via OAuth against the sandbox, keeps the connection alive through rotated-refresh-token handling, and reads the company's reference data into a realm-scoped cache.
**Mode:** mvp
**Depends on**: Phase 1
**Requirements**: QBO-01, QBO-02, QBO-03, QBO-04, QBO-05
**Live credentials**: This is the single live-credentials pause seam. Anthony provides QuickBooks sandbox client id, client secret, and redirect URI here to proceed; all work in this phase runs against the sandbox using a plain http://localhost loopback redirect. Production credentials are provided later, at Phase 8.
**Success Criteria** (what must be TRUE):
  1. User can connect the app to a QuickBooks Online company through a guided OAuth sign-in (sandbox loopback flow) and see a clear connection-health status.
  2. The app stores QuickBooks tokens only in the OS keychain, refreshes the access token proactively, and persists the rotated refresh token on every refresh, so the connection survives more than a day.
  3. When re-authorization is needed, the app surfaces a one-click "Reconnect to QuickBooks" action rather than silently failing.
  4. The app reads the company's vendors, expense accounts, payment accounts, and items and caches them keyed by realm, resolving names to IDs at runtime instead of hard-coding entity IDs.
**Plans**: TBD

### Phase 5: Reconciliation and Matching
**Goal**: The app matches each parsed bill's vendor and category against the cached QuickBooks reference data, strongly preferring existing records and never creating new ones silently.
**Mode:** mvp
**Depends on**: Phase 3, Phase 4
**Requirements**: RECON-01, RECON-02, RECON-03, RECON-04
**Success Criteria** (what must be TRUE):
  1. The app matches each parsed vendor to existing QuickBooks vendors and pre-selects a confident match instead of creating a new vendor.
  2. The app maps each suggested category to an existing QuickBooks expense account, preferring existing accounts over creating new ones.
  3. The app creates a new vendor or account only when the user explicitly confirms it, never silently.
  4. Category candidates and "Paid from" candidates are filtered by the correct QuickBooks account type (expense categories versus bank or credit-card payment sources).
**Plans**: TBD

### Phase 6: Review UI
**Goal**: The user reviews every parsed and reconciled bill in one editable table, corrects anything, sees confidence and duplicate warnings, and decides exactly what will be sent, before anything posts.
**Mode:** mvp
**Depends on**: Phase 3, Phase 5
**Requirements**: REVIEW-01, REVIEW-02, REVIEW-03, REVIEW-04, REVIEW-05, REVIEW-06, REVIEW-07, REVIEW-08, REVIEW-09
**Success Criteria** (what must be TRUE):
  1. User sees all parsed bills in a single editable review table before anything is sent, and can change vendor and category via searchable dropdowns of existing QuickBooks records and edit the amount directly.
  2. User can set each row's transaction type to unpaid Bill or already-paid Expense, and for Expense rows select the "Paid from" bank or credit-card account.
  3. The app visually flags low-confidence fields and lets the user filter to just the flagged rows.
  4. The app warns on likely duplicates (matching vendor, amount, and date against previously sent entries) before sending.
  5. User can exclude or remove any row from the batch before sending.
**Plans**: TBD
**UI hint**: yes

### Phase 7: Posting, Audit, Undo, and Reporting (Sandbox)
**Goal**: The user sends an approved batch to the QuickBooks sandbox as Bills and Expenses idempotently, gets a durable audit trail and a saveable summary, and can safely undo the most recent batch.
**Mode:** mvp
**Depends on**: Phase 6
**Requirements**: POST-01, POST-02, POST-03, POST-04, POST-05, AUDIT-01, AUDIT-02, AUDIT-03, AUDIT-04, REPORT-01
**Success Criteria** (what must be TRUE):
  1. User can click "Send to QuickBooks" and approved rows post to the sandbox as Bill entities (unpaid) or Purchase entities (already-paid), each coded to a single expense category, with the correct account roles.
  2. Every create carries a persisted idempotency key (requestid) and per-row send state (pending, sent, confirmed, failed), so an injected mid-batch failure produces zero duplicates on re-run and the batch resumes.
  3. The app records an audit-log row for every posted entry (QuickBooks Id, SyncToken, entity type, company, batch), and the user can view the history of past batches and the entries in each.
  4. User can reverse the most recent batch, and the app refuses to reverse any entry modified or linked since posting (after re-checking its current state) and reports why.
  5. After a batch is sent, the app produces a summary the user can save or print.
**Plans**: TBD
**UI hint**: yes

### Phase 8: Production Cutover and Packaging
**Goal**: With every posting path already proven in sandbox behind the environment seam, the app flips to production QuickBooks and ships as signed, auto-updating installers for Windows and Mac.
**Mode:** mvp
**Depends on**: Phase 7
**Requirements**: PLAT-03, PLAT-04
**Procurement note**: Code-signing certificate procurement has real lead time (Apple Developer Program enrollment, Windows HSM or cloud code-signing such as Azure Trusted Signing). Start procurement early, well before this phase opens, even though the build work lands here.
**Success Criteria** (what must be TRUE):
  1. The app connects to the production QuickBooks company via the HTTPS-redirect OAuth flow (a base-URL and redirect-strategy flip, with no changes to posting logic) and passes a controlled live smoke test.
  2. The app ships as a signed and notarized installer that opens on a clean Windows machine and a clean Mac without Gatekeeper or SmartScreen blocking it.
  3. The app updates itself from the private release channel using signed update artifacts, with no repository token embedded in the shipped binary.
**Plans**: TBD

## Progress

**Execution Order:**
Phases execute in numeric order: 1 -> 2 -> 3 -> 4 -> 5 -> 6 -> 7 -> 8 (Phases 2, 3, and 4 may proceed in parallel once Phase 1 is complete)

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Foundation | 0/8 | Not started | - |
| 2. Ingestion and Dedupe | 0/TBD | Not started | - |
| 3. AI Client and Parse Pipeline | 0/TBD | Not started | - |
| 4. QuickBooks Connection (Sandbox) | 0/TBD | Not started | - |
| 5. Reconciliation and Matching | 0/TBD | Not started | - |
| 6. Review UI | 0/TBD | Not started | - |
| 7. Posting, Audit, Undo, and Reporting (Sandbox) | 0/TBD | Not started | - |
| 8. Production Cutover and Packaging | 0/TBD | Not started | - |

---
*Roadmap created: 2026-07-22*
*Coverage: 48/48 v1 requirements mapped*
