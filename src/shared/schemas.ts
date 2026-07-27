// src/shared/schemas.ts
//
// Zod schemas that gate every IPC payload at the main-process handler (plan 01-05).
// A thrown parse becomes a rejected promise in the renderer, so a malformed payload
// never reaches the privileged action. These bounds ARE the T-01-03 input-validation
// control (tampering mitigation) for the IPC boundary: min/max lengths on every key and
// value. The unit suite in test/ipc-contract.test.ts proves the accept/reject behavior.
//
// Length bounds (from 01-RESEARCH Security Domain, lines 694 and 706):
//   key:            min 1, max 128   (never empty, guards oversized keys)
//   settings value: max 4096         (plain app-settings strings)
//   secret value:   max 8192         (room for tokens and API keys)

import { z } from 'zod'

/** settings:set payload. Rejects empty keys, oversized keys/values, and non-string fields. */
export const SettingsSetSchema = z.object({
  key: z.string().min(1).max(128),
  value: z.string().max(4096)
})

/** settings:get key. Bare string, never empty, bounded length. */
export const SettingsKeySchema = z.string().min(1).max(128)

/** secrets:set payload. Same key bounds as settings; a larger value ceiling for tokens. */
export const SecretSetSchema = z.object({
  key: z.string().min(1).max(128),
  value: z.string().max(8192)
})

/** secrets:get and secrets:delete key. Bare string, never empty, bounded length. */
export const SecretKeySchema = z.string().min(1).max(128)

// ingestion:scan takes NO renderer payload: the inbox path is read server-side from
// app_settings, which removes any path-injection surface (D-15, threat T-02-02). The strict
// empty-object schema rejects any payload a caller tries to smuggle in before runScan runs.
export const ScanRequestSchema = z.object({}).strict()

// ---------------------------------------------------------------------------
// Phase 3 — ai + parse payload schemas (plan 03-01)
//
// SECRET BOUNDARY (D-05, threat T-03-01): no schema below carries the AI credential or the
// endpoint URL. Both live in the OS keychain and are read main-side when the client is built, so
// the renderer never sends and never receives them. Adding such a field here would be the leak.
// ---------------------------------------------------------------------------

/**
 * ai:test-connection takes NO renderer payload — the key and base URL are read main-side from the
 * secret store (D-04/D-05). Strict-empty, exactly like ScanRequestSchema, so a caller cannot
 * smuggle a credential (or anything else) in and have it reach the client builder.
 */
export const AiTestConnectionSchema = z.object({}).strict()

/**
 * ai:list-models is likewise payload-free: same server-side credential resolution, just a re-fetch.
 */
export const AiListModelsSchema = z.object({}).strict()

/**
 * ai:set-model payload. The selected model id is the ONE piece of AI config that is non-secret and
 * therefore allowed to cross the boundary; it is persisted to app_settings (D-05). Bounded like
 * every other IPC string — provider-qualified ids ("openai/gpt-4o-2024-11-20") stay well inside 256.
 */
export const AiSetModelSchema = z.object({
  modelId: z.string().min(1).max(256)
})

/**
 * parse:parse-batch payload: the loaded subset of the Phase 2 scan. `hash` is pinned to exactly 64
 * chars (SHA-256 hex) because it is the parsed_results primary key and the cache lookup key (D-14)
 * — a wrong-length value can never become a cache row. The 500-entry ceiling bounds the batch a
 * single call can queue (Nicole's real batches are 5-20 files), and `filename` is bounded but is
 * NEVER used to build a filesystem path — the pipeline resolves bytes from the server-side inbox,
 * the same path-injection guard as ingestion:scan (T-02-02).
 */
export const ParseBatchSchema = z
  .array(
    z.object({
      filename: z.string().min(1).max(1024),
      hash: z.string().length(64),
      batchEntryDate: z.string().min(1).max(32)
    })
  )
  .max(500)

/** parse:reparse payload. The explicit per-doc override that forces a fresh model call (D-14). */
export const ReparseSchema = z.object({
  fileHash: z.string().length(64)
})

/**
 * The authoritative gate on the MODEL's output (D-09/D-23/D-25). Not an IPC payload schema — it
 * validates what comes back from the vision call, and it is re-applied locally even when the
 * provider claims strict structured-output support, because the local Zod parse is the only layer
 * we control (RESEARCH Pattern 3).
 *
 * Two rules make this schema load-bearing:
 *   1. Only `vendor` and `total` are required. Every other field is genuinely `.nullable()`, paired
 *      with the prompt's "return null if absent" instruction — forcing optionals to be required is
 *      the top cause of hallucinated fills, e.g. inventing an invoice number on a cash receipt (D-09).
 *   2. Money stays the RAW PRINTED STRING here ('1,234.10', '$5.00'). The model is never asked to
 *      do arithmetic or unit conversion; the string -> integer-cents coercion is deterministic and
 *      local, in 03-06's validate.ts (D-23, RESEARCH Pitfall 4).
 */
export const BillSchema = z.object({
  vendor: z.string(),
  invoice_number: z.string().nullable(),
  invoice_date: z.string().nullable(),
  due_date: z.string().nullable(),
  subtotal: z.string().nullable(), // raw printed string; cents coercion happens in validate.ts
  tax: z.string().nullable(),
  total: z.string(), // raw printed string
  currency: z.string().nullable(),
  suggested_category: z.string().nullable()
})

/** The inferred model-output type, so extract-fields.ts and validate.ts share one source of truth. */
export type Bill = z.infer<typeof BillSchema>

// ---------------------------------------------------------------------------
// Finish sprint — qbo / recon / posting / upload payload schemas (SEAMS)
//
// TWO RULES CARRIED FORWARD, both load-bearing:
//   1. PAYLOAD-FREE CHANNELS use z.object({}).strict() and the handler parses `raw ?? {}`, never a
//      bare `raw`. The preload invokes those channels with NO argument, so raw is undefined and
//      z.object({}).strict().parse(undefined) throws 'expected object, received undefined' — which
//      is exactly the defect that shipped ingestion:scan permanently-rejecting for a whole phase.
//      The strict gate still rejects anything smuggled in; only the undefined case is normalized.
//   2. NO SECRET MATERIAL. No schema below carries a QuickBooks access token, refresh token, or
//      client secret. Those live encrypted main-side and are read only where a request is signed.
//      realmId is a company identifier, not a credential, and is never accepted FROM the renderer.
//
// Downstream agents own their group's schemas and may tighten these bounds. They may not rename a
// channel, and they may not loosen a schema into z.any() or drop .strict() from a payload-free one.
// ---------------------------------------------------------------------------

/**
 * The Phase 2 SHA-256 file hash, pinned to exactly 64 chars. This is the join key across scan,
 * parse, recon, and posting, and it is also a parsed_results primary key, so a wrong-length value
 * can never reach a cache or ledger lookup.
 */
const FileHashSchema = z.string().length(64)

/**
 * A QuickBooks entity id as it comes back from the API. Intuit returns short numeric strings, but
 * the bound is generous because ids are opaque; what matters is that it is a non-empty, bounded
 * string and never an object that could smuggle structure into a query builder.
 */
const QboIdSchema = z.string().min(1).max(64)

/** ISO calendar date, 'YYYY-MM-DD'. QuickBooks rejects anything else, so reject it here first. */
const IsoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)

// --- qbo: every channel in the group is payload-free -------------------------
// The connection is resolved server-side from the encrypted token store, so there is nothing
// legitimate for the renderer to send on any of these and the strict-empty schema rejects
// anything it tries to (a smuggled realmId would be an attempt to redirect the company).

/** qbo:status payload gate. */
export const QboStatusSchema = z.object({}).strict()

/** qbo:connect payload gate. The OAuth flow is started main-side; no renderer input is accepted. */
export const QboConnectSchema = z.object({}).strict()

/** qbo:disconnect payload gate. */
export const QboDisconnectSchema = z.object({}).strict()

/** qbo:sync-reference payload gate. */
export const QboSyncReferenceSchema = z.object({}).strict()

/** qbo:get-reference payload gate. */
export const QboGetReferenceSchema = z.object({}).strict()

/**
 * qbo:create-vendor payload. The ONE qbo channel that carries renderer input, because the name of a
 * vendor that does not exist yet cannot come from anywhere else.
 *
 * Trimmed BEFORE the length checks, so a field holding only spaces is refused rather than sent to
 * QuickBooks as an empty DisplayName. The 100-character ceiling is Intuit's own DisplayName limit:
 * catching it here turns a mid-click API rejection into an up-front validation error. The value is
 * sent as a JSON string field, never interpolated into a URL or a query statement.
 */
export const QboCreateVendorSchema = z.object({
  displayName: z.string().trim().min(1).max(100)
})

// --- recon -------------------------------------------------------------------

/**
 * recon:match payload. Hashes ONLY: the parsed vendor/category text already lives in the main-side
 * parsed_results cache, so accepting it from the renderer would let a compromised renderer steer
 * the match against text the parser never produced. The 500 ceiling mirrors ParseBatchSchema.
 */
export const ReconMatchSchema = z.object({
  fileHashes: z.array(FileHashSchema).max(500)
})

// --- posting -----------------------------------------------------------------

/**
 * One approved review row.
 *
 * amountCents is INTEGER cents and must be positive (RESEARCH Pitfall 4): a float would lose cents,
 * and a zero or negative amount is a credit memo, which is not something this app posts. The
 * ceiling is ~1 billion dollars, far above any real bill but low enough that an absurd value from a
 * mis-parse is refused before it reaches QuickBooks.
 *
 * refNumber is capped at 21 characters because that is the QuickBooks DocNumber limit; catching it
 * here turns a confusing API rejection mid-batch into an up-front validation error.
 *
 * NOTE for POSTING-ENGINE: the bill-vs-expense cross-field rule (a 'expense' row must name a
 * paidFromAccountId, a 'bill' row must not) is deliberately NOT encoded here. Add it in your own
 * module with .superRefine or .check so the refinement lives beside the code that depends on it.
 */
export const PostingRowSchema = z.object({
  fileHash: FileHashSchema,
  entryType: z.enum(['bill', 'expense']),
  vendorId: QboIdSchema,
  categoryAccountId: QboIdSchema,
  paidFromAccountId: QboIdSchema.nullable(),
  txnDate: IsoDateSchema,
  dueDate: IsoDateSchema.nullable(),
  refNumber: z.string().min(1).max(21).nullable(),
  amountCents: z.number().int().positive().max(99999999999),
  memo: z.string().max(4000).nullable()
})

/**
 * posting:send payload. At least one row (an empty send is a UI bug, not a no-op worth a batch id)
 * and at most 500, the same ceiling as a parse batch.
 */
export const PostingSendSchema = z.object({
  rows: z.array(PostingRowSchema).min(1).max(500)
})

/** posting:batches is payload-free: the history is read server-side from the audit tables. */
export const PostingBatchesSchema = z.object({}).strict()

/** posting:batch-detail payload. The batch id is opaque and bounded, never interpolated into SQL. */
export const PostingBatchDetailSchema = z.object({
  batchId: z.string().min(1).max(64)
})

/**
 * posting:undo-last is payload-free BY DESIGN: "the last batch" is resolved server-side. Letting
 * the renderer name a batch id would turn undo into "void any batch you can name", which is a much
 * larger destructive surface than the one-step undo the UI actually offers.
 */
export const PostingUndoLastSchema = z.object({}).strict()

/** posting:summary payload. Same bounded opaque batch id as batch-detail. */
export const PostingSummarySchema = z.object({
  batchId: z.string().min(1).max(64)
})

/**
 * posting:check-duplicates payload (REVIEW-UI).
 *
 * The three fields that define "the same bill" plus an opaque rowKey the renderer uses to attach
 * each answer to the row that asked. Bounds mirror PostingRowSchema deliberately: a probe that
 * could carry an amount PostingRowSchema would refuse would be checking a row that can never be
 * sent. An EMPTY probe list is allowed, because a debounced check can legitimately fire with
 * nothing complete yet, and answering {} is cheaper than making the renderer special-case it.
 */
export const PostingCheckDuplicatesSchema = z.object({
  probes: z
    .array(
      z.object({
        rowKey: z.string().min(1).max(128),
        vendorId: QboIdSchema,
        amountCents: z.number().int().positive().max(99999999999),
        txnDate: IsoDateSchema
      })
    )
    .max(500)
})

// --- upload + ingestion:pick-files: all payload-free --------------------------
// pick-files opens the native dialog main-side and the upload server binds main-side, so neither
// accepts a renderer-supplied path, port, or host. That is the same path-injection guard as
// ingestion:scan (T-02-02), extended to the two new ways documents enter the inbox.

/** ingestion:pick-files payload gate. */
export const IngestionPickFilesSchema = z.object({}).strict()

/** upload:start payload gate. */
export const UploadStartSchema = z.object({}).strict()

/** upload:stop payload gate. */
export const UploadStopSchema = z.object({}).strict()

/** upload:status payload gate. */
export const UploadStatusSchema = z.object({}).strict()
