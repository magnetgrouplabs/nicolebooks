# Feature Research

**Domain:** Bill/receipt capture and accounts-payable (AP) automation, single-user, low-volume, posting to QuickBooks Online (QBO)
**Researched:** 2026-07-22
**Confidence:** HIGH on category-leader feature sets and QBO API mechanics; MEDIUM on the exact internal confidence-scoring implementations of proprietary competitors (their marketing describes behavior, not method)

## Context: What the Category Leaders Actually Do

Studied leaders fall into two camps:

- **Capture-and-code tools** (Dext / Receipt Bank, Hubdoc, AutoEntry, QBO's own Receipt Snap): ingest documents, extract fields, code them, let a human review, then push to the accounting ledger. They do NOT move money. This is NicoleBooks' camp.
- **Full AP-automation / bill-pay tools** (Bill.com, Ramp Bill Pay, Melio): everything above PLUS multi-approver routing and actual payment execution (ACH, check, card). This is a different, heavier product.

The single most useful finding for scoping: QBO's own Receipt Snap only records already-paid money movement and pairs it to a bank-feed transaction; it does NOT create vendor Bills for unpaid invoices ([QBO receipt capture review](https://invoicedataextraction.com/blog/quickbooks-online-receipt-capture-reviews)). NicoleBooks' explicit Bill-vs-Expense typing is therefore filling a real gap in the native tool, not reinventing it. That is a legitimate reason for this app to exist even though QBO "already has receipt capture."

Second most useful finding: line-item extraction is now the dividing line between "modern" and "legacy" capture tools. Hubdoc captures only header totals and cannot break out line items; Dext and AutoEntry extract full line items ([Datamolino comparison](https://www.datamolino.com/blog/pricing-and-features-autoentry-vs-hubdoc-vs-dext-vs-datamolino-in-2026/), [Tofu HubDoc alternatives](https://www.gotofu.com/blog/best-hubdoc-alternatives)). Since NicoleBooks serves a service business where most bills are single-category but some are itemized, multi-line support is a differentiator to have but not the common case.

## Feature Landscape

### Table Stakes (Users Expect These)

Missing any of these and the tool feels broken or untrustworthy; the user reverts to manual entry.

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| Accurate field extraction (vendor, date, amount, tax, invoice/reference number) | This is the entire promise; every leader leads with OCR/AI extraction | MEDIUM | Hybrid pipeline: programmatic text for digital PDFs, vision model for photos, deterministic validation on top. Amount and date are the fields users check first, so accuracy there is non-negotiable |
| Vendor matching to the accounting system (prefer existing over creating new) | Duplicate vendor records pollute the QBO company; Dext/AutoEntry match suppliers to the ledger | MEDIUM | Fuzzy match extracted vendor name against the QBO Vendor list; only offer "create new vendor" when no reasonable match exists. Requires a normalized-name match (case, punctuation, "Inc/LLC" noise) |
| Category / account coding from existing chart of accounts | Users expect suggested categories drawn from their own QBO accounts, not free text | MEDIUM | Pull the QBO chart of accounts; dropdown constrained to real expense/COGS accounts. Auto-suggest per vendor is a differentiator (below), but showing valid accounts at all is table stakes |
| Human review / approve step before anything is written | Trust requires a look-before-you-post gate; every capture tool has a review queue | MEDIUM-HIGH | The editable review table IS this gate. Nothing posts to QBO without an explicit approve action |
| Duplicate detection | Double-posting a bill is the scariest failure mode; Dext flags matching supplier+date+amount, Ramp compares vendor+invoice#+amount | MEDIUM | Two layers: exact file-hash dedupe at ingest, and fuzzy vendor+amount+date warning at review. Both confirmed as the industry pattern ([Dext](https://dext.com/us/business/product/capture-receipts-and-invoices), [Ramp](https://ramp.com/accounts-payable)) |
| Posting to the accounting system | The payoff; without it the tool is just a spreadsheet | MEDIUM | QBO API create of Bill or Purchase. Must capture and store the returned QBO Id (and SyncToken) for audit and undo |
| Source-document handling / traceability | Users need to see the paper they are approving; every leader keeps the image attached to the entry | LOW (in-app) / MEDIUM (attach to QBO) | In-app: show the file next to the row. Attaching the file to the QBO entry via the Attachable API is deferred per PROJECT.md, which is acceptable because the local file plus audit log preserves traceability |

### Differentiators (Competitive Advantage)

Not strictly required, but each raises trust or saves time. NicoleBooks should pick the ones that reinforce its core value (confidence for a non-technical user), not chase all of them.

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| Per-row Bill-vs-Expense typing | Records unpaid invoices AND already-paid receipts correctly; QBO's own Receipt Snap cannot create Bills at all | MEDIUM | Drives which QBO entity is created (Bill vs Purchase) and which fields become required. A genuine gap-filler vs native QBO |
| "Paid from" account selection for Expenses | Already-paid purchases require a source account in QBO; getting this right avoids miscoded cash/card spend | LOW-MEDIUM | Conditional on Expense typing; dropdown limited to bank/credit-card accounts. Maps to Purchase.AccountRef + PaymentType |
| Confidence flags on low-certainty fields | Directs the user's limited attention to exactly the fields the AI was unsure about; reduces review fatigue | MEDIUM | Best practice is to derive confidence from deterministic signals (programmatic vs vision agreement, amount/tax math checks, match strength), NOT from a raw self-reported LLM score, which is poorly calibrated. See Pitfalls note below |
| Learning vendor-to-category rules over time | "This vendor is always Fuel" applied automatically; Dext explicitly "remembers how you categorise suppliers and applies rules automatically" ([Dext](https://dext.com/us/business/product/capture-receipts-and-invoices)) | MEDIUM | High value for a repeat-vendor service business. Store per-vendor default account/type in the local ledger; pre-fill on future matches. Keep it as a suggestion the user can override, never silent auto-post |
| Multi-line / itemized splitting | Handles the minority of bills split across categories without dropping to manual entry | MEDIUM-HIGH | One row per line item, each with its own account and amount, validated to sum to the document total. Dext's Line Items / Smart Split are the reference behavior |
| Undo-last-batch (one-click reversal) | Safety net that makes a non-technical user brave enough to post; no mainstream capture tool offers a true batch undo | MEDIUM-HIGH | Reverses the most recent batch using stored QBO Ids. Critical nuance: Bills must be DELETED (QBO API does not support voiding Bill entities); Purchases can be voided or deleted. See committed-behavior section |
| Batch summary report (saveable/printable) | Gives the user a paper trail and a sense of "what just happened" per session | LOW-MEDIUM | Per-entry list: vendor, amount, type, category, QBO Id, status (posted/skipped-duplicate/failed). Print or save to PDF |
| Local audit trail with returned QBO IDs | Every posted entry is traceable and reversible; Ramp markets its audit log as a headline feature ([Ramp](https://ramp.com/accounts-payable)) | MEDIUM | Local SQLite ledger. Underpins dedupe, undo, and the batch report all at once |
| Batch operations (approve/post many at once) | Low friction for a weekly run of 5-20 bills | LOW-MEDIUM | Select-all / post-all across the review table. Cheap because volume is low |

### Anti-Features (Commonly Requested, Often Problematic)

Things the category leaders have that NicoleBooks should deliberately NOT build. Each is justified by the single-user, low-volume, record-only (not pay) scope.

| Feature | Why It Seems Attractive | Why It's Out of Scope Here | What to Do Instead |
|---------|-------------------------|----------------------------|--------------------|
| Multi-approver approval workflows (routing by amount/department, approve/reject chains) | It is Bill.com's flagship capability and signals "enterprise-grade" | There is exactly one user who is both preparer and approver. Routing to nobody adds pure friction | The single review-and-approve gate IS the approval step |
| Payment execution (ACH/check/card, pay-the-bill) | Ramp/Melio/Bill.com "pay bills" is the obvious next step | Moving money is a regulated, high-liability feature; the stepdad's business already pays bills its own way. NicoleBooks records, it does not pay | Record the Bill (unpaid A/P) or the already-paid Expense; leave payment to the existing process |
| Supplier-portal auto-fetch (log into vendor sites to pull invoices) | Hubdoc's signature feature; removes manual file gathering | Enormous scope (credential vaulting, per-vendor scrapers, breakage) for a user who already receives bills by email/paper | Date-named-folder drop-in; the user places files, the app reads them |
| Email-in / forwarding inbox | Dext/AutoEntry forwarding addresses are convenient | Adds an inbound mail service, address provisioning, and spam handling to a desktop app | The watched folder is the single, simple ingestion channel |
| Bank-feed reconciliation / match-to-transaction | QBO Receipt Snap and Ramp match receipts to bank/card feeds | Requires bank-feed access and a matching engine; NicoleBooks' job ends at creating the correct ledger entry | Post a clean Bill/Expense; QBO's own reconciliation handles matching later |
| Auto-publish / straight-through posting (no human look) | Dext Auto Publish is a time-saver at scale | Directly contradicts the core value: a non-technical user reviewing and approving with confidence. Unattended posting removes the trust gate | Always require the explicit "Send to QuickBooks" approve step |
| OCR / model training UI (label data, tune the extractor) | Feels like it would improve accuracy | Volume is far too low to train anything; a labeling UI is a whole product. The vision model plus deterministic checks is enough | Improve accuracy via prompt/validation tuning in code, and via the vendor-rule learning that is already in scope |
| Multi-company / multi-entity support | Natural "what if we add another company" instinct | One user, one QBO company (per PROJECT.md). Multi-tenant data model and per-company auth is wasted complexity | Single-company scope; hard-code the assumption, revisit only if a second company ever appears |
| Mobile capture app | Every leader has a phone app for on-the-go photos | This is a desktop tool by requirement; the user works from a folder on a computer | The user photographs bills on their phone and drops the images into the folder as files |
| Spend analytics / dashboards / budgets | Ramp and Bill.com upsell reporting | Reporting lives in QBO once entries are posted; duplicating it adds surface with no unique value | The batch summary covers "what did this run do"; QBO covers ongoing reporting |
| Recurring-bill automation / scheduled bills | Convenient for fixed monthly vendors | Adds a scheduler and silent-creation path that conflicts with the review-everything principle at very low volume | Vendor-rule learning pre-fills fields; the user still reviews each occurrence |

## Committed Feature Behaviors (Concrete Specifications)

These are the features PROJECT.md commits to. Described concretely so requirements/roadmap can lift them directly.

### 1. Date-named-folder ingestion
- **Model:** The user creates or reuses a folder whose name encodes the intended QBO transaction date (for example `2026-07-22`). All files in that folder become candidate entries dated to that folder's date by default (still per-row editable).
- **Trigger:** A "scan folder / pick folder" action (a persistent file watcher is optional polish, not required for a weekly run). Keep an explicit user-initiated scan for v1 to avoid surprise processing.
- **Per file:** one file = one candidate bill for v1. Supported types: digital PDF, plus image formats (JPG/PNG, and ideally HEIC given phone photos).
- **Deterministic date parsing:** parse the folder name against a fixed, documented format; if it does not parse, prompt the user to pick a date rather than guessing. Do not silently fall back to "today."
- **At-ingest dedupe:** compute a file hash on each file; if the hash already exists in the local ledger, skip it and note "already processed" in the run. This is the first duplicate guardrail.
- **Multi-page PDFs:** treat as a single bill in v1 (one invoice spanning pages is the common case). Splitting multiple invoices out of one PDF is a v2 concern.
- **Complexity:** MEDIUM. **Depends on:** local ledger (for hash dedupe); feeds the parse pipeline.

### 2. Editable review table
- **Layout:** a grid, one row per candidate bill (or one row per line item for itemized bills). Each row shows the source file (name/thumbnail, clickable to view), and editable controls.
- **Columns:** source file; vendor (searchable dropdown bound to QBO vendors, with "create new" as a last resort); category/account (dropdown from QBO chart of accounts); transaction type (Bill vs Expense); amount (editable, validated numeric); date (defaults from folder, per-row editable); "Paid from" account (shown only when type = Expense); confidence flags surfaced inline on the relevant cells.
- **Behavior:** all AI-extracted values are pre-filled but every field is editable before posting. Editing is the whole point of the review gate. Row-level and select-all selection for batch posting.
- **Complexity:** HIGH (this is the core UI). **Depends on:** QBO vendor list and chart of accounts (dropdowns), parse results (pre-fill), confidence signals (flags), Bill/Expense typing (conditional columns).

### 3. Per-row Bill-vs-Expense typing
- **Meaning:** Bill = unpaid, creates a QBO **Bill** (Accounts Payable; VendorRef + expense line coded to an account). Expense = already paid, creates a QBO **Purchase** (records money that already left a bank/card account).
- **Default guess, human override:** the parser can suggest type (an "invoice / due date / net terms" document leans Bill; a "receipt / paid / card" document leans Expense), but the user sets the final type per row.
- **Field consequences:** choosing Expense reveals and requires the "Paid from" account and a PaymentType; choosing Bill hides those and (optionally) exposes a due date.
- **Complexity:** MEDIUM. **Depends on:** determines which QBO entity and required fields; gates the "Paid from" picker.

### 4. "Paid from" account selection (Expense rows only)
- **Behavior:** a dropdown populated from the QBO account list filtered to bank and credit-card accounts, plus a PaymentType (Cash / Check / CreditCard). Maps to the Purchase entity's `AccountRef` (the source account) and `PaymentType`.
- **Validation:** an Expense row cannot post without a "Paid from" account selected; a Bill row must not send one.
- **Complexity:** LOW-MEDIUM (conditional UI + validation). **Depends on:** Bill/Expense typing; QBO account list.

### 5. Confidence flags on low-certainty fields
- **What the user sees:** low-certainty cells are visually marked (for example an amber highlight with a short reason on hover), and the table can filter to "only flagged rows."
- **How confidence is derived (important):** do NOT rely on a raw self-reported model score, which is poorly calibrated. Derive per-field confidence from deterministic signals: agreement between programmatic text extraction and the vision model; amount/tax arithmetic checks (line items sum to total; tax + net = gross); strength of the vendor match against QBO; whether a category was inferred confidently or is a fallback. This matches document-processing best practice of routing only low-confidence fields to human review ([confidence scoring in document extraction](https://subhajitbhar.com/blog/idp/glossary/confidence-scoring-document-extraction/)).
- **Complexity:** MEDIUM (defining and combining signals is the work, not the UI). **Depends on:** the hybrid parse pipeline emitting per-field signals; vendor matching (for match-strength signal).

### 6. Batch summary report
- **Content:** after a "Send to QuickBooks" run, a report listing every entry with vendor, amount, transaction type, category/account, resulting QBO entity type, returned QBO Id, and status (posted / skipped-as-duplicate / failed-with-reason), plus a run timestamp and totals.
- **Output:** viewable in-app and saveable/printable (PDF or print dialog).
- **Complexity:** LOW-MEDIUM. **Depends on:** posting results and the audit log.

### 7. Undo-last-batch (one-click reversal)
- **Behavior:** reverses every entry created in the most recent posted batch, using the QBO Ids stored at post time.
- **Critical API nuance (verified):** the QBO API does NOT support voiding **Bill** entities; Bills can only be **deleted** ([Intuit developer forum](https://help.developer.intuit.com/s/question/0D5TR0000037H5n0AE/how-to-void-a-quickbook-bill-using-api)). **Purchase** entities can be voided or deleted. So "undo" is a delete for Bills and a void-or-delete for Expenses. PROJECT.md's wording "one-click void" should be understood as "reverse," implemented per entity type. Flag this to requirements.
- **Correctness requirements:** delete/void requires the entity's current `Id` and `SyncToken`; the token may be stale if the entry was edited in QBO in the meantime, so re-fetch before reversing and handle "already changed / already deleted / linked-transaction" errors gracefully rather than failing the whole batch. Linked transactions must be unlinked before a Bill can be deleted.
- **Scope guard:** undo covers only the single most recent batch (per requirement), which keeps the state model simple and the failure surface small.
- **Complexity:** MEDIUM-HIGH (correctness-critical). **Depends on:** the audit log storing per-entry Id + SyncToken + entity type + batch id; posting.

## Feature Dependencies

```
QuickBooks OAuth connection (foundation)
    |--> Vendor / Account / Item lookups
    |         |--> Review table dropdowns
    |         |--> Vendor matching (prefer existing)
    |         |--> "Paid from" account picker (bank/CC accounts)
    |--> Posting (create Bill / Purchase)
              |--> Batch summary report
              |--> Undo-last-batch  (needs returned Id + SyncToken)

Hybrid parse pipeline (programmatic + vision + validation)
    |--> Review table pre-fill
    |--> Confidence flags (per-field signals)
    |--> Fuzzy duplicate warning (vendor + amount + date)

Local SQLite ledger (foundation)
    |--> File-hash dedupe (at ingest)
    |--> Audit log (returned QBO IDs)
    |--> Undo-last-batch
    |--> Batch summary report
    |--> Vendor-to-category rule learning

Date-named-folder ingestion --> Parse pipeline --> Review table --> Posting

Bill-vs-Expense typing --enables/requires--> "Paid from" account picker
Auto-publish (anti-feature) --conflicts with--> Human review gate (core value)
```

### Dependency Notes

- **Everything QBO-facing requires the OAuth connection first.** Vendor matching, account coding, the "Paid from" picker, posting, and undo all read or write QBO. This is the hard prerequisite phase.
- **Confidence flags require the parse pipeline to emit per-field signals.** If the pipeline only returns final values, confidence flags cannot be built afterward without rework. Design the pipeline to return signals from day one.
- **Undo and batch summary both consume posting results.** The audit log must capture the returned QBO Id, SyncToken, entity type, and a batch id at the moment of posting; if that data is not stored, neither feature can work later.
- **"Paid from" picker is gated by Bill/Expense typing.** It should only exist for Expense rows; build the typing control before or with the picker.
- **Duplicate detection is two features, not one.** File-hash dedupe lives in ingestion (local ledger); fuzzy vendor+amount+date warning lives in review (parse output + ledger history). They are independent and both needed.
- **Vendor-rule learning enhances category coding** but must never bypass the review gate; it pre-fills, it does not auto-post.
- **Auto-publish conflicts with the core value.** Listing it explicitly so it does not creep in as a "time-saver."

## MVP Definition

### Launch With (v1)

Everything needed to turn a folder into trustworthy QBO entries with a safety net.

- [ ] QuickBooks OAuth connect + token refresh - foundation for all QBO reads/writes
- [ ] Date-named-folder ingestion with file-hash dedupe - the input channel + first guardrail
- [ ] Hybrid parse pipeline emitting per-field values AND confidence signals - the extraction engine
- [ ] Vendor matching against QBO (prefer existing) - avoids polluting the company file
- [ ] Category/account coding from the QBO chart of accounts - required to post correctly
- [ ] Editable review table - the trust gate; core UI
- [ ] Per-row Bill-vs-Expense typing + conditional "Paid from" picker - correct entity per row
- [ ] Fuzzy duplicate warning (vendor + amount + date) - second guardrail
- [ ] Confidence flags on low-certainty fields - directs review attention
- [ ] Post to QBO as Bill/Purchase, storing returned Id + SyncToken - the payoff + audit basis
- [ ] Local audit log - underpins undo, dedupe, and reporting
- [ ] Batch summary report (save/print) - session paper trail
- [ ] Undo-last-batch (delete Bills / void-or-delete Purchases) - the safety net that builds trust
- [ ] Vendor-to-category rule learning (pre-fill only) - high value for a repeat-vendor business, cheap given the ledger already exists

### Add After Validation (v1.x)

- [ ] Multi-line / itemized splitting with sum-to-total validation - add once single-category flow is proven and real itemized bills appear
- [ ] Attach source file to the QBO entry via Attachable API - deferred in PROJECT.md; add when in-app traceability proves insufficient
- [ ] Persistent folder watcher (auto-detect new files) - polish once the manual scan flow is validated
- [ ] HEIC and additional image-format support hardening - as real phone-photo inputs surface

### Future Consideration (v2+)

- [ ] Splitting multiple invoices out of a single multi-page PDF - only if such documents actually occur
- [ ] Broader undo (older batches) - only if single-batch undo proves too limited
- [ ] Vendor-rule management UI (view/edit learned rules) - once enough rules accumulate to need curation

## Feature Prioritization Matrix

| Feature | User Value | Implementation Cost | Priority |
|---------|------------|---------------------|----------|
| QBO OAuth + token refresh | HIGH | MEDIUM | P1 |
| Date-named-folder ingestion + hash dedupe | HIGH | MEDIUM | P1 |
| Hybrid parse pipeline (+ confidence signals) | HIGH | HIGH | P1 |
| Vendor matching (prefer existing) | HIGH | MEDIUM | P1 |
| Category/account coding | HIGH | MEDIUM | P1 |
| Editable review table | HIGH | HIGH | P1 |
| Bill-vs-Expense typing + "Paid from" picker | HIGH | MEDIUM | P1 |
| Fuzzy duplicate warning | HIGH | MEDIUM | P1 |
| Confidence flags | MEDIUM | MEDIUM | P1 |
| Post to QBO (Bill/Purchase) + store Id/SyncToken | HIGH | MEDIUM | P1 |
| Local audit log | HIGH | MEDIUM | P1 |
| Undo-last-batch | HIGH | MEDIUM-HIGH | P1 |
| Batch summary report | MEDIUM | LOW-MEDIUM | P1 |
| Vendor-to-category rule learning | MEDIUM | MEDIUM | P2 |
| Multi-line splitting | MEDIUM | MEDIUM-HIGH | P2 |
| Attach source file to QBO entry | LOW-MEDIUM | MEDIUM | P2 |
| Persistent folder watcher | LOW | LOW-MEDIUM | P3 |

**Priority key:** P1 = must have for launch; P2 = should have, add when possible; P3 = nice to have, future.

## Competitor Feature Analysis

| Feature | Dext / AutoEntry | QBO native (Receipt Snap) | Bill.com / Ramp / Melio | NicoleBooks approach |
|---------|------------------|---------------------------|-------------------------|----------------------|
| Field extraction | Strong OCR+AI, high quality | Basic OCR, misreads totals/tax often | OCR on invoices | Hybrid programmatic + vision + deterministic validation |
| Line-item extraction | Yes (Dext/AutoEntry); Hubdoc no | Limited | Header-focused | v1.x differentiator; single-category is the v1 default |
| Vendor matching | Yes, to ledger | Partial, via bank-feed match | Yes | Fuzzy match to QBO vendors, prefer existing |
| Category learning per vendor | Yes ("remembers suppliers") | Minimal | Rules-based | Yes, pre-fill only, never auto-post |
| Duplicate detection | Supplier+date+amount | Weak | Vendor+invoice#+amount | Hash at ingest + fuzzy vendor+amount+date at review |
| Bill vs already-paid Expense | Both | Cannot create Bills | Both (and pays them) | Explicit per-row typing (fills the QBO-native gap) |
| Human review gate | Yes, with auto-publish option | Yes | Multi-approver | Single mandatory review gate, no auto-publish |
| Approval routing | Optional | No | Core (Bill.com) | Deliberately excluded (single user) |
| Payment execution | No | No | Yes | Deliberately excluded (record only) |
| Undo / reversal | Delete in ledger | Manual | Void/delete | One-click undo-last-batch (delete Bills, void/delete Purchases) |
| Audit trail | Yes | Limited | Yes (Ramp headline) | Local SQLite log with returned QBO IDs |

## Key Risks / Notes for Requirements

- **"One-click void" wording:** QBO's API cannot void Bills, only delete them; Purchases can be voided or deleted. Undo must branch by entity type. Update the requirement language to "reverse the last batch."
- **Confidence must be engineered, not asked of the model:** raw LLM self-confidence is unreliable. Build confidence from deterministic cross-checks. This is the single biggest correctness dependency on the review UX.
- **Store SyncToken at post time and re-fetch before undo:** stale tokens and linked-transaction constraints are the main ways undo fails in practice.

## Sources

- [Dext - Capture Receipts & Invoices](https://dext.com/us/business/product/capture-receipts-and-invoices) - duplicate detection (supplier+date+amount), supplier categorization memory
- [Dext - Line Item Extraction](https://dext.com/en/business/products/line-item-extraction) and [Smart Split help](https://help.dext.com/en/s/article/using-smart-split) - line-item and split behavior
- [Datamolino: AutoEntry vs Hubdoc vs Dext vs Datamolino 2026](https://www.datamolino.com/blog/pricing-and-features-autoentry-vs-hubdoc-vs-dext-vs-datamolino-in-2026/) - line-item extraction differences, QBO integration
- [Tofu: Best HubDoc Alternatives](https://www.gotofu.com/blog/best-hubdoc-alternatives) - Hubdoc header-only vs full line items
- [Ramp Accounts Payable](https://ramp.com/accounts-payable) and [Bill Pay approvals](https://support.ramp.com/bill-pay-approvals/) - duplicate flagging (vendor+invoice#+amount), audit trail, approval routing
- [Beancount: Bill.com vs Melio vs Ramp](https://beancount.io/blog/2026/07/11/bill-com-vs-melio-vs-ramp-accounts-payable-guide) and [Jamie Trull: BILL vs Melio](https://jamietrull.com/2026/02/28/small-business-accounts-payable-software/) - approval workflows, duplicate handling, payment execution scope
- [QBO Receipt Capture Review 2026](https://invoicedataextraction.com/blog/quickbooks-online-receipt-capture-reviews) - Receipt Snap does not create vendor Bills; OCR accuracy limits
- [Intuit Developer: void a QuickBooks bill via API](https://help.developer.intuit.com/s/question/0D5TR0000037H5n0AE/how-to-void-a-quickbook-bill-using-api) - Bills cannot be voided, only deleted
- [Knit: QuickBooks API integration guide](https://www.getknit.dev/blog/quickbooks-online-api-integration-guide-in-depth) and [use cases](https://developers.getknit.dev/docs/quickbooks-usecases-1) - Bill vs Purchase, delete requires Id+SyncToken, batch operations
- [Intuit: difference between bills, checks, and expenses](https://quickbooks.intuit.com/learn-support/en-us/help-article/accounts-payable/learn-difference-bills-checks-expenses-quickbooks/L0ZtL2TYI_US_en_US) - Bill (unpaid A/P) vs Expense (already paid)
- [Confidence scoring in document extraction](https://subhajitbhar.com/blog/idp/glossary/confidence-scoring-document-extraction/) - threshold-based routing of low-confidence fields to human review

---
*Feature research for: bill/receipt capture and AP automation posting to QuickBooks Online (single-user, low-volume)*
*Researched: 2026-07-22*
