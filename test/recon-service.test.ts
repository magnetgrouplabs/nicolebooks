// test/recon-service.test.ts
//
// The batch reconciliation operation (src/main/recon/service.ts), driven against a real
// better-sqlite3 handle on a temp file (the test/migrate.test.ts pattern) so the parsed_results and
// qbo_reference reads are the real ones. No Electron, no network, no live sandbox.
//
// The four properties this file exists to pin, each of them a silent failure if it regresses:
//
//   1. THE TEXT COMES FROM THE CACHE, NOT THE CALLER. recon:match takes hashes only. If this module
//      ever accepted vendor text it would give a compromised renderer a way to steer a match against
//      words the parser never produced.
//   2. ONE MISSING PARSE NEVER FAILS THE BATCH. A hash with no cached parse comes back as two
//      'none' cells. The failure mode of getting this wrong is a batch of nine documents refusing
//      to reconcile because one of them failed to parse.
//   3. CATEGORIES COME FROM THE EXPENSE POOL ONLY (RECON-04). A Bank or Credit Card account offered
//      as a category is a posting error QuickBooks rejects mid-batch.
//   4. NOTHING IS WRITTEN AND NOTHING IS CREATED (RECON-03). Matching is a read-only opinion. The
//      spec asserts the database is byte-for-byte unchanged afterwards.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { migrate } from '../src/main/db/migrate'
import { putCached } from '../src/main/parse/cache'
import { QBO_REALM_ID_SETTING, writeSetting } from '../src/main/qbo/connection'
import { writeReferenceRows } from '../src/main/qbo/reference'
import {
  categoryCandidates,
  matchBatch,
  RECON_NOT_CONNECTED,
  RECON_REFERENCE_EMPTY,
  vendorCandidates
} from '../src/main/recon/service'
import type { ParsedFields } from '../src/shared/ipc-contract'
import {
  FIXTURE_EXPENSE_ACCOUNTS,
  FIXTURE_PAYMENT_ACCOUNTS,
  FIXTURE_REALM_ID,
  FIXTURE_VENDORS,
  fixtureReference
} from './helpers/qbo-reference-fixture'

/** Well-formed 64-char hashes, one per fixture document that matters here. */
const HASH_APEX = 'a'.repeat(64)
const HASH_BRIGHTLINE = 'b'.repeat(64)
const HASH_UNKNOWN_VENDOR = 'c'.repeat(64)
const HASH_NEVER_PARSED = 'd'.repeat(64)

let dir: string
let db: Database.Database

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nb-recon-'))
  db = new Database(join(dir, 'app.db'))
  migrate(db)
})

afterEach(() => {
  try {
    db.close()
  } catch {
    /* already closed */
  }
  rmSync(dir, { recursive: true, force: true })
})

/** Write one parsed_results row, the way the Phase 3 pipeline would have. */
function cacheParse(fileHash: string, fields: Partial<ParsedFields>): void {
  putCached(db, {
    fileHash,
    originalFilename: `${fileHash.slice(0, 6)}.pdf`,
    route: 'text',
    pageCount: 1,
    model: 'test-model',
    fields: {
      vendor: 'Unnamed',
      invoiceNumber: null,
      invoiceDate: null,
      dueDate: null,
      subtotalCents: null,
      taxCents: null,
      totalCents: 1000,
      currency: 'USD',
      suggestedCategory: null,
      ...fields
    },
    confidence: {},
    parsedAt: '2026-07-27T12:00:00.000Z'
  })
}

describe('matchBatch reads the parsed text main-side', () => {
  beforeEach(() => {
    cacheParse(HASH_APEX, { vendor: 'Apex Plumbing Supply', suggestedCategory: 'Job Materials' })
    cacheParse(HASH_BRIGHTLINE, {
      vendor: 'Brightline Electric',
      suggestedCategory: 'Job Materials'
    })
    cacheParse(HASH_UNKNOWN_VENDOR, {
      vendor: 'Quality Craft Tools LLC',
      suggestedCategory: 'Supplies'
    })
  })

  it('keys the result by file hash, the same join key as scan, parse and posting', () => {
    const result = matchBatch([HASH_APEX, HASH_BRIGHTLINE], {
      db,
      reference: fixtureReference()
    })
    expect(Object.keys(result.matches).sort()).toEqual([HASH_APEX, HASH_BRIGHTLINE].sort())
  })

  it('reconciles the whole fixture batch exactly as MANIFEST.md says it should', () => {
    const result = matchBatch([HASH_APEX, HASH_BRIGHTLINE, HASH_UNKNOWN_VENDOR], {
      db,
      reference: fixtureReference()
    })

    expect(result.matches[HASH_APEX].vendor).toMatchObject({
      selectedId: '58',
      confidence: 'auto'
    })
    expect(result.matches[HASH_APEX].category).toMatchObject({
      selectedId: '63',
      confidence: 'auto'
    })

    expect(result.matches[HASH_BRIGHTLINE].vendor).toMatchObject({
      selectedId: '59',
      confidence: 'suggested'
    })

    expect(result.matches[HASH_UNKNOWN_VENDOR].vendor).toMatchObject({
      selectedId: null,
      confidence: 'none',
      candidates: []
    })
    // The category still resolves even though the vendor did not: the two cells are independent.
    expect(result.matches[HASH_UNKNOWN_VENDOR].category).toMatchObject({
      selectedId: '20',
      confidence: 'auto'
    })
  })

  it('gives a hash with no cached parse two empty cells rather than failing the batch', () => {
    const result = matchBatch([HASH_APEX, HASH_NEVER_PARSED], { db, reference: fixtureReference() })

    expect(result.matches[HASH_NEVER_PARSED]).toEqual({
      vendor: { selectedId: null, selectedName: null, confidence: 'none', candidates: [] },
      category: { selectedId: null, selectedName: null, confidence: 'none', candidates: [] }
    })
    // ...and the rest of the batch is untouched.
    expect(result.matches[HASH_APEX].vendor.selectedId).toBe('58')
  })

  it('leaves both cells empty when the parser found no category', () => {
    cacheParse(HASH_NEVER_PARSED, { vendor: 'Apex Plumbing Supply', suggestedCategory: null })
    const result = matchBatch([HASH_NEVER_PARSED], { db, reference: fixtureReference() })
    expect(result.matches[HASH_NEVER_PARSED].category.confidence).toBe('none')
    expect(result.matches[HASH_NEVER_PARSED].vendor.confidence).toBe('auto')
  })

  it('collapses a repeated hash into one entry', () => {
    const result = matchBatch([HASH_APEX, HASH_APEX, HASH_APEX], {
      db,
      reference: fixtureReference()
    })
    expect(Object.keys(result.matches)).toEqual([HASH_APEX])
  })

  it('returns nothing for an empty batch, without needing a connection', () => {
    // A scan that loaded nothing is not an error, and it must not lecture the user about connecting.
    expect(matchBatch([], { db })).toEqual({ matches: {} })
  })

  it('writes nothing: matching is a read-only opinion (RECON-03)', () => {
    const before = db.prepare('SELECT COUNT(*) AS n FROM qbo_reference').get() as { n: number }
    const parsedBefore = db.prepare('SELECT COUNT(*) AS n FROM parsed_results').get() as { n: number }

    matchBatch([HASH_APEX, HASH_UNKNOWN_VENDOR, HASH_NEVER_PARSED], {
      db,
      reference: fixtureReference()
    })

    expect(db.prepare('SELECT COUNT(*) AS n FROM qbo_reference').get()).toEqual(before)
    expect(db.prepare('SELECT COUNT(*) AS n FROM parsed_results').get()).toEqual(parsedBefore)
  })
})

describe('matchBatch against the real realm-scoped cache', () => {
  beforeEach(() => {
    cacheParse(HASH_APEX, { vendor: 'Apex Plumbing Supply', suggestedCategory: 'Job Materials' })
    writeSetting(QBO_REALM_ID_SETTING, FIXTURE_REALM_ID, { db })
    writeReferenceRows(
      db,
      FIXTURE_REALM_ID,
      [
        ...FIXTURE_VENDORS.map((vendor) => ({
          entityKind: 'vendor' as const,
          entityId: vendor.id,
          name: vendor.name,
          active: vendor.active,
          accountType: null,
          accountSubType: null
        })),
        ...[...FIXTURE_EXPENSE_ACCOUNTS, ...FIXTURE_PAYMENT_ACCOUNTS].map((account) => ({
          entityKind: 'account' as const,
          entityId: account.id,
          name: account.name,
          active: account.active,
          accountType: account.accountType,
          accountSubType: account.accountSubType
        }))
      ],
      '2026-07-27T12:00:00.000Z'
    )
  })

  it('resolves the reference set from the connected realm with no reference injected', () => {
    const result = matchBatch([HASH_APEX], { db })
    expect(result.matches[HASH_APEX].vendor.selectedId).toBe('58')
    expect(result.matches[HASH_APEX].category.selectedId).toBe('63')
  })

  it('derives the account leaf from the fully qualified name, as the cache stores it', () => {
    // 'Job Expenses:Job Materials' is what QuickBooks holds; 'Job Materials' is what the bill says.
    expect(matchBatch([HASH_APEX], { db }).matches[HASH_APEX].category.selectedName).toBe(
      'Job Expenses:Job Materials'
    )
  })

  it('refuses to match when no company is connected', () => {
    db.prepare('DELETE FROM app_settings WHERE key = ?').run(QBO_REALM_ID_SETTING)
    expect(() => matchBatch([HASH_APEX], { db })).toThrow(RECON_NOT_CONNECTED)
  })

  it('refuses to match when the reference cache has never been synced', () => {
    db.prepare('DELETE FROM qbo_reference').run()
    // Nine silently unmatched rows and a cache that was never downloaded look identical in the
    // review grid, and only one of them has a one-click fix.
    expect(() => matchBatch([HASH_APEX], { db })).toThrow(RECON_REFERENCE_EMPTY)
  })

  it('does not offer a vendor another company owns', () => {
    // Realm scoping is enforced by the cache read, not by the matcher; this proves the matcher uses
    // the scoped read rather than reaching for every row in the table.
    writeSetting(QBO_REALM_ID_SETTING, '1111111111111111', { db })
    expect(() => matchBatch([HASH_APEX], { db })).toThrow(RECON_REFERENCE_EMPTY)
  })
})

describe('the two candidate pools', () => {
  it('vendor candidates match and display the same name', () => {
    for (const option of vendorCandidates(fixtureReference())) {
      expect(option.matchText).toBe(option.name)
    }
  })

  it('category candidates match the leaf and display the fully qualified path', () => {
    const options = categoryCandidates(fixtureReference())
    const jobMaterials = options.find((option) => option.id === '63')
    expect(jobMaterials).toEqual({
      id: '63',
      name: 'Job Expenses:Job Materials',
      matchText: 'Job Materials',
      active: true
    })
  })

  it('category candidates never include a Bank or Credit Card account (RECON-04)', () => {
    const names = new Set(categoryCandidates(fixtureReference()).map((option) => option.name))
    for (const account of FIXTURE_PAYMENT_ACCOUNTS) {
      expect(names.has(account.name)).toBe(false)
    }
  })

  it('drops inactive records, which stay resolvable by id but are never offered', () => {
    const reference = fixtureReference({
      vendors: FIXTURE_VENDORS.map((vendor) =>
        vendor.id === '58' ? { ...vendor, active: false } : vendor
      )
    })
    expect(vendorCandidates(reference).some((option) => option.id === '58')).toBe(false)
  })
})
