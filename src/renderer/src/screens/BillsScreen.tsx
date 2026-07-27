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
// Parse status (03-07, D-13/D-15/D-18b/D-26): after a successful scan the screen fires
// window.api.parse.parseBatch() on the loaded set as a SEPARATE call (never from inside the scan
// invoke, D-26), subscribes to the parse:progress broadcast for a live "parsing N of M" indicator,
// and badges every loaded row parsed / cached / could-not-read. A row that failed carries a plain
// recoverable reason and a Retry control that re-parses just that one file, mirroring the
// include-anyway affordance above (D-15, flag-and-continue). Parsed rows show a read-only vendor
// and total; the editable review table is Phase 6, deliberately not here.
//
// The renderer performs zero direct fs/db access — every privileged operation runs main-side
// behind the ingestion IPC group. All colors are semantic theme classes (no hardcoded hex).

import { useEffect, useRef, useState } from 'react'

import { Receipt } from 'lucide-react'

import { EmptyState } from '../components/EmptyState'
import { Badge } from '../components/ui/badge'
import { Button } from '../components/ui/button'
import type {
  ParseBatchFile,
  ParseFileResult,
  ParseFileStatus,
  ParseProgress,
  ScanFile,
  ScanFileStatus,
  ScanResult
} from '@shared/ipc-contract'

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

// A freshly parsed file reads as the branded default. A cache hit reads secondary: nothing went
// wrong and nothing was re-charged, it is simply already known. A failure reads destructive and
// always pairs with a reason plus a Retry control, never a bare red badge (D-15).
const PARSE_STATUS_VARIANT: Record<ParseFileStatus, BadgeVariant> = {
  parsed: 'default',
  cached: 'secondary',
  'parse-failed': 'destructive'
}

const PARSE_STATUS_LABEL: Record<ParseFileStatus, string> = {
  parsed: 'Parsed',
  cached: 'Cached',
  'parse-failed': 'Could not read'
}

/**
 * Render integer cents as printed money. String math only, never cents / 100: this value came
 * from the deterministic gate as an exact integer and a float round trip is how it stops being one.
 */
function formatCents(cents: number): string {
  const negative = cents < 0
  const digits = Math.abs(cents).toString().padStart(3, '0')
  const whole = digits.slice(0, -2).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return `${negative ? '-' : ''}$${whole}.${digits.slice(-2)}`
}

/** The one-line read-only summary of a parsed bill. The editable table is Phase 6. */
export function parsedSummary(parse: ParseFileResult): string | null {
  if (!parse.fields) return null
  const vendor = parse.fields.vendor.trim()
  const total = formatCents(parse.fields.totalCents)
  return vendor === '' ? total : `${vendor} ${total}`
}

/**
 * Did the deterministic gate flag anything about this row?
 *
 * This is what makes D-12's "flag-and-keep" actually kept AND flagged. validate.ts is explicit
 * that an unreadable total is recorded as 0 "but only ever alongside its flag, which is what
 * makes the fallback visible instead of silent" — so a row that renders the VALUE without the
 * flag turns the case that module is proudest of catching (a total reading "N/A" must never
 * become a confident $0.00) into a normal, successfully parsed $0.00 bill on screen.
 *
 * The rich per-field flagging UI is Phase 6 (D-18) and this is deliberately not that. It is the
 * minimum that makes displaying a value honest: if any check failed, say so next to the number.
 */
export function isFlagged(parse?: ParseFileResult): boolean {
  if (!parse) return false
  if ((parse.validationFlags?.length ?? 0) > 0) return true
  return Object.values(parse.confidence ?? {}).some((level) => level === 'flagged')
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

export function ScanRow({
  file,
  included,
  onToggleInclude,
  parse,
  retrying,
  onRetry
}: {
  file: ScanFile
  included?: boolean
  onToggleInclude?: () => void
  parse?: ParseFileResult
  retrying?: boolean
  onRetry?: () => void
}): React.JSX.Element {
  const isExcluded = file.status === 'duplicate-excluded'
  // A caught already-posted file surfaces its posted date so the user knows when it was entered.
  const label =
    isExcluded && file.postedAt ? `Already entered on ${file.postedAt}` : STATUS_LABEL[file.status]
  const summary = parse && parse.status !== 'parse-failed' ? parsedSummary(parse) : null
  const canRetry = parse?.status === 'parse-failed' && onRetry !== undefined
  // A displayed amount always travels with its flag. Displaying the value alone is worse than
  // displaying neither, because it reads as a clean, confident parse.
  const flagged = summary !== null && isFlagged(parse)

  return (
    <li className="flex items-center justify-between gap-3 rounded-lg border border-border bg-card px-3 py-2">
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="font-mono text-sm text-card-foreground">{file.filename}</span>
        {summary && (
          <span
            className={
              flagged
                ? 'font-sans text-sm text-destructive'
                : 'font-sans text-sm text-muted-foreground'
            }
          >
            {flagged ? `${summary} (needs review)` : summary}
          </span>
        )}
        {/* Visibility over silence: a failed row always says WHY, never just turns red. */}
        {parse?.status === 'parse-failed' && parse.error && (
          <span className="font-sans text-sm text-destructive">{parse.error}</span>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {included && <Badge variant="default">In batch</Badge>}
        <Badge variant={STATUS_VARIANT[file.status]}>{label}</Badge>
        {parse && (
          <Badge variant={PARSE_STATUS_VARIANT[parse.status]}>
            {PARSE_STATUS_LABEL[parse.status]}
          </Badge>
        )}
        {flagged && <Badge variant="destructive">Needs review</Badge>}
        {isExcluded && onToggleInclude && (
          <Button variant="ghost" size="sm" onClick={onToggleInclude}>
            {included ? 'Remove from batch' : 'Include anyway'}
          </Button>
        )}
        {canRetry && (
          <Button variant="ghost" size="sm" disabled={retrying} onClick={onRetry}>
            {retrying ? 'Retrying...' : 'Retry'}
          </Button>
        )}
      </div>
    </li>
  )
}

/**
 * The "Scan now" control.
 *
 * Disabled while a PARSE is running, not only while a scan is (WR-07). runScan fires
 * `void runParse(loaded)` without awaiting it and its finally immediately clears `scanning`, so a
 * guard on `scanning` alone let a second click start a second, concurrent parse:parse-batch:
 * the second run's setParseResults({}) wiped the first batch's rows, the first batch's finally
 * cleared the "parsing N of M" indicator while the second was still going, and both batches
 * missed the cache for the same in-flight documents and paid the model twice — the exact
 * double-charge PARSE-05 exists to prevent.
 *
 * Its own component so the disabled rule is provable without a DOM.
 */
export function ScanButton({
  scanning,
  parsing,
  onScan
}: {
  scanning: boolean
  parsing: boolean
  onScan: () => void
}): React.JSX.Element {
  return (
    <Button variant="default" disabled={scanning || parsing} onClick={onScan}>
      {scanning ? 'Scanning...' : parsing ? 'Reading bills...' : 'Scan now'}
    </Button>
  )
}

export function BillsScreen(): React.JSX.Element {
  const [inboxPath, setInboxPath] = useState<string | null>(null)
  const [scanning, setScanning] = useState(false)
  const [scanError, setScanError] = useState<string | null>(null)
  const [result, setResult] = useState<ScanResult | null>(null)
  // Renderer-only override: which duplicate-excluded files the user chose to include anyway.
  const [includedOverrides, setIncludedOverrides] = useState<Set<string>>(new Set())
  // Parse state, all renderer-local: per-file results keyed by hash, the live progress event, the
  // in-flight flags, and one recoverable error surface for a batch that rejected outright.
  const [parseResults, setParseResults] = useState<Record<string, ParseFileResult>>({})
  const [parseProgress, setParseProgress] = useState<ParseProgress | null>(null)
  const [parsing, setParsing] = useState(false)
  const [parseError, setParseError] = useState<string | null>(null)
  const [retrying, setRetrying] = useState<Set<string>>(new Set())
  // Guards runParse against re-entry; see the note in runParse.
  const parsingRef = useRef(false)

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

  // The parse:progress broadcast (D-26), subscribed exactly like theme.onChange: onProgress hands
  // back a disposer, so this effect's cleanup removes its own listener and a remount cannot leave
  // a second one counting behind it.
  useEffect(() => {
    return window.api.parse.onProgress((progress) => {
      setParseProgress(progress)
    })
  }, [])

  async function runScan(): Promise<void> {
    setScanning(true)
    setScanError(null)
    try {
      const scan = await window.api.ingestion.scan()
      setResult(scan)
      // A fresh scan clears any prior include-anyway overrides (they keyed to the old batch).
      setIncludedOverrides(new Set())
      setParseResults({})
      setParseProgress(null)
      setParseError(null)

      // D-13/D-26: auto-parse the loaded set immediately, as a SEPARATE call after the scan
      // resolved rather than from inside it. The pipeline is cache-first, so re-scanning bytes
      // that were already parsed costs nothing and never re-charges the model (PARSE-05).
      const loaded: ParseBatchFile[] = scan.files
        .filter((file) => file.status === 'loaded' && typeof file.hash === 'string')
        .map((file) => ({
          filename: file.filename,
          hash: file.hash as string,
          batchEntryDate: scan.batchEntryDate
        }))
      if (loaded.length > 0) void runParse(loaded)
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

  async function runParse(files: ParseBatchFile[]): Promise<void> {
    // Second line of defence behind the disabled button (WR-07). The button is the control the
    // user sees; this ref is what makes a second batch impossible even if a future caller (a
    // keyboard shortcut, a retry-all control) forgets to check. A ref, not state, because the
    // check has to see the current value synchronously rather than a render-scoped snapshot.
    if (parsingRef.current) return
    parsingRef.current = true
    setParsing(true)
    setParseError(null)
    try {
      const batch = await window.api.parse.parseBatch(files)
      setParseResults((prev) => {
        const next = { ...prev }
        for (const file of batch.files) next[file.hash] = file
        return next
      })
    } catch {
      // Per-file problems come back INSIDE the result as parse-failed rows (D-15); a rejection
      // here means the whole call failed, which in practice is unconfigured AI settings.
      setParseError(
        'Could not read your bills with the AI model. Check your AI settings on the Settings screen, then scan again.'
      )
    } finally {
      parsingRef.current = false
      setParsing(false)
      setParseProgress(null)
    }
  }

  /** D-15's "retry just the failed ones": re-parse one file, bypassing the cache (D-14). */
  async function retryParse(file: ScanFile): Promise<void> {
    const hash = file.hash
    if (!hash) return
    setRetrying((prev) => new Set(prev).add(hash))
    try {
      const retried = await window.api.parse.reparse(hash)
      setParseResults((prev) => ({ ...prev, [hash]: retried }))
    } catch {
      setParseResults((prev) => ({
        ...prev,
        [hash]: {
          filename: file.filename,
          hash,
          status: 'parse-failed',
          error: 'That retry could not run. Check your AI settings, then try again.'
        }
      }))
    } finally {
      setRetrying((prev) => {
        const next = new Set(prev)
        next.delete(hash)
        return next
      })
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

  // A one-line parse tally once a batch settles. 'cached' is called out separately because it is
  // the visible proof of PARSE-05: those files cost nothing to re-scan.
  const parsedRows = Object.values(parseResults)
  const parsedCount = parsedRows.filter((row) => row.status === 'parsed').length
  const cachedCount = parsedRows.filter((row) => row.status === 'cached').length
  const failedCount = parsedRows.filter((row) => row.status === 'parse-failed').length
  const parseSummaryLine =
    parsedRows.length === 0
      ? null
      : [
          `${parsedCount} parsed`,
          cachedCount > 0 ? `${cachedCount} already read` : null,
          failedCount > 0
            ? `${failedCount} could not be read (use Retry)`
            : null
        ]
          .filter((part): part is string => part !== null)
          .join(', ')

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h2 className="font-sans text-sm font-semibold text-muted-foreground">Inbox</h2>
          <p className="font-mono text-sm text-muted-foreground">
            {inboxPath ?? 'Locating your inbox folder...'}
          </p>
        </div>
        <ScanButton scanning={scanning} parsing={parsing} onScan={() => void runScan()} />
      </div>

      {scanError && (
        <p
          role="alert"
          className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 font-sans text-sm text-destructive"
        >
          {scanError}
        </p>
      )}

      {parseError && (
        <p
          role="alert"
          className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 font-sans text-sm text-destructive"
        >
          {parseError}
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
            {/* The D-15 "parsing N of M" indicator, fed by the parse:progress broadcast. */}
            {parsing && (
              <p className="font-sans text-sm text-muted-foreground" aria-live="polite">
                {parseProgress
                  ? `Reading bills: parsing ${parseProgress.done} of ${parseProgress.total}...`
                  : 'Reading bills with the AI model...'}
              </p>
            )}
            {!parsing && parseSummaryLine && (
              <p className="font-sans text-sm text-muted-foreground">{parseSummaryLine}</p>
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
              {loadedFiles.map((file) => {
                const parse = file.hash ? parseResults[file.hash] : undefined
                return (
                  <ScanRow
                    key={file.filename}
                    file={file}
                    parse={parse}
                    retrying={file.hash ? retrying.has(file.hash) : false}
                    onRetry={
                      parse?.status === 'parse-failed' ? () => void retryParse(file) : undefined
                    }
                  />
                )
              })}
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
