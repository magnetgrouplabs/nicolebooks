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
// Getting bills IN (finish sprint, INGEST-UX): the folder is no longer the only way in, and no
// longer the first thing the screen asks of the user. Two additions sit beside "Scan now":
//
//   "Add files"      opens the native OS picker in MAIN, copies what was chosen into the managed
//                    inbox, then rescans. The renderer never sees or sends a path, so the T-02-02
//                    path-injection guard is unchanged.
//   "Add from phone" starts a LAN-only upload server in main and shows its QR code. Every file the
//                    phone sends arrives on the upload:received broadcast, which bumps a live count
//                    and fires a rescan, so a photo taken on the phone appears in this list without
//                    the user touching the computer.
//
// The folder path is still displayed, because a user who wants to drag files in should not have to
// hunt for it, but it is no longer the instruction.
//
// Review (Phase 6, REVIEW-01..09): once documents are scanned and read, the editable review surface
// renders BELOW the scan list, fed by the same files and parse results. It is its own component
// (src/renderer/src/review/ReviewTable.tsx) because it owns a second, larger concern (what will be
// sent) and this screen already owns two (getting documents in, and reading them). The parsed-field
// display and the flag attribution moved to review/parsed-fields.tsx, because BOTH surfaces render
// them now; they are re-exported here so the specs that import them from this module still do.
//
// The renderer performs zero direct fs/db access — every privileged operation runs main-side
// behind the ingestion IPC group. All colors are semantic theme classes (no hardcoded hex).

import { useEffect, useMemo, useRef, useState } from 'react'

import { FilePlus, Receipt, Smartphone } from 'lucide-react'

import { EmptyState } from '../components/EmptyState'
import type { Destination } from '../components/Sidebar'
import { Badge } from '../components/ui/badge'
import { Button } from '../components/ui/button'
import { ReviewTable } from '../review/ReviewTable'
import { ParsedFieldList, flaggedFields, isFlagged } from '../review/parsed-fields'
import type {
  ParseBatchFile,
  ParseFileResult,
  ParseProgress,
  PickFilesResult,
  ScanFile,
  ScanFileStatus,
  ScanResult
} from '@shared/ipc-contract'

// Re-exported, not re-implemented: test/bills-row-status.test.ts and test/bills-parse-flags.test.ts
// both import these from this module, and the rule they pin (WR-10: a displayed money value never
// appears without its flag) is the same rule wherever the implementation lives.
export { flaggedFields, isFlagged }

type BadgeVariant = 'default' | 'secondary' | 'outline' | 'destructive'

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
 * The calendar day out of a stored ISO instant.
 *
 * The ledger records the exact moment an entry was confirmed, which is the right thing to store and
 * the wrong thing to show: "when did I send this" is a question people answer in days. A value that
 * is already a plain date passes through unchanged, so this is safe whatever the ledger holds.
 */
export function postedDate(postedAt: string): string {
  return postedAt.slice(0, 10)
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
  //
  // The DATE, not the timestamp. The ledger stores a full ISO instant, and printing it verbatim put
  // "Already entered on 2026-07-27T22:08:18.559Z" in front of the one non-technical user this app
  // exists for (the live drill screenshotted it). The review table's duplicate notice already
  // sliced it the same way; this chip was the surface that did not.
  if (file.status === 'duplicate-excluded') {
    return {
      label: file.postedAt ? `Already entered on ${postedDate(file.postedAt)}` : STATUS_LABEL[file.status],
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
            check field by field. The same list is rendered inside every review row. */}
        {fields && <ParsedFieldList fields={fields} flags={flags} />}
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

/**
 * The "Add files" control. Disabled while a scan or a parse is in flight for the same reason
 * "Scan now" is (WR-07): the picker rescans when it finishes, and a rescan landing on top of a
 * running parse batch is the concurrency bug that spec exists to prevent.
 */
export function AddFilesButton({
  adding,
  busy,
  onAdd
}: {
  adding: boolean
  busy: boolean
  onAdd: () => void
}): React.JSX.Element {
  return (
    <Button variant="outline" disabled={adding || busy} onClick={onAdd}>
      <FilePlus />
      {adding ? 'Adding...' : 'Add files'}
    </Button>
  )
}

/** The "Add from phone" control. Same busy rule as the picker, for the same rescan reason. */
export function AddFromPhoneButton({
  busy,
  onOpen
}: {
  busy: boolean
  onOpen: () => void
}): React.JSX.Element {
  return (
    <Button variant="outline" disabled={busy} onClick={onOpen}>
      <Smartphone />
      Add from phone
    </Button>
  )
}

/**
 * What to tell the user after the picker closes.
 *
 * A cancel returns null and the screen says NOTHING: the user changed their mind and a message
 * about it is noise. Everything else is reported, including the skips, by name. A file that
 * silently fails to arrive is the failure that costs the most trust, because there is no way for
 * the user to notice it happened.
 */
export function addFilesNotice(result: PickFilesResult): string | null {
  const { added, skipped } = result
  if (added === 0 && skipped.length === 0) return null

  const addedPart =
    added === 0
      ? 'Nothing was added.'
      : `Added ${added} ${added === 1 ? 'file' : 'files'} to your inbox.`
  if (skipped.length === 0) return addedPart

  const noun = skipped.length === 1 ? 'file was' : 'files were'
  return `${addedPart} ${skipped.length} ${noun} skipped, because NicoleBooks only takes PDF files and photos: ${skipped.join(', ')}`
}

/** The live tally inside the phone-upload panel. Plain counting, no jargon. */
export function phoneReceivedLine(count: number): string {
  if (count === 0) return 'Nothing sent yet. Point your phone camera at the code to begin.'
  if (count === 1) return '1 file received so far.'
  return `${count} files received so far.`
}

/**
 * The phone-upload panel.
 *
 * A plain overlay rather than a component from components/ui, because this build has no Dialog
 * primitive yet. DESIGN wave: this is the first modal in the app and is the obvious place to
 * introduce one; the markup below is deliberately structural so restyling it does not mean
 * rewriting behaviour.
 *
 * The URL is printed as selectable text beside the QR code, because a phone whose camera cannot
 * read a screen (glare, a cracked lens, an older Android) still needs a way in, and reading twelve
 * characters off a screen is that way. It is in a monospace face for the same reason.
 */
export function PhoneUploadPanel({
  starting,
  url,
  qrDataUrl,
  receivedCount,
  error,
  onDone
}: {
  starting: boolean
  url: string | null
  qrDataUrl: string | null
  receivedCount: number
  error: string | null
  onDone: () => void
}): React.JSX.Element {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="phone-upload-heading"
      className="fixed inset-0 z-50 flex items-center justify-center bg-foreground/40 p-4"
    >
      <div className="flex w-full max-w-md flex-col gap-4 rounded-xl border border-border bg-card p-6 shadow-lg">
        <div className="flex flex-col gap-1">
          <h2
            id="phone-upload-heading"
            className="font-heading text-lg font-semibold text-card-foreground"
          >
            Add from phone
          </h2>
          <p className="font-sans text-sm text-muted-foreground">
            Point your phone camera at the code, then take a photo of the bill or pick files already
            on your phone. They land in your inbox here.
          </p>
        </div>

        {starting && (
          <p className="font-sans text-sm text-muted-foreground" aria-live="polite">
            Starting phone upload...
          </p>
        )}

        {error && (
          <p
            role="alert"
            className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 font-sans text-sm text-destructive"
          >
            {error}
          </p>
        )}

        {qrDataUrl && (
          <div className="flex justify-center rounded-lg border border-border bg-background p-3">
            {/* A self-contained data: URI, so the renderer fetches nothing to draw it. */}
            <img src={qrDataUrl} alt="Code to scan with your phone camera" className="size-56" />
          </div>
        )}

        {url && (
          <div className="flex flex-col gap-1">
            <p className="font-sans text-sm text-muted-foreground">
              Or type this into your phone browser:
            </p>
            <p className="font-mono text-sm break-all text-card-foreground select-all">{url}</p>
          </div>
        )}

        <p className="font-sans text-sm font-medium text-foreground" aria-live="polite">
          {phoneReceivedLine(receivedCount)}
        </p>

        <p className="font-sans text-sm text-muted-foreground">
          The first time you use this, Windows may ask whether to allow NicoleBooks on your network.
          Choose Allow, or your phone will not be able to reach this computer. Your phone and this
          computer need to be on the same Wi-Fi.
        </p>

        <div className="flex justify-end">
          <Button variant="default" onClick={onDone}>
            Done
          </Button>
        </div>
      </div>
    </div>
  )
}

/**
 * Which scanned files belong in the review table.
 *
 * Loaded files, plus any already-entered duplicate the user deliberately included. A
 * duplicate-in-batch file is NEVER here: it is a byte-identical copy of a file that is already in
 * the list, so a row for it would be a second row for the same document, and the whole-batch check
 * at send time would refuse both.
 *
 * Exported so the rule is pinned by a spec rather than by reading the JSX.
 */
export function reviewableFiles(
  result: ScanResult | null,
  includedOverrides: ReadonlySet<string>
): ScanFile[] {
  if (!result) return []
  return result.files.filter((file) => {
    if (file.status === 'loaded') return true
    return file.status === 'duplicate-excluded' && includedOverrides.has(fileKey(file))
  })
}

export function BillsScreen({
  onNavigate
}: {
  /** Lets the post-send strip point at the History screen, where the receipt lives. */
  onNavigate?: (destination: Destination) => void
} = {}): React.JSX.Element {
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
  // "Add files" (native picker) state.
  const [adding, setAdding] = useState(false)
  const [addNotice, setAddNotice] = useState<string | null>(null)
  // "Add from phone" state. The server itself lives in main; none of this is a path or a port.
  const [phoneOpen, setPhoneOpen] = useState(false)
  const [phoneStarting, setPhoneStarting] = useState(false)
  const [phoneUrl, setPhoneUrl] = useState<string | null>(null)
  const [phoneQr, setPhoneQr] = useState<string | null>(null)
  const [phoneError, setPhoneError] = useState<string | null>(null)
  const [phoneReceived, setPhoneReceived] = useState(0)
  // Lets the mount-once upload:received subscription call the CURRENT runScan. Subscribing with
  // runScan in the dependency list would tear down and re-add the listener on every render, and a
  // phone upload landing in that gap would be missed.
  const rescanRef = useRef<() => void>(() => {})

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

  // Keep the rescan hook pointing at the latest closure. Runs after every render, deliberately
  // without a dependency list.
  useEffect(() => {
    rescanRef.current = () => void runScan()
  })

  // The upload:received broadcast. Subscribed exactly like parse.onProgress, and exactly once: the
  // disposer means a remount cannot leave a second listener counting behind it. Each broadcast is
  // one completed phone request, so the rescan fires once per request, not once per file.
  useEffect(() => {
    return window.api.upload.onReceived((received) => {
      setPhoneReceived((count) => count + received.filenames.length)
      rescanRef.current()
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

  /**
   * "Add files": open the native picker in main, then rescan so the copies show up immediately.
   * The rescan is skipped when nothing was added, so a cancel costs nothing.
   */
  async function addFiles(): Promise<void> {
    setAdding(true)
    setAddNotice(null)
    try {
      const result = await window.api.ingestion.pickFiles()
      setAddNotice(addFilesNotice(result))
      if (result.added > 0) await runScan()
    } catch {
      setAddNotice('Could not add those files to your inbox. Please try again.')
    } finally {
      setAdding(false)
    }
  }

  /** Open the phone panel and start the LAN server. The count resets per session, like the QR. */
  async function openPhoneUpload(): Promise<void> {
    setPhoneOpen(true)
    setPhoneStarting(true)
    setPhoneError(null)
    setPhoneReceived(0)
    try {
      const started = await window.api.upload.start()
      setPhoneUrl(started.url)
      setPhoneQr(started.qrDataUrl)
    } catch {
      setPhoneError(
        'Could not start phone upload just now. Check that you are connected to a network, then try again.'
      )
    } finally {
      setPhoneStarting(false)
    }
  }

  /**
   * Close the panel and stop the server. The URL is the whole credential, so it stops existing the
   * moment the panel that shows it closes. A failed stop is swallowed on purpose: main also stops
   * the server on its idle timer and on app quit, so there is nothing useful to ask the user to do.
   */
  async function closePhoneUpload(): Promise<void> {
    setPhoneOpen(false)
    setPhoneUrl(null)
    setPhoneQr(null)
    setPhoneError(null)
    try {
      await window.api.upload.stop()
    } catch {
      /* the idle timer and the quit hook both close it too */
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

  // The same set, as the review table needs it. Memoized because it is the prop the table re-seeds
  // its rows from: a fresh array identity on every render would re-seed on every keystroke. The
  // user's edits would survive that (they are a separate overlay, keyed by file hash, which is the
  // whole point of the three-layer model), but re-running recon and the duplicate probes for every
  // character typed is real work for no change in what is on screen.
  const reviewFiles = useMemo(
    () => reviewableFiles(result, includedOverrides),
    [result, includedOverrides]
  )

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
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h2 className="font-sans text-sm font-semibold text-muted-foreground">Inbox</h2>
          <p className="font-mono text-sm text-muted-foreground">
            {inboxPath ?? 'Locating your inbox folder...'}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <AddFilesButton
            adding={adding}
            busy={scanning || parsing}
            onAdd={() => void addFiles()}
          />
          <AddFromPhoneButton
            busy={scanning || parsing || phoneOpen}
            onOpen={() => void openPhoneUpload()}
          />
          <ScanButton scanning={scanning} parsing={parsing} onScan={() => void runScan()} />
        </div>
      </div>

      {addNotice && (
        <p className="rounded-lg border border-border bg-card px-3 py-2 font-sans text-sm text-card-foreground">
          {addNotice}
        </p>
      )}

      {phoneOpen && (
        <PhoneUploadPanel
          starting={phoneStarting}
          url={phoneUrl}
          qrDataUrl={phoneQr}
          receivedCount={phoneReceived}
          error={phoneError}
          onDone={() => void closePhoneUpload()}
        />
      )}

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
          body="Use Add files to pick bills from this computer, or Add from phone to send a photo. You can also drop files straight into the inbox folder, then click Scan now."
        />
      )}

      {result && result.files.length === 0 && (
        <EmptyState
          icon={Receipt}
          heading="No files in your inbox yet"
          body="Use Add files to pick bills from this computer, or Add from phone to send a photo. You can also drop files straight into the inbox folder, then click Scan now."
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

          {/* THE REVIEW SURFACE (Phase 6). Everything the app guessed, beside a control that
              changes it, above one button that says exactly what it will do. It replaces the plain
              scan list for loaded documents rather than sitting under it: two lists of the same
              bills would be two places to look for the same fact.

              It is rendered WHILE A PARSE IS RUNNING too, with busy set, which is not cosmetic. A
              phone upload arriving mid-review fires a rescan and a re-parse; unmounting the table
              for the duration would throw away every correction the user had already made. Busy
              suppresses the "still needed" lines, because nothing is missing while the reading is
              still going on. */}
          {reviewFiles.length > 0 && (
            <ReviewTable
              files={reviewFiles}
              batchEntryDate={result.batchEntryDate}
              parseResults={parseResults}
              busy={parsing}
              retrying={retrying}
              onRetry={(fileHash) => {
                const file = reviewFiles.find((candidate) => candidate.hash === fileHash)
                if (file) void retryParse(file)
              }}
              onOpenHistory={onNavigate ? () => onNavigate('history') : undefined}
            />
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
