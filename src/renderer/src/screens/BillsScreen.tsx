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
// and gives every loaded row one status chip. A row that failed carries a plain recoverable reason
// and a Retry control that re-parses just that one file, mirroring the include-anyway affordance
// above (D-15, flag-and-continue).
//
// Row structure (quick task 260727-iv0): a parsed row prints every populated field as a LABELED
// label/value pair in a <dl>, with the review marker on the individual field whose deterministic
// check failed rather than one blanket warning on the row. The status chip is a single Badge whose
// label AND variant both come from statusChip's precedence table, so the color carries meaning
// (default = done and good, secondary = benign, destructive = needs you, outline = skipped) instead
// of a row wearing four badges at once. The editable review table is still Phase 6.
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
  ParseProgress,
  ParsedFields,
  ScanFile,
  ScanFileStatus,
  ScanResult
} from '@shared/ipc-contract'

type BadgeVariant = 'default' | 'secondary' | 'outline' | 'destructive'

/** Every field the row can display, in ParsedFields declaration order. */
const FIELD_ORDER = [
  'vendor',
  'invoiceNumber',
  'invoiceDate',
  'dueDate',
  'subtotalCents',
  'taxCents',
  'totalCents',
  'currency',
  'suggestedCategory'
] as const satisfies readonly (keyof ParsedFields)[]

type ParsedFieldKey = (typeof FIELD_ORDER)[number]

const FIELD_LABEL: Record<ParsedFieldKey, string> = {
  vendor: 'Vendor',
  invoiceNumber: 'Invoice number',
  invoiceDate: 'Invoice date',
  dueDate: 'Due date',
  subtotalCents: 'Subtotal',
  taxCents: 'Tax',
  totalCents: 'Total',
  currency: 'Currency',
  suggestedCategory: 'Suggested category'
}

/** Membership test for "is this string the name of a field this build knows how to display?" */
const KNOWN_FIELDS: ReadonlySet<string> = new Set<string>(FIELD_ORDER)

/**
 * The three fields an unattributable flag condemns together, mirroring the same constant in
 * src/main/parse/confidence.ts. Any one of the three could be the wrong number.
 */
const MONEY_FIELDS = ['subtotalCents', 'taxCents', 'totalCents'] as const

// File-status labels and variants, read by rows 1 to 5 of statusChip's precedence table.
// Unsupported is a quiet outline. A caught already-posted file reads destructive so it stands out;
// a within-scan copy reads secondary (benign — a copy of it is already loaded). not-ready-skipped
// (plan 02-03) reads outline: it is a benign, recoverable state (the file is still syncing), so it
// should not alarm like an error. The `loaded` row is superseded by statusChip, which resolves a
// loaded file from its PARSE state and only falls back to a secondary "Loaded" chip when no parse
// result exists yet; the entry stays because ScanFileStatus is exhaustive.
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
 * Render integer cents as printed money. String math only, never cents / 100: this value came
 * from the deterministic gate as an exact integer and a float round trip is how it stops being one.
 */
function formatCents(cents: number): string {
  const negative = cents < 0
  const digits = Math.abs(cents).toString().padStart(3, '0')
  const whole = digits.slice(0, -2).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return `${negative ? '-' : ''}$${whole}.${digits.slice(-2)}`
}

/**
 * The text to print for one parsed field, or null when the field should be omitted entirely.
 *
 * Omit a null field, EXCEPT when it carries a flag, mirroring what computeConfidence already
 * decided main-side: it drops ungradeable nulls "so Phase 6 does not badge an empty cell" but
 * deliberately keeps a FLAGGED field "even when its value is null, because the flag itself is the
 * thing to show". A cash receipt with no tax line legitimately has taxCents: null and printing
 * "Tax: not found" on every such row is blank noise; but money:taxCents fires only when the
 * document HAD a tax value and it was unreadable, and hiding that row would hide a failed check.
 *
 * vendor and totalCents are the two required fields and are always printed. A total that is not a
 * number (only reachable through a degraded cache blob) prints Not found rather than $0.00,
 * because a confident zero-dollar bill is the precise failure D-12 and WR-10 exist to prevent.
 */
function fieldValue(fields: ParsedFields, field: ParsedFieldKey, flagged: boolean): string | null {
  const value = fields[field]
  if (field === 'vendor') {
    const vendor = typeof value === 'string' ? value.trim() : ''
    return vendor === '' ? 'Not found' : vendor
  }
  if (field === 'totalCents') {
    return typeof value === 'number' ? formatCents(value) : 'Not found'
  }
  if (value === null || value === undefined) return flagged ? 'Not found' : null
  if (field === 'subtotalCents' || field === 'taxCents') {
    return typeof value === 'number' ? formatCents(value) : 'Not found'
  }
  // invoiceDate / dueDate print the stored ISO string verbatim: reformatting a date is a display
  // decision and this task is structure only.
  return String(value)
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
 * WHICH displayed fields carry a failed deterministic check. The per-field half of isFlagged.
 *
 * Three sources, unioned, plus one backstop:
 *   1. a `confidence` entry of 'flagged' under a known field name  -> that field
 *   2. a `validationFlags` entry shaped `prefix:field` whose suffix is a known field name
 *      -> that field (this includes the D-22 `agreement:` flags, which the renderer keeps
 *      treating as flagged even though the main process grades them 'low')
 *   3. ANYTHING ELSE                                               -> UNATTRIBUTED
 *   4. if anything was UNATTRIBUTED, every one of MONEY_FIELDS is flagged
 *
 * Rule 4 is the load-bearing line. ARITHMETIC_FLAG is literally the string
 * 'arithmetic:subtotal+tax!=total', and the part after its colon is NOT a ParsedFields key --
 * confidence.ts special-cases that flag and condemns all three money fields together. A naive
 * `split(':')` mapping here would therefore drop the arithmetic cross-check silently, which is
 * precisely the WR-10 failure ("a displayed money value must never appear without its flag")
 * wearing a per-field costume. Rule 4 handles it correctly by construction, without importing
 * anything from src/main across the process boundary, and it makes every future flag string this
 * build does not recognize degrade toward showing MORE review markers rather than fewer.
 *
 * The consequence worth stating: totalCents is ALWAYS displayed, so rule 4 guarantees that a
 * non-empty flag set always produces at least one visible marker. That, plus the property
 * `isFlagged(parse) === (flaggedFields(parse).size > 0)` pinned in test/bills-row-status.test.ts,
 * is what keeps WR-10 true for every input shape rather than only the ones anticipated here.
 */
export function flaggedFields(parse?: ParseFileResult): Set<string> {
  const flagged = new Set<string>()
  if (!parse) return flagged
  let unattributed = false

  for (const [key, level] of Object.entries(parse.confidence ?? {})) {
    if (level !== 'flagged') continue
    if (KNOWN_FIELDS.has(key)) flagged.add(key)
    else unattributed = true
  }

  for (const flag of parse.validationFlags ?? []) {
    // A cached row's flag list is rehydrated from JSON, so a degraded blob could hand back a
    // non-string. Count it rather than skip it: dropping it is the one outcome WR-10 forbids.
    if (typeof flag !== 'string') {
      unattributed = true
      continue
    }
    const separator = flag.indexOf(':')
    const field = separator < 0 ? '' : flag.slice(separator + 1)
    if (separator >= 0 && KNOWN_FIELDS.has(field)) flagged.add(field)
    else unattributed = true
  }

  if (unattributed) for (const key of MONEY_FIELDS) flagged.add(key)
  return flagged
}

/**
 * The row's single status chip: one label and one variant, resolved by first match.
 *
 * Order matters and is deliberate.
 *
 * A file whose status is anything but 'loaded' never entered the parse pipeline (BillsScreen
 * only sends loaded files to parse.parseBatch), so its file status is the only fact that exists
 * about it. Putting those rows first also means that if a future change ever parses an
 * included-anyway duplicate, the dedupe warning cannot be overwritten by a cheerful "Ready to
 * review". Losing an "already entered in QuickBooks" warning is the worse failure, and it is safe
 * to order it this way ONLY because WR-10 is enforced in the field list, not by this chip.
 *
 * Among the parse rows, "Could not read" and "Needs review" are the two states that require the
 * user to act, so they outrank both "Already read" (a cost and provenance fact, already reported
 * in the batch summary line) and the bland "Loaded", which carries no information at all once a
 * parse result exists. A flagged bill wearing a calm "Already read" chip would be the chip-level
 * version of the exact WR-10 failure.
 *
 * Variant semantics this produces: default = done and good, secondary = in progress or a benign
 * no-op, destructive = needs you, outline = skipped and not in the batch.
 */
export function statusChip(
  file: ScanFile,
  parse?: ParseFileResult
): { label: string; variant: BadgeVariant } {
  // Rows 1 and 2: an already-posted duplicate, carrying its posted date when the ledger knows it.
  if (file.status === 'duplicate-excluded') {
    return {
      label: file.postedAt ? `Already entered on ${file.postedAt}` : STATUS_LABEL[file.status],
      variant: STATUS_VARIANT[file.status]
    }
  }
  // Rows 3, 4 and 5: every other non-loaded status reads straight off the file-status tables.
  if (file.status !== 'loaded') {
    return { label: STATUS_LABEL[file.status], variant: STATUS_VARIANT[file.status] }
  }
  // Row 6.
  if (parse?.status === 'parse-failed') return { label: 'Could not read', variant: 'destructive' }
  // Row 7.
  if (isFlagged(parse)) return { label: 'Needs review', variant: 'destructive' }
  // Row 8.
  if (parse?.status === 'cached') return { label: 'Already read', variant: 'secondary' }
  // Row 9.
  if (parse?.status === 'parsed') return { label: 'Ready to review', variant: 'default' }
  // Row 10: loaded, not read yet.
  return { label: 'Loaded', variant: 'secondary' }
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
  const canRetry = parse?.status === 'parse-failed' && onRetry !== undefined
  const chip = statusChip(file, parse)
  // A failed parse has no fields to print; it prints its recoverable reason instead.
  const fields = parse?.status === 'parse-failed' ? undefined : parse?.fields
  // Computed ONCE for the whole row, not per field. A displayed amount always travels with its
  // flag: displaying the value alone is worse than displaying neither, because it reads as a
  // clean, confident parse.
  const flags = flaggedFields(parse)

  return (
    <li className="flex items-start justify-between gap-3 rounded-lg border border-border bg-card px-3 py-2">
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="font-mono text-sm text-card-foreground">{file.filename}</span>
        {/* A definition list is the right semantics for label/value pairs, and it is what turns
            an unreadable "Nassau Plumbing Supply $1,336.00" into data the user can actually
            check field by field. */}
        {fields && (
          <dl className="flex flex-wrap gap-x-4 gap-y-0.5">
            {FIELD_ORDER.map((field) => {
              const flagged = flags.has(field)
              const value = fieldValue(fields, field, flagged)
              if (value === null) return null
              return (
                <div key={field} className="flex gap-1.5">
                  <dt className="font-sans text-sm text-muted-foreground">{FIELD_LABEL[field]}</dt>
                  <dd
                    className={
                      flagged
                        ? 'font-sans text-sm text-destructive'
                        : 'font-sans text-sm text-card-foreground'
                    }
                  >
                    {flagged ? `${value} (needs review)` : value}
                  </dd>
                </div>
              )
            })}
          </dl>
        )}
        {/* A truncated read presenting a confident total is the same class of silent-confidence
            problem WR-10 exists to prevent, so say it out loud (D-21). */}
        {parse?.truncated && (
          <span className="font-sans text-sm text-muted-foreground">
            Long document: only some of the pages were read.
          </span>
        )}
        {/* Visibility over silence: a failed row always says WHY, never just turns red. */}
        {parse?.status === 'parse-failed' && parse.error && (
          <span className="font-sans text-sm text-destructive">{parse.error}</span>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {/* Exactly one chip. Inclusion is a different axis and needs no badge of its own: the
            button beside it already reads "Remove from batch" whenever the file is in the batch,
            which says the same thing and is also actionable. */}
        <Badge variant={chip.variant}>{chip.label}</Badge>
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
