// src/main/db/connection.ts
//
// better-sqlite3 connection for the main process.
//
// The database lives at app.getPath('userData')/app.db: a per-user, writable location on
// both Windows and Mac. It is never opened at a relative path or inside the app bundle
// (RESEARCH anti-pattern), which would be read-only or non-portable.
//
// openDatabase() is a pure opener that takes an explicit path, so unit tests can point at a
// temp file and the electron app object is not required. getDatabase() is the lazy main
// process singleton: it opens app.db, runs the forward-only migrations once (idempotent),
// and caches the handle for the IPC settings handlers wired in plan 01-05.
//
// No secret material is ever written here (decision D-12): app.db holds non-secret
// app_settings only. Encrypted secrets live in secrets.enc via the secret store.

import Database from 'better-sqlite3'
import { app } from 'electron'
import { join } from 'node:path'
import { migrate } from './migrate'

/** Open a better-sqlite3 handle at dbPath with WAL journaling. Pure: no electron, no migrate. */
export function openDatabase(dbPath: string): Database.Database {
  const db = new Database(dbPath)
  // WAL gives durable, concurrent-read journaling; the app is single-writer (main process).
  db.pragma('journal_mode = WAL')
  return db
}

let handle: Database.Database | null = null

/**
 * Lazy main-process singleton. Opens userData/app.db on first call, applies the forward
 * only migrations (idempotent), caches, and returns the handle. Must be called after app
 * 'ready' (app.getPath needs the app initialized). Plan 01-05 imports this.
 */
export function getDatabase(): Database.Database {
  if (handle) return handle
  const dbPath = join(app.getPath('userData'), 'app.db')
  handle = openDatabase(dbPath)
  migrate(handle)
  return handle
}
