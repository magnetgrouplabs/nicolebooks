// src/main/ingestion/materialization.ts
//
// The "metadata-first, bytes-last" materialization gate (ING-03, D-11, SC4). Cloud-sync
// providers (OneDrive / iCloud / Dropbox) leave online-only PLACEHOLDER files on disk whose
// bytes are not local. Reading those bytes is exactly what forces a download / materialization,
// so this module screens each file using ONLY metadata (stat + OS attributes) — it never opens a
// file's data stream. The scan runs both gates below before it ever streams bytes for the hash.
//
// Two independent, both-required gates:
//   1. isNotMaterialized — a placeholder check (macOS: size>0 && blocks===0, or a legacy
//      `.<name>.icloud` sentinel sibling; Windows: FILE_ATTRIBUTE_OFFLINE / RECALL_ON_DATA_ACCESS
//      / RECALL_ON_OPEN read via one batched, injection-safe attribute read per scan). A stable
//      placeholder never changes, so the settling poll alone cannot catch it — this gate is
//      separate and mandatory (02-RESEARCH Pitfall 1).
//   2. isSettled — a bounded size+mtime settling poll that catches a file still being written
//      (partial write), so a half-copied bill is never hashed.
//
// Inconclusive-detection fallback (flagged decision, 02-RESEARCH Section 1.4): if the Windows
// attribute read throws or returns nothing, the file is treated as MATERIALIZED (loaded/hashed)
// rather than false-skipping a real bill. Skipping requires POSITIVE placeholder evidence. This
// favors "never false-skip a real bill" over "never ever download", within D-11's spirit that
// skipped files are always surfaced and re-scannable.
//
// The functions are injectable (an explicit `platform` argument plus a `deps` object carrying a
// fake stat / attribute reader), mirroring connection.ts openDatabase(path) injectability, so
// both OS branches are unit-tested deterministically on a single CI host.

import { stat } from 'node:fs/promises'
import { setTimeout as sleep } from 'node:timers/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { dirname, join } from 'node:path'

const execFileAsync = promisify(execFile)

// Windows online-only / recall attribute bits. ANY set bit means the file's bytes are not on
// local disk yet. We bit-test the raw [int64] Attributes integer because .NET's FileAttributes
// enum has no named member for RECALL_ON_DATA_ACCESS (0x400000), so an enum-only check misses it.
const FILE_ATTRIBUTE_OFFLINE = 0x1000
const FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS = 0x400000
const FILE_ATTRIBUTE_RECALL_ON_OPEN = 0x40000
const WIN_OFFLINE_MASK =
  FILE_ATTRIBUTE_OFFLINE | FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS | FILE_ATTRIBUTE_RECALL_ON_OPEN

/** Minimal stat shape the placeholder check reads (macOS branch). */
interface StatMeta {
  size: number | bigint
  blocks: number | bigint
}

/** Injectable dependencies for cross-OS unit testing (all default to the real implementations). */
export interface MaterializationDeps {
  /** macOS metadata read; default node:fs/promises stat. Never faults in a placeholder's data. */
  stat?: (fullPath: string) => Promise<StatMeta>
  /** Windows attribute reader; default the batched readWindowsOfflineFlags. */
  readWinFlags?: (dirPath: string) => Promise<Map<string, number>>
}

/**
 * True when the file's bytes are NOT on local disk yet (an online-only cloud placeholder). Reads
 * metadata ONLY, so it never triggers a download / materialization.
 *
 * - darwin: a dataless APFS file reports its full logical `size` with zero allocated `blocks`;
 *   a legacy iCloud stub leaves a `.<name>.icloud` sentinel sibling. Either -> not materialized.
 * - win32: any of the OFFLINE / RECALL bits set for the file -> not materialized. If the attribute
 *   read throws or the file is absent from the map, return false (LOAD-on-failure: skip only on
 *   positive evidence).
 * - other platforms: no cloud-placeholder concept here; treat as materialized.
 */
export async function isNotMaterialized(
  fullPath: string,
  siblingNames: Set<string>,
  fileName: string,
  platform: NodeJS.Platform = process.platform,
  deps: MaterializationDeps = {}
): Promise<boolean> {
  if (platform === 'darwin') {
    const statFn = deps.stat ?? stat
    // Load-on-failure, mirroring the win32 branch (WR-01): a stat that throws (file removed
    // between readdir and the gate, permission error) is INCONCLUSIVE, not positive placeholder
    // evidence, so treat it as materialized and let the settling/hash gates (and the scan-level
    // per-file try/catch) handle a genuinely-vanished file. Skip only on positive evidence.
    let st: StatMeta
    try {
      st = await statFn(fullPath)
    } catch {
      return false
    }
    // APFS dataless file: full logical size, zero allocated extents.
    if (Number(st.size) > 0 && Number(st.blocks) === 0) return true
    // Legacy pre-Sonoma iCloud stub: a sibling ".<name>.icloud" placeholder exists.
    if (siblingNames.has(`.${fileName}.icloud`)) return true
    return false
  }

  if (platform === 'win32') {
    try {
      const reader = deps.readWinFlags ?? readWindowsOfflineFlags
      const flags = await reader(dirname(fullPath))
      const attr = flags.get(fileName)
      // Missing entry -> inconclusive -> LOAD (skip only on positive evidence).
      if (attr === undefined) return false
      return (attr & WIN_OFFLINE_MASK) !== 0
    } catch {
      // Attribute read unavailable (no PowerShell/attrib) -> inconclusive -> LOAD.
      return false
    }
  }

  return false
}

/**
 * Bounded size+mtime settling poll (partial-write guard). Resolves true once two consecutive
 * samples of (size, mtimeMs) are equal, or false if the file is still changing after the budget
 * (~intervalMs * maxSamples). A file still growing after the ceiling is treated as not-ready and
 * surfaced for a later re-scan. Defaults: 750ms x up to 6 samples (~4.5s ceiling).
 */
export async function isSettled(
  fullPath: string,
  { intervalMs = 750, maxSamples = 6 }: { intervalMs?: number; maxSamples?: number } = {}
): Promise<boolean> {
  let prev = await stat(fullPath)
  for (let i = 0; i < maxSamples; i++) {
    await sleep(intervalMs)
    const next = await stat(fullPath)
    if (next.size === prev.size && next.mtimeMs === prev.mtimeMs) return true
    prev = next
  }
  return false
}

/**
 * Read the Windows offline/recall attributes for every file in one directory in a SINGLE batched
 * spawn (never once per file). Returns a name -> raw attribute-integer map.
 *
 * SECURITY (Pitfall 4 / T-02-08): this uses execFile with an ARGS ARRAY and shell:false — never
 * `exec` with a concatenated command string. The directory path is passed out-of-band via an
 * environment variable (NB_SCAN_DIR), so a crafted folder path or filename can never be parsed as
 * a command (no command injection / EoP).
 *
 * Fallback chain: PowerShell (precise raw attribute integer) -> `attrib` (coarse offline letter)
 * -> empty map. An empty map drives the load-on-failure fallback in isNotMaterialized.
 */
export async function readWindowsOfflineFlags(dirPath: string): Promise<Map<string, number>> {
  const map = new Map<string, number>()

  // Primary: PowerShell one-liner returning "name<TAB>[int64]Attributes". The path lives ONLY in
  // an env var referenced by the static script, so it is never interpolated into code.
  try {
    const script =
      'Get-ChildItem -LiteralPath $env:NB_SCAN_DIR -File | ' +
      'ForEach-Object { "$($_.Name)`t$([int64]$_.Attributes)" }'
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      {
        shell: false,
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, NB_SCAN_DIR: dirPath }
      }
    )
    parseNameTabAttr(stdout, map)
    return map
  } catch {
    // fall through to attrib
  }

  // Fallback: attrib prints attribute letters then the full path. The directory + wildcard is a
  // DISCRETE argument (args array, shell:false) — never a concatenated command string.
  try {
    const { stdout } = await execFileAsync('attrib', [join(dirPath, '*')], {
      shell: false,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024
    })
    parseAttribOfflineLetters(stdout, map)
    return map
  } catch {
    // Both readers unavailable -> empty map -> load-on-failure in isNotMaterialized.
    return map
  }
}

/** Parse the PowerShell "name<TAB>attributes-integer" lines into the attribute map. */
function parseNameTabAttr(stdout: string, map: Map<string, number>): void {
  for (const line of stdout.split(/\r?\n/)) {
    const tab = line.indexOf('\t')
    if (tab < 0) continue
    const name = line.slice(0, tab)
    const attr = Number.parseInt(line.slice(tab + 1).trim(), 10)
    if (name && Number.isFinite(attr)) map.set(name, attr)
  }
}

/** Parse `attrib` output: an 'O' (offline) in the attribute columns maps to the OFFLINE bit. */
function parseAttribOfflineLetters(stdout: string, map: Map<string, number>): void {
  for (const line of stdout.split(/\r?\n/)) {
    // The full path starts at the drive-letter token (e.g. "C:\"); attribute letters precede it.
    const driveIdx = line.search(/[A-Za-z]:\\/)
    if (driveIdx < 0) continue
    const attrCols = line.slice(0, driveIdx)
    const fullPath = line.slice(driveIdx).trim()
    const base = fullPath.split(/[\\/]/).pop() ?? ''
    if (!base) continue
    map.set(base, attrCols.includes('O') ? FILE_ATTRIBUTE_OFFLINE : 0)
  }
}
