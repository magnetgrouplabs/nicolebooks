// src/main/parse/cache.ts
//
// The parsed-results cache: read and write parsed_results by the Phase 2 SHA-256 file hash
// (PARSE-05, decisions D-14/D-24, threats T-03-06 tampering / T-03-01 disclosure).
//
// This module is the whole point of PARSE-05. The pipeline is cache-first, cache-last: step 1
// is getCached(hash), and a hit returns WITHOUT any model call, so the same bytes are never
// paid for twice; the final step is putCached(row), so a reload or a crash finds the result
// already on disk.
//
// KEYED ON THE HASH ALONE (D-14 / RESEARCH Pitfall 7). The `model` column records which model
// produced the row, but it is NOT part of the key: switching the selected model in Settings
// must never silently re-parse and re-charge every already-parsed document. Two things do
// invalidate a row, both deliberate:
//   1. an explicit per-doc Re-parse (03-07's parse:reparse, which overwrites via putCached), and
//   2. a SCHEMA_VERSION bump — a prompt or output-schema change means the stored fields were
//      produced by a contract we no longer use, so getCached treats the row as a miss. That
//      gate lives HERE rather than in the caller so no future call site can forget it.
//
// SECURITY. Every value is bound through a prepared statement and never interpolated into SQL
// (T-03-06) — the settings.ts / ledger.ts convention. That matters more here than anywhere
// else in the app, because the values are derived from an attacker-influenceable document:
// anyone can mail a PDF whose vendor line reads `Robert'); DROP TABLE parsed_results; --`.
// Bound, it is stored as text; interpolated, it would be executed.
//
// NO SECRET MATERIAL IS PERSISTED (D-05, T-03-01). putCached accepts the base URL and stores
// only its HOST, so a gateway URL carrying the key in userinfo or a query string
// (`https://sk-live-...@gw.example.com/v1?key=sk-live-...`) cannot leak into the database.
// The key itself lives in the OS keychain and is never read by this module.

import type Database from 'better-sqlite3'
import { getDatabase } from '../db/connection'
import type { FieldConfidence, ParsedFields } from '../../shared/ipc-contract'
import type { ParseRoute } from './route'

/**
 * The version of the prompt + output-schema contract that produced a cached row. Bump this
 * when a change to the prompt (D-23) or the bill schema makes previously cached fields
 * untrustworthy; every existing row then reads as a miss and is re-parsed once. A MODEL change
 * is deliberately NOT a reason to bump (D-14).
 *
 * History:
 *   1  the original transcription-only prompt. suggested_category was read off the page, so it
 *      came back null on every bill (no bill prints one) and every review row needed its category
 *      picked by hand.
 *   2  suggested_category became an INFERENCE from the vendor and the line items (prompt.ts's
 *      CATEGORY_INSTRUCTION). Rows written under version 1 hold a null category that the current
 *      contract would have filled, so serving one would hand the user a blank cell the app can now
 *      answer. They stay on disk for their D-24 audit value and are re-parsed once on next scan.
 */
export const SCHEMA_VERSION = 2

/** What putCached accepts. `db` is injectable so tests drive a temp DB with no Electron. */
export interface CacheRowInput {
  /** The Phase 2 SHA-256 hex hash. The cache key. */
  fileHash: string
  originalFilename: string
  route: ParseRoute
  pageCount: number
  /** The model id that produced this result — recorded, never part of the key (D-14). */
  model: string
  /** The configured base URL. Only its HOST is stored; the key is never accepted here (D-05). */
  baseUrl?: string | null
  /** The validated field set: integer cents, ISO dates (03-03's validate.ts output). */
  fields: ParsedFields
  confidence: FieldConfidence
  /** Which deterministic checks failed (D-12, flag-and-keep). */
  validationFlags?: readonly string[] | null
  /** The model reply verbatim, for the D-24 audit column. Stored, never logged. */
  rawResponse?: string | null
  /** ISO timestamp. */
  parsedAt: string
  /** True when the D-21 10-page cap truncated the request. Persisted as a 0/1 INTEGER. */
  truncated?: boolean
}

/** What getCached returns on a hit: the input shape, deserialized, plus the stored provenance. */
export interface CachedResult {
  fileHash: string
  originalFilename: string
  route: ParseRoute
  pageCount: number
  model: string
  baseUrlHost: string | null
  fields: ParsedFields
  confidence: FieldConfidence
  validationFlags: string[]
  rawResponse: string | null
  parsedAt: string
  schemaVersion: number
  truncated: boolean
}

/** The raw parsed_results row as SQLite returns it (snake_case, JSON blobs still text). */
interface ParsedResultsRow {
  file_hash: string
  original_filename: string
  route: string
  page_count: number
  model: string
  base_url_host: string | null
  vendor: string | null
  invoice_number: string | null
  invoice_date: string | null
  due_date: string | null
  subtotal_cents: number | null
  tax_cents: number | null
  total_cents: number
  currency: string | null
  suggested_category: string | null
  field_confidence: string
  validation_flags: string | null
  raw_response: string | null
  parsed_at: string
  schema_version: number
  truncated: number
}

const SELECT_SQL = 'SELECT * FROM parsed_results WHERE file_hash = ?'

// Named parameters (@name), never interpolation (T-03-06). ON CONFLICT(file_hash) makes the
// write an upsert on the hash alone, so re-parsing a document — with the same model or a
// different one — updates the single existing row instead of erroring or duplicating it.
const UPSERT_SQL = `INSERT INTO parsed_results (
    file_hash, original_filename, route, page_count, model, base_url_host,
    vendor, invoice_number, invoice_date, due_date,
    subtotal_cents, tax_cents, total_cents, currency, suggested_category,
    field_confidence, validation_flags, raw_response, parsed_at, schema_version, truncated
  ) VALUES (
    @file_hash, @original_filename, @route, @page_count, @model, @base_url_host,
    @vendor, @invoice_number, @invoice_date, @due_date,
    @subtotal_cents, @tax_cents, @total_cents, @currency, @suggested_category,
    @field_confidence, @validation_flags, @raw_response, @parsed_at, @schema_version, @truncated
  )
  ON CONFLICT(file_hash) DO UPDATE SET
    original_filename  = excluded.original_filename,
    route              = excluded.route,
    page_count         = excluded.page_count,
    model              = excluded.model,
    base_url_host      = excluded.base_url_host,
    vendor             = excluded.vendor,
    invoice_number     = excluded.invoice_number,
    invoice_date       = excluded.invoice_date,
    due_date           = excluded.due_date,
    subtotal_cents     = excluded.subtotal_cents,
    tax_cents          = excluded.tax_cents,
    total_cents        = excluded.total_cents,
    currency           = excluded.currency,
    suggested_category = excluded.suggested_category,
    field_confidence   = excluded.field_confidence,
    validation_flags   = excluded.validation_flags,
    raw_response       = excluded.raw_response,
    parsed_at          = excluded.parsed_at,
    schema_version     = excluded.schema_version,
    truncated          = excluded.truncated`

/**
 * Reduce a base URL to its host (with port), or null when it is absent or unparseable.
 *
 * This is the D-05 guard made structural: a user can paste anything into the base-URL field,
 * including a gateway URL that carries the credential in userinfo or a query string. Taking
 * URL.host drops the scheme, the userinfo, the path, the query and the fragment, so no part of
 * a URL that could carry a key survives into the database. Never throws — a malformed URL is
 * provenance we simply do not have.
 */
export function baseUrlHost(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string' || raw.trim() === '') return null
  try {
    return new URL(raw).host || null
  } catch {
    return null
  }
}

/**
 * Look up a cached parse by file hash. Returns null on a miss — including the deliberate miss
 * when the stored row was produced under a different SCHEMA_VERSION (see the module header).
 * The stale row is left on disk (its raw_response keeps its audit value) and is overwritten by
 * the next putCached.
 *
 * The db handle is injectable (default: the main-process singleton) so the temp-DB unit test
 * drives it without Electron, mirroring ledger.ts's checkPostedHash.
 */
export function getCached(
  db: Database.Database = getDatabase(),
  fileHash: string
): CachedResult | null {
  const row = db.prepare(SELECT_SQL).get(fileHash) as ParsedResultsRow | undefined
  if (!row) return null
  if (row.schema_version !== SCHEMA_VERSION) return null

  return {
    fileHash: row.file_hash,
    originalFilename: row.original_filename,
    route: row.route as ParseRoute,
    pageCount: row.page_count,
    model: row.model,
    baseUrlHost: row.base_url_host,
    fields: {
      // vendor is required in ParsedFields and is always written from a validated string;
      // the column is nullable only because every other text field is.
      vendor: row.vendor ?? '',
      invoiceNumber: row.invoice_number,
      invoiceDate: row.invoice_date,
      dueDate: row.due_date,
      subtotalCents: row.subtotal_cents,
      taxCents: row.tax_cents,
      totalCents: row.total_cents,
      currency: row.currency,
      suggestedCategory: row.suggested_category
    },
    confidence: parseConfidence(row.field_confidence),
    validationFlags: parseFlags(row.validation_flags),
    rawResponse: row.raw_response,
    parsedAt: row.parsed_at,
    schemaVersion: row.schema_version,
    // 0/1 INTEGER back to the boolean the ParseFileResult contract exposes (Pitfall 8).
    truncated: row.truncated === 1
  }
}

/**
 * Write (or overwrite) the cached parse for one file hash.
 *
 * Every nullable value is normalized to an explicit null before binding: better-sqlite3 throws
 * on an `undefined` bind, and losing an already-paid-for parse to a TypeError would be the
 * worst possible failure here. Money is bound as-is — validate.ts guarantees integer cents, and
 * silently rounding a total would be exactly the auto-correction D-12 forbids, so a
 * non-integer amount is left to fail loudly against the STRICT INTEGER column and surface as a
 * retryable per-file error (D-15) rather than as a quietly wrong number.
 */
export function putCached(db: Database.Database = getDatabase(), row: CacheRowInput): void {
  db.prepare(UPSERT_SQL).run({
    file_hash: row.fileHash,
    original_filename: row.originalFilename,
    route: row.route,
    page_count: row.pageCount,
    model: row.model,
    base_url_host: baseUrlHost(row.baseUrl),
    vendor: row.fields.vendor,
    invoice_number: row.fields.invoiceNumber ?? null,
    invoice_date: row.fields.invoiceDate ?? null,
    due_date: row.fields.dueDate ?? null,
    subtotal_cents: row.fields.subtotalCents ?? null,
    tax_cents: row.fields.taxCents ?? null,
    total_cents: row.fields.totalCents,
    currency: row.fields.currency ?? null,
    suggested_category: row.fields.suggestedCategory ?? null,
    field_confidence: JSON.stringify(row.confidence ?? {}),
    validation_flags: JSON.stringify(row.validationFlags ?? []),
    raw_response: row.rawResponse ?? null,
    parsed_at: row.parsedAt,
    schema_version: SCHEMA_VERSION,
    // STRICT has no BOOLEAN and better-sqlite3 refuses to bind a JS boolean (Pitfall 8).
    truncated: row.truncated ? 1 : 0
  })
}

/** Deserialize the confidence blob. A corrupt blob degrades to {} — never throws a batch away. */
function parseConfidence(text: string): FieldConfidence {
  const value = safeParse(text)
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  const out: FieldConfidence = {}
  for (const [field, flag] of Object.entries(value as Record<string, unknown>)) {
    if (flag === 'high' || flag === 'low' || flag === 'flagged') out[field] = flag
  }
  return out
}

/** Deserialize the validation-flag blob. Null, corrupt, or non-array all degrade to []. */
function parseFlags(text: string | null): string[] {
  if (text === null) return []
  const value = safeParse(text)
  if (!Array.isArray(value)) return []
  return value.filter((flag): flag is string => typeof flag === 'string')
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}
