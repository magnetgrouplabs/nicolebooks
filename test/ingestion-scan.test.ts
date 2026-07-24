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
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { migrate } from '../src/main/db/migrate'
import { runScan } from '../src/main/ingestion/scan'
import { localDateStamp } from '../src/main/ingestion/filetype'

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
    const result = await runScan({ inboxPath: inbox, db })

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
    await runScan({ inboxPath: inbox, db })
    const after = snapshot(inbox)
    expect(after).toEqual(before)
  })
})
