// Plan 02-01 / 02-02: the Bills screen scan surface (ING-01, ING-04, D-09, D-14).
//
// On mount it reads the configured inbox path through window.api.ingestion.resolveInbox()
// (display-only; repointing lives on the Settings screen). A "Scan now" button runs the
// read-only scan through window.api.ingestion.scan() and renders the minimal loaded-results
// surface: a one-line summary, the batch processing date, the loaded files with a per-status
// Badge, the caught duplicates, and an unsupported-skipped summary (D-12, visibility over
// silence).
//
// Duplicates (02-02): a duplicate-excluded row (exact hash already posted to QuickBooks) shows
// "Already entered on <date>" and is excluded from the batch by default, with a one-click
// "Include anyway" control that toggles the file into the batch in local renderer state (an
// includedOverrides Set keyed by filename + hash). Phase 2 ends at "loaded for processing", so
// the override is renderer-only local state, never a window.api write. A duplicate-in-batch row
// (a byte-identical copy within this same scan, D-10) shows its own quiet badge.
//
// The renderer performs zero direct fs/db access — every privileged operation runs main-side
// behind the ingestion IPC group. All colors are semantic theme classes (no hardcoded hex).

import { useEffect, useState } from 'react'

import { Receipt } from 'lucide-react'

import { EmptyState } from '../components/EmptyState'
import { Badge } from '../components/ui/badge'
import { Button } from '../components/ui/button'
import type { ScanFile, ScanFileStatus, ScanResult } from '@shared/ipc-contract'

type BadgeVariant = 'default' | 'secondary' | 'outline' | 'destructive'

// Loaded is the branded default; unsupported is a quiet outline. A caught already-posted file
// reads destructive so it stands out; a within-scan copy reads secondary (benign — a copy of it
// is already loaded). not-ready-skipped (plan 02-03) reads outline: it is a benign, recoverable
// state (the file is still syncing), so it should not alarm like an error.
const STATUS_VARIANT: Record<ScanFileStatus, BadgeVariant> = {
  loaded: 'default',
  'duplicate-excluded': 'destructive',
  'duplicate-in-batch': 'secondary',
  'not-ready-skipped': 'outline',
  'unsupported-skipped': 'outline'
}

const STATUS_LABEL: Record<ScanFileStatus, string> = {
  loaded: 'Loaded',
  'duplicate-excluded': 'Already entered',
  'duplicate-in-batch': 'Duplicate in this scan',
  'not-ready-skipped': 'Not downloaded yet, re-scan shortly',
  'unsupported-skipped': 'Unsupported'
}

/**
 * When a scan loads nothing, explain WHY (visibility over silence): distinguish an all-duplicates
 * batch from a mixed all-skipped batch so the user is never left staring at an unexplained empty
 * result. All copy is plain text (no dashes) per project style.
 */
function noLoadState(result: ScanResult): { heading: string; body: string } {
  const duplicateCount = result.files.filter(
    (f) => f.status === 'duplicate-excluded' || f.status === 'duplicate-in-batch'
  ).length
  if (duplicateCount > 0 && duplicateCount === result.files.length) {
    return {
      heading: 'Everything was already entered',
      body: 'Every file in this scan is a duplicate already posted to QuickBooks. Use Include anyway to add one back to the batch.'
    }
  }
  return {
    heading: 'No new bills loaded',
    body: 'Every file in this scan was skipped as a duplicate, unsupported, or not yet downloaded. See the details below, then fix or re-scan.'
  }
}

/** Stable local key for a scanned file (filename + hash), used for include-anyway overrides. */
function fileKey(file: ScanFile): string {
  return `${file.filename} ${file.hash ?? ''}`
}

function summaryLine(result: ScanResult): string {
  const { total, loaded, duplicates, notReady, unsupported } = result.summary
  const parts = [`${loaded} loaded`]
  if (duplicates > 0) parts.push(`${duplicates} duplicate${duplicates === 1 ? '' : 's'}`)
  if (notReady > 0) parts.push(`${notReady} not downloaded`)
  if (unsupported > 0) parts.push(`${unsupported} unsupported`)
  const noun = total === 1 ? 'file' : 'files'
  return `${total} ${noun}: ${parts.join(', ')}`
}

function ScanRow({
  file,
  included,
  onToggleInclude
}: {
  file: ScanFile
  included?: boolean
  onToggleInclude?: () => void
}): React.JSX.Element {
  const isExcluded = file.status === 'duplicate-excluded'
  // A caught already-posted file surfaces its posted date so the user knows when it was entered.
  const label =
    isExcluded && file.postedAt ? `Already entered on ${file.postedAt}` : STATUS_LABEL[file.status]

  return (
    <li className="flex items-center justify-between gap-3 rounded-lg border border-border bg-card px-3 py-2">
      <span className="font-mono text-sm text-card-foreground">{file.filename}</span>
      <div className="flex items-center gap-2">
        {included && <Badge variant="default">In batch</Badge>}
        <Badge variant={STATUS_VARIANT[file.status]}>{label}</Badge>
        {isExcluded && onToggleInclude && (
          <Button variant="ghost" size="sm" onClick={onToggleInclude}>
            {included ? 'Remove from batch' : 'Include anyway'}
          </Button>
        )}
      </div>
    </li>
  )
}

export function BillsScreen(): React.JSX.Element {
  const [inboxPath, setInboxPath] = useState<string | null>(null)
  const [scanning, setScanning] = useState(false)
  const [scanError, setScanError] = useState<string | null>(null)
  const [result, setResult] = useState<ScanResult | null>(null)
  // Renderer-only override: which duplicate-excluded files the user chose to include anyway.
  const [includedOverrides, setIncludedOverrides] = useState<Set<string>>(new Set())

  useEffect(() => {
    let cancelled = false
    async function loadInbox(): Promise<void> {
      try {
        const resolved = await window.api.ingestion.resolveInbox()
        if (!cancelled) setInboxPath(resolved.path)
      } catch {
        if (!cancelled) setInboxPath(null)
      }
    }
    void loadInbox()
    return () => {
      cancelled = true
    }
  }, [])

  async function runScan(): Promise<void> {
    setScanning(true)
    setScanError(null)
    try {
      const scan = await window.api.ingestion.scan()
      setResult(scan)
      // A fresh scan clears any prior include-anyway overrides (they keyed to the old batch).
      setIncludedOverrides(new Set())
    } catch {
      // The scan rejected. The most common trigger is a moved, renamed, or deleted inbox folder
      // (or one on an offline drive), but any main-side fault lands here. Surface a plain,
      // recoverable message instead of failing silently, which would only flicker the button.
      setScanError(
        'Could not scan your inbox folder. Make sure the folder still exists, then try again.'
      )
    } finally {
      setScanning(false)
    }
  }

  function toggleInclude(file: ScanFile): void {
    const key = fileKey(file)
    setIncludedOverrides((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const loadedFiles = result?.files.filter((f) => f.status === 'loaded') ?? []
  const duplicateFiles =
    result?.files.filter(
      (f) => f.status === 'duplicate-excluded' || f.status === 'duplicate-in-batch'
    ) ?? []
  const notReadyFiles = result?.files.filter((f) => f.status === 'not-ready-skipped') ?? []
  const unsupportedFiles = result?.files.filter((f) => f.status === 'unsupported-skipped') ?? []

  // The batch is the loaded files plus any duplicate-excluded files the user included anyway.
  const batchCount = loadedFiles.length + includedOverrides.size

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h2 className="font-sans text-sm font-semibold text-muted-foreground">Inbox</h2>
          <p className="font-mono text-sm text-muted-foreground">
            {inboxPath ?? 'Locating your inbox folder...'}
          </p>
        </div>
        <Button variant="default" disabled={scanning} onClick={() => void runScan()}>
          {scanning ? 'Scanning...' : 'Scan now'}
        </Button>
      </div>

      {scanError && (
        <p
          role="alert"
          className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 font-sans text-sm text-destructive"
        >
          {scanError}
        </p>
      )}

      {!result && (
        <EmptyState
          icon={Receipt}
          heading="No bills to review"
          body="Drop bills into your inbox folder, then click Scan now to load them for review."
        />
      )}

      {result && result.files.length === 0 && (
        <EmptyState
          icon={Receipt}
          heading="No files in your inbox yet"
          body="Drop bills into your inbox folder, then click Scan now to load them for review."
        />
      )}

      {result && result.files.length > 0 && (
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1">
            <p className="font-sans text-sm font-medium text-foreground">{summaryLine(result)}</p>
            <p className="font-sans text-sm text-muted-foreground">
              Batch date: {result.batchEntryDate}
            </p>
            {duplicateFiles.length > 0 && (
              <p className="font-sans text-sm text-muted-foreground">
                {batchCount} {batchCount === 1 ? 'file' : 'files'} in batch
              </p>
            )}
          </div>

          {/* A scan that loads nothing still explains why (all-duplicates vs all-skipped), then
              the detail sections below stay visible so duplicates can be included and skipped
              files can be re-scanned (visibility over silence). */}
          {loadedFiles.length === 0 && (
            <EmptyState
              icon={Receipt}
              heading={noLoadState(result).heading}
              body={noLoadState(result).body}
            />
          )}

          {loadedFiles.length > 0 && (
            <ul className="flex flex-col gap-2">
              {loadedFiles.map((file) => (
                <ScanRow key={file.filename} file={file} />
              ))}
            </ul>
          )}

          {duplicateFiles.length > 0 && (
            <div className="flex flex-col gap-2">
              <p className="font-sans text-sm font-semibold text-muted-foreground">Duplicates</p>
              <ul className="flex flex-col gap-2">
                {duplicateFiles.map((file) => {
                  const isExcluded = file.status === 'duplicate-excluded'
                  const included = isExcluded && includedOverrides.has(fileKey(file))
                  return (
                    <ScanRow
                      key={file.filename}
                      file={file}
                      included={isExcluded ? included : undefined}
                      onToggleInclude={isExcluded ? () => toggleInclude(file) : undefined}
                    />
                  )
                })}
              </ul>
            </div>
          )}

          {notReadyFiles.length > 0 && (
            <div className="flex flex-col gap-2">
              <p className="font-sans text-sm font-semibold text-muted-foreground">
                Not downloaded yet
              </p>
              <ul className="flex flex-col gap-2">
                {notReadyFiles.map((file) => (
                  <ScanRow key={file.filename} file={file} />
                ))}
              </ul>
            </div>
          )}

          {unsupportedFiles.length > 0 && (
            <div className="flex flex-col gap-2 rounded-xl border border-border bg-card p-4">
              <p className="text-sm font-semibold text-card-foreground">
                {unsupportedFiles.length} {unsupportedFiles.length === 1 ? 'file' : 'files'} skipped
                (unsupported type)
              </p>
              <ul className="flex flex-col gap-1">
                {unsupportedFiles.map((file) => (
                  <li key={file.filename} className="font-mono text-sm text-muted-foreground">
                    {file.filename}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
