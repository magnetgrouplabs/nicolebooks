// test/ingestion-inbox.test.ts
//
// Wave-0 (RED) unit spec for inbox path resolve/persist against app_settings (ING-02, D-01).
// Reuses the migrate.test.ts temp better-sqlite3 lifecycle: a real DB on a temp file, migrated
// so app_settings exists. The db handle and the base documents dir are injected so app.getPath
// / Electron are never required (design-for-testability from 02-VALIDATION). Until
// src/main/ingestion/inbox.ts exists this file fails to import (RED), the correct Wave-0 state.
//
// Coverage:
//   - persistInboxPath + resolveInboxPath round-trip a chosen path through app_settings key
//     inbox_path; once set, resolveInboxPath returns { created: false } and the stored path.
//   - When inbox_path is unset, resolveInboxPath computes join(documentsDir, 'NicoleBooks',
//     'Inbox'), creates it (recursive mkdir), persists it, and returns { created: true }; a
//     second call returns { created: false } with the same path.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { migrate } from '../src/main/db/migrate'
import { resolveInboxPath, persistInboxPath } from '../src/main/ingestion/inbox'

let dir: string
let dbPath: string
let docsDir: string
let db: Database.Database

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nb-inbox-'))
  dbPath = join(dir, 'app.db')
  docsDir = join(dir, 'documents')
  db = new Database(dbPath)
  migrate(db)
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

function readInboxSetting(): string | undefined {
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get('inbox_path') as
    | { value: string }
    | undefined
  return row?.value
}

describe('persistInboxPath / resolveInboxPath', () => {
  it('round-trips a chosen path through app_settings inbox_path', () => {
    const chosen = join(dir, 'custom', 'MyInbox')
    persistInboxPath(chosen, { db })
    expect(readInboxSetting()).toBe(chosen)

    const resolved = resolveInboxPath({ db, documentsDir: docsDir })
    expect(resolved).toEqual({ path: chosen, created: false })
  })

  it('creates and persists the default inbox when inbox_path is unset', () => {
    const expected = join(docsDir, 'NicoleBooks', 'Inbox')
    expect(existsSync(expected)).toBe(false)

    const first = resolveInboxPath({ db, documentsDir: docsDir })
    expect(first).toEqual({ path: expected, created: true })
    expect(existsSync(expected)).toBe(true)
    expect(readInboxSetting()).toBe(expected)
  })

  it('returns created:false on a second resolve once the default is persisted', () => {
    const expected = join(docsDir, 'NicoleBooks', 'Inbox')
    resolveInboxPath({ db, documentsDir: docsDir })

    const second = resolveInboxPath({ db, documentsDir: docsDir })
    expect(second).toEqual({ path: expected, created: false })
  })
})
