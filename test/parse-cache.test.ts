// test/parse-cache.test.ts
//
// Wave-0 (RED) unit spec for the parsed-results cache — the PARSE-05 storage layer
// (D-14/D-24, threats T-03-06 tampering / T-03-01 disclosure).
//
// Mirrors the migrate.test.ts + ingestion-ledger.test.ts lifecycle: a real better-sqlite3
// handle on a temp FILE (not :memory:), migrated so parsed_results exists, torn down per test.
// Until src/main/parse/cache.ts exists this file fails to import (RED), the correct state.
//
// Scope note: this file proves the STORAGE layer only. The pipeline-level PARSE-05 proof —
// "a second parse of the same hash returns the cached row and the injected client is NEVER
// called" — is added by 03-07 as an additional describe block against `makeRow` below.
//
// Coverage:
//   - a full row round-trips by file_hash: JSON blobs, integer cents, the D-21 truncated flag
//   - an absent hash is a miss (null), so the caller parses
//   - an upsert with a DIFFERENT model keeps exactly ONE row (hash-alone keying, D-14 /
//     RESEARCH Pitfall 7) — switching models must never silently re-charge
//   - money is stored as INTEGER cents, never a float (RESEARCH Pitfall 4)
//   - `truncated` is stored as a 0/1 INTEGER (STRICT has no BOOLEAN, Pitfall 8) and reads
//     back as a JS boolean
//   - base_url_host stores a HOST only: never the path, never the query, never the key (D-05)
//   - a SQL-metacharacter hash is a miss and a metacharacter vendor round-trips verbatim,
//     proving every value is bound and never interpolated (T-03-06)
//   - a row written under an older schema_version is NOT served (D-24: a deliberate prompt or
//     schema bump forces a re-parse, while a model switch alone never does)

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { migrate } from '../src/main/db/migrate'
import {
  SCHEMA_VERSION,
  baseUrlHost,
  getCached,
  putCached,
  type CacheRowInput
} from '../src/main/parse/cache'
import { parseBatch } from '../src/main/parse/pipeline'
import { makeFakeClient } from './helpers/fake-openai-client'
import type { FieldConfidence, ParsedFields } from '../src/shared/ipc-contract'

let dir: string
let db: Database.Database

export const HASH_A = 'a'.repeat(64)
export const HASH_B = 'b'.repeat(64)

/** A fully populated validated field set (post 03-03 gate: integer cents, ISO dates). */
export const FIELDS: ParsedFields = {
  vendor: 'Nassau Plumbing Supply',
  invoiceNumber: 'INV-2026-0417',
  invoiceDate: '2026-07-14',
  dueDate: '2026-08-13',
  subtotalCents: 123410,
  taxCents: 10190,
  totalCents: 133600,
  currency: 'USD',
  suggestedCategory: 'Job Materials'
}

const CONFIDENCE: FieldConfidence = {
  vendor: 'high',
  invoiceNumber: 'low',
  totalCents: 'high',
  taxCents: 'flagged'
}

/**
 * Build a cache row. 03-07 reuses this for the pipeline cache-hit-no-recall spec, so keep the
 * overrides parameter and the exported shape stable.
 */
export function makeRow(overrides: Partial<CacheRowInput> = {}): CacheRowInput {
  return {
    fileHash: HASH_A,
    originalFilename: 'nassau-plumbing-0417.pdf',
    route: 'native',
    pageCount: 2,
    model: 'gpt-4o-2024-11-20',
    baseUrl: 'https://api.openai.com/v1',
    fields: FIELDS,
    confidence: CONFIDENCE,
    validationFlags: ['arithmetic:subtotal+tax!=total'],
    rawResponse: '{"vendor":"Nassau Plumbing Supply","total":"1,336.00"}',
    parsedAt: '2026-07-27T15:12:03.000Z',
    truncated: false,
    ...overrides
  }
}

/** Read the stored row untouched by the cache's own deserialization, to assert column types. */
function rawRow(fileHash: string): Record<string, unknown> | undefined {
  return db.prepare('SELECT * FROM parsed_results WHERE file_hash = ?').get(fileHash) as
    | Record<string, unknown>
    | undefined
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nb-parse-cache-'))
  db = new Database(join(dir, 'app.db'))
  migrate(db)
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('putCached / getCached round trip', () => {
  it('round-trips a full row keyed on file_hash', () => {
    putCached(db, makeRow())
    expect(getCached(db, HASH_A)).toEqual({
      fileHash: HASH_A,
      originalFilename: 'nassau-plumbing-0417.pdf',
      route: 'native',
      pageCount: 2,
      model: 'gpt-4o-2024-11-20',
      baseUrlHost: 'api.openai.com',
      fields: FIELDS,
      confidence: CONFIDENCE,
      validationFlags: ['arithmetic:subtotal+tax!=total'],
      rawResponse: '{"vendor":"Nassau Plumbing Supply","total":"1,336.00"}',
      parsedAt: '2026-07-27T15:12:03.000Z',
      schemaVersion: SCHEMA_VERSION,
      truncated: false
    })
  })

  it('returns null on an absent hash so the caller parses', () => {
    putCached(db, makeRow())
    expect(getCached(db, HASH_B)).toBeNull()
  })

  it('round-trips the nullable optionals as null, never as empty strings or zeros', () => {
    // D-09: forcing optionals to be required is what produces hallucinated fills. A receipt
    // with no invoice number, no due date and no separate tax line is the COMMON case, and a
    // null tax must never read back as $0.00.
    putCached(
      db,
      makeRow({
        fields: {
          vendor: 'Corner Hardware',
          invoiceNumber: null,
          invoiceDate: '2026-07-02',
          dueDate: null,
          subtotalCents: null,
          taxCents: null,
          totalCents: 4799,
          currency: null,
          suggestedCategory: null
        },
        baseUrl: null,
        validationFlags: null,
        rawResponse: null
      })
    )
    const hit = getCached(db, HASH_A)
    expect(hit?.fields).toEqual({
      vendor: 'Corner Hardware',
      invoiceNumber: null,
      invoiceDate: '2026-07-02',
      dueDate: null,
      subtotalCents: null,
      taxCents: null,
      totalCents: 4799,
      currency: null,
      suggestedCategory: null
    })
    expect(hit?.baseUrlHost).toBeNull()
    expect(hit?.rawResponse).toBeNull()
    expect(hit?.validationFlags).toEqual([])
  })

  it('stores the confidence map and the validation flags as JSON TEXT blobs (5a-A)', () => {
    putCached(db, makeRow())
    const raw = rawRow(HASH_A)
    expect(typeof raw?.field_confidence).toBe('string')
    expect(typeof raw?.validation_flags).toBe('string')
    expect(JSON.parse(raw?.field_confidence as string)).toEqual(CONFIDENCE)
    expect(JSON.parse(raw?.validation_flags as string)).toEqual([
      'arithmetic:subtotal+tax!=total'
    ])
  })

  it('stores money as INTEGER cents, never a float (RESEARCH Pitfall 4)', () => {
    putCached(db, makeRow())
    const raw = rawRow(HASH_A)
    for (const col of ['subtotal_cents', 'tax_cents', 'total_cents']) {
      expect(typeof raw?.[col]).toBe('number')
      expect(Number.isInteger(raw?.[col] as number)).toBe(true)
    }
    expect(raw?.total_cents).toBe(133600)
    expect(raw?.subtotal_cents).toBe(123410)
    expect(raw?.tax_cents).toBe(10190)
  })

  it('preserves the raw model response verbatim for the D-24 audit column', () => {
    const rawResponse = '{"vendor":"Nassau Plumbing Supply","total":"1,336.00","tax":"101.90"}'
    putCached(db, makeRow({ rawResponse }))
    expect(getCached(db, HASH_A)?.rawResponse).toBe(rawResponse)
  })
})

describe('the D-21 truncated flag (STRICT has no BOOLEAN — Pitfall 8)', () => {
  it('persists true as the INTEGER 1 and reads it back as a boolean', () => {
    putCached(db, makeRow({ pageCount: 14, truncated: true }))
    expect(rawRow(HASH_A)?.truncated).toBe(1)
    expect(typeof rawRow(HASH_A)?.truncated).toBe('number')
    const hit = getCached(db, HASH_A)
    expect(hit?.truncated).toBe(true)
    expect(typeof hit?.truncated).toBe('boolean')
  })

  it('persists false as the INTEGER 0 and reads it back as a boolean', () => {
    putCached(db, makeRow({ truncated: false }))
    expect(rawRow(HASH_A)?.truncated).toBe(0)
    const hit = getCached(db, HASH_A)
    expect(hit?.truncated).toBe(false)
    expect(typeof hit?.truncated).toBe('boolean')
  })

  it('defaults an omitted truncated flag to 0 rather than binding undefined', () => {
    const row = makeRow()
    delete row.truncated
    expect(() => putCached(db, row)).not.toThrow()
    expect(rawRow(HASH_A)?.truncated).toBe(0)
    expect(getCached(db, HASH_A)?.truncated).toBe(false)
  })
})

describe('hash-alone keying (D-14 / RESEARCH Pitfall 7)', () => {
  it('upserts on the same file_hash with a DIFFERENT model, keeping exactly ONE row', () => {
    // The whole point of PARSE-05: the key is the bytes, not the bytes+model. Keying on
    // hash+model would re-parse (and re-charge) every cached document the moment the user
    // switched models in Settings.
    putCached(db, makeRow({ model: 'gpt-4o-2024-11-20' }))
    expect(() =>
      putCached(db, makeRow({ model: 'anthropic/claude-sonnet-4', parsedAt: '2026-07-28T09:00:00.000Z' }))
    ).not.toThrow()

    const count = db
      .prepare('SELECT COUNT(*) AS n FROM parsed_results WHERE file_hash = ?')
      .get(HASH_A) as { n: number }
    expect(count.n).toBe(1)
    expect(db.prepare('SELECT COUNT(*) AS n FROM parsed_results').get()).toEqual({ n: 1 })

    const hit = getCached(db, HASH_A)
    expect(hit?.model).toBe('anthropic/claude-sonnet-4')
    expect(hit?.parsedAt).toBe('2026-07-28T09:00:00.000Z')
  })

  it('keeps different hashes in separate rows', () => {
    putCached(db, makeRow({ fileHash: HASH_A, originalFilename: 'a.pdf' }))
    putCached(db, makeRow({ fileHash: HASH_B, originalFilename: 'b.jpg', route: 'image-only' }))
    expect(getCached(db, HASH_A)?.originalFilename).toBe('a.pdf')
    expect(getCached(db, HASH_B)?.originalFilename).toBe('b.jpg')
    expect(getCached(db, HASH_B)?.route).toBe('image-only')
    expect(db.prepare('SELECT COUNT(*) AS n FROM parsed_results').get()).toEqual({ n: 2 })
  })

  it('does NOT serve a row written under an older schema_version (D-24 forced re-parse)', () => {
    // A model switch alone must never invalidate (above). A deliberate prompt/schema bump
    // must, so the gate lives in the cache and no call site can forget it.
    putCached(db, makeRow())
    db.prepare('UPDATE parsed_results SET schema_version = ? WHERE file_hash = ?').run(
      SCHEMA_VERSION - 1,
      HASH_A
    )
    expect(getCached(db, HASH_A)).toBeNull()
    // The stale row is still on disk (audit value preserved); it is simply not served.
    expect(rawRow(HASH_A)).toBeDefined()
  })
})

describe('no secret material lands in the cache (D-05, threat T-03-01)', () => {
  it('stores the base URL HOST only — never the path, the query, or a credential', () => {
    // A user can paste anything into the base-URL field, including a gateway URL that carries
    // the key in userinfo or a query string. Deriving the host is what makes "never the key"
    // structurally true rather than a convention.
    putCached(db, makeRow({ baseUrl: 'https://sk-live-CANARY123@gateway.example.com:8443/v1?key=sk-live-CANARY123' }))

    const hit = getCached(db, HASH_A)
    expect(hit?.baseUrlHost).toBe('gateway.example.com:8443')

    const serialized = JSON.stringify(rawRow(HASH_A))
    expect(serialized).not.toContain('sk-live-CANARY123')
    expect(serialized).not.toContain('/v1')
  })

  it('baseUrlHost() reduces any base URL to a host and never throws on junk', () => {
    expect(baseUrlHost('https://api.openai.com/v1')).toBe('api.openai.com')
    expect(baseUrlHost('https://openrouter.ai/api/v1')).toBe('openrouter.ai')
    expect(baseUrlHost('not a url')).toBeNull()
    expect(baseUrlHost('')).toBeNull()
    expect(baseUrlHost(null)).toBeNull()
    expect(baseUrlHost(undefined)).toBeNull()
  })
})

describe('every value is bound, never interpolated (threat T-03-06)', () => {
  it('treats a SQL-metacharacter hash as a literal miss and leaves the table standing', () => {
    putCached(db, makeRow())
    expect(getCached(db, "x' OR '1'='1")).toBeNull()
    expect(getCached(db, "'; DROP TABLE parsed_results; --")).toBeNull()
    // The table survived: a bound value cannot become a statement.
    expect(db.prepare('SELECT COUNT(*) AS n FROM parsed_results').get()).toEqual({ n: 1 })
  })

  it('stores a metacharacter-laden vendor verbatim rather than executing it', () => {
    // Bill content is attacker-influenceable (anyone can mail a PDF). The vendor string here
    // is the value the vision model returned; it must land in the row as text.
    const vendor = "Robert'); DROP TABLE parsed_results; --"
    putCached(db, makeRow({ fields: { ...FIELDS, vendor } }))
    expect(getCached(db, HASH_A)?.fields.vendor).toBe(vendor)
    expect(db.prepare('SELECT COUNT(*) AS n FROM parsed_results').get()).toEqual({ n: 1 })
  })
})

// ---------------------------------------------------------------------------
// The PARSE-05 behavioral half (added by plan 03-07): the storage layer above proves the row
// round-trips; THIS block proves the pipeline actually consults it FIRST, so the paid model is
// never called twice for the same bytes. That is the requirement in one sentence.
// ---------------------------------------------------------------------------

describe('cache-hit no-recall at the pipeline level (PARSE-05 / D-13/D-14)', () => {
  /** A file entry whose hash matches the seeded row. */
  const CACHED_FILE = {
    filename: 'nassau-plumbing-0417.pdf',
    hash: HASH_A,
    batchEntryDate: '2026-07-27'
  }

  it('returns the seeded row as "cached" and NEVER calls the model', async () => {
    putCached(db, makeRow())

    // Both collaborators are booby-trapped: the client rejects every call and the byte reader
    // throws. A cache hit must reach neither, which is what makes this a no-recall proof rather
    // than a "the answer happened to match" one.
    const client = makeFakeClient({
      chatError: new Error('the model must never be called on a cache hit')
    })

    const result = await parseBatch([CACHED_FILE], {
      db,
      client,
      model: 'fake-vision-model',
      readFile: async () => {
        throw new Error('bytes must never be read on a cache hit')
      }
    })

    expect(result.files).toHaveLength(1)
    expect(result.files[0].status).toBe('cached')
    expect(result.files[0].fields).toEqual(FIELDS)
    expect(result.summary).toEqual({ total: 1, parsed: 0, failed: 0, cached: 1 })

    expect(client.calls).toEqual([])
    expect(client.neverCalled()).toBe(true)
  })

  it('returns the stored confidence, flags and truncated flag on the hit', async () => {
    putCached(db, makeRow({ pageCount: 14, truncated: true }))
    const client = makeFakeClient({ chatError: new Error('must not be called') })

    const result = await parseBatch([CACHED_FILE], {
      db,
      client,
      model: 'fake-vision-model',
      readFile: async () => {
        throw new Error('must not be read')
      }
    })

    expect(result.files[0].confidence).toEqual({
      vendor: 'high',
      invoiceNumber: 'low',
      totalCents: 'high',
      taxCents: 'flagged'
    })
    expect(result.files[0].validationFlags).toEqual(['arithmetic:subtotal+tax!=total'])
    expect(result.files[0].truncated).toBe(true)
    expect(client.neverCalled()).toBe(true)
  })

  it('treats a stale schema_version row as a miss and parses it again', async () => {
    // getCached returns null for a row that EXISTS when the prompt/schema contract moved on.
    // The pipeline must read that as "parse it", never as "the file is unknown".
    putCached(db, makeRow())
    db.prepare('UPDATE parsed_results SET schema_version = ? WHERE file_hash = ?').run(
      SCHEMA_VERSION - 1,
      HASH_A
    )

    const client = makeFakeClient({
      parsedObject: {
        vendor: 'Nassau Plumbing Supply',
        invoice_number: null,
        invoice_date: null,
        due_date: null,
        subtotal: null,
        tax: null,
        total: '1,336.00',
        currency: null,
        suggested_category: null
      }
    })

    const result = await parseBatch([CACHED_FILE], {
      db,
      client,
      model: 'fake-vision-model',
      baseUrl: 'https://api.openai.com/v1',
      now: () => '2026-07-28T09:00:00.000Z',
      readFile: async () => Buffer.from('bytes'),
      routeFile: async () => ({ route: 'native', pageCount: 1, pages: [] }),
      extractPdfText: async () => ({ totalPages: 1, text: ['Total $1,336.00'] }),
      renderPdfPageImage: async () => Buffer.from('page')
    })

    expect(result.files[0].status).toBe('parsed')
    expect(client.callCount()).toBe(1)
    // The row is rewritten at the current SCHEMA_VERSION, so the NEXT run hits the cache again.
    expect(getCached(db, HASH_A)?.parsedAt).toBe('2026-07-28T09:00:00.000Z')
  })

  it('bypasses the cache when the explicit re-parse override is set (D-14)', async () => {
    putCached(db, makeRow())
    const client = makeFakeClient({
      parsedObject: {
        vendor: 'Corner Hardware',
        invoice_number: null,
        invoice_date: null,
        due_date: null,
        subtotal: null,
        tax: null,
        total: '47.99',
        currency: null,
        suggested_category: null
      }
    })

    const result = await parseBatch([CACHED_FILE], {
      db,
      client,
      force: true,
      model: 'fake-vision-model',
      now: () => '2026-07-28T10:00:00.000Z',
      readFile: async () => Buffer.from('bytes'),
      routeFile: async () => ({ route: 'native', pageCount: 1, pages: [] }),
      extractPdfText: async () => ({ totalPages: 1, text: ['Total $47.99'] }),
      renderPdfPageImage: async () => Buffer.from('page')
    })

    expect(result.files[0].status).toBe('parsed')
    expect(result.files[0].fields?.totalCents).toBe(4799)
    expect(client.callCount()).toBe(1)
    // The override upserts over the existing row rather than adding a second one.
    expect(db.prepare('SELECT COUNT(*) AS n FROM parsed_results').get()).toEqual({ n: 1 })
    expect(getCached(db, HASH_A)?.fields.vendor).toBe('Corner Hardware')
  })

  it('mixes cached and freshly parsed files in one batch, calling the model only for the new one', async () => {
    putCached(db, makeRow()) // HASH_A is already parsed; HASH_B is not
    const client = makeFakeClient({
      parsedObject: {
        vendor: 'Corner Hardware',
        invoice_number: null,
        invoice_date: null,
        due_date: null,
        subtotal: null,
        tax: null,
        total: '47.99',
        currency: null,
        suggested_category: null
      }
    })

    const result = await parseBatch(
      [CACHED_FILE, { filename: 'corner-hardware.pdf', hash: HASH_B, batchEntryDate: '2026-07-27' }],
      {
        db,
        client,
        model: 'fake-vision-model',
        now: () => '2026-07-27T16:00:00.000Z',
        readFile: async () => Buffer.from('bytes'),
        routeFile: async () => ({ route: 'native', pageCount: 1, pages: [] }),
        extractPdfText: async () => ({ totalPages: 1, text: ['Total $47.99'] }),
        renderPdfPageImage: async () => Buffer.from('page')
      }
    )

    expect(result.files.map((f) => f.status)).toEqual(['cached', 'parsed'])
    expect(result.summary).toEqual({ total: 2, parsed: 1, failed: 0, cached: 1 })
    expect(client.callCount()).toBe(1) // exactly one paid call, for the one uncached file
  })
})
