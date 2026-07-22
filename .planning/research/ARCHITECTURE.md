# Architecture Research

**Domain:** Cross-platform desktop app (document-to-accounting automation) with LLM parsing and QuickBooks Online integration
**Researched:** 2026-07-22
**Confidence:** HIGH (QuickBooks entity shapes, query API, and OAuth flow verified against official Intuit docs via Context7; component and data-flow design derived from those constraints plus standard desktop-app security patterns)

## Standard Architecture

NicoleBooks is a **local-first, single-user desktop pipeline app**. There is no server tier and no multi-tenant concern. The right shape is a **two-process desktop app** (a sandboxed UI front-end plus a privileged back-end core) with all input/output, secrets, and network calls confined to the back-end, and a **staged pipeline** (ingest, parse, reconcile, review, post, record) driving a document from a watched folder to a posted QuickBooks entry.

The single most important architectural boundary is the **front-end / back-end trust boundary**: the UI (webview/renderer) must never touch the filesystem, the database, the OS keychain, or the network directly. It communicates only through typed IPC commands and events. This keeps API keys and OAuth tokens out of the web layer, which is the standard security posture for both Tauri and Electron.

### System Overview

```
┌───────────────────────────────────────────────────────────────────────┐
│  FRONT-END  (webview / renderer - sandboxed, no direct IO)             │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌────────────┐  │
│  │ Review Table │  │  Settings    │  │ Batch Summary│  │ Connect QB │  │
│  │ (dropdowns,  │  │ (AI key,     │  │ / Report     │  │ button     │  │
│  │  conf flags, │  │  model pick) │  │              │  │            │  │
│  │  type toggle)│  │              │  │              │  │            │  │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘  └─────┬──────┘  │
│         │                 │                 │                │         │
└─────────┼─────────────────┼─────────────────┼────────────────┼─────────┘
          │        IPC commands (invoke)  +  events (emit)      │
══════════╪═════════════════ TRUST BOUNDARY ════════════════════╪═════════
          ▼                                                      ▼
┌───────────────────────────────────────────────────────────────────────┐
│  BACK-END CORE  (Tauri Rust core / Electron main - all IO + secrets)   │
│                                                                         │
│  ┌───────────┐   ┌───────────────┐   ┌────────────────────────────┐    │
│  │ Folder    │──▶│ File Store +  │──▶│ Parse Pipeline             │    │
│  │ Watcher / │   │ Dedupe        │   │  ┌────────┐ ┌────────────┐  │    │
│  │ Ingestion │   │ (SHA-256)     │   │  │ Text   │ │ Image Prep │  │    │
│  └───────────┘   └───────────────┘   │  │ Extract│ │(rasterize) │  │    │
│                                      │  └───┬────┘ └─────┬──────┘  │    │
│                                      │      └─────┬──────┘         │    │
│                                      │      ┌─────▼──────┐         │    │
│                                      │      │ Vision     │◀────────┼──┐ │
│                                      │      │ Structuring│         │  │ │
│                                      │      └─────┬──────┘         │  │ │
│                                      │      ┌─────▼──────┐         │  │ │
│                                      │      │ Validation │         │  │ │
│                                      │      │(sums,dates)│         │  │ │
│                                      │      └─────┬──────┘         │  │ │
│                                      └────────────┼────────────────┘  │ │
│                        ┌──────────────────────────▼───────────────┐   │ │
│                        │ Reconciliation / Matching Engine         │   │ │
│                        │ (fuzzy match vendor/account/item,        │   │ │
│                        │  prefer-existing, confidence thresholds) │   │ │
│                        └───────┬──────────────────────┬───────────┘   │ │
│                                │                       │               │ │
│   ┌──────────────┐   ┌─────────▼─────────┐   ┌─────────▼──────────┐   │ │
│   │ AI Client    │◀──│ QuickBooks API    │   │ Batch / Undo Mgr   │   │ │
│   │ (OpenAI-     │   │ Client            │   │ (audit log, submit,│   │ │
│   │  compatible) │   │  - OAuth manager  │   │  undo-last-batch)  │   │ │
│   │  model list, │   │  - entity CRUD    │   └─────────┬──────────┘   │ │
│   │  vision chat)│   │  - query          │             │              │ │
│   └──────┬───────┘   │  - delete/void    │             │              │ │
│          │           └───┬───────────┬───┘             │              │ │
│          │               │           │                 │              │ │
│   ┌──────▼───────────────▼──┐   ┌────▼─────────────────▼──────────┐   │ │
│   │ Secret Store (OS keychain)│   │ Persistence / Repository       │   │ │
│   │  - AI API key             │   │ (SQLite: dedupe, docs, batches,│───┘ │
│   │  - QBO OAuth tokens       │   │  audit log, cached QBO refs)   │     │
│   └───────────────────────────┘   └────────────────────────────────┘     │
└───────────────────────────────────────────────────────────────────────┘
                    │                              │
                    ▼                              ▼
          ┌──────────────────┐          ┌────────────────────┐
          │ AI provider      │          │ QuickBooks Online  │
          │ (OpenAI /        │          │ API (v3, OAuth2,   │
          │  OpenRouter)     │          │  sandbox first)    │
          └──────────────────┘          └────────────────────┘
```

### Component Responsibilities

| Component | Responsibility (what it owns) | Talks to |
|-----------|-------------------------------|----------|
| **Folder Watcher / Ingestion** | Watch the configured root for date-named subfolders; detect new PDF/image files; parse the intended entry date from the folder name; enqueue files. Debounce partial writes. | File Store/Dedupe (push new files); Persistence (record ingest events) |
| **File Store + Dedupe** | Compute SHA-256 of each file; look up the hash in the dedupe table; skip or flag exact re-drops; copy the file into an app-managed store (or record its path) with a stable internal id. | Persistence (hash + doc record); Parse Pipeline (hand off unique files) |
| **Parse Pipeline** (orchestrator) | Drive a single document through: classify (digital PDF vs scanned/photo), text-extract, image-prep, vision-structure, validate. Produce a normalized `ParsedBill` object with per-field confidence. | Text Extractor, Image Prep, AI Client, Validation, Persistence |
| **Text Extractor** | Pull embedded text from digital PDFs; decide "has real text" vs "needs vision". Feed text to the AI as context to cut cost and boost accuracy. | Parse Pipeline |
| **Image Prep** | Rasterize PDF pages when needed; normalize/resize/re-encode photos to a vision-friendly format and size; produce base64/data-URL payloads. | Parse Pipeline, AI Client |
| **Vision Structuring** (via AI Client) | Send text + image to the vision model with a strict JSON schema; return structured fields: vendor, dates, doc number, subtotal, tax, total, line items, suggested transaction type, suggested category per line. | AI Client |
| **Validation** | Deterministic checks: line items sum to subtotal/total; subtotal + tax == total; parse dates and currency; range-check; set/adjust confidence flags. No LLM here. | Parse Pipeline, Persistence |
| **Reconciliation / Matching Engine** | Load and cache QBO reference lists (vendors, expense accounts, bank/credit-card accounts, items); fuzzy-match extracted names against them; apply confidence thresholds to decide **match existing vs suggest-create**; attach candidate lists to each editable field for the dropdowns. | QBO Client (query), Persistence (ref cache), Parse output |
| **AI Client** (OpenAI-compatible) | List available models (flag vision capability where derivable); perform vision chat completions with structured/JSON output; retry with backoff; enforce timeouts. Holds no UI logic. | Secret Store (key), external AI provider |
| **QuickBooks API Client** | Own everything QBO: OAuth manager (auth-code flow, token persistence, auto-refresh, reconnect), entity CRUD (create Bill/Purchase), query (Vendor/Account/Item), delete/void for undo, rate-limit + retry, sandbox-vs-production base URL switch. | Secret Store (tokens), Persistence (SyncTokens/ids), external QBO API |
| **Batch / Undo Manager** | Group an approved review set into a batch; submit each row through the QBO Client; persist an audit record per entry (internal id, QBO id, SyncToken, entity type, amount, timestamp); implement undo-last-batch by deleting/voiding the batch's entities. | QBO Client, Persistence |
| **Persistence / Repository** (SQLite) | Single source of local truth: dedupe hashes, parsed docs, batches, audit log, cached QBO references, settings pointers. Migrations. | All back-end components |
| **Secret Store** (OS keychain adapter) | Store/retrieve the AI API key and QBO OAuth tokens in the OS keychain (Keychain on macOS, Credential Manager on Windows). Never write secrets to SQLite or disk in plaintext. | AI Client, QBO OAuth manager |
| **Reporting** | Generate a saveable/printable batch summary from the audit log (what posted, QBO ids, totals, any skipped/duplicate rows). | Persistence, Front-end (report view) |

## Recommended Project Structure

Framework-agnostic layout (the front-end folder is a web app; the core folder is the privileged process, whether that is a Tauri Rust crate or an Electron main-process module). The **STACK.md** research owns the final Tauri-vs-Electron call; this structure works for either by keeping the pipeline in the core and the UI thin.

```
nicolebooks/
├── src-ui/                      # FRONT-END (webview / renderer)
│   ├── views/
│   │   ├── ReviewTable/         # editable dropdowns, confidence flags,
│   │   │                        #   Bill/Expense toggle, Paid-from picker
│   │   ├── Settings/            # AI key entry, model picker, QB connect
│   │   └── BatchSummary/        # printable/saveable report
│   ├── state/                   # client store: current batch under review
│   ├── ipc/                     # typed wrappers over invoke()/emit()
│   └── theme/                   # Magnet Group brand tokens, NicoleBooks wordmark
│
├── core/                        # BACK-END (all IO, secrets, network)
│   ├── ingestion/               # folder watcher, date-folder parsing, queue
│   ├── files/                   # hashing, dedupe, file store
│   ├── parse/
│   │   ├── extract/             # PDF text extraction, digital-vs-scanned classify
│   │   ├── imageprep/           # rasterize, normalize, encode for vision
│   │   ├── structure/           # AI vision structuring + JSON schema
│   │   └── validate/            # deterministic sums/dates/currency checks
│   ├── reconcile/               # fuzzy matching, confidence thresholds, ref cache
│   ├── quickbooks/
│   │   ├── oauth/               # auth-code flow, token store, refresh, reconnect
│   │   ├── entities/            # Bill + Purchase builders, delete/void
│   │   ├── query/               # Vendor/Account/Item queries
│   │   └── client/              # base URL (sandbox|prod), retry, rate-limit
│   ├── ai/                      # OpenAI-compatible client, model listing
│   ├── batch/                   # submit orchestration, audit log, undo-last-batch
│   ├── secrets/                 # OS keychain adapter
│   ├── db/                      # SQLite schema, migrations, repositories
│   └── ipc/                     # command handlers exposed to the UI
│
└── shared/                      # types shared across the boundary
    └── contracts/               # ParsedBill, ReviewRow, BatchResult, enums
```

### Structure Rationale

- **`src-ui/` vs `core/` split mirrors the process boundary.** Anything that reads files, hits SQLite, touches the keychain, or calls an API lives under `core/`. The UI only imports from `shared/contracts` and calls `ipc/`.
- **`parse/` is a sub-pipeline of its own** because it has four distinct, independently testable stages. Each stage has a pure function signature (input document -> output object) so it can be unit tested with fixture PDFs and photos, no network required (mock the AI client).
- **`quickbooks/` isolates the one integration with a hard external dependency and a credentials gate.** Keeping OAuth, entities, query, and client separate lets the sandbox-first build proceed with a single seam (base URL + token source) to flip for live credentials.
- **`shared/contracts/` is the anti-corruption layer.** The UI speaks in `ReviewRow`, never in raw QuickBooks JSON. QuickBooks-specific shapes never leak into the front-end.

## Architectural Patterns

### Pattern 1: Two-process desktop app with a strict IPC boundary

**What:** The UI runs in a sandboxed webview and can do nothing privileged. All filesystem, database, keychain, and network work happens in the back-end core. They communicate through a small set of typed IPC commands (request/response) and events (back-end -> UI push).

**When to use:** Always, for this app. It is the default security model of both Tauri and Electron and is mandatory here because the app holds an AI key and live financial-system tokens.

**Trade-offs:** More ceremony than a single-process app (every capability needs a command). The payoff is that a compromised or buggy renderer cannot read tokens or write to QuickBooks directly.

**Example (conceptual):**
```
// UI (front-end) - no secrets, no IO
const rows = await ipc.invoke("parse_pending_folder", { folder });
ipc.on("batch_progress", (p) => updateProgressBar(p));
await ipc.invoke("submit_batch", { rows });   // returns BatchResult with QBO ids

// Core (back-end) - registered command handler
register("submit_batch", async ({ rows }) => batchManager.submit(rows));
```

### Pattern 2: Staged pipeline with a normalized intermediate object

**What:** A document flows through discrete stages, each producing/enriching one `ParsedBill` -> `ReviewRow` object. Each stage is pure and idempotent where possible; results are persisted after expensive stages (hashing, extraction, AI call, reconciliation) so a crash or restart resumes without re-calling the AI.

**When to use:** For the ingest-to-review path. Persisting after the AI call is important because that step costs money and latency; never re-run it just because the UI reloaded.

**Trade-offs:** Requires a small state machine / status field per document (`ingested`, `parsed`, `reconciled`, `reviewed`, `posted`, `failed`). Worth it for reliability and cost control.

### Pattern 3: Prefer-existing reconciliation (match-or-suggest-create)

**What:** For each extracted vendor, expense account/category, and item, the engine searches cached QBO reference data and returns a ranked candidate list with a confidence score. A high-confidence exact/near-exact match is auto-selected; a medium match is pre-selected but flagged for the user to confirm; a low or no match surfaces a "create new" option. Creation of a new QBO vendor/account/item is never silent; it only happens through an explicit user choice at review time (or at submit for a confirmed new vendor).

**When to use:** The core of the reconciliation engine. This is what keeps the QuickBooks company clean and satisfies "prefer existing over create new".

**Trade-offs:** Requires a fuzzy-match strategy and threshold tuning. Recommended approach: normalize strings (lowercase, strip punctuation/legal suffixes like "LLC"/"Inc"), try exact match, then a QBO `LIKE` query on a prefix/token, then a local similarity score (token-set / Levenshtein ratio). Suggested thresholds: >= 0.90 auto-select, 0.70-0.90 pre-select + flag, < 0.70 offer create-new. Tune against sandbox data.

**Example (QBO query for candidates):**
```
GET /v3/company/<realmId>/query?query=select * from Vendor where DisplayName LIKE 'Home%'
GET /v3/company/<realmId>/query?query=select * from Account where AccountType = 'Expense'
GET /v3/company/<realmId>/query?query=select * from Item maxresults 100
```

## Data Flow

### End-to-end: folder to posted QuickBooks entry

```
[User drops files into  .../2026-07-22/ ]
      ↓  (Folder Watcher detects; parses entry date = 2026-07-22)
[File Store + Dedupe]  --SHA-256--> check dedupe table
      ↓  new/unique                              ↘ exact re-drop -> skip + flag
[persist: documents row (status=ingested, hash, path, entry_date)]
      ↓
[Parse Pipeline]
   classify digital-PDF vs photo/scan
      ↓
   Text Extract (digital)  or  Image Prep (photo / scanned PDF page)
      ↓
   Vision Structuring (AI Client -> strict JSON: vendor, dates, doc #,
                       subtotal, tax, total, line items, type, category/line)
      ↓
   Validation (line sums == total? subtotal+tax==total? dates/currency parse?)
      ↓
[persist: parsed fields + per-field confidence (status=parsed)]
      ↓
[Reconciliation Engine]
   match vendor -> VendorRef candidate(s)
   match each line category -> expense AccountRef candidate(s)
   (if item-based) match item -> ItemRef candidate(s)
   soft duplicate check: vendor + amount + date near an existing audit entry?
      ↓
[persist: candidate refs + match confidence (status=reconciled)]
      ↓  emit "batch_ready" event
[Review UI]  table of ReviewRows: editable vendor/category dropdowns,
             editable amount, Bill<->Expense toggle, Paid-from picker (Expense),
             low-confidence flags, duplicate warnings
      ↓  user edits + clicks "Send to QuickBooks"
[persist: user-confirmed values (status=reviewed)]
      ↓
[Batch / Undo Manager]  -> for each row:
   build Bill  (VendorRef + Line[AccountBasedExpenseLineDetail.AccountRef])
   OR Purchase (PaymentType + AccountRef[paid-from] + Line[...])
      ↓
[QuickBooks API Client]  POST create (sandbox or production base URL)
      ↓  response: QBO Id + SyncToken
[persist: audit_log (internal id, QBO id, SyncToken, entity type, amount,
          realmId, batch id, timestamp)  (status=posted)]
      ↓
[Reporting]  batch summary (posted rows, QBO ids, totals, skipped/dupes)
             -> save / print

[Undo-last-batch]  read latest batch's audit rows ->
   POST /bill?operation=delete  or  /purchase?operation=delete
   with { Id, SyncToken }  -> mark batch reversed
```

### What is persisted at each step (SQLite)

| Step | Persisted | Why |
|------|-----------|-----|
| Ingest | `documents`: hash, source path, entry_date, status | Dedupe across runs; resume; audit trail of what was seen |
| Parse | parsed field values + per-field confidence + raw AI response ref | Avoid re-calling the paid AI model on reload/crash |
| Reconcile | candidate refs + chosen defaults + match scores; cached QBO ref lists | Fast review; offline-capable review; consistent candidates |
| Review | user-confirmed final values | Source of what will be posted; undo/repost safety |
| Post | `audit_log`: internal id, QBO id, SyncToken, entity type, amount, realmId, batch id, timestamp | Duplicate guardrails, batch summary, and undo-last-batch |
| Reference cache | `qbo_vendors`, `qbo_accounts`, `qbo_items` with LastUpdatedTime | Reconcile without hammering the QBO query API; incremental refresh |

## QuickBooks Online Domain Model (verified against Intuit docs)

Two target entities. Choice is per-row via the transaction-type control.

### Bill (accounts payable - money owed, not yet paid)

- **Required:** `VendorRef` + at least one `Line`. Each expense line needs `DetailType`, `Amount`, and `AccountBasedExpenseLineDetail.AccountRef` (the expense/category account).
- **`APAccountRef`** is optional on create; QuickBooks defaults it to the company's Accounts Payable account. Do not set it unless there is a specific reason.
- **`DueDate`** and **`TxnDate`** are optional (TxnDate defaults to today; the app should set TxnDate from the date-named folder).
- Minimal create body (verified):
```json
{
  "VendorRef": { "value": "56" },
  "Line": [
    { "DetailType": "AccountBasedExpenseLineDetail", "Amount": 200.0,
      "AccountBasedExpenseLineDetail": { "AccountRef": { "value": "7" } } }
  ]
}
```

### Purchase (expense - already paid, cash/check/credit card)

- **Required:** `PaymentType` (`Cash` | `Check` | `CreditCard`), `AccountRef`, and at least one `Line`.
- **`AccountRef` here is the "paid-from" source account, not an expense category.** Rules: `Check` must reference a bank account; `CreditCard` must reference a credit-card account. This is exactly the review UI's "Paid from" picker for Expense rows.
- **`EntityRef`** (with `"type": "Vendor"`) is the vendor and is optional but should be set when known.
- The expense category still lives inside the line: `Line[].AccountBasedExpenseLineDetail.AccountRef` is the expense account.
- Minimal create body (verified):
```json
{
  "PaymentType": "CreditCard",
  "AccountRef": { "value": "42", "name": "Visa" },
  "EntityRef": { "value": "60", "type": "Vendor" },
  "Line": [
    { "DetailType": "AccountBasedExpenseLineDetail", "Amount": 10.0,
      "AccountBasedExpenseLineDetail": { "AccountRef": { "value": "13" } } }
  ]
}
```

### AccountBasedExpenseLineDetail vs ItemBasedExpenseLineDetail

- **AccountBasedExpenseLineDetail** categorizes a line to an expense **account** (a chart-of-accounts category). This is the default and correct choice for a **service business**, which is NicoleBooks' primary case, and it applies to both Bill and Purchase.
- **ItemBasedExpenseLineDetail** ties a line to a QuickBooks **Item** (a product/service record, often inventory), using `ItemRef`, `Qty`, `UnitPrice`. Use only when a bill genuinely maps to catalog items. For v1, default every line to account-based; treat item-based as an optional enhancement, not table stakes.

### Querying and name matching (verified)

- Read reference data via the query endpoint: `GET /v3/company/<realmId>/query?query=<SQL-like select>`. Supports `select * from Vendor`, `... from Account`, `... from Item`, `WHERE`, `LIKE`, `maxresults`, and paging with `startposition`.
- **Prefer-existing implementation:** cache the full vendor/expense-account/paid-from-account/item lists locally (they are small for one company); refresh incrementally using `WHERE MetaData.LastUpdatedTime > <last sync>`. Match extracted names against the cache with normalization + exact -> `LIKE` -> local similarity scoring and the confidence thresholds above. Only create a new Vendor/Account/Item when the user explicitly confirms no existing record fits.

### Undo-last-batch (verified)

- Both entities support hard delete: `POST /v3/company/<realmId>/bill?operation=delete` and `POST /v3/company/<realmId>/purchase?operation=delete`, each requiring only `{ Id, SyncToken }` in the body. Store the returned `Id` and `SyncToken` in the audit log at post time so undo needs no extra fetch.
- Caveat: a Bill cannot be deleted while it has linked transactions (for example a BillPayment). Since NicoleBooks creates **unpaid** Bills, they will have no linked payments, so delete is clean. Still, handle the linked-transaction error path gracefully.

## OAuth 2.0 Connection Lifecycle (desktop, verified constraints)

QuickBooks uses the **OAuth 2.0 authorization-code flow**. Key verified facts:

- Authorize endpoint: `https://appcenter.intuit.com/connect/oauth2` with `client_id`, `redirect_uri`, `response_type=code`, `scope=com.intuit.quickbooks.accounting`, `state`.
- Token endpoint: `POST https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer` with HTTP Basic auth (`client_id:client_secret`) and `grant_type=authorization_code` (then `grant_type=refresh_token` to refresh).
- **Access token lives ~60 minutes.** **Refresh token lives ~100 days and rotates**: every refresh response returns a new refresh token that you must persist, replacing the old one. Let a stale refresh token linger and the connection dies.
- `realmId` (the company id) comes back on the redirect and must be stored alongside the tokens; every API call is scoped by it.

### The redirect-URI constraint (the critical desktop seam)

- **Sandbox/development:** Intuit allows a plain `http://localhost:<port>` redirect URI. So the entire OAuth flow can be built and tested locally using a **loopback listener** (spin up a throwaway `http://localhost:<port>/callback` server in the core, open the system browser to the authorize URL, capture the `code` on the loopback, exchange for tokens).
- **Production:** Intuit requires an **HTTPS** redirect URI and **rejects IP addresses** (and plain `http://localhost`). A native desktop app therefore cannot use a bare loopback URL in production.

**Recommended handling:** build the loopback flow first for sandbox. For production, register a small **static HTTPS callback page** (for example on GitHub Pages under the magnetgrouplabs org, which already hosts the repo) as the redirect URI. That page reads `?code=...&state=...` and immediately forwards to the local loopback listener via a browser redirect to `http://127.0.0.1:<port>/callback?...`, preserving the one-click "log in and you are connected" UX. The user's browser performs the final local hop, so Intuit only ever sees the HTTPS URI. (A lower-effort fallback for a single-user tool: the HTTPS page displays the code for the user to paste once; acceptable because reconnection is rare given the ~100-day refresh window.)

### Token storage and reconnect

- Store access token, refresh token, refresh-token expiry, and `realmId` in the **OS keychain** via the Secret Store, never in SQLite or a plaintext config file.
- On every QBO call: if the access token is near/after expiry, refresh first; on `401`, refresh once and retry; on refresh failure (expired/revoked refresh token past 100 days), surface a "Reconnect QuickBooks" state in the UI that re-runs the authorize flow.
- Keep a sandbox-vs-production flag that switches both the API base URL (`sandbox-quickbooks.api.intuit.com` vs `quickbooks.api.intuit.com`) and the redirect strategy.

## Suggested Build Order (dependency-driven, sandbox-first)

The overriding constraint (from PROJECT.md) is that **live QuickBooks credentials are not available yet**, and everything except live posting should be buildable and testable against the QuickBooks **sandbox**, with a clean seam for the live-credentials pause. The dependency graph below reflects that.

```
Foundation ─┬─▶ Ingest+Dedupe ─▶ Parse Pipeline ─▶ Reconcile ─▶ Review UI ─┐
            │        (needs DB)      (needs AI)     (needs QBO             │
            │                                        query, sandbox)       │
            └─▶ Secret Store                                               ▼
                                                          Batch/Post+Audit ─▶ Undo ─▶ Reporting
                                                          (SANDBOX first;         (needs audit log)
                                                           live-creds SEAM)
```

**Recommended phase decomposition:**

1. **App shell + boundary + persistence foundation.** Two-process skeleton, typed IPC, SQLite schema + migrations, Secret Store adapter, branding tokens. Everything downstream depends on the boundary and the DB. No external services yet.
2. **Ingestion + file store + dedupe.** Folder watcher, date-folder parsing, SHA-256 hashing, dedupe table, `documents` lifecycle. Fully testable with local files; no network.
3. **AI client + parse pipeline.** OpenAI-compatible client (model listing, vision chat, JSON schema), text extraction, image prep, structuring, deterministic validation. Testable with fixture PDFs/photos and a real or mocked AI key; no QuickBooks needed.
4. **QuickBooks client against sandbox (read side first).** OAuth loopback flow, token store/refresh, and the **query** API (Vendor/Account/Item) plus the reference cache. This is the first QuickBooks work and it runs entirely against the sandbox with a `http://localhost` redirect. **This is where the live-credentials pause lands:** Anthony provides sandbox client id/secret to proceed; production is a later flip.
5. **Reconciliation / matching engine.** Fuzzy matching, thresholds, prefer-existing logic, soft duplicate detection. Depends on the sandbox query + cache from phase 4.
6. **Review UI.** Editable table, dropdowns fed by reconciliation candidates, Bill/Expense toggle, Paid-from picker, confidence flags, duplicate warnings. Depends on parsed + reconciled data.
7. **Batch post + audit log (sandbox), then undo, then reporting.** Build Bill/Purchase entities and POST to the **sandbox**; record audit rows with returned Id + SyncToken; implement undo-last-batch (delete); generate batch summaries. All exercised end-to-end in sandbox.
8. **Production cutover (thin, isolated).** Flip base URL to production, register the HTTPS redirect page, swap in live client id/secret, and run a controlled live smoke test. Because every posting path was proven in sandbox behind a single base-URL + redirect seam, this phase is small and low-risk.

**The sandbox-first seam in one sentence:** the QuickBooks API Client exposes a single `environment` switch that selects (a) the API base URL and (b) the redirect strategy (loopback for sandbox, HTTPS page for production); nothing else in the app knows or cares which environment is live, so the live-credentials pause is a one-parameter change plus a redirect-page registration.

## Front-end / Back-end Responsibility Split

Whether the final stack is **Tauri** (Rust core + system webview, commands via `#[tauri::command]` and events) or **Electron** (Node main process + Chromium renderer, `ipcMain`/`ipcRenderer` with a `contextBridge` preload), the division of labor is identical:

| Concern | Front-end (webview / renderer) | Back-end core (Tauri Rust / Electron main) |
|---------|-------------------------------|---------------------------------------------|
| Filesystem / folder watching | Never | Owns it |
| SQLite | Never | Owns it |
| OS keychain / secrets | Never | Owns it |
| Network (AI, QuickBooks) | Never | Owns it |
| OAuth loopback server | Never | Owns it |
| Hashing, PDF extraction, image prep | Never | Owns it |
| Rendering the review table, dropdowns, flags | Owns it | Never |
| Holding the in-review batch state | Owns it (transient UI state) | Owns the persisted source of truth |
| Business rules (matching, validation, entity building) | Never | Owns it |
| Triggering actions | Calls IPC commands | Registers command handlers |

**Rules of the split:**
- The renderer calls **coarse-grained commands** (`parse_pending_folder`, `get_review_batch`, `submit_batch`, `undo_last_batch`, `connect_quickbooks`, `list_models`), not fine-grained CRUD. Keep the API surface small and intention-revealing.
- Long-running work (parsing a folder, submitting a batch) reports progress via **events** the UI subscribes to, so the UI stays responsive and shows per-file/per-row status.
- Secrets and tokens **never cross the boundary**. The UI's "Connect QuickBooks" button triggers a core-side flow; the UI only learns "connected / needs reconnect", never the tokens.
- With Electron specifically: keep `nodeIntegration` off, `contextIsolation` on, and expose only a whitelisted IPC surface through a preload `contextBridge`. With Tauri: keep the allowlist minimal and route capability through commands rather than broad plugin permissions.

**Framework lean (defer final call to STACK.md):** both satisfy the requirements. Tauri gives smaller binaries, lower memory, and a strong default security posture, at the cost of a Rust back-end and a slightly thinner library ecosystem for PDF text extraction. Electron gives an all-JavaScript back-end and the richest library ecosystem (mature PDF and image tooling, `keytar`, `chokidar`, `better-sqlite3`) at the cost of larger installers and heavier updates. For a solo builder prioritizing low deployment headache with mature PDF/keychain/SQLite libraries, Electron is the pragmatic default; if binary size, memory, and security posture dominate, Tauri wins. Either way, this architecture (strict boundary, staged pipeline, single QBO environment seam) is unchanged.

## Load and Robustness Considerations

This is a **single-user, low-volume** tool (roughly 5-20 bills per week). Classic "scale" is a non-issue; the real robustness concerns are latency, external limits, and correctness.

| Concern | Reality here | Handling |
|---------|-------------|----------|
| AI latency/cost | A few dozen vision calls per week | Persist parse results; never re-call on reload; run files concurrently with a small bound (2-4) |
| QuickBooks rate limits | Well within limits at this volume | Cache reference data; batch-refresh with `LastUpdatedTime`; single retry with backoff on 429/5xx |
| Token expiry mid-batch | Access token can expire during a slow batch | Refresh-before-expiry and refresh-once-on-401 in the QBO client |
| Duplicate posting | The biggest correctness risk | File-hash dedupe + soft (vendor+amount+date) warnings + audit log with QBO ids; make submit idempotent per document id |
| Partial batch failure | One row fails, others succeed | Post row-by-row, record each result, report successes/failures separately; undo operates on recorded ids only |
| Crash mid-pipeline | Possible | Status field per document lets the pipeline resume from the last persisted stage |

## Anti-Patterns

### Anti-Pattern 1: Doing IO or holding secrets in the renderer

**What people do:** Call the QuickBooks or AI API directly from the web/renderer layer, or read the keychain there, to "save an IPC hop".
**Why it's wrong:** Puts live financial tokens and the AI key in the most exposed process; a single XSS or a bad dependency can exfiltrate them. Also couples UI to QuickBooks JSON.
**Do this instead:** Confine all IO and secrets to the core; the UI only calls typed commands and speaks in `ReviewRow`/`BatchResult`, never raw QBO shapes.

### Anti-Pattern 2: Auto-creating QuickBooks vendors/accounts/items on a weak match

**What people do:** When the extracted vendor does not exactly match, silently create a new Vendor (or Account/Item).
**Why it's wrong:** Pollutes the client's QuickBooks company with duplicate/misspelled vendors and mis-categorized accounts, which is exactly what "prefer existing" is meant to prevent, and is hard to clean up.
**Do this instead:** Fuzzy-match with thresholds; auto-select only high-confidence matches; require explicit user confirmation before any create.

### Anti-Pattern 3: Re-running the vision model on every UI reload

**What people do:** Treat parsing as stateless and re-call the AI whenever the review screen re-renders.
**Why it's wrong:** Wastes money and adds latency; also risks non-deterministic re-extraction changing values the user already reviewed.
**Do this instead:** Persist parse output after the AI call; the review screen reads from SQLite. Re-parse only on explicit user request.

### Anti-Pattern 4: Confusing Purchase.AccountRef with the expense category

**What people do:** Put the expense category account in `Purchase.AccountRef`.
**Why it's wrong:** For a Purchase, top-level `AccountRef` is the **paid-from** bank/credit-card account; the category belongs in `Line[].AccountBasedExpenseLineDetail.AccountRef`. Swapping them posts to the wrong ledger accounts.
**Do this instead:** Map the "Paid from" picker to `Purchase.AccountRef` and the per-line "category" dropdown to the line detail's `AccountRef`. (Bills have no paid-from; they use only the line-level category and default `APAccountRef`.)

### Anti-Pattern 5: Building against production QuickBooks from day one

**What people do:** Wait for live credentials, then wire QuickBooks last against production.
**Why it's wrong:** Blocks progress on the credentials gate and puts first-ever posting code against a real company.
**Do this instead:** Build and prove the entire QuickBooks path (OAuth loopback, query, create, delete) against the **sandbox** behind a single environment seam; make production a thin, late cutover.

## Integration Points

### External Services

| Service | Integration Pattern | Notes / gotchas |
|---------|---------------------|-----------------|
| QuickBooks Online API v3 | OAuth 2.0 auth-code flow; REST create/query/delete; scoped by `realmId` | Access token 60 min; refresh token ~100 days and **rotates** (persist the new one). Sandbox allows `http://localhost` redirect; production requires **HTTPS**, no IPs. Delete needs `{Id, SyncToken}`. Purchase requires PaymentType + paid-from AccountRef; Bill requires VendorRef. |
| AI provider (OpenAI / OpenRouter) | OpenAI-compatible REST; user-supplied key; dynamic model list; vision chat with JSON/structured output | Must be vision-capable; surface vision capability in the model picker where derivable. Send extracted PDF text alongside the image to cut cost and improve accuracy. Handle timeouts/retries. |
| OS keychain | macOS Keychain / Windows Credential Manager via a keychain library | Only secret store; never fall back to plaintext files. One entry each for AI key and the QBO token bundle. |

### Internal Boundaries

| Boundary | Communication | Considerations |
|----------|---------------|----------------|
| Renderer <-> Core | Typed IPC commands + progress events | Coarse-grained commands; no secrets cross; UI speaks in shared contracts, not QBO JSON |
| Parse Pipeline <-> AI Client | Function call with schema + image/text payload | Mockable for tests; persist result immediately after |
| Reconcile <-> QBO Client | Query + local reference cache | Reconcile reads cache; cache refreshed incrementally via `LastUpdatedTime` |
| Batch Manager <-> QBO Client | Create + delete calls; returns Id/SyncToken | Persist audit row before reporting success; undo reads audit rows only |
| All core modules <-> Persistence | Repository interfaces over SQLite | Single source of local truth; status field drives resumability |
| AI Client / QBO OAuth <-> Secret Store | Keychain read/write | The only components allowed to touch secrets |

## Sources

- QuickBooks Online Accounting API - Purchase entity (create, delete, AccountRef, PaymentType, line details): https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/purchase (via Context7, HIGH)
- QuickBooks Online Accounting API - Bill entity (create, delete, VendorRef, APAccountRef, line details): https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/bill (via Context7, HIGH)
- QuickBooks Online Accounting API - Vendor / Account / Item query endpoint (SELECT, LIKE, LastUpdatedTime): https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/vendor (via Context7, HIGH)
- Intuit OAuth 2.0 - authorization/token endpoints, token lifetimes, refresh rotation: https://developer.intuit.com/app/developer/qbo/docs/develop/authentication-and-authorization/oauth-2.0 (via Context7, HIGH)
- Intuit - set app redirect URIs (localhost allowed for sandbox; HTTPS required and IPs disallowed for production): https://developer.intuit.com/app/developer/qbo/docs/develop/authentication-and-authorization/set-redirect-uri (via Context7, HIGH)
- Intuit authorization FAQ (redirect URI requirements, TLS, no IP addresses): https://developer.intuit.com/app/developer/qbo/docs/develop/authentication-and-authorization/faq (via Context7, HIGH)
- QuickBooks API OAuth 2.0 for desktop application (loopback vs hosted redirect, token storage, ~100-day refresh) - Hongbo Liu: https://medium.com/@devedium/quickbooks-api-oauth-2-0-for-desktop-application-964041871166 (WebSearch, MEDIUM - corroborates the verified Intuit redirect constraint)
- Tauri command/event IPC and Electron main/renderer + contextBridge security model (standard desktop two-process boundary) - framework docs (training + standard practice, MEDIUM; final stack choice deferred to STACK.md)

---
*Architecture research for: cross-platform desktop bill-to-QuickBooks automation (NicoleBooks)*
*Researched: 2026-07-22*
