// src/renderer/src/review/ReviewTable.tsx
//
// Phase 6: the editable review surface (REVIEW-01 through REVIEW-09).
//
// This is the screen the product's trust rests on. Everything the app guessed is shown beside a
// control that changes it, nothing is sent until the user says so, and the button that sends says
// exactly what it will do before it does it.
//
// THE ONE LAYOUT RULE, and it is not decoration: every row prints WHAT THE DOCUMENT SAID above WHAT
// WILL BE SENT. Correcting a vendor must never hide the vendor that was read off the page, because
// the only way a non-technical user can audit a guess is by seeing both at once. That is why the
// parsed field list stays in the row after the editable controls arrive, rather than being replaced
// by them.
//
// DEGRADING WELL IS THE OTHER HALF. Three things this screen depends on can be absent, and none of
// them is an error wall:
//   * reconciliation rejected or has not landed -> every cell is manual selection, no marker
//   * QuickBooks is not connected                -> the pickers are empty and one sentence says why
//   * the duplicate check failed                 -> no warning chips, sending is unaffected
// A screen that refused to render because a suggestion service was down would be worse than one
// with no suggestions.
//
// The renderer performs zero fs, db, or network access: everything crosses the window.api bridge.
// All colors are semantic theme classes. No em dashes and no en dashes in any user-facing string.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { CheckCircle2, Send } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Combobox, type ComboboxOption } from '@/components/ui/combobox'
import { Separator } from '@/components/ui/separator'
import { formatCents } from '@/lib/money'
import { ParsedFieldList, flaggedFields } from './parsed-fields'
import {
  REF_NUMBER_MAX,
  amountFieldInvalid,
  applyMatches,
  attentionRows,
  batchSummaryLine,
  duplicateNoticeLine,
  duplicateProbes,
  includedRows,
  resolveRows,
  rowGap,
  seedRows,
  sendConfirmBody,
  sendGate,
  untickConfirmedRows,
  type ReviewEdit,
  type ReviewRow
} from './model'
import { sendReviewBatch } from './send'
import type {
  DuplicateWarning,
  FileMatch,
  MatchConfidence,
  ParseFileResult,
  PostingEntryState,
  PostingProgress,
  QboRefAccount,
  QboRefRecord,
  QboReference,
  ScanFile
} from '@shared/ipc-contract'

type BadgeVariant = 'default' | 'secondary' | 'outline' | 'destructive'

/** How long to sit still before asking main whether a row looks like a prior entry. */
const DUPLICATE_DEBOUNCE_MS = 400

/** The sentence shown when the pickers have nothing in them because QuickBooks is not connected. */
export const NO_REFERENCE_NOTICE =
  'Connect NicoleBooks to QuickBooks on the Settings screen, then sync, so vendors and categories can be picked here.'

/**
 * The marker beside a reconciled cell.
 *
 * 'auto' gets NOTHING, deliberately. A confident match that announces itself is asking the user to
 * check work that did not need checking, and a screen where everything is marked is a screen where
 * nothing is. The two tiers that do get a marker are the two where the user has a decision to make.
 */
export function matchMarkerText(confidence: MatchConfidence | null): string | null {
  if (confidence === 'suggested') return 'suggested match'
  if (confidence === 'none') return 'needs your pick'
  return null
}

export function MatchMarker({
  confidence
}: {
  confidence: MatchConfidence | null
}): React.JSX.Element | null {
  const text = matchMarkerText(confidence)
  if (text === null) return null
  return (
    <Badge variant={confidence === 'none' ? 'destructive' : 'secondary'}>{text}</Badge>
  )
}

/**
 * Bill or Expense, per row.
 *
 * Two buttons rather than a dropdown, because it is a binary with real accounting consequences and
 * both options should be readable without opening anything: a Bill is money owed later, an Expense
 * is money already gone. Choosing Expense reveals the account that paid it, which is the field
 * QuickBooks refuses a Purchase without.
 */
export function TypeToggle({
  value,
  disabled = false,
  onChange
}: {
  value: 'bill' | 'expense'
  disabled?: boolean
  onChange: (next: 'bill' | 'expense') => void
}): React.JSX.Element {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="font-sans text-xs font-medium text-muted-foreground">Type</span>
      <div role="group" aria-label="Bill or expense" className="flex gap-1">
        <Button
          variant={value === 'bill' ? 'default' : 'outline'}
          size="sm"
          disabled={disabled}
          aria-pressed={value === 'bill'}
          onClick={() => onChange('bill')}
        >
          Bill
        </Button>
        <Button
          variant={value === 'expense' ? 'default' : 'outline'}
          size="sm"
          disabled={disabled}
          aria-pressed={value === 'expense'}
          onClick={() => onChange('expense')}
        >
          Expense
        </Button>
      </div>
    </div>
  )
}

/** A labeled text input, styled once so every editable cell in the grid matches. */
export function FieldInput({
  label,
  value,
  onChange,
  type = 'text',
  placeholder,
  invalid = false,
  disabled = false,
  hint
}: {
  label: string
  value: string
  onChange: (next: string) => void
  type?: 'text' | 'date'
  placeholder?: string
  invalid?: boolean
  disabled?: boolean
  hint?: string
}): React.JSX.Element {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <label className="flex flex-col gap-1">
        <span className="font-sans text-xs font-medium text-muted-foreground">{label}</span>
        <input
          type={type}
          value={value}
          placeholder={placeholder}
          aria-invalid={invalid}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
          className={`h-8 w-full rounded-lg border bg-background px-2.5 font-sans text-sm text-foreground placeholder:text-muted-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50 ${
            invalid ? 'border-destructive' : 'border-border focus-visible:border-ring'
          }`}
        />
      </label>
      {hint && <span className="font-sans text-xs text-muted-foreground">{hint}</span>}
    </div>
  )
}

/**
 * The duplicate warning.
 *
 * It NEVER blocks. The user is the only one who knows whether a vendor billed twice, and a hard
 * stop here would either be wrong or would train them to work around it. What it does instead is
 * say when the earlier entry went in and let them open the details, so the claim is checkable.
 *
 * <details> rather than a hover card on purpose: hover is not a thing you can do on the way to
 * pressing Send with a mouse in one hand and a stack of paper in the other, and it leaves nothing
 * on screen to read twice.
 */
export function DuplicateNotice({
  warnings
}: {
  warnings: readonly DuplicateWarning[]
}): React.JSX.Element | null {
  const line = duplicateNoticeLine(warnings)
  if (line === null) return null
  return (
    <details className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2">
      <summary className="cursor-pointer font-sans text-sm text-destructive">
        {line} You can send it anyway.
      </summary>
      <ul className="mt-2 flex flex-col gap-1">
        {warnings.map((warning) => (
          <li key={`${warning.batchId}-${warning.fileHash}`} className="font-sans text-sm text-muted-foreground">
            {warning.vendorName ?? 'That vendor'}, {formatCents(warning.amountCents)}, dated{' '}
            {warning.txnDate}
            {warning.filename !== null ? `, from ${warning.filename}` : ''}
            {warning.qboId !== null ? `, in QuickBooks as ${warning.qboId}` : ''}
          </li>
        ))}
      </ul>
    </details>
  )
}

/** The per-row chip while a batch is in flight and after it settles. */
export function sendStateChip(state: PostingEntryState): { label: string; variant: BadgeVariant } {
  if (state === 'confirmed') return { label: 'Entered', variant: 'default' }
  if (state === 'failed') return { label: 'Did not go in', variant: 'destructive' }
  if (state === 'sent') return { label: 'Sending', variant: 'secondary' }
  return { label: 'Waiting', variant: 'secondary' }
}

/** One reviewable bill: what the document said, then what will be sent. */
export function ReviewRowCard({
  row,
  vendorOptions,
  categoryOptions,
  paymentOptions,
  warnings,
  sendState,
  sendError,
  retrying = false,
  busy = false,
  onRetry,
  onEdit
}: {
  row: ReviewRow
  vendorOptions: readonly ComboboxOption[]
  categoryOptions: readonly ComboboxOption[]
  paymentOptions: readonly ComboboxOption[]
  warnings: readonly DuplicateWarning[]
  sendState?: PostingEntryState
  sendError?: string | null
  retrying?: boolean
  /** The batch is still being read. Nothing is missing yet, so nothing is reported missing. */
  busy?: boolean
  onRetry?: () => void
  onEdit: (patch: ReviewEdit) => void
}): React.JSX.Element {
  const flags = flaggedFields(row.parse)
  // While the model is still reading, every row is legitimately empty. Telling the user that each
  // one needs a vendor, a category and an amount would be a wall of red about work in progress.
  const gap = row.included && !busy ? rowGap(row) : null
  const chip = sendState ? sendStateChip(sendState) : null
  const failed = row.parse?.status === 'parse-failed'

  /**
   * Once this row has been handed to QuickBooks, its fields stop being editable.
   *
   * What was SENT is a snapshot taken at the moment of the send, so editing afterwards cannot
   * change what went. It can do something worse: leave the row showing $50.00 beside an "Entered"
   * chip, when $1,336.00 is what is actually in the books. On a screen whose entire purpose is that
   * the user can check what happened, the display drifting from the payload is the one failure that
   * costs more than the edit was worth. Corrections after the fact belong in QuickBooks, or behind
   * the undo on the History screen.
   */
  const locked = sendState !== undefined

  return (
    <li className="flex flex-col gap-3 rounded-xl border border-border bg-card p-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <label className="flex min-w-0 items-center gap-2">
          <input
            type="checkbox"
            checked={row.included}
            disabled={locked}
            onChange={(event) => onEdit({ included: event.target.checked })}
            className="size-4 accent-primary disabled:cursor-not-allowed disabled:opacity-50"
          />
          <span className="font-mono text-sm text-card-foreground">{row.filename}</span>
        </label>
        <div className="flex shrink-0 items-center gap-2">
          {row.scanStatus === 'duplicate-excluded' && (
            <Badge variant="destructive">Already entered before</Badge>
          )}
          {failed && <Badge variant="destructive">Could not read</Badge>}
          {!failed && flags.size > 0 && <Badge variant="destructive">Needs review</Badge>}
          {chip && <Badge variant={chip.variant}>{chip.label}</Badge>}
          {/* D-15's "retry just the failed ones", kept on the row it belongs to now that the
              review row has replaced the plain scan row for loaded documents. */}
          {failed && onRetry && (
            <Button variant="ghost" size="sm" disabled={retrying} onClick={onRetry}>
              {retrying ? 'Retrying...' : 'Retry'}
            </Button>
          )}
        </div>
      </div>

      {/* WHAT THE DOCUMENT SAID. Stays visible above the controls so a correction never hides the
          claim it corrected. */}
      {row.parsed && <ParsedFieldList fields={row.parsed} flags={flags} />}
      {failed && (
        <p className="font-sans text-sm text-destructive">
          {row.parse?.error ??
            'This document could not be read. Fill it in yourself, or leave it out.'}
        </p>
      )}

      <Separator />

      {/* WHAT WILL BE SENT. */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <TypeToggle
          value={row.entryType}
          disabled={locked}
          onChange={(entryType) => onEdit({ entryType })}
        />
        <Combobox
          label="Vendor"
          value={row.vendorId}
          options={vendorOptions}
          priorityIds={row.vendorCandidates.map((candidate) => candidate.id)}
          marker={<MatchMarker confidence={row.vendorConfidence} />}
          disabled={locked}
          onChange={(vendorId) => onEdit({ vendorId })}
        />
        <Combobox
          label="Category"
          value={row.categoryAccountId}
          options={categoryOptions}
          priorityIds={row.categoryCandidates.map((candidate) => candidate.id)}
          marker={<MatchMarker confidence={row.categoryConfidence} />}
          disabled={locked}
          onChange={(categoryAccountId) => onEdit({ categoryAccountId })}
        />
        {/* Revealed by Expense, hidden and cleared by Bill: a Purchase must name what paid it, and
            a Bill that named one would be refused by the whole-batch check at send time. */}
        {row.entryType === 'expense' && (
          <Combobox
            label="Paid from"
            value={row.paidFromAccountId}
            options={paymentOptions}
            placeholder="Bank or credit card"
            disabled={locked}
            onChange={(paidFromAccountId) => onEdit({ paidFromAccountId })}
          />
        )}
        <FieldInput
          label="Amount"
          value={row.amountText}
          placeholder="1336.00"
          // Covers both "that is not money" and "that is money QuickBooks will not take", so the
          // flagged $0.00 an unreadable total leaves behind is marked, not quietly accepted.
          invalid={amountFieldInvalid(row)}
          disabled={locked}
          onChange={(amountText) => onEdit({ amountText })}
        />
        <FieldInput
          label="Entry date"
          type="date"
          value={row.txnDate}
          disabled={locked}
          onChange={(txnDate) => onEdit({ txnDate })}
        />
        {row.entryType === 'bill' && (
          <FieldInput
            label="Due date"
            type="date"
            value={row.dueDate}
            disabled={locked}
            onChange={(dueDate) => onEdit({ dueDate })}
          />
        )}
        <FieldInput
          label="Reference number"
          value={row.refNumber}
          invalid={row.refNumber.length > REF_NUMBER_MAX}
          disabled={locked}
          onChange={(refNumber) => onEdit({ refNumber })}
        />
      </div>

      <DuplicateNotice warnings={warnings} />

      {gap && <p className="font-sans text-sm text-destructive">Still needed: {gap}.</p>}
      {sendError && <p className="font-sans text-sm text-destructive">{sendError}</p>}
    </li>
  )
}

/**
 * The footer: what is selected, what it comes to, and the one button that sends it.
 *
 * The disabled reason is printed rather than hidden in a tooltip. A disabled button with no
 * explanation is the single most common way a screen makes a user feel stupid, and the reason here
 * is always something they can fix in one click.
 */
export const STILL_READING = 'Still reading your bills. This will be ready in a moment.'

export function ReviewFooter({
  rows,
  sending,
  busy = false,
  onSend
}: {
  rows: readonly ReviewRow[]
  sending: boolean
  /** The batch is still being read, so there is nothing complete to send yet. */
  busy?: boolean
  onSend: () => void
}): React.JSX.Element {
  const gate = busy ? { canSend: false, reason: STILL_READING } : sendGate(rows)
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-card p-3">
      <div className="flex min-w-0 flex-col gap-0.5">
        <p className="font-sans text-sm font-medium text-card-foreground">
          {batchSummaryLine(rows)}
        </p>
        {gate.reason && <p className="font-sans text-sm text-muted-foreground">{gate.reason}</p>}
      </div>
      <Button variant="default" disabled={!gate.canSend || sending} onClick={onSend}>
        <Send aria-hidden="true" />
        {sending ? 'Sending...' : 'Send to QuickBooks'}
      </Button>
    </div>
  )
}

/**
 * The confirmation, which states exactly what will happen before anything leaves the app.
 *
 * Sending to somebody's books is not undoable in one step from here (undo lives on the History
 * screen and refuses anything already worked on), so the last thing between the user and their
 * accounts spells out the count and the split rather than asking "are you sure".
 */
export function SendConfirm({
  rows,
  busy,
  onConfirm,
  onCancel
}: {
  rows: readonly ReviewRow[]
  busy: boolean
  onConfirm: () => void
  onCancel: () => void
}): React.JSX.Element {
  return (
    <div
      role="group"
      aria-label="Confirm send"
      className="flex flex-col gap-3 rounded-xl border border-primary/30 bg-muted p-4"
    >
      <p className="font-sans text-sm font-semibold text-foreground">Send these to QuickBooks?</p>
      <p className="font-sans text-sm text-muted-foreground">{sendConfirmBody(rows)}</p>
      <p className="font-sans text-sm text-muted-foreground">
        You can reverse the whole batch afterwards on the History screen, as long as nothing has been
        changed or paid in QuickBooks since.
      </p>
      <div className="flex gap-2">
        <Button variant="default" disabled={busy} onClick={onConfirm}>
          {busy ? 'Sending...' : 'Yes, send them'}
        </Button>
        <Button variant="ghost" disabled={busy} onClick={onCancel}>
          Not yet
        </Button>
      </div>
    </div>
  )
}

/** The live "sending N of M" line, fed by the posting:progress broadcast. */
export function sendProgressLine(progress: PostingProgress | null): string {
  if (progress === null) return 'Sending to QuickBooks...'
  return `Sending to QuickBooks: ${progress.done} of ${progress.total} done...`
}

/** What the strip says once a batch settles. Counts only, no cheerfulness about failures. */
export function completionLine(states: Readonly<Record<string, PostingEntryState>>): string {
  const values = Object.values(states)
  const entered = values.filter((state) => state === 'confirmed').length
  const failed = values.filter((state) => state === 'failed').length
  const base = `${entered} of ${values.length} entered in QuickBooks.`
  return failed === 0 ? base : `${base} ${failed} did not go in, and can be sent again.`
}

/** The strip shown after a batch settles, with the way to the receipt. */
export function CompletionStrip({
  states,
  onOpenHistory
}: {
  states: Readonly<Record<string, PostingEntryState>>
  onOpenHistory?: () => void
}): React.JSX.Element {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-card p-3">
      <p className="flex items-center gap-2 font-sans text-sm font-medium text-card-foreground">
        <CheckCircle2 aria-hidden="true" className="size-4" />
        {completionLine(states)}
      </p>
      {onOpenHistory && (
        <Button variant="outline" onClick={onOpenHistory}>
          Open History for the receipt
        </Button>
      )}
    </div>
  )
}

/** Active records plus, defensively, whichever record is currently selected. */
function toOptions(
  records: readonly QboRefRecord[],
  selectedIds: ReadonlySet<string>,
  hint?: (record: QboRefRecord) => string | undefined
): ComboboxOption[] {
  return records
    .filter((record) => record.active || selectedIds.has(record.id))
    .map((record) => ({ id: record.id, label: record.name, hint: hint?.(record) }))
}

/** The account's kind, as a quiet second line under its name. */
function accountHint(record: QboRefRecord): string | undefined {
  const account = record as QboRefAccount
  return account.accountSubType ?? account.accountType
}

/**
 * The whole review surface.
 *
 * State lives here rather than on the Bills screen because it is all one concern (what will be
 * sent) and none of it outlives the batch. The Bills screen keeps owning the scan and the parse and
 * hands this component the files; a fresh scan produces new props, and the edits keyed by file hash
 * fall away with the rows they belonged to.
 */
export function ReviewTable({
  files,
  batchEntryDate,
  parseResults,
  busy = false,
  retrying,
  onRetry,
  onOpenHistory
}: {
  files: readonly ScanFile[]
  batchEntryDate: string
  parseResults: Readonly<Record<string, ParseFileResult>>
  /**
   * A parse batch is running, so the fields are not filled in yet.
   *
   * This component stays MOUNTED while that is true, which is the whole reason the flag exists. A
   * phone upload arriving mid-review triggers a rescan and a re-parse, and unmounting here would
   * throw away every correction the user had already made. The edits are keyed by file hash and
   * survive the re-seed; they cannot survive an unmount.
   */
  busy?: boolean
  /** File hashes with a re-parse in flight, so the row's Retry control can say so. */
  retrying?: ReadonlySet<string>
  onRetry?: (fileHash: string) => void
  onOpenHistory?: () => void
}): React.JSX.Element {
  const [edits, setEdits] = useState<Record<string, ReviewEdit>>({})
  const [matches, setMatches] = useState<Record<string, FileMatch>>({})
  const [duplicates, setDuplicates] = useState<Record<string, DuplicateWarning[]>>({})
  const [reference, setReference] = useState<QboReference | null>(null)
  const [attentionOnly, setAttentionOnly] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [sending, setSending] = useState(false)
  const [progress, setProgress] = useState<PostingProgress | null>(null)
  const [sendStates, setSendStates] = useState<Record<string, PostingEntryState>>({})
  const [sendErrors, setSendErrors] = useState<Record<string, string | null>>({})
  const [settled, setSettled] = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)
  // The batch this component is watching, and whether it is watching at all. Refs because the
  // progress subscription is mounted once and must see the CURRENT values, not a render-scoped
  // snapshot.
  //
  // Two refs rather than one, because of a real ordering race: the main handler persists the batch
  // and returns the id, but the sends run behind it, so the first posting:progress events can
  // arrive BEFORE the send promise resolves and batchRef is set. Gating on the batch id alone would
  // drop those events and the first rows would sit on "Waiting" until the batch finished. Gating on
  // "are we sending" instead catches them from the first one, and the id filter then only has to
  // reject a batch that is definitely somebody else's.
  const batchRef = useRef<string | null>(null)
  const sendingRef = useRef(false)
  // The same per-row states the render reads, mirrored so the subscription can act on them without
  // doing work inside a setState updater (React may run an updater twice, and "untick this row"
  // does not belong in something that can be replayed).
  const sendStatesRef = useRef<Record<string, PostingEntryState>>({})

  const seeds = useMemo(
    () => applyMatches(seedRows(files, batchEntryDate, parseResults), matches),
    [files, batchEntryDate, parseResults, matches]
  )
  const rows = useMemo(() => resolveRows(seeds, edits), [seeds, edits])

  const hashes = useMemo(() => seeds.map((seed) => seed.fileHash), [seeds])
  const hashKey = hashes.join(',')

  const editRow = useCallback((fileHash: string, patch: ReviewEdit): void => {
    setEdits((prev) => ({ ...prev, [fileHash]: { ...prev[fileHash], ...patch } }))
  }, [])

  /** Untick every row QuickBooks confirmed, so a second Send can only re-send the failures. */
  const untickConfirmed = useCallback((states: Readonly<Record<string, PostingEntryState>>): void => {
    setEdits((prev) => untickConfirmedRows(prev, states))
  }, [])

  // The QuickBooks reference lists. A rejection is NOT an error wall: it means the app is not
  // connected yet, which is a sentence, not a failure.
  useEffect(() => {
    let cancelled = false
    async function load(): Promise<void> {
      try {
        const next = await window.api.qbo.getReference()
        if (!cancelled) setReference(next)
      } catch {
        if (!cancelled) setReference(null)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [])

  // Reconciliation, once per set of documents, and never while a parse is still running: recon
  // reads the parsed vendor and category text from the main-side cache, so asking before the parse
  // has written it would spend a round trip to be told 'none' about every row.
  //
  // A rejection leaves `matches` empty, which is exactly the manual-selection state, so there is
  // nothing to report and nothing to recover from.
  useEffect(() => {
    if (busy || hashKey === '') return
    let cancelled = false
    async function match(): Promise<void> {
      try {
        const result = await window.api.recon.match(hashKey.split(','))
        if (!cancelled) setMatches(result.matches)
      } catch {
        if (!cancelled) setMatches({})
      }
    }
    void match()
    return () => {
      cancelled = true
    }
  }, [busy, hashKey])

  // The duplicate check, debounced, because it re-runs while the user types an amount. Probes are
  // serialized into the dependency so an edit that does not change the three probed fields (a memo,
  // a reference number, a tick) does not re-ask.
  const probes = useMemo(() => duplicateProbes(rows), [rows])
  const probeKey = JSON.stringify(probes)
  useEffect(() => {
    const parsed = JSON.parse(probeKey) as ReturnType<typeof duplicateProbes>
    if (parsed.length === 0) {
      setDuplicates({})
      return
    }
    let cancelled = false
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const result = await window.api.posting.checkDuplicates(parsed)
          if (!cancelled) setDuplicates(result.warnings)
        } catch {
          // No warning is a safe degradation: the send itself is unaffected, and a red bar about a
          // failed advisory check would be louder than the advice it failed to give.
          if (!cancelled) setDuplicates({})
        }
      })()
    }, DUPLICATE_DEBOUNCE_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [probeKey])

  // The posting:progress broadcast. The FINAL event is done === total with current null, which is
  // when the authoritative per-entry outcomes are read back through posting:batch-detail: the
  // progress stream reports what was attempted, batch-detail reports what QuickBooks confirmed.
  useEffect(() => {
    return window.api.posting.onProgress((next) => {
      if (!sendingRef.current) return
      if (batchRef.current !== null && next.batchId !== batchRef.current) return
      setProgress(next)
      if (next.current !== null) {
        const { fileHash, state } = next.current
        sendStatesRef.current = { ...sendStatesRef.current, [fileHash]: state }
        setSendStates(sendStatesRef.current)
        return
      }
      if (next.done < next.total) return
      const batchId = batchRef.current
      sendingRef.current = false
      setSending(false)
      setSettled(true)
      // A row that is now IN QuickBooks unticks itself. What is left ticked is exactly what did not
      // go in, so pressing Send again re-sends the failures and nothing else. Leaving them ticked
      // would offer a second send of entries that already exist; main's ledger guard would refuse
      // each one, but the honest place to prevent it is the box the user is looking at.
      untickConfirmed(sendStatesRef.current)
      if (batchId === null) return
      void (async () => {
        try {
          const detail = await window.api.posting.batchDetail(batchId)
          const states: Record<string, PostingEntryState> = {}
          const errors: Record<string, string | null> = {}
          for (const entry of detail.entries) {
            states[entry.fileHash] = entry.state
            errors[entry.fileHash] = entry.error
          }
          sendStatesRef.current = states
          setSendStates(states)
          setSendErrors(errors)
          // Again, from the authoritative read: the stream reports what was ATTEMPTED, batch-detail
          // reports what QuickBooks CONFIRMED, and only the second is allowed to untick a row.
          untickConfirmed(states)
        } catch {
          // The states streamed on the broadcast are already on screen; failing to refine them is
          // not worth an error the user cannot act on.
        }
      })()
    })
  }, [untickConfirmed])

  async function runSend(): Promise<void> {
    // Set BEFORE the await: the first progress events can beat the send promise back.
    sendingRef.current = true
    batchRef.current = null
    sendStatesRef.current = {}
    setSending(true)
    setSendError(null)
    setSettled(false)
    setSendErrors({})
    setSendStates({})

    // Main already mapped every failure to a recoverable sentence (including the not-connected one,
    // which names the Settings screen). sendReviewBatch forwards it VERBATIM rather than inventing
    // a second wording for a condition main understands better than this component does.
    const outcome = await sendReviewBatch(rows, (payload) => window.api.posting.send(payload))
    if (!outcome.ok) {
      sendingRef.current = false
      setSendError(outcome.error)
      setSending(false)
      return
    }
    batchRef.current = outcome.batchId
    // Seed every row that actually went as Waiting, WITHOUT overwriting a state the broadcast has
    // already reported for it (the race above means some rows may already read Sending or Entered).
    const seeded = { ...sendStatesRef.current }
    for (const sent of outcome.sent) seeded[sent.fileHash] ??= 'pending'
    sendStatesRef.current = seeded
    setSendStates(seeded)
    setConfirming(false)
  }

  const vendorSelections = new Set(
    rows.map((row) => row.vendorId).filter((id): id is string => id !== null)
  )
  const categorySelections = new Set(
    rows.map((row) => row.categoryAccountId).filter((id): id is string => id !== null)
  )
  const paymentSelections = new Set(
    rows.map((row) => row.paidFromAccountId).filter((id): id is string => id !== null)
  )

  const vendorOptions = toOptions(reference?.vendors ?? [], vendorSelections)
  const categoryOptions = toOptions(reference?.expenseAccounts ?? [], categorySelections, accountHint)
  const paymentOptions = toOptions(reference?.paymentAccounts ?? [], paymentSelections, accountHint)

  const attention = attentionRows(rows, duplicates, busy)
  const visibleRows = attentionOnly ? attention : rows

  if (rows.length === 0) {
    return (
      <p className="font-sans text-sm text-muted-foreground">
        Nothing to review yet. Scan or add bills above, and they will appear here ready to check.
      </p>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-sans text-sm font-semibold text-muted-foreground">
          Review before sending
        </h2>
        <Button
          variant={attentionOnly ? 'default' : 'outline'}
          size="sm"
          aria-pressed={attentionOnly}
          onClick={() => setAttentionOnly((on) => !on)}
        >
          {attentionOnly ? 'Show all bills' : `Show what needs me (${attention.length})`}
        </Button>
      </div>

      {reference === null && (
        <p className="rounded-lg border border-border bg-card px-3 py-2 font-sans text-sm text-muted-foreground">
          {NO_REFERENCE_NOTICE}
        </p>
      )}

      {sendError && (
        <p
          role="alert"
          className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 font-sans text-sm text-destructive"
        >
          {sendError}
        </p>
      )}

      {sending && (
        <p className="font-sans text-sm text-muted-foreground" aria-live="polite">
          {sendProgressLine(progress)}
        </p>
      )}

      {settled && <CompletionStrip states={sendStates} onOpenHistory={onOpenHistory} />}

      {attentionOnly && visibleRows.length === 0 && (
        <p className="font-sans text-sm text-muted-foreground">
          Nothing needs you. Every bill has a vendor, a category, an amount, and a date.
        </p>
      )}

      <ul className="flex flex-col gap-3">
        {visibleRows.map((row) => (
          <ReviewRowCard
            key={row.fileHash}
            row={row}
            vendorOptions={vendorOptions}
            categoryOptions={categoryOptions}
            paymentOptions={paymentOptions}
            warnings={duplicates[row.fileHash] ?? []}
            sendState={sendStates[row.fileHash]}
            sendError={sendErrors[row.fileHash] ?? null}
            busy={busy}
            retrying={retrying?.has(row.fileHash) ?? false}
            onRetry={onRetry ? () => onRetry(row.fileHash) : undefined}
            onEdit={(patch) => editRow(row.fileHash, patch)}
          />
        ))}
      </ul>

      {confirming ? (
        <SendConfirm
          rows={includedRows(rows)}
          busy={sending}
          onConfirm={() => void runSend()}
          onCancel={() => setConfirming(false)}
        />
      ) : (
        <ReviewFooter
          rows={rows}
          sending={sending}
          busy={busy}
          onSend={() => setConfirming(true)}
        />
      )}
    </div>
  )
}
