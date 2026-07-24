// src/main/ingestion/scan.ts
//
// Scan orchestrator (ING-01, D-04, D-05). Enumerates the flat inbox once, classifies each
// entry by name, stream-hashes every supported file, and returns an in-memory ScanResult.
// This is the walking-path slice (02-01): every supported file is treated as materialized and
// loaded; the ledger dedupe check (02-02) and the materialization/stability gate (02-03) layer
// onto this same pipeline at the marked seams below.
//
// Read-only invariant (D-04): this module performs NO filesystem mutation anywhere — no
// rename, unlink, writeFile, or copyFile. It only reads directory entries, stats, and byte
// streams. Enumeration is flat (no recursion), which also avoids materializing a dataless
// subdirectory on macOS (02-RESEARCH Pitfall 3).

import type Database from 'better-sqlite3'
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { ScanFile, ScanResult } from '../../shared/ipc-contract'
import { getDatabase } from '../db/connection'
import { isJunk, isSupported, localDateStamp } from './filetype'
import { sha256File } from './hash'
import { resolveInboxPath } from './inbox'
import { checkPostedHash } from './ledger'

/** Injectable dependencies so the unit test drives a temp inbox + temp DB without Electron. */
export interface ScanDeps {
  inboxPath?: string
  db?: Database.Database
}

/**
 * Run one manual scan of the flat inbox. The inbox path is resolved server-side (default:
 * app_settings via resolveInboxPath); no renderer-supplied path ever reaches fs. Returns the
 * per-file statuses, the batch's local processing date, and a one-line summary.
 */
export async function runScan(deps: ScanDeps = {}): Promise<ScanResult> {
  // Resolve the db handle once (default: main-process singleton) for the ledger dedupe check.
  // In tests deps.db is always injected, so getDatabase() (which needs Electron) is never hit.
  const db = deps.db ?? getDatabase()
  const inboxPath = deps.inboxPath ?? resolveInboxPath({ db }).path

  // Flat, non-recursive enumeration (D-01, Pitfall 3): list this one directory, never descend.
  const entries = await readdir(inboxPath, { withFileTypes: true })
  const files: ScanFile[] = []

  for (const entry of entries) {
    const name = entry.name

    // Never follow symlinks out of the inbox, and skip anything that is not a regular file
    // (directories, sockets, etc.) — Security Domain, threat T-02-05.
    if (entry.isSymbolicLink() || !entry.isFile()) continue

    // OS/system junk is silently dropped and never appears in the results (D-13).
    if (isJunk(name)) continue

    // Wrong file type: surfaced in the results, never silently lost (D-12).
    if (!isSupported(name)) {
      files.push({ filename: name, status: 'unsupported-skipped' })
      continue
    }

    // SLICE 3 (02-03): materialization + stability gate goes here (skip online-only
    // placeholders and still-writing files before any byte read). This slice treats every
    // enumerated supported file as materialized and hashes it.
    const fullPath = join(inboxPath, name)
    const st = await stat(fullPath)
    const hash = await sha256File(fullPath)
    files.push({ filename: name, status: 'loaded', hash, sizeBytes: Number(st.size) })
  }

  // SLICE 2 (02-02): within-scan collapse (D-10) then the posted-ledger dedupe check (D-08/09).
  // Compute-all-hashes-first (02-RESEARCH Pitfall 5): every supported file above is already
  // hashed, so the whole batch is in memory before we group — a whole-batch operation, not a
  // streaming one.

  // Within-scan collapse (D-10): the FIRST entry of each identical-bytes group keeps its
  // 'loaded' status; every later byte-identical copy becomes 'duplicate-in-batch'. seen also
  // doubles as the set of distinct hashes for the ledger pass below.
  const seen = new Set<string>()
  for (const file of files) {
    if (file.status !== 'loaded' || !file.hash) continue
    if (seen.has(file.hash)) {
      file.status = 'duplicate-in-batch'
    } else {
      seen.add(file.hash)
    }
  }

  // Posted-ledger dedupe check (D-08/09), READ-ONLY: for each distinct hash, a ledger hit marks
  // EVERY entry with that hash 'duplicate-excluded' and stamps the posted date. This takes
  // precedence over 'duplicate-in-batch' when both apply to the same hash. No ledger write.
  for (const hash of seen) {
    const posted = checkPostedHash(db, hash)
    if (!posted) continue
    for (const file of files) {
      if (file.hash === hash) {
        file.status = 'duplicate-excluded'
        file.postedAt = posted.postedAt
      }
    }
  }

  const loaded = files.filter((f) => f.status === 'loaded').length
  const duplicates = files.filter(
    (f) => f.status === 'duplicate-excluded' || f.status === 'duplicate-in-batch'
  ).length
  const unsupported = files.filter((f) => f.status === 'unsupported-skipped').length

  return {
    batchEntryDate: localDateStamp(),
    inboxPath,
    files,
    summary: { total: files.length, loaded, duplicates, notReady: 0, unsupported }
  }
}
