// src/shared/ipc-contract.ts
//
// Single source of truth for the IPC trust boundary (SC4). This file declares the
// channel-name string constants and the payload/return TypeScript types for every
// method the renderer may reach through window.api.
//
// IMPORTANT: types plus string constants ONLY. This file has zero runtime Electron or
// Node imports, because BOTH sides of the boundary import it: the sandbox-safe preload
// (renderer side) and the main-process handlers (main side, added in plan 01-05). Any
// Electron/Node import here would break the sandboxed preload bundle.

/**
 * The exact channel-name constants for every IPC channel, grouped by feature: settings
 * (get/set), secrets (set/get/delete), theme (get plus the main-to-renderer broadcast
 * theme:changed), ingestion (Phase 2), and ai + parse (Phase 3). Handlers and the preload
 * import these verbatim so a rename cannot silently desync the two sides of the boundary;
 * test/ipc-contract.test.ts pins every value.
 */
export const Channels = {
  settingsGet: 'settings:get',
  settingsSet: 'settings:set',
  secretsSet: 'secrets:set',
  secretsGet: 'secrets:get',
  secretsDelete: 'secrets:delete',
  themeGet: 'theme:get',
  themeChanged: 'theme:changed',
  // ingestion channel group (Phase 2, plan 02-01). resolve/choose the flat inbox folder and
  // run a read-only scan. All fs/hash/db work runs main-side behind the Phase 1 trust boundary.
  ingestionResolveInbox: 'ingestion:resolve-inbox',
  ingestionChooseInbox: 'ingestion:choose-inbox',
  ingestionScan: 'ingestion:scan',
  // ai channel group (Phase 3, plan 03-01): connection test, live model list, and persistence of
  // the selected (non-secret) model id. The API key and base URL NEVER travel on these channels —
  // they are read main-side from the Phase 1 secret store (D-05/D-16).
  aiTestConnection: 'ai:test-connection',
  aiListModels: 'ai:list-models',
  aiSetModel: 'ai:set-model',
  // parse channel group (Phase 3, plan 03-01): batch parse of the loaded scan output, a single-file
  // re-parse override (D-14), and the main->renderer progress broadcast (D-26).
  parseBatch: 'parse:parse-batch',
  parseReparse: 'parse:reparse',
  parseProgress: 'parse:progress', // main->renderer broadcast (mirrors themeChanged)
  // ---------------------------------------------------------------------------
  // Finish-sprint channel groups (SEAMS). These names are a FIXED integration contract: the
  // downstream agents own the handler bodies in src/main/ipc/{qbo,recon,posting,upload}.ts and
  // may refine their group's response shapes, but a channel name may never be renamed, because
  // four modules are being written in parallel against exactly these strings.
  // ---------------------------------------------------------------------------
  // qbo channel group: OAuth connect/disconnect, connection status, and the QuickBooks
  // reference-data cache (vendors, expense accounts, payment accounts, items). Tokens NEVER
  // cross this boundary; they live in the OS keychain and are read main-side, exactly like the
  // AI credentials (D-05/D-16).
  qboStatus: 'qbo:status',
  qboConnect: 'qbo:connect',
  qboDisconnect: 'qbo:disconnect',
  qboSyncReference: 'qbo:sync-reference',
  qboGetReference: 'qbo:get-reference',
  qboStatusChanged: 'qbo:status-changed', // main->renderer broadcast (mirrors themeChanged)
  // recon channel group: reconcile parsed vendor/category text against the cached QBO reference
  // lists. Takes file hashes only, so no parsed field values are re-sent across the boundary.
  reconMatch: 'recon:match',
  // posting channel group: send an approved review batch to QuickBooks, inspect prior batches,
  // undo the last one, and render a printable per-batch report.
  postingSend: 'posting:send',
  postingProgress: 'posting:progress', // main->renderer broadcast (mirrors parseProgress)
  postingBatches: 'posting:batches',
  postingBatchDetail: 'posting:batch-detail',
  postingUndoLast: 'posting:undo-last',
  postingSummary: 'posting:summary',
  // upload channel group plus ingestion:pick-files. Both feed the same managed inbox the Phase 2
  // scan already reads, so the folder becomes an internal detail rather than the primary UX.
  ingestionPickFiles: 'ingestion:pick-files',
  uploadStart: 'upload:start',
  uploadStop: 'upload:stop',
  uploadStatus: 'upload:status',
  uploadReceived: 'upload:received' // main->renderer broadcast (mirrors themeChanged)
} as const

/** Union of every valid channel-name string. */
export type ChannelName = (typeof Channels)[keyof typeof Channels]

/** Payload for settings:set (validated by SettingsSetSchema in the main handler). */
export type SettingsSetPayload = { key: string; value: string }

/** Payload for secrets:set (validated by SecretSetSchema in the main handler). */
export type SecretSetPayload = { key: string; value: string }

/**
 * settings channel group. Plain key-value app settings (window size, last folder, and
 * so on). NO secret material ever flows here (secrets have their own encrypted channel).
 */
export interface SettingsApi {
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<boolean>
}

/**
 * secrets channel group. Values are encrypted at rest by the main process (safeStorage,
 * plan 01-05). The contract layer itself carries no secret material, only channel names
 * and length bounds (threat T-01-05: accept).
 */
export interface SecretsApi {
  set(key: string, value: string): Promise<void>
  get(key: string): Promise<string | null>
  delete(key: string): Promise<void>
}

/**
 * theme channel group. get resolves the current isDark value (main reads
 * nativeTheme.shouldUseDarkColors); onChange subscribes to the theme:changed broadcast
 * and returns an unsubscribe function.
 */
export interface ThemeApi {
  get(): Promise<boolean>
  onChange(cb: (isDark: boolean) => void): () => void
}

/**
 * Per-file outcome of a scan. Every status except junk (which is silently dropped, D-13)
 * surfaces in the results list. Later slices add the duplicate and not-ready statuses:
 * duplicate-* arrive in plan 02-02, not-ready-skipped in plan 02-03.
 */
export type ScanFileStatus =
  | 'loaded'
  | 'duplicate-excluded' // exact hash already posted (ledger, D-08/09) — plan 02-02
  | 'duplicate-in-batch' // within-scan byte-identical copy (D-10) — plan 02-02
  | 'not-ready-skipped' // placeholder or still-being-written (D-11) — plan 02-03
  | 'unsupported-skipped' // wrong file type (D-12) — this slice

/** One entry in a ScanResult. hash/sizeBytes are present for loaded/duplicate files. */
export interface ScanFile {
  filename: string
  status: ScanFileStatus
  hash?: string // 64-char lowercase SHA-256 hex; present for loaded / duplicate-*
  sizeBytes?: number
  postedAt?: string // present for duplicate-excluded ("Already entered on ...")
}

/** The whole result of one manual scan of the flat inbox. */
export interface ScanResult {
  batchEntryDate: string // processing date = local day of scan, 'YYYY-MM-DD' (D-05)
  inboxPath: string
  files: ScanFile[]
  summary: { total: number; loaded: number; duplicates: number; notReady: number; unsupported: number }
}

/**
 * ingestion channel group. resolveInbox reads (and, on first run, creates + persists) the
 * default inbox path; chooseInbox opens the native OS folder picker and persists the pick;
 * scan runs the read-only enumerate -> classify -> hash pipeline server-side (no renderer
 * path ever reaches fs — the path-injection guard).
 */
export interface IngestionApi {
  resolveInbox(): Promise<{ path: string; created: boolean }>
  chooseInbox(): Promise<{ canceled: true } | { canceled: false; path: string }>
  scan(): Promise<ScanResult>
  // Finish sprint: the native "Add files" picker. Main opens the OS open-file dialog, copies the
  // chosen documents into the managed inbox, and reports how many landed. The renderer never sees
  // (or sends) a filesystem path, so the T-02-02 path-injection guard is unchanged.
  pickFiles(): Promise<PickFilesResult>
}

/**
 * Result of ingestion:pick-files. `skipped` holds the FILE NAMES that were not copied (wrong type,
 * unreadable, or already present), never their paths, so nothing path-shaped crosses the boundary.
 */
export interface PickFilesResult {
  added: number
  skipped: string[]
}

// ---------------------------------------------------------------------------
// Phase 3 — ai + parse (plan 03-01)
//
// SECRET BOUNDARY (D-05/D-16): NOTHING below carries the AI API key or the base URL. Both are
// stored in the OS keychain via the Phase 1 secrets channel and read main-side when the client is
// built; the only AI configuration that crosses this boundary is the non-secret model id, plus
// result objects. A field carrying the credential or the endpoint URL would be a contract
// violation (threat T-03-01); the parse cache stores base_url_host (host only), never a secret.
// ---------------------------------------------------------------------------

/**
 * One model returned by the endpoint's /models, after vision classification (D-01/D-02).
 * `vision` records HOW it was classified, because the UI treats the three cases differently:
 *   'vision'        — the endpoint's own metadata says so (OpenRouter architecture.input_modalities
 *                     contains 'image'); badge it confidently.
 *   'vision-family' — no metadata, but the id matches the curated vision-family list; badge it.
 *   'unknown'       — unclassifiable; stays unbadged and hits the D-01 "use anyway" confirm gate.
 * The rich OpenRouter-only fields are all optional so OpenAI's minimal { id, object, created,
 * owned_by } shape degrades gracefully (RESEARCH Directive 6a).
 */
export interface ModelInfo {
  id: string
  label?: string
  vision: 'vision' | 'vision-family' | 'unknown'
  inputModalities?: string[]
  supportedParameters?: string[]
  contextLength?: number
}

/**
 * The validated field set for one bill, after the Zod deterministic gate (D-10) has coerced money
 * to integer cents and normalized dates to ISO. Mirrors the parsed_results columns (D-24). Only
 * `vendor` and `totalCents` are non-null-required — every optional is genuinely nullable, because
 * forcing fields required is a top cause of hallucinated fills (D-09).
 */
export interface ParsedFields {
  vendor: string
  invoiceNumber: string | null
  invoiceDate: string | null // ISO 'YYYY-MM-DD' after normalize
  dueDate: string | null
  subtotalCents: number | null // integer cents, never a float (RESEARCH Pitfall 4)
  taxCents: number | null
  totalCents: number
  currency: string | null
  suggestedCategory: string | null // rough model guess only; Phase 5 reconciles it against QBO
}

/**
 * Per-field confidence flags (D-11, deterministic-weighted). Keyed by ParsedFields field name.
 * 'flagged' means a deterministic check failed — the value is KEPT and surfaced for review, never
 * rejected and never silently corrected (D-12, flag-and-keep).
 */
export type FieldConfidence = Record<string, 'high' | 'low' | 'flagged'>

/** Per-file outcome of a parse. 'cached' means the D-14 hash cache answered with no model call. */
export type ParseFileStatus = 'parsed' | 'parse-failed' | 'cached'

/** One entry in a ParseBatchResult. `hash` is the Phase 2 SHA-256, the join key to ScanFile. */
export interface ParseFileResult {
  filename: string
  hash: string
  status: ParseFileStatus
  fields?: ParsedFields // absent on parse-failed
  confidence?: FieldConfidence
  validationFlags?: string[] // which deterministic checks failed (D-12)
  truncated?: boolean // over the D-21 10-page cap: only pages 1-3 + the last 2 were sent
  error?: string // recoverable, human-readable reason for parse-failed (never a raw stack)
}

/** One loaded file handed to parse:parse-batch. Mirrors the loaded subset of ScanFile. */
export interface ParseBatchFile {
  filename: string
  hash: string
  batchEntryDate: string
}

/** Payload of the parse:progress broadcast — the "parsing N/M" surface (D-26). */
export interface ParseProgress {
  done: number
  total: number
  filename: string
  status: ParseFileStatus
}

/** The whole result of one batch parse. One file failing never aborts the batch (D-15). */
export interface ParseBatchResult {
  files: ParseFileResult[]
  summary: { total: number; parsed: number; failed: number; cached: number }
}

/**
 * ai channel group. testConnection calls the endpoint's /models exactly once so a single action
 * both validates the stored key + base URL and populates the picker (D-04). listModels re-fetches.
 * setModel persists the non-secret selected model id to app_settings. The key never crosses here
 * in either direction.
 */
export interface AiApi {
  testConnection(): Promise<{ ok: boolean; models?: ModelInfo[]; error?: string }>
  listModels(): Promise<ModelInfo[]>
  setModel(modelId: string): Promise<boolean>
}

/**
 * parse channel group. parseBatch parses the loaded scan output (auto-fired by the renderer after
 * a scan, deliberately NOT inside the scan IPC call — D-26). reparse forces a fresh model call for
 * one file, overriding the hash cache (D-14). onProgress subscribes to the parse:progress
 * broadcast and returns an unsubscribe function, exactly like ThemeApi.onChange.
 */
export interface ParseApi {
  parseBatch(files: ParseBatchFile[]): Promise<ParseBatchResult>
  reparse(fileHash: string): Promise<ParseFileResult>
  onProgress(cb: (progress: ParseProgress) => void): () => void
}

// ---------------------------------------------------------------------------
// Finish sprint — qbo (QUICKBOOKS CONNECT)
//
// SECRET BOUNDARY (mirrors the AI rules above): the QuickBooks access token, refresh token and
// client secret NEVER appear in any type below. They are stored encrypted main-side and read only
// where a request is signed. What crosses this boundary is connection STATE plus non-secret
// reference data (names and ids the user picks from). realmId is the company id, not a credential;
// it identifies which QuickBooks company is connected and is safe to display.
// ---------------------------------------------------------------------------

/**
 * Connection state as the renderer must render it. 'expired' is deliberately distinct from
 * 'disconnected': the refresh token rolls (~100 days) and silently dropping to 'disconnected'
 * would hide the fact that reconnecting is a one-click reauthorization, not fresh setup.
 */
export type QboConnectionState = 'disconnected' | 'connected' | 'expired'

/** The single status object every qbo channel (and the qbo:status-changed broadcast) returns. */
export interface QboStatus {
  state: QboConnectionState
  companyName: string | null // display name of the connected company, null when disconnected
  realmId: string | null // QuickBooks company id (not a credential)
  lastSyncAt: string | null // ISO timestamp of the last successful reference sync
}

/** One selectable QuickBooks record (a vendor or an item) as the review grid needs it. */
export interface QboRefRecord {
  id: string
  name: string
  active: boolean // inactive records stay in the cache so an existing bill still resolves its name
}

/**
 * A chart-of-accounts entry. accountType/accountSubType are carried because they are what
 * separates a category (expense) account from a "Paid from" (bank/credit card) account, and the
 * review grid has to filter the two lists differently.
 */
export interface QboRefAccount extends QboRefRecord {
  accountType: string
  accountSubType: string | null
}

/** Counts written by one qbo:sync-reference run, so the UI can say what it refreshed. */
export interface QboSyncResult {
  vendors: number
  expenseAccounts: number
  paymentAccounts: number
  items: number
  syncedAt: string // ISO timestamp
}

/** The whole cached reference set. syncedAt is null when nothing has ever been synced. */
export interface QboReference {
  vendors: QboRefRecord[]
  expenseAccounts: QboRefAccount[]
  paymentAccounts: QboRefAccount[]
  items: QboRefRecord[]
  syncedAt: string | null
}

/**
 * qbo channel group. connect kicks off the browser authorization-code flow main-side (the loopback
 * redirect is caught by main, never by the renderer) and resolves with the resulting status, so one
 * call both starts and reports the connection. Every method returns the SAME QboStatus shape so the
 * renderer has exactly one status reducer. onStatusChanged subscribes to the qbo:status-changed
 * broadcast and returns an unsubscribe function, exactly like ThemeApi.onChange.
 */
export interface QboApi {
  status(): Promise<QboStatus>
  connect(): Promise<QboStatus>
  disconnect(): Promise<QboStatus>
  syncReference(): Promise<QboSyncResult>
  getReference(): Promise<QboReference>
  onStatusChanged(cb: (status: QboStatus) => void): () => void
}

// ---------------------------------------------------------------------------
// Finish sprint — recon (RECONCILIATION)
// ---------------------------------------------------------------------------

/**
 * How a match was reached, which is what the review grid renders differently:
 *   'auto'      — confident enough to pre-select and leave unhighlighted
 *   'suggested' — pre-selected but flagged for a look
 *   'none'      — nothing plausible; the cell starts empty and the user picks
 */
export type MatchConfidence = 'auto' | 'suggested' | 'none'

/** One ranked alternative for a cell's dropdown. `score` is 0..1, higher is a better match. */
export interface MatchCandidate {
  id: string
  name: string
  score: number
}

/**
 * The resolved value for one cell. selectedId/selectedName are null when confidence is 'none'.
 * Candidates are always present so the dropdown can show the runners-up without a second call.
 */
export interface MatchResult {
  selectedId: string | null
  selectedName: string | null
  confidence: MatchConfidence
  candidates: MatchCandidate[]
}

/** Both reconciled cells for one document. */
export interface FileMatch {
  vendor: MatchResult
  category: MatchResult
}

/** recon:match result, keyed by the Phase 2 SHA-256 file hash (the same join key as everywhere). */
export interface ReconMatchResult {
  matches: Record<string, FileMatch>
}

/**
 * recon channel group. The renderer sends HASHES ONLY: the parsed vendor/category text is already
 * in the main-side parsed_results cache, so re-sending it would duplicate the source of truth and
 * widen the payload for nothing.
 */
export interface ReconApi {
  match(fileHashes: string[]): Promise<ReconMatchResult>
}

// ---------------------------------------------------------------------------
// Finish sprint — posting (SEND TO QUICKBOOKS)
// ---------------------------------------------------------------------------

/** Which QuickBooks entity a row becomes: a Bill (payable later) or a Purchase (already paid). */
export type PostingEntryType = 'bill' | 'expense'

/**
 * Per-entry lifecycle. 'sent' and 'confirmed' are deliberately separate: a request can succeed at
 * the socket and still leave us unsure the entity exists, and only a confirmed read-back may write
 * the dedupe ledger. Collapsing them would risk double-posting after a timeout.
 */
export type PostingEntryState = 'pending' | 'sent' | 'confirmed' | 'failed'

/**
 * One approved review row, exactly as the user left it. Money is INTEGER CENTS end to end
 * (RESEARCH Pitfall 4); a float here would lose cents in a financial tool. paidFromAccountId is
 * null for 'bill' rows and required for 'expense' rows (a Purchase must name what paid it) — that
 * cross-field rule is enforced by the posting group's schema, not by the type.
 */
export interface PostingRow {
  fileHash: string
  entryType: PostingEntryType
  vendorId: string
  categoryAccountId: string
  paidFromAccountId: string | null
  txnDate: string // ISO 'YYYY-MM-DD'
  dueDate: string | null // ISO 'YYYY-MM-DD'; bills only
  refNumber: string | null // QuickBooks DocNumber
  amountCents: number
  memo: string | null
}

/** posting:send result. The batch id is the handle for progress, detail, undo, and the report. */
export interface PostingSendResult {
  batchId: string
}

/** Payload of the posting:progress broadcast — the "sending N/M" surface. */
export interface PostingProgress {
  batchId: string
  done: number
  total: number
  current: { fileHash: string; state: PostingEntryState } | null
}

/** One row of the batch history list. */
export interface PostingBatchSummaryRow {
  batchId: string
  createdAt: string // ISO timestamp
  total: number
  confirmed: number
  failed: number
}

/** posting:batches result. Newest first. */
export interface PostingBatchesResult {
  batches: PostingBatchSummaryRow[]
}

/**
 * One entry inside a batch. syncToken is QuickBooks' optimistic-concurrency token and is what a
 * void/undo needs alongside the id, so it is recorded at post time rather than re-fetched later.
 * `error` is always recoverable, human-readable copy, never a raw API body or a stack.
 */
export interface PostingBatchEntry {
  fileHash: string
  entryType: PostingEntryType
  qboId: string | null
  syncToken: string | null
  state: PostingEntryState
  error: string | null
}

/** posting:batch-detail result. */
export interface PostingBatchDetail {
  entries: PostingBatchEntry[]
}

/**
 * posting:undo-last result. batchId is null when there is nothing to undo. Per-entity results are
 * returned rather than a single boolean because a partial undo is a real outcome the user must
 * see: some entities void cleanly, others are already paid or already deleted in QuickBooks.
 */
export interface PostingUndoResult {
  batchId: string | null
  results: Array<{ qboId: string; undone: boolean; reason: string | null }>
}

/** One printable line of a batch report. Names are denormalized so the report renders offline. */
export interface PostingSummaryLine {
  fileHash: string
  filename: string
  vendorName: string
  categoryName: string
  entryType: PostingEntryType
  txnDate: string
  refNumber: string | null
  amountCents: number
  state: PostingEntryState
  qboId: string | null
  error: string | null
}

/**
 * posting:summary result: everything a printable "what did I just send" report needs, resolved
 * main-side so the renderer never has to re-join ids against the reference cache to print.
 */
export interface PostingSummary {
  batchId: string
  createdAt: string
  companyName: string | null
  totals: { entries: number; confirmed: number; failed: number; amountCents: number }
  lines: PostingSummaryLine[]
}

/**
 * posting channel group. send hands over the approved rows and returns immediately with a batch id;
 * per-entry outcomes arrive on the posting:progress broadcast and are readable afterwards through
 * batchDetail, so a closed window never loses a batch. onProgress returns an unsubscribe function,
 * exactly like ParseApi.onProgress.
 */
export interface PostingApi {
  send(rows: PostingRow[]): Promise<PostingSendResult>
  batches(): Promise<PostingBatchesResult>
  batchDetail(batchId: string): Promise<PostingBatchDetail>
  undoLast(): Promise<PostingUndoResult>
  summary(batchId: string): Promise<PostingSummary>
  onProgress(cb: (progress: PostingProgress) => void): () => void
}

// ---------------------------------------------------------------------------
// Finish sprint — upload (PHONE UPLOAD OVER THE LAN)
// ---------------------------------------------------------------------------

/** upload:start result. qrDataUrl is a self-contained data: URI, so the renderer fetches nothing. */
export interface UploadStartResult {
  url: string
  qrDataUrl: string
}

/** upload:stop result. */
export interface UploadStopResult {
  stopped: boolean
}

/** upload:status result. url is null while the server is not running. */
export interface UploadStatusResult {
  running: boolean
  url: string | null
  receivedCount: number
}

/** Payload of the upload:received broadcast. File NAMES only, never paths (T-02-02). */
export interface UploadReceived {
  filenames: string[]
}

/**
 * upload channel group. The LAN-only HTTP server runs entirely in main; the renderer only starts
 * and stops it and renders the pairing URL plus its QR code. onReceived subscribes to the
 * upload:received broadcast and returns an unsubscribe function, exactly like ThemeApi.onChange.
 */
export interface UploadApi {
  start(): Promise<UploadStartResult>
  stop(): Promise<UploadStopResult>
  status(): Promise<UploadStatusResult>
  onReceived(cb: (received: UploadReceived) => void): () => void
}

/**
 * The complete typed surface exposed to the renderer as window.api. The preload builds
 * a concrete object conforming to this interface and re-exports its type as Api, and the
 * renderer Window augmentation derives from that preload type, so every layer traces back
 * to this one contract.
 */
export interface Api {
  settings: SettingsApi
  secrets: SecretsApi
  theme: ThemeApi
  ingestion: IngestionApi
  ai: AiApi
  parse: ParseApi
  qbo: QboApi
  recon: ReconApi
  posting: PostingApi
  upload: UploadApi
}
