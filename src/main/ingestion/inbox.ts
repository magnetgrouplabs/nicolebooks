// src/main/ingestion/inbox.ts
//
// Inbox path resolve/persist against app_settings (ING-02, D-01). Reuses the Phase 1
// app_settings table and the settings.ts prepared-statement UPSERT pattern (no new settings
// plumbing). All writes go through named-parameter prepared statements — the inbox path (even
// a user-picked one from the OS dialog) is NEVER interpolated into SQL (threat T-02-03).
//
// The db handle and the base documents dir are injectable (default to the main-process
// singleton getDatabase() and Electron app.getPath('documents')) so the temp-DB unit test
// drives both functions without Electron. On first run the default inbox is created with an
// explicit recursive mkdir — the dialog's createDirectory is macOS-only, so we never rely on
// it (02-RESEARCH Pitfall 6).

import type Database from 'better-sqlite3'
import { app } from 'electron'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { getDatabase } from '../db/connection'

/** Injectable dependencies so unit tests can drive a temp DB + temp documents dir. */
export interface InboxDeps {
  db?: Database.Database
  documentsDir?: string
}

/** The app_settings key that stores the configured inbox path (D-01). */
const INBOX_KEY = 'inbox_path'

/** UPSERT the chosen inbox path into app_settings (mirrors settings.ts, prepared statement). */
export function persistInboxPath(inboxPath: string, deps: InboxDeps = {}): void {
  const db = deps.db ?? getDatabase()
  const setStmt = db.prepare(
    'INSERT INTO app_settings (key, value) VALUES (@key, @value) ' +
      'ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  )
  setStmt.run({ key: INBOX_KEY, value: inboxPath })
}

/**
 * Resolve the inbox path. If app_settings already holds one AND that folder still exists on disk,
 * return it with created:false. Otherwise (no path configured yet, OR the persisted path was
 * moved / renamed / deleted / lives on an unmounted volume) fall back to (re)creating the default
 * Documents/NicoleBooks/Inbox, persist it, and return it with created:true.
 */
export function resolveInboxPath(deps: InboxDeps = {}): { path: string; created: boolean } {
  const db = deps.db ?? getDatabase()
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(INBOX_KEY) as
    | { value: string }
    | undefined
  // WR-03: existence-check the persisted path before trusting it. A stale path (folder gone,
  // renamed, or on an unmounted drive) must not be returned as-is, or every downstream consumer
  // (runScan's readdir, the Bills/Settings display) inherits a path that cannot resolve.
  if (row?.value && existsSync(row.value)) {
    return { path: row.value, created: false }
  }

  const documentsDir = deps.documentsDir ?? app.getPath('documents')
  const inboxPath = join(documentsDir, 'NicoleBooks', 'Inbox')
  mkdirSync(inboxPath, { recursive: true }) // mandatory; dialog createDirectory is macOS-only
  persistInboxPath(inboxPath, { db })
  return { path: inboxPath, created: true }
}
