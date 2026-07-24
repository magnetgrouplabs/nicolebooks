// src/main/ingestion/scan.ts
//
// Scan orchestrator (ING-01, D-04, D-05). Enumerates the flat inbox once, classifies each
// entry by name, runs the materialization gate, stream-hashes every ready file, and returns an
// in-memory ScanResult. The ledger dedupe check (02-02) and the materialization/stability gate
// (02-03) layer onto this same pipeline at the marked seams below.
//
// Metadata-first, bytes-last (D-11, SC4): before ANY byte read, each supported file passes two
// independent gates — a placeholder check (isNotMaterialized, stat/attribute metadata only) and a
// bounded settling poll (isSettled). Reading bytes is exactly what forces a cloud placeholder to
// download, so a placeholder or a still-writing file is flagged not-ready-skipped WITHOUT ever
// opening its data stream, and surfaced for re-scan rather than silently dropped.
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
import { isNotMaterialized, isSettled, readWindowsOfflineFlags } from './materialization'

/** Injectable dependencies so the unit test drives a temp inbox + temp DB without Electron. */
export interface ScanDeps {
  inboxPath?: string
  db?: Database.Database
  /** Placeholder gate (default: the real isNotMaterialized). Metadata-only; injected in tests. */
  isNotMaterialized?: (
    fullPath: string,
    siblingNames: Set<string>,
    fileName: string
  ) => Promise<boolean>
  /** Partial-write settling poll (default: the real isSettled). Injected in tests for speed. */
  isSettled?: (fullPath: string) => Promise<boolean>
  /** File hasher (default: the real streaming sha256File). A test spy proves bytes-last. */
  sha256File?: (fullPath: string) => Promise<string>
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
  const hashFile = deps.sha256File ?? sha256File
  const settled = deps.isSettled ?? ((fullPath: string) => isSettled(fullPath))

  // Flat, non-recursive enumeration (D-01, Pitfall 3): list this one directory, never descend.
  const entries = await readdir(inboxPath, { withFileTypes: true })
  const files: ScanFile[] = []

  // Sibling names from the SAME readdir, so the macOS `.<name>.icloud` sentinel check needs no
  // extra directory read.
  const siblingNames = new Set(entries.map((e) => e.name))

  // Resolve the placeholder gate ONCE. On Windows the offline/recall attribute map is read in a
  // SINGLE batched spawn for the whole scan (never once per file); on any failure the map is
  // empty, which drives the load-on-failure fallback (skip only on positive placeholder
  // evidence). The gate is injectable so tests bypass all OS calls deterministically.
  const notMaterialized = await resolvePlaceholderGate(inboxPath, deps.isNotMaterialized)

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

    const fullPath = join(inboxPath, name)

    // Per-file error isolation (WR-01): a single transient fs fault on ONE entry (a file removed
    // mid-scan by cloud sync, a permission error, a lock) must never abort the whole batch and
    // discard every already-classified file. Any throw from the gates, the stat, or the hash is
    // caught here and recorded as not-ready-skipped — a benign, recoverable state that is
    // surfaced for re-scan rather than silently dropped (D-11's spirit).
    try {
      // SLICE 3 (02-03): the materialization gate runs BEFORE any byte read (metadata-first,
      // bytes-last). 1) placeholder check (stat/attribute only): an online-only cloud placeholder
      // is skipped without opening its bytes, so it is never force-downloaded. 2) settling poll: a
      // still-writing file is skipped so it is never hashed half-complete. Either failing gate ->
      // not-ready-skipped, surfaced for re-scan, and CONTINUE without hashing.
      if (await notMaterialized(fullPath, siblingNames, name)) {
        files.push({ filename: name, status: 'not-ready-skipped' })
        continue
      }
      if (!(await settled(fullPath))) {
        files.push({ filename: name, status: 'not-ready-skipped' })
        continue
      }

      // Now safe: the file is local and settled. Only here do we read its bytes (bytes-last).
      const st = await stat(fullPath)
      const hash = await hashFile(fullPath)
      files.push({ filename: name, status: 'loaded', hash, sizeBytes: Number(st.size) })
    } catch {
      files.push({ filename: name, status: 'not-ready-skipped' })
    }
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
  const notReady = files.filter((f) => f.status === 'not-ready-skipped').length
  const unsupported = files.filter((f) => f.status === 'unsupported-skipped').length

  return {
    batchEntryDate: localDateStamp(),
    inboxPath,
    files,
    summary: { total: files.length, loaded, duplicates, notReady, unsupported }
  }
}

/**
 * Build the placeholder gate for one scan. When a gate is injected (tests) it is used verbatim.
 * Otherwise the real isNotMaterialized is threaded with a per-scan attribute map: on Windows the
 * offline/recall attributes are read in a SINGLE batched spawn here (one per scan, never per
 * file), and any failure yields an empty map so isNotMaterialized loads-on-failure (skip only on
 * positive placeholder evidence). On macOS/other platforms no batched read is needed.
 */
async function resolvePlaceholderGate(
  inboxPath: string,
  injected?: (fullPath: string, siblingNames: Set<string>, fileName: string) => Promise<boolean>
): Promise<(fullPath: string, siblingNames: Set<string>, fileName: string) => Promise<boolean>> {
  if (injected) return injected

  const platform = process.platform
  let winFlags: Map<string, number> | undefined
  if (platform === 'win32') {
    try {
      winFlags = await readWindowsOfflineFlags(inboxPath)
    } catch {
      winFlags = new Map() // empty -> load-on-failure for every file
    }
  }

  return (fullPath, siblingNames, fileName) =>
    isNotMaterialized(fullPath, siblingNames, fileName, platform, {
      // Return the already-batched map; the arg is ignored so no per-file spawn occurs.
      readWinFlags: async () => winFlags ?? new Map()
    })
}
