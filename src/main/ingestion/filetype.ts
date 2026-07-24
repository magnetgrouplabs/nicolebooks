// src/main/ingestion/filetype.ts
//
// Pure file-type classifier + junk filter (ING-05, D-12, D-13). No fs, no DB, no Electron:
// every function takes a name/date and returns a value, so the whole module is unit-testable
// off a single OS. Classifying by EXTENSION (never by reading bytes) is a correctness
// requirement, not a shortcut: reading a file's bytes is exactly what forces a cloud-sync
// placeholder to download / materialize (02-RESEARCH Section 1). Screen by name here; the
// scan only ever streams bytes after materialization + stability gates pass in a later slice.

const SUPPORTED = new Set(['.pdf', '.jpg', '.jpeg', '.png', '.heic', '.heif'])
const JUNK_EXACT = new Set(['.ds_store', 'thumbs.db', 'desktop.ini', '.localized'])

/**
 * True for OS/system junk that is silently dropped (D-13): exact junk names, AppleDouble
 * `._*` resource forks, and hidden dotfiles. CRITICAL ordering: a `.<name>.icloud` iCloud
 * placeholder sentinel is NOT junk — it is translated to a placeholder signal for `<name>`
 * (see iCloudSentinelTarget) BEFORE the generic leading-dot rule, so the sentinel survives
 * the filter and the real file is flagged not-ready rather than silently lost.
 */
export function isJunk(name: string): boolean {
  const lower = name.toLowerCase()
  if (JUNK_EXACT.has(lower)) return true
  if (name.startsWith('._')) return true // AppleDouble resource fork
  if (name.startsWith('.') && !lower.endsWith('.icloud')) return true // hidden dotfile
  return false
}

/** True when the extension is one of the supported bill formats (case-insensitive). */
export function isSupported(name: string): boolean {
  const dot = name.lastIndexOf('.')
  return dot >= 0 && SUPPORTED.has(name.slice(dot).toLowerCase())
}

/**
 * Translate an iCloud placeholder sentinel to the real file it stands in for:
 * ".bill.pdf.icloud" -> "bill.pdf". Returns null for any name that is not a sentinel.
 */
export function iCloudSentinelTarget(name: string): string | null {
  const lower = name.toLowerCase()
  if (name.startsWith('.') && lower.endsWith('.icloud')) {
    return name.slice(1, -'.icloud'.length)
  }
  return null
}

/**
 * The processing date = the local calendar day of the scan, formatted 'YYYY-MM-DD' (D-05).
 * Uses the LOCAL date parts, never toISOString(), which is UTC and can be off by a day near
 * midnight. Phase 2 stamps every batch with this; the per-row date is editable later (D-06).
 */
export function localDateStamp(d = new Date()): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}
