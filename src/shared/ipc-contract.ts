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
  parseProgress: 'parse:progress' // main->renderer broadcast (mirrors themeChanged)
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
}
