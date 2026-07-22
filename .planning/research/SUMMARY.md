# Project Research Summary

**Project:** NicoleBooks
**Domain:** Cross-platform desktop bill-entry app (document parsing plus vision LLM plus QuickBooks Online automation)
**Researched:** 2026-07-22
**Confidence:** HIGH

## Executive Summary

NicoleBooks belongs to a well-understood product category: a "capture and code" AP tool (the same camp as Dext, Hubdoc, and AutoEntry) that extracts fields from bills and receipts, reconciles them against an accounting system, and requires a human review-and-approve gate before anything posts. It deliberately does not enter the heavier "pay bills" category (Bill.com, Ramp, Melio). Research across stack, features, architecture, and pitfalls agrees on the shape of the solution: a two-process desktop app (Electron 43 with a React 19 review UI, all filesystem/network/secrets confined to the Node main process) driving a staged pipeline (ingest, dedupe, parse, reconcile, review, post, record) from a date-named folder to a posted QuickBooks Bill or Purchase. Electron is the settled framework choice, not an open question: every backend capability this app needs (QuickBooks OAuth, an OpenAI-compatible client, PDF extraction, HEIC/image preprocessing, SQLite, OS-keychain secrets) is a mature, first-class Node library, and Electron's toolchain (electron-builder, electron-updater, safeStorage) solves signing, private-GitHub auto-update, and secret storage with no extra native dependencies. Tauri remains a documented alternative only if the builder becomes Rust-fluent or binary size becomes a real constraint, neither of which applies here.

The recommended build order is sandbox-first and dependency-driven: establish the process boundary and SQLite persistence, then ingestion and dedupe, then the AI parse pipeline (fully testable without QuickBooks), then the QuickBooks client against the sandbox (read side first: OAuth loopback plus vendor/account/item query), then reconciliation, then the review UI, then batch posting plus audit plus undo plus reporting, and only at the very end a thin production cutover behind a single environment seam (base URL plus redirect strategy). This lands the one hard external gate, live QuickBooks credentials, as late and as narrow as possible while keeping nearly the entire app buildable and testable today.

The dominant risk cluster is QuickBooks posting correctness, not UI or AI quality: idempotent creates (a requestid UUID persisted before every send), correct account-role wiring (Bill/Purchase line AccountRef is always the expense category; Purchase's top-level AccountRef is the "Paid from" bank/credit-card source; these are commonly swapped), environment-scoped IDs (sandbox account/vendor IDs are meaningless in production and must never be cached as config), and careful undo (delete for Bills, void-or-delete for Purchases, always re-fetching SyncToken and checking for linked transactions first). A second, newly-surfaced risk supersedes the older assumption in STACK.md and ARCHITECTURE.md: as of the November 2025 Intuit policy change, QuickBooks refresh tokens now rotate roughly every 24 hours (not every ~100 days) and must be re-persisted on every single refresh, with a 5-year hard cap and a mandatory "Reconnect URL" re-auth flow required as of February 24, 2026. This makes rotated-refresh-token persistence, not the once-per-quarter refresh the older docs implied, the top silent-failure risk for a non-technical solo user, and it should be treated as authoritative and load-bearing for the OAuth/connection phase.

## Key Findings

### Recommended Stack

Electron 43.2.0 with React 19, Vite 8, TypeScript 7, Tailwind 4, and TanStack Table 8 for the review grid is the settled stack decision (Tauri v2.10 was seriously evaluated and rejected for this app; see Architecture Approach and Confidence Assessment). The backend runs entirely in the Electron main process using mature, actively maintained Node libraries, with Zod as the deterministic validation layer between the LLM's structured output and both the review grid and QuickBooks.

**Core technologies:**
- Electron 43.2.0: cross-platform desktop shell, bundled Chromium for identical UI rendering on Windows and Mac, Node main process runs the entire backend natively
- React 19 + Vite 8 + TypeScript 7: renderer UI, fast HMR, type safety across the IPC boundary and around LLM/QuickBooks payloads
- TanStack Table 8 + Tailwind 4 + shadcn/ui (Radix): headless, fully brandable review grid with a free searchable Combobox for vendor/category, avoiding AG Grid Enterprise licensing
- Zod 4: schema validation and coercion of LLM output before it reaches the review grid or QuickBooks
- unpdf (primary) plus pdfjs-dist (fallback): digital-PDF text extraction, with extracted-text length as the deterministic router to the vision path
- sharp plus heic-convert: image resize/orient/re-encode, with heic-convert handling iPhone HEIC photos that sharp's prebuilt binary cannot decode
- openai official SDK (baseURL swappable between OpenAI and OpenRouter): vision chat completions and dynamic model listing
- intuit-oauth (official OAuth client) plus raw v3 REST calls validated by Zod: there is no official or well-maintained Node data SDK for QuickBooks, so raw REST is the lower-risk choice over the stale node-quickbooks package
- better-sqlite3: local audit log, dedupe hashes, sent-transaction ledger, undo state
- Electron safeStorage (OS keychain/DPAPI): the only secret store for the AI key and QuickBooks tokens; keytar is explicitly disqualified as unmaintained since Dec 2022
- electron-builder plus electron-updater: signing, notarization, and private-GitHub auto-update

### Expected Features

NicoleBooks sits between QuickBooks' own native Receipt Snap (which cannot create Bills for unpaid invoices) and full AP-automation tools (which add approval routing and payment execution NicoleBooks deliberately excludes). The explicit per-row Bill-vs-Expense typing is a genuine gap-filler versus native QuickBooks, not a reinvention.

**Must have (table stakes):**
- Accurate field extraction (vendor, date, amount, tax, reference number) via the hybrid programmatic-plus-vision pipeline
- Vendor matching that prefers existing QuickBooks records over creating new ones
- Category/account coding drawn from the real QuickBooks chart of accounts
- Mandatory human review/approve gate before anything posts, with all fields editable
- Duplicate detection at two layers: exact file-hash at ingest, fuzzy vendor+amount+date at review
- Posting as QuickBooks Bill or Purchase, storing the returned Id and SyncToken
- Source-document visibility in-app (attaching to the QuickBooks entry itself is explicitly deferred per PROJECT.md)

**Should have (competitive differentiators, still in v1 per PROJECT.md):**
- Per-row Bill-vs-Expense typing with a conditional "Paid from" account picker for Expense rows
- Confidence flags on low-certainty fields, derived from deterministic signals (arithmetic checks, extraction agreement, match strength), never from the model's raw self-reported confidence
- Vendor-to-category rule learning that pre-fills but never auto-posts
- Undo-last-batch as a genuine safety net (no mainstream capture tool offers true batch undo)
- Batch summary report (save/print) and a local audit trail with returned QuickBooks IDs

**Defer (v2+):**
- Multi-line/itemized splitting (build after the single-category flow is proven)
- Persistent folder watcher (manual scan is sufficient for a weekly run)
- Splitting multiple invoices out of one multi-page PDF
- Attaching source files to the QuickBooks entry via the Attachable API
- Broader undo beyond the single most recent batch

**Explicitly out of scope (anti-features):** multi-approver workflows, payment execution, supplier-portal auto-fetch, email-in ingestion, bank-feed reconciliation, auto-publish/unattended posting, OCR model-training UI, multi-company support, a mobile app, and spend analytics/dashboards. Each is justified by the single-user, low-volume, record-only (never pay) scope; auto-publish in particular directly contradicts the core value of a reviewable, trustworthy gate.

### Architecture Approach

NicoleBooks is a local-first, single-user desktop pipeline app with no server tier. The load-bearing boundary is the front-end/back-end trust boundary: the renderer never touches the filesystem, database, keychain, or network directly, communicating only through typed IPC commands and events, while the Electron main process owns all IO, secrets, and business logic. A staged pipeline (ingest, dedupe, parse, reconcile, review, post, record) moves each document through a normalized ParsedBill/ReviewRow object, persisting after every expensive stage (hashing, AI call, reconciliation) so a crash or reload never triggers a re-call of the paid AI model.

**Major components:**
1. Folder Watcher/Ingestion plus File Store and Dedupe (SHA-256): the input channel and first duplicate guardrail, keyed to date-named folders
2. Parse Pipeline (text extraction, image prep, vision structuring, deterministic validation): produces a normalized object with per-field confidence signals from day one, since confidence flags cannot be retrofitted later without rework
3. Reconciliation/Matching Engine: fuzzy-matches extracted vendor/account/item names against a cached, realm-scoped QuickBooks reference list, applying confidence thresholds so only high-confidence matches auto-select and every new-record creation requires explicit user confirmation
4. QuickBooks API Client (OAuth manager, entity CRUD, query, delete/void): isolates the one hard external dependency behind a single environment switch (base URL plus redirect strategy) that makes the live-credentials pause a one-parameter change, not a rewrite
5. Batch/Undo Manager plus Persistence (SQLite) plus Secret Store (OS keychain): submits batches idempotently, records an audit row (internal id, QuickBooks id, SyncToken, entity type, batch id) at post time, and is the only place undo, dedupe, and reporting read from

The sandbox-first build order matters architecturally, not just operationally: the QuickBooks client's single environment seam (sandbox loopback OAuth versus production HTTPS-redirect OAuth, sandbox versus production base URL) means every posting, query, and undo code path can be built and fully exercised against the sandbox, leaving production cutover as a small, late, low-risk phase.

### Critical Pitfalls

1. **OAuth refresh-token rotation mishandled (connection silently dies):** as of the November 2025 policy, access tokens last 60 minutes and refresh tokens rotate roughly every 24 hours; every refresh response must have its new refresh token persisted immediately, or the connection dies within about a day with no visible cause to a non-technical user. Refresh tokens now cap at 5 years (not the old ~100-day model) but can still be revoked at any time, and a mandatory "Reconnect URL" re-auth flow becomes required February 24, 2026. Build proactive refresh (before the 60-minute window), atomic persistence of both tokens on every refresh, a first-class "Reconnect to QuickBooks" state on refresh failure, and a visible connection-health indicator. This is the top silent-failure risk in the whole app.
2. **Confusing the two AccountRef roles on Bill vs Purchase:** this is the single most common QuickBooks posting error for AP integrations. Line-level AccountBasedExpenseLineDetail.AccountRef is always the expense category (Bill and Purchase alike); Purchase's top-level AccountRef is the "Paid from" bank/credit-card source account and must never be fed the category. Filter each dropdown by account type at lookup time and validate before posting.
3. **Double-posting on retries and partial batch failures:** QuickBooks does not deduplicate transactions as a whole. Pass a UUID requestid on every create, generated and persisted in the local ledger before sending, so retries are idempotent; make batch submission resumable with per-row state (pending/sent/confirmed/failed).
4. **Hard-coding QuickBooks entity IDs across environments:** sandbox account/vendor/item IDs are meaningless in the real production company. Never persist IDs as config; always resolve names to IDs at runtime, cache per realm, and treat production wire-up as a full re-test, not a config swap.
5. **Vision-model hallucination rubber-stamped by a trusting reviewer:** LLMs fill every field confidently even on blurry documents. Ground every field with deterministic cross-checks (line-sum equals total, dates parse unambiguously, vendor/account resolve to real QuickBooks records) and never derive confidence from the model's own self-reported score; low-confidence fields must be visually distinct and block casual approval.
6. **Undo that corrupts the books:** Bills can only be deleted via the API (never voided); Purchases can be voided or deleted. Undo must re-fetch SyncToken and check for linked transactions before reversing each row, refuse rather than force a reversal on anything modified or linked, and record every undo action in the audit log.

## Implications for Roadmap

Based on combined research, the dependency graph is unambiguous and all four research files converge on the same order. Suggested phase structure:

### Phase 1: Foundation (app shell, trust boundary, persistence)
**Rationale:** Every other component depends on the IPC boundary, the SQLite schema, and the Secret Store adapter existing first; nothing here touches an external service, so it has zero dependency on the live-credentials gate.
**Delivers:** Electron main/renderer/preload skeleton with contextIsolation and a narrow typed contextBridge, SQLite schema plus migrations, safeStorage-backed Secret Store adapter, Magnet Group brand tokens wired into Tailwind.
**Addresses:** the "local persistence" and "secure secret storage" constraints in PROJECT.md.
**Avoids:** Anti-Pattern 1 (doing IO or holding secrets in the renderer) from ARCHITECTURE.md; the "storing tokens in plaintext" security mistake from PITFALLS.md.

### Phase 2: Ingestion, file store, and dedupe
**Rationale:** Fully testable with local files and no network; establishes the documents table and hash-based dedupe that the parse pipeline and audit log both build on.
**Delivers:** date-named-folder scan, deterministic folder-name date parsing (prompt rather than silently defaulting to "today" on a parse failure), SHA-256 hashing, exact re-drop skip-and-flag.
**Addresses:** "Date-named folder ingestion with file-hash dedupe" (P1 in FEATURES.md).
**Avoids:** Pitfall 4 (QuickBooks does not dedupe, so the app must own it) and the cloud-sync placeholder-file gotcha (debounce and wait for file-size stability before hashing).

### Phase 3: AI client and parse pipeline
**Rationale:** Independently testable against fixture PDFs/photos with a real or mocked AI key; no QuickBooks dependency, so it can proceed in full parallel with QuickBooks-gated work.
**Delivers:** OpenAI-compatible client (model listing, vision-capability detection via OpenRouter metadata or a curated allowlist for OpenAI), digital-PDF text extraction routed by extracted-text length, HEIC/image preprocessing, vision structuring against a strict JSON schema, and deterministic validation (line-sum-equals-total, tax-inclusive detection, integer-cents money handling) that emits per-field confidence signals from day one.
**Uses:** unpdf, pdfjs-dist, sharp, heic-convert, the openai SDK, and Zod from STACK.md.
**Avoids:** Pitfall 6 (hallucination rubber-stamped) and Pitfall 10 (float money and tax-inclusive mismatches).

### Phase 4: QuickBooks connection and sandbox read access
**Rationale:** This is where the single live-credentials pause seam lands. It is the first QuickBooks-touching phase and runs entirely against the sandbox using a plain http://localhost redirect, so it can start as soon as Anthony provides sandbox client id/secret without waiting for production access.
**Delivers:** OAuth loopback authorization-code flow, token persistence with atomic rotated-refresh-token handling, proactive refresh plus reconnect-on-failure state, and the vendor/account/item query API with a realm-keyed reference cache.
**Implements:** the QuickBooks API Client component and its environment-switch seam from ARCHITECTURE.md.
**Avoids:** Pitfall 5 (refresh-token rotation mishandled) and Pitfall 1 (environment-scoped entity IDs). This phase should design the lookup layer to be realm-scoped from the start, not retrofit it later.

### Phase 5: Reconciliation and matching engine
**Rationale:** Depends directly on the sandbox query and reference cache from Phase 4; feeds the review table's dropdowns and candidate pre-selection.
**Delivers:** normalized fuzzy matching (strip punctuation/legal suffixes, exact then LIKE then similarity score) with confidence thresholds (0.90 or above auto-select, 0.70 to 0.90 pre-select-and-flag, below 0.70 offer create-new), account-type-filtered dropdowns (expense-category accounts versus bank/credit-card "Paid from" accounts), and safe query escaping for names with apostrophes.
**Avoids:** Pitfall 2 (AccountRef role confusion) and Pitfall 9 (name-matching creates duplicates or fails silently). This phase is the primary defense for "prefer existing over create new."

### Phase 6: Review UI
**Rationale:** Depends on parsed and reconciled data existing (Phases 3 and 5); this is the core, highest-complexity UI surface and the product's trust gate.
**Delivers:** the editable TanStack Table review grid, searchable vendor/category comboboxes, per-row Bill-vs-Expense toggle with conditional "Paid from" picker, confidence-flag highlighting with a filter to flagged-only rows, and fuzzy duplicate warnings.
**Addresses:** "Editable review table," "Per-row Bill-vs-Expense typing," "Confidence flags," and "'Paid from' account selection" (all P1 in FEATURES.md).
**Avoids:** the UX pitfall of a flat review table inviting rubber-stamping (PITFALLS.md).

### Phase 7: Batch posting, audit log, undo, and reporting (sandbox)
**Rationale:** Depends on the review UI producing user-confirmed rows and on the audit-log schema; undo and reporting both consume posting results, so they are naturally built together against the sandbox before any production exposure.
**Delivers:** idempotent batch submission (requestid UUID persisted before send, per-row pending/sent/confirmed/failed state), Bill/Purchase entity construction, audit-log rows storing Id plus SyncToken plus entity type plus batch id, undo-last-batch (delete for Bills, void-or-delete for Purchases, with a fresh SyncToken and linked-transaction check before reversing), and a saveable/printable batch summary.
**Avoids:** Pitfall 3 (double-posting on retry), Pitfall 7 (sparse-update/SyncToken mistakes), and Pitfall 8 (undo that corrupts the books). These three are correctness-critical and should be verified together against sandbox with an injected mid-batch failure.

### Phase 8: Production cutover and packaging/distribution
**Rationale:** Deliberately last and deliberately thin: every posting path was proven end-to-end in sandbox behind the single environment seam, so cutover is a base-URL flip plus an HTTPS redirect-page registration, not new logic. Packaging/signing has real lead time (Apple Developer enrollment, Windows certificate) so procurement should start well before this phase closes, even though the build work itself lands here.
**Delivers:** production QuickBooks base URL and HTTPS-redirect OAuth flow, signed and notarized macOS/Windows installers, private-GitHub auto-update wired without an embedded token (public release artifacts or an authenticated proxy, with signed update artifacts), and a controlled live smoke test.
**Avoids:** Pitfall 11 (unsigned/unnotarized builds blocked at the user's machine) and Pitfall 12 (leaked auto-update token from a private repo).

### Phase Ordering Rationale

- The dependency graph is genuinely linear at the top (foundation before everything) and then splits into two independent tracks that can proceed in parallel: ingestion-and-parsing (no QuickBooks needed) and QuickBooks-connection-and-reconciliation (gated only on sandbox credentials, which are available immediately, unlike production credentials). The roadmap should reflect that Phases 2-3 and Phase 4 have no hard ordering dependency on each other, only on Phase 1.
- Confidence flags, undo, and the batch report all depend on data shapes decided early (per-field signals from the parse pipeline; Id/SyncToken/entity-type/batch-id from the audit log). Both research files (FEATURES.md and ARCHITECTURE.md) flag that retrofitting these later means rework, so Phases 3 and 7's data contracts should be designed with the full feature list in view even though the UI for them lands in later phases.
- Every research file independently converges on sandbox-first, production-last as the way to de-risk the one confirmed external gate (live QuickBooks credentials per PROJECT.md), which is why production cutover is the final phase rather than being threaded through earlier phases.
- Packaging/signing is scheduled last as a build phase but flagged for early procurement (Apple Developer membership, Windows signing certificate) because of real-world lead time that has nothing to do with code dependencies.

### Research Flags

Needs research during planning:
- **Phase 3 (AI client and parse pipeline):** vision-capability detection differs meaningfully by provider (OpenRouter exposes architecture.input_modalities; OpenAI's /v1/models has no capability metadata), and confidence-signal design (combining extraction agreement, arithmetic checks, and match strength into a usable score) is genuinely novel work, not a copy-paste pattern.
- **Phase 4 (QuickBooks connection):** the OAuth token-lifecycle facts changed substantially in November 2025 (60-minute access tokens, ~24-hour refresh rotation, 5-year cap, mandatory Reconnect URL by Feb 2026); verify the exact current behavior against Intuit's live docs at implementation time rather than relying solely on this research, since policy specifics of this kind can continue to shift.
- **Phase 5 (Reconciliation):** fuzzy-match threshold tuning (the 0.90/0.70 cutoffs are a starting recommendation, not verified against this specific company's real vendor list) should be tuned against sandbox data once available.
- **Phase 7 (Posting, undo, reporting):** sparse=true update support is inconsistent across QuickBooks entity types per PITFALLS.md and must be verified per entity in sandbox before the undo path relies on it; Bill's supported delete/void operation set should also be confirmed in sandbox before building.
- **Phase 8 (Production cutover, packaging):** Windows code-signing now requires HSM/cloud signing (post-June-2023 rules); the specific low-cost path (for example Azure Trusted Signing) should be selected and its account setup verified early given its lead time.

Phases with standard, well-documented patterns (research-phase likely not needed):
- **Phase 1 (Foundation):** the two-process Electron trust-boundary pattern (contextIsolation, sandboxed renderer, contextBridge IPC) is a standard, thoroughly documented Electron security pattern.
- **Phase 2 (Ingestion and dedupe):** SHA-256 file hashing and folder watching are standard, low-novelty patterns; the main nuance (cloud-sync placeholder files) is already documented in PITFALLS.md with a concrete fix.
- **Phase 6 (Review UI):** TanStack Table plus shadcn/ui Combobox composition is a documented, common pattern with clear STACK.md guidance; no unresolved unknowns.

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH | Library and version choices verified directly against the npm registry as of 2026-07-22; the Electron-vs-Tauri framework decision itself is judgment-based (rated MEDIUM-HIGH in STACK.md) but is treated as settled for this project per the reconciliation guidance, since both PITFALLS.md and ARCHITECTURE.md independently converge on the same recommendation |
| Features | HIGH | Category-leader feature sets (Dext, Hubdoc, AutoEntry, Bill.com, Ramp, QBO Receipt Snap) are well documented; MEDIUM only on the exact internal confidence-scoring implementations of proprietary competitors, which is not load-bearing since NicoleBooks builds its own deterministic confidence model regardless |
| Architecture | HIGH | QuickBooks entity shapes (Bill, Purchase, AccountRef roles), the query API, and the OAuth authorization-code flow were verified against official Intuit documentation; the two-process boundary and staged-pipeline patterns are standard desktop-app practice |
| Pitfalls | HIGH | QuickBooks API and OAuth facts verified against Intuit docs and current 2025-2026 sources, including the November 2025 refresh-token policy change; MEDIUM specifically on some entity-level void/delete support (Bill's exact supported operations), explicitly flagged for sandbox verification |

**Overall confidence:** HIGH

### Gaps to Address

- **OAuth token-lifecycle reconciliation:** STACK.md and ARCHITECTURE.md describe the older ~100-day refresh-token model; PITFALLS.md documents the November 2025 policy change (60-minute access tokens, ~24-hour refresh rotation, 5-year cap, mandatory Reconnect URL by Feb 24, 2026). This summary treats PITFALLS.md as authoritative per the reconciliation instructions; Phase 4 planning should re-verify current behavior against Intuit's live documentation, since this is exactly the kind of policy detail that can shift again before build.
- **Exact current minorversion value:** STACK.md flags this as MEDIUM confidence and PITFALLS.md notes a floor of 75 as of Aug 1, 2025; confirm the current documented value against Intuit's minor-versions changelog at Phase 4 implementation time rather than hard-coding a guess.
- **Bill entity's exact supported void/delete operation set and sparse=true support per entity:** flagged explicitly in PITFALLS.md as needing sandbox verification before the undo path (Phase 7) is built.
- **Fuzzy-match thresholds:** the 0.90/0.70 similarity cutoffs in ARCHITECTURE.md are a reasonable starting point, not validated against the actual stepdad's-business vendor list, which does not exist yet in any research artifact; tune once sandbox and eventually production data are available.
- **Non-technical end-user OS:** per PROJECT.md, Nicole's actual OS (Windows vs Mac) is unconfirmed, so both platforms remain equal-priority through Phase 8; no research gap here, just a standing constraint to keep visible through packaging.

## Sources

### Primary (HIGH confidence)
- QuickBooks Online Accounting API - Bill and Purchase entities (via Context7, official Intuit developer docs)
- QuickBooks Online Accounting API - Vendor/Account/Item query endpoint (via Context7, official Intuit developer docs)
- Intuit OAuth 2.0 authorization/token endpoints and redirect-URI rules (via Context7, official Intuit developer docs)
- npm registry (npm view <pkg> version, checked 2026-07-22) for all stack version numbers
- Intuit Developer Help: Handling OAuth token expiration; Validity of Refresh Token; refresh-token rotation before 100 days
- Intuit Developer (Medium, Nov 2025): Important changes to refresh token policy, covering the 5-year cap, rotation cadence, and mandatory Reconnect URL
- Intuit Developer: minorversion deprecation (floor of 75, effective Aug 1, 2025); QuickBooks Online API Best Practices; requestid idempotency mechanism
- Electron safeStorage docs; keytar-archived status corroborated by multiple sources (for example VS Code's migration off keytar)

### Secondary (MEDIUM confidence)
- OpenRouter models API docs (architecture.input_modalities, supported_parameters) for provider-side vision-capability metadata
- Ramp and Dext product documentation for duplicate-detection and category-learning behavior patterns
- Tauri v2 docs and multiple dev.to/blog write-ups on macOS notarization entitlements and Windows HSM/cloud-signing requirements
- Satva Solutions guides on QuickBooks API rate limits and base URLs

### Tertiary (LOW confidence)
- None flagged as load-bearing; all LOW-confidence items in the underlying research (for example the exact current minorversion number) are called out above as explicit gaps requiring verification during Phase 4 planning.

---
*Research completed: 2026-07-22*
*Ready for roadmap: yes*
