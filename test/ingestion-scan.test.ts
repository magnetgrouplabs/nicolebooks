// test/ingestion-scan.test.ts
//
// Wave-0 (RED) unit spec for the scan orchestrator's walking path (ING-01, D-04, D-05).
// Reuses the migrate.test.ts temp-dir + temp-DB lifecycle. A temp inbox and a migrated temp
// DB are injected into runScan so no Electron/app.getPath is needed. Until
// src/main/ingestion/scan.ts exists this file fails to import (RED), the correct Wave-0 state.
//
// Coverage (this slice, 02-01):
//   - Supported files (.pdf, .png) come back status 'loaded' with a hash.
//   - Unsupported files (.docx) come back status 'unsupported-skipped'.
//   - OS junk (.DS_Store) is absent from files entirely (D-13).
//   - summary counts non-junk entries as total: { total:3, loaded:2, unsupported:1,
//     duplicates:0, notReady:0 }.
//   - batchEntryDate equals localDateStamp() for today (D-05, local not UTC).
//   - Read-only invariant (D-04): the inbox name-set and every file's mtimeMs are unchanged
//     after the scan (no move/rename/delete/write).

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { migrate } from '../src/main/db/migrate'
import { runScan } from '../src/main/ingestion/scan'
import { localDateStamp } from '../src/main/ingestion/filetype'
import { sha256File } from '../src/main/ingestion/hash'

// Deterministic materialization injection for the tests that are NOT exercising the gate:
// every file is treated as local + settled, so the scan never spawns an OS attribute read or
// waits on the ~750ms production settling poll. The not-ready case at the bottom overrides
// isNotMaterialized for a single file to prove the bytes-last skip.
const materialized = {
  isNotMaterialized: async (): Promise<boolean> => false,
  isSettled: async (): Promise<boolean> => true
}

/** Compute the SHA-256 the scan will produce for these exact bytes (test-side, independent). */
function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** Insert a posted-ledger row directly (simulates a Phase-7 post; Phase 2 never writes this). */
function insertPosted(
  handle: Database.Database,
  hash: string,
  postedAt: string,
  originalFilename: string
): void {
  handle
    .prepare('INSERT INTO posted_file_hashes (hash, posted_at, original_filename) VALUES (?, ?, ?)')
    .run(hash, postedAt, originalFilename)
}

let dir: string
let inbox: string
let db: Database.Database

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nb-scan-'))
  inbox = join(dir, 'Inbox')
  const dbPath = join(dir, 'app.db')
  db = new Database(dbPath)
  migrate(db)

  // Build a flat inbox: two supported files, one unsupported, one OS junk file.
  const fs = require('node:fs') as typeof import('node:fs')
  fs.mkdirSync(inbox, { recursive: true })
  writeFileSync(join(inbox, 'invoice.pdf'), Buffer.from('%PDF-1.7 fake pdf bytes'))
  writeFileSync(join(inbox, 'receipt.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]))
  writeFileSync(join(inbox, 'contract.docx'), Buffer.from('not a bill'))
  writeFileSync(join(inbox, '.DS_Store'), Buffer.from('macos junk'))
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

function snapshot(path: string): Record<string, number> {
  const out: Record<string, number> = {}
  for (const name of readdirSync(path)) {
    out[name] = statSync(join(path, name)).mtimeMs
  }
  return out
}

describe('runScan (walking-path slice)', () => {
  it('loads supported files, skips unsupported, ignores junk, and stamps today', async () => {
    const result = await runScan({ inboxPath: inbox, db, ...materialized })

    const byName = new Map(result.files.map((f) => [f.filename, f]))

    // Supported files are loaded with a hash.
    for (const name of ['invoice.pdf', 'receipt.png']) {
      const file = byName.get(name)
      expect(file?.status).toBe('loaded')
      expect(file?.hash).toMatch(/^[0-9a-f]{64}$/)
    }

    // Unsupported file surfaced, never silently dropped.
    expect(byName.get('contract.docx')?.status).toBe('unsupported-skipped')

    // OS junk never appears in the results.
    expect(byName.has('.DS_Store')).toBe(false)

    // Summary counts junk out of total.
    expect(result.summary).toEqual({
      total: 3,
      loaded: 2,
      duplicates: 0,
      notReady: 0,
      unsupported: 1
    })

    // Batch stamped with today's LOCAL calendar day.
    expect(result.batchEntryDate).toBe(localDateStamp())
    expect(result.inboxPath).toBe(inbox)
  })

  it('is strictly read-only on the inbox (D-04): names and mtimes unchanged', async () => {
    const before = snapshot(inbox)
    await runScan({ inboxPath: inbox, db, ...materialized })
    const after = snapshot(inbox)
    expect(after).toEqual(before)
  })
})

// Slice 2 (02-02) dedupe cases: within-scan collapse (D-10) + posted-ledger check (D-08/09).
// The base fixture from the top-level beforeEach (invoice.pdf, receipt.png unique; contract.docx
// unsupported; .DS_Store junk; an empty migrated ledger) is extended per-test with the exact
// fixtures each case needs. Each test gets a fresh temp inbox + temp DB from that beforeEach.
describe('runScan dedupe (within-scan collapse + posted ledger)', () => {
  it('collapses byte-identical copies within one scan (D-10): one loaded, one duplicate-in-batch', async () => {
    const bytes = Buffer.from('%PDF-1.7 identical duplicate bill bytes')
    writeFileSync(join(inbox, 'copy-a.pdf'), bytes)
    writeFileSync(join(inbox, 'copy-b.pdf'), bytes)

    const result = await runScan({ inboxPath: inbox, db, ...materialized })
    const a = result.files.find((f) => f.filename === 'copy-a.pdf')
    const b = result.files.find((f) => f.filename === 'copy-b.pdf')

    // Exactly one of the identical pair loads; the other collapses to duplicate-in-batch.
    expect([a?.status, b?.status].sort()).toEqual(['duplicate-in-batch', 'loaded'])
    // Both carry the same (real) hash.
    expect(a?.hash).toBe(b?.hash)
    expect(a?.hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('excludes a file whose exact hash is already posted (D-08/09), with postedAt set', async () => {
    const bytes = Buffer.from('%PDF-1.7 already posted to quickbooks')
    writeFileSync(join(inbox, 'already-posted.pdf'), bytes)
    const postedAt = '2026-07-18T09:30:00.000Z'
    insertPosted(db, sha256(bytes), postedAt, 'already-posted.pdf')

    const result = await runScan({ inboxPath: inbox, db, ...materialized })
    const file = result.files.find((f) => f.filename === 'already-posted.pdf')
    expect(file?.status).toBe('duplicate-excluded')
    expect(file?.postedAt).toBe(postedAt)
  })

  it('duplicate-excluded outranks duplicate-in-batch when a hash is both posted and duplicated', async () => {
    const bytes = Buffer.from('%PDF-1.7 posted and also duplicated in this scan')
    writeFileSync(join(inbox, 'dup-1.pdf'), bytes)
    writeFileSync(join(inbox, 'dup-2.pdf'), bytes)
    insertPosted(db, sha256(bytes), '2026-07-10T00:00:00.000Z', 'dup-original.pdf')

    const result = await runScan({ inboxPath: inbox, db, ...materialized })
    const dup1 = result.files.find((f) => f.filename === 'dup-1.pdf')
    const dup2 = result.files.find((f) => f.filename === 'dup-2.pdf')

    // Precedence: BOTH copies are duplicate-excluded (already-posted outranks in-batch); a
    // posted file never comes back loaded.
    expect(dup1?.status).toBe('duplicate-excluded')
    expect(dup2?.status).toBe('duplicate-excluded')
    expect(dup1?.postedAt).toBe('2026-07-10T00:00:00.000Z')
  })

  it('reloads a supported file whose hash is not in the ledger (Design B pending reload)', async () => {
    // invoice.pdf from the base fixture has no ledger row, so it must still load.
    const result = await runScan({ inboxPath: inbox, db, ...materialized })
    const invoice = result.files.find((f) => f.filename === 'invoice.pdf')
    expect(invoice?.status).toBe('loaded')
  })

  it('summary.duplicates counts duplicate-excluded + duplicate-in-batch', async () => {
    // One within-scan pair (yields 1 duplicate-in-batch) plus one already-posted file (yields
    // 1 duplicate-excluded).
    const dupBytes = Buffer.from('%PDF-1.7 within scan dup')
    writeFileSync(join(inbox, 'dup-a.pdf'), dupBytes)
    writeFileSync(join(inbox, 'dup-b.pdf'), dupBytes)

    const postedBytes = Buffer.from('%PDF-1.7 posted already')
    writeFileSync(join(inbox, 'posted.pdf'), postedBytes)
    insertPosted(db, sha256(postedBytes), '2026-07-01T00:00:00.000Z', 'posted.pdf')

    const result = await runScan({ inboxPath: inbox, db, ...materialized })
    const dupExcluded = result.files.filter((f) => f.status === 'duplicate-excluded').length
    const dupInBatch = result.files.filter((f) => f.status === 'duplicate-in-batch').length
    expect(result.summary.duplicates).toBe(dupExcluded + dupInBatch)
    expect(result.summary.duplicates).toBe(2)
  })
})

// WR-02 legacy iCloud sentinel wiring: a `.<name>.icloud` placeholder must be translated back to
// its real target and surfaced not-ready-skipped (re-scannable), never mislabeled unsupported by
// its `.icloud` extension. When the real file is also present, the sentinel must not add a dup row.
describe('runScan legacy iCloud sentinel wiring (WR-02)', () => {
  it('surfaces a lone .<name>.icloud sentinel as not-ready-skipped keyed to the real file', async () => {
    // Legacy eviction model: the real bill.pdf is REPLACED by its sentinel, so only it exists.
    writeFileSync(join(inbox, '.evicted-bill.pdf.icloud'), Buffer.from('icloud placeholder stub'))

    const result = await runScan({ inboxPath: inbox, db, ...materialized })
    const target = result.files.find((f) => f.filename === 'evicted-bill.pdf')

    // Translated back to the real file and surfaced not-ready, never unsupported; the sentinel
    // name itself never appears as its own row.
    expect(target?.status).toBe('not-ready-skipped')
    expect(result.files.some((f) => f.filename === '.evicted-bill.pdf.icloud')).toBe(false)
    expect(result.files.some((f) => f.filename.endsWith('.icloud'))).toBe(false)
  })

  it('does not emit a duplicate row when both the real file and its sentinel are present', async () => {
    writeFileSync(join(inbox, 'mixed.pdf'), Buffer.from('%PDF-1.7 real local bill still present'))
    writeFileSync(join(inbox, '.mixed.pdf.icloud'), Buffer.from('icloud placeholder stub'))

    const result = await runScan({ inboxPath: inbox, db, ...materialized })
    const rows = result.files.filter((f) => f.filename === 'mixed.pdf')

    // Exactly one row for the real file (the sentinel de-dupes against it); no sentinel row.
    expect(rows).toHaveLength(1)
    expect(result.files.some((f) => f.filename === '.mixed.pdf.icloud')).toBe(false)
  })
})

// Slice 3 (02-03) materialization gate: a file the gate reports "not materialized" must come back
// 'not-ready-skipped', is NEVER hashed (metadata-first, bytes-last), and is surfaced for re-scan;
// a real local file in the same inbox still loads. The gate is injected so the assertion is
// deterministic and does not depend on the host OS or a real cloud provider.
describe('runScan materialization gate (02-03)', () => {
  it('flags a not-materialized file not-ready-skipped, never hashes it, and still loads real files', async () => {
    writeFileSync(join(inbox, 'placeholder.pdf'), Buffer.from('%PDF-1.7 would-be online-only placeholder'))
    writeFileSync(join(inbox, 'local.pdf'), Buffer.from('%PDF-1.7 real local bill'))

    // Spy hasher: records every file whose BYTES are read, then delegates to the real hash so
    // genuinely-loaded files still return a valid 64-char digest.
    const hashed: string[] = []
    const hashSpy = async (fullPath: string): Promise<string> => {
      hashed.push(fullPath)
      return sha256File(fullPath)
    }

    const result = await runScan({
      inboxPath: inbox,
      db,
      // Only placeholder.pdf is "not materialized"; everything else is local.
      isNotMaterialized: async (_full, _siblings, fileName: string): Promise<boolean> =>
        fileName === 'placeholder.pdf',
      isSettled: async (): Promise<boolean> => true,
      sha256File: hashSpy
    })

    const placeholder = result.files.find((f) => f.filename === 'placeholder.pdf')
    const local = result.files.find((f) => f.filename === 'local.pdf')

    // The placeholder is skipped as not-ready and carries no hash.
    expect(placeholder?.status).toBe('not-ready-skipped')
    expect(placeholder?.hash).toBeUndefined()
    // A real local file in the same inbox still loads with a real hash.
    expect(local?.status).toBe('loaded')
    expect(local?.hash).toMatch(/^[0-9a-f]{64}$/)

    // Bytes-last proof: the not-ready file's bytes were NEVER read; the local file's were.
    expect(hashed.some((p) => p.endsWith('placeholder.pdf'))).toBe(false)
    expect(hashed.some((p) => p.endsWith('local.pdf'))).toBe(true)

    // Surfaced for re-scan, never silently dropped.
    expect(result.summary.notReady).toBe(1)
  })
})
