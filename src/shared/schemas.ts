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
