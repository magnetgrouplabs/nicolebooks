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

import { CheckCircle2, ChevronRight, Plus, Send } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Combobox, type ComboboxOption } from '@/components/ui/combobox'
import { Dialog, DialogBackdrop, DialogPopup, DialogPortal } from '@/components/ui/dialog'
import { ipcErrorMessage } from '@/lib/ipc-error'
import { cn } from '@/lib/utils'
import { formatCents } from '@/lib/money'
import { ParsedFieldList, flaggedFields } from './parsed-fields'
import {
  REF_NUMBER_MAX,
  VENDOR_NAME_MAX,
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

/** What the "Add new vendor" panel says it is for. */
export const ADD_VENDOR_HINT =
  'No vendor is picked for this bill. Choose one above, or add this supplier to QuickBooks.'

/**
 * Should this row offer to create a vendor?
 *
 * Exactly when it has no vendor selected. That covers both ways a row gets there: reconciliation
 * came back 'none' because nothing in the company looked like the printed name, or the user cleared
 * a suggestion they disagreed with. It is deliberately NOT offered on a row that already has a
 * vendor, because the answer there is to change the selection, not to create a second record with
 * a similar name.
 *
 * A locked row (already handed to QuickBooks) never offers it: nothing about that row is editable
 * any more, so creating a vendor for it would change nothing and imply otherwise.
 */
export function canOfferVendorCreate(row: ReviewRow, locked = false): boolean {
  if (locked) return false
  return row.vendorId === null || row.vendorId === ''
}

/**
 * What the create field starts as: the name the PARSER read off the document.
 *
 * Prefilled rather than blank because the document is the reason this panel is open, and retyping a
 * supplier name off a receipt is exactly the manual work this app exists to remove. It stays fully
 * editable, because the printed name is often not the name the books should carry ("QUALITY CRAFT
 * TOOLS" on a receipt, "Quality Craft Tools LLC" in the ledger).
 */
export function vendorCreatePrefill(row: ReviewRow): string {
  return row.parsed?.vendor?.trim() ?? ''
}

/**
 * Splice a newly created vendor into the cached reference set, in the same order a re-read returns.
 *
 * Done locally as well as re-reading from main, because the option has to exist in the dropdown by
 * the time the row's selection changes to it. Selecting an id with no matching option would leave
 * the combobox showing an empty field over a row that is, in fact, complete.
 *
 * Sorted case-insensitively by name, which is what the cache's own read does (ORDER BY name COLLATE
 * NOCASE), so the local splice and the authoritative re-read cannot disagree about position.
 */
export function withCreatedVendor(
  reference: QboReference | null,
  record: QboRefRecord
): QboReference {
  const base: QboReference = reference ?? {
    vendors: [],
    expenseAccounts: [],
    paymentAccounts: [],
    items: [],
    syncedAt: null
  }
  const vendors = base.vendors.filter((vendor) => vendor.id !== record.id)
  vendors.push(record)
  vendors.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
  return { ...base, vendors }
}

/** Shown only when a rejection carried no message at all, which main's mapping makes unlikely. */
export const VENDOR_CREATE_FALLBACK =
  'Could not add that vendor to QuickBooks just now. Try again.'

/** Everything runVendorCreate touches outside itself, injected so the ORDER can be asserted. */
export interface VendorCreateIo {
  createVendor: (displayName: string) => Promise<QboRefRecord>
  getReference: () => Promise<QboReference>
  setReference: (next: QboReference) => void
  select: (vendorId: string) => void
  fail: (message: string) => void
}

/**
 * Create one vendor and leave the row pointing at it.
 *
 * THE ORDER IS THE WHOLE FUNCTION, and it is why this is not inline in a click handler:
 *
 *   1. create           the only network call, and the only thing that can fail meaningfully.
 *   2. splice locally   so the option EXISTS before anything selects it. Selecting an id with no
 *                       matching option leaves the combobox blank over a row that is complete,
 *                       which reads as the click having done nothing.
 *   3. select           the row now has its vendor.
 *   4. re-read main     the authoritative list, which also picks up anything else that changed.
 *                       A failure here is swallowed: the vendor exists, the row is set, and the
 *                       next sync confirms it. There is nothing for the user to do about it.
 *
 * A refused create surfaces main's OWN sentence verbatim. Main knows a duplicate name means "pick
 * the existing one" and says so; rewording it here would produce two vocabularies for one failure.
 */
export async function runVendorCreate(
  displayName: string,
  current: QboReference | null,
  io: VendorCreateIo
): Promise<void> {
  let record: QboRefRecord
  try {
    record = await io.createVendor(displayName)
  } catch (err) {
    // Unwrapped: Electron rejects an invoke with its own error, whose message puts the channel name
    // and the word Error in front of the sentence main mapped.
    const message = ipcErrorMessage(err)
    io.fail(message === '' ? VENDOR_CREATE_FALLBACK : message)
    return
  }

  io.setReference(withCreatedVendor(current, record))
  io.select(record.id)

  try {
    io.setReference(await io.getReference())
  } catch {
    /* the local splice already holds the new vendor */
  }
}

/**
 * The "Add new vendor" panel, shown under the vendor picker on a row with nothing selected.
 *
 * TWO DELIBERATE CHOICES, both about not creating records by accident:
 *
 *   1. IT IS A BUTTON, NOT A SIDE EFFECT. Nothing is created by typing, by blurring the field, or
 *      by reconciliation deciding it found nothing (RECON-03). One click, on a control that says
 *      what it does, is the only path.
 *
 *   2. THE FIELD IS EDITABLE. The prefill is what the document printed, which is frequently not
 *      what the vendor should be called in the books. Locking it to the parsed text would mint
 *      shouty receipt headers as permanent QuickBooks records.
 */
export function AddVendorPanel({
  suggestedName,
  busy = false,
  error = null,
  onCreate
}: {
  suggestedName: string
  busy?: boolean
  error?: string | null
  onCreate: (displayName: string) => void
}): React.JSX.Element {
  const [name, setName] = useState(suggestedName)
  const trimmed = name.trim()

  return (
    /*
      A DASHED well, not another filled panel. It sat in a solid muted box that looked exactly like
      the field grid above it, so the one control on this screen that writes a permanent record into
      somebody's QuickBooks read as a seventh form field. A dashed edge is the long-standing
      convention for "this creates something that does not exist yet", and the Plus on the button
      says the same thing a second time.
    */
    <div className="flex flex-col gap-2 rounded-md border border-dashed border-border bg-muted/40 px-3 py-3">
      <p className="font-sans text-sm text-muted-foreground">{ADD_VENDOR_HINT}</p>
      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-0 flex-1">
          <FieldInput
            label="Add new vendor"
            value={name}
            placeholder="Vendor name as it should appear in QuickBooks"
            disabled={busy}
            invalid={trimmed.length > VENDOR_NAME_MAX}
            onChange={setName}
          />
        </div>
        <Button
          variant="outline"
          size="sm"
          className="h-9"
          disabled={busy || trimmed === '' || trimmed.length > VENDOR_NAME_MAX}
          onClick={() => onCreate(trimmed)}
        >
          <Plus aria-hidden="true" />
          {busy ? 'Adding...' : 'Add to QuickBooks'}
        </Button>
      </div>
      {trimmed.length > VENDOR_NAME_MAX && (
        <p className="font-sans text-sm text-destructive">
          Shorten this name to {VENDOR_NAME_MAX} characters or fewer.
        </p>
      )}
      {error && (
        <p role="alert" className="font-sans text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  )
}

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

/**
 * THE MARKER IS NOT AN ERROR, and it used to look exactly like one.
 *
 * 'needs your pick' rendered destructive, which is the same red the app uses for a document it
 * could not read and an entry QuickBooks refused. On a fresh batch reconciliation returns 'none'
 * for most cells, so the live drill screenshotted nine bills wearing eighteen red chips before the
 * user had done anything wrong. A screen that is red by default has spent its red: the one row
 * that genuinely failed no longer stands out from the eight that are simply waiting.
 *
 * It is now the warning tier, which is what the state actually is: a request, addressed to the
 * person reading it, on a screen whose whole job is collecting those answers.
 */
export function MatchMarker({
  confidence
}: {
  confidence: MatchConfidence | null
}): React.JSX.Element | null {
  const text = matchMarkerText(confidence)
  if (text === null) return null
  return <Badge variant={confidence === 'none' ? 'warning' : 'outline'}>{text}</Badge>
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
    <div className="flex min-w-0 flex-col gap-1.5">
      <span className="font-sans text-xs font-medium text-muted-foreground tracking-[0.06em] uppercase">
        Type
      </span>
      {/*
        A real segmented control: one recessed track holding two halves, so the pair reads as one
        two-state control rather than as two buttons that happen to sit together. The chosen half
        lifts to the card surface, which is the same "selected sits forward" language the sidebar
        uses. It was a solid crimson button beside an outlined one, which spent the brand colour on
        a field-level choice and made every row carry a crimson slab.
      */}
      <div
        role="group"
        aria-label="Bill or expense"
        className="inline-flex h-9 w-fit items-center gap-0.5 rounded-md bg-muted p-0.5"
      >
        {(['bill', 'expense'] as const).map((option) => (
          <Button
            key={option}
            variant="ghost"
            size="sm"
            disabled={disabled}
            aria-pressed={value === option}
            onClick={() => onChange(option)}
            className={cn(
              'h-8 px-3 font-medium',
              value === option
                ? 'bg-card text-foreground shadow-raised hover:bg-card'
                : 'text-muted-foreground hover:bg-transparent hover:text-foreground'
            )}
          >
            {option === 'bill' ? 'Bill' : 'Expense'}
          </Button>
        ))}
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
  figure = false,
  hint
}: {
  label: string
  value: string
  onChange: (next: string) => void
  type?: 'text' | 'date'
  placeholder?: string
  invalid?: boolean
  disabled?: boolean
  /** The value is a figure (money, an id) rather than a phrase, so it is set in the mono face. */
  figure?: boolean
  hint?: string
}): React.JSX.Element {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <label className="flex flex-col gap-1.5">
        <span className="font-sans text-xs font-medium text-muted-foreground tracking-[0.06em] uppercase">
          {label}
        </span>
        <input
          type={type}
          value={value}
          placeholder={placeholder}
          aria-invalid={invalid}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
          className={cn(
            // 36px tall, matching the comboboxes and the segmented control beside it, on the
            // control rung of the radius ladder. Money and dates are figures, so they are set in
            // the mono face: a column of amounts that does not line up is a column nobody checks.
            'h-9 w-full rounded-md border bg-background px-3 font-sans text-sm text-foreground',
            'transition-[border-color,box-shadow] duration-150 ease-standard',
            'placeholder:text-muted-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none',
            'disabled:cursor-not-allowed disabled:opacity-50',
            (figure || type === 'date') && 'font-mono',
            invalid ? 'border-destructive' : 'border-border focus-visible:border-ring'
          )}
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
    /*
      Warning tier, not destructive, and a real disclosure control rather than a bare <details>.

      It was a red panel whose only affordance was the browser's default triangle, which reads as
      an error the user has to clear. It is not one: the notice says so itself ("You can send it
      anyway"), and its own copy is an offer to check rather than a refusal. The chevron replaces
      the default marker so the row plainly looks openable, and it turns when it is open.
    */
    <details className="group/dupe rounded-md border border-warning/30 bg-warning/12 px-3 py-2 [&_summary::-webkit-details-marker]:hidden">
      <summary className="flex cursor-pointer list-none items-start gap-2 font-sans text-sm text-warning-foreground">
        <ChevronRight
          aria-hidden="true"
          className="mt-0.5 size-3.5 shrink-0 transition-transform duration-150 ease-standard group-open/dupe:rotate-90"
        />
        <span>{line} You can send it anyway.</span>
      </summary>
      <ul className="mt-2 flex flex-col gap-1 pl-5.5">
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
  creatingVendor = false,
  createVendorError = null,
  onCreateVendor,
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
  /** A vendor create for THIS row is in flight. */
  creatingVendor?: boolean
  /** The mapped sentence from a refused create, most often the duplicate-name one. */
  createVendorError?: string | null
  onCreateVendor?: (displayName: string) => void
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
    /*
      THE ROW'S ARGUMENT, MADE VISUALLY.

      A row states two different kinds of thing and used to state them in one undifferentiated
      stack: parsed values, a hairline rule, editable controls, all on one flat card at one type
      size. The rule carried the entire distinction, and in dark mode the rule was very nearly
      invisible. So the screen's central claim, "here is what the document said, and separately,
      here is what will be sent", was left for the user to infer.

      Now the evidence is QUOTED. What the document said sits on a recessed slab with a rule down
      its left edge, which is the same device prose uses for a block quotation, and it reads as
      something transcribed rather than something typed. What will be sent sits forward on the card
      itself, in live controls at full contrast. Two surfaces, two jobs, no caption needed.
    */
    <li className="flex flex-col gap-4 rounded-lg border border-border bg-card p-4 shadow-raised">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <label className="flex min-w-0 cursor-pointer items-center gap-2.5">
          <input
            type="checkbox"
            checked={row.included}
            disabled={locked}
            onChange={(event) => onEdit({ included: event.target.checked })}
            className="size-4 cursor-pointer accent-primary disabled:cursor-not-allowed disabled:opacity-50"
          />
          <span className="truncate font-mono text-sm font-medium text-card-foreground">
            {row.filename}
          </span>
        </label>
        <div className="flex shrink-0 items-center gap-2">
          {row.scanStatus === 'duplicate-excluded' && (
            <Badge variant="warning">Already entered before</Badge>
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
      {row.parsed && (
        <div className="rounded-md border-y border-r border-border border-l-2 border-l-muted-foreground/30 bg-muted px-4 py-3">
          <ParsedFieldList fields={row.parsed} flags={flags} />
        </div>
      )}
      {failed && (
        <p className="font-sans text-sm text-destructive">
          {row.parse?.error ??
            'This document could not be read. Fill it in yourself, or leave it out.'}
        </p>
      )}

      {/* WHAT WILL BE SENT. */}
      <div className="grid grid-cols-1 gap-x-4 gap-y-4 sm:grid-cols-2 lg:grid-cols-3">
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
          figure
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
          figure
          invalid={row.refNumber.length > REF_NUMBER_MAX}
          disabled={locked}
          onChange={(refNumber) => onEdit({ refNumber })}
        />
      </div>

      {/* The unknown-supplier escape hatch. Only on a row with no vendor picked, only from the
          button inside it, and never while the batch is still being read: mid-parse every row is
          legitimately vendorless, and offering to create nine vendors would be an invitation to
          make a mess of somebody's books. */}
      {onCreateVendor && !busy && canOfferVendorCreate(row, locked) && (
        <AddVendorPanel
          // Remounts when the parsed name changes (a re-parse), so the prefill follows the document
          // rather than stranding the field on what an earlier read guessed.
          key={vendorCreatePrefill(row)}
          suggestedName={vendorCreatePrefill(row)}
          busy={creatingVendor}
          error={createVendorError}
          onCreate={onCreateVendor}
        />
      )}

      <DuplicateNotice warnings={warnings} />

      {/* Same reasoning as the match marker: an unfinished row is a request, not a fault, and it is
          the ordinary state of every row on a fresh batch. Red belongs to what actually went wrong,
          which on this row is sendError. */}
      {gap && (
        <p className="font-sans text-sm font-medium text-warning-foreground">
          Still needed: {gap}.
        </p>
      )}
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
    // Sticky, and that is a working decision rather than a flourish: with nine bills open the one
    // button that sends them was below nine screenfuls of form, so checking a row meant losing
    // sight of the total it contributes to. The elevation is the overlay tier because the strip
    // genuinely floats over the list.
    <div className="sticky bottom-0 z-10 flex flex-wrap items-center justify-between gap-4 rounded-lg border border-border bg-card px-4 py-3 shadow-overlay">
      <div className="flex min-w-0 flex-col gap-0.5">
        <p className="font-sans text-sm font-semibold text-card-foreground">
          {batchSummaryLine(rows)}
        </p>
        {gate.reason && <p className="font-sans text-sm text-muted-foreground">{gate.reason}</p>}
      </div>
      <Button variant="default" size="lg" disabled={!gate.canSend || sending} onClick={onSend}>
        <Send aria-hidden="true" />
        {sending ? 'Sending...' : 'Send to QuickBooks'}
      </Button>
    </div>
  )
}

/** The id the send dialog's popup points its aria-labelledby at. */
export const SEND_CONFIRM_HEADING_ID = 'send-confirm-heading'

/**
 * The confirmation, which states exactly what will happen before anything leaves the app.
 *
 * Sending to somebody's books is not undoable in one step from here (undo lives on the History
 * screen and refuses anything already worked on), so the last thing between the user and their
 * accounts spells out the count and the split rather than asking "are you sure".
 *
 * It renders INSIDE a real modal now (see the Dialog at the bottom of this file), which is why
 * there is no card frame here any more: the dialog popup is the frame. This stays a plain
 * component so its copy and its two disabled controls remain provable without a DOM, which a
 * portalled dialog is not.
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
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <h2
          id={SEND_CONFIRM_HEADING_ID}
          className="font-heading text-lg font-semibold text-card-foreground"
        >
          Send these to QuickBooks?
        </h2>
        <p className="font-sans text-sm text-muted-foreground">{sendConfirmBody(rows)}</p>
        <p className="font-sans text-sm text-muted-foreground">
          You can reverse the whole batch afterwards on the History screen, as long as nothing has
          been changed or paid in QuickBooks since.
        </p>
      </div>
      {/* The affirmative sits on the right, where the eye finishes, and the way out is a quiet
          ghost beside it: this dialog exists to be read, not to be dismissed by reflex. */}
      <div className="flex flex-row-reverse gap-2">
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
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-success/25 bg-success/[0.08] px-4 py-3">
      <p className="flex items-center gap-2 font-sans text-sm font-medium text-success-foreground">
        <CheckCircle2 aria-hidden="true" className="size-4 shrink-0" />
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

/**
 * A determinate progress rail, for the two long operations on this screen.
 *
 * Both of them reported themselves as a line of grey text that counted upward ("parsing 3 of 9")
 * and nothing else, which asks the user to read a sentence repeatedly to find out whether anything
 * is happening. A bar answers that at a glance and is the one place motion earns its keep here.
 *
 * The sentence stays: it is the accessible announcement and it carries the exact counts. The bar is
 * aria-hidden decoration on top of it.
 */
export function ProgressRail({ done, total }: { done: number; total: number }): React.JSX.Element {
  const pct = total > 0 ? Math.min(100, Math.max(0, Math.round((done / total) * 100))) : 0
  return (
    <div aria-hidden="true" className="h-1 w-full overflow-hidden rounded-full bg-muted">
      <div
        className="h-full rounded-full bg-primary-vivid transition-[width] duration-300 ease-standard"
        style={{ width: `${pct}%` }}
      />
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
  // The vendor-create affordance, per row: which row has a create in flight, and what a refused
  // create said. Keyed by file hash like every other per-row map on this screen.
  const [creatingVendor, setCreatingVendor] = useState<string | null>(null)
  const [vendorErrors, setVendorErrors] = useState<Record<string, string | null>>({})
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

  /** Create one vendor for one row, from that row's explicit click. Order lives in runVendorCreate. */
  async function createVendorFor(fileHash: string, displayName: string): Promise<void> {
    setCreatingVendor(fileHash)
    setVendorErrors((prev) => ({ ...prev, [fileHash]: null }))
    try {
      await runVendorCreate(displayName, reference, {
        createVendor: (name) => window.api.qbo.createVendor(name),
        getReference: () => window.api.qbo.getReference(),
        setReference,
        select: (vendorId) => editRow(fileHash, { vendorId }),
        fail: (message) => setVendorErrors((prev) => ({ ...prev, [fileHash]: message }))
      })
    } finally {
      setCreatingVendor(null)
    }
  }

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
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-2">
        <h2 className="font-sans text-xs font-semibold tracking-[0.08em] text-muted-foreground uppercase">
          Review before sending
        </h2>
        <Button
          variant={attentionOnly ? 'secondary' : 'outline'}
          size="sm"
          aria-pressed={attentionOnly}
          onClick={() => setAttentionOnly((on) => !on)}
        >
          {attentionOnly ? 'Show all bills' : `Show what needs me (${attention.length})`}
        </Button>
      </div>

      {reference === null && (
        <p className="rounded-md border border-border bg-muted/50 px-3 py-2 font-sans text-sm text-muted-foreground">
          {NO_REFERENCE_NOTICE}
        </p>
      )}

      {sendError && (
        <p
          role="alert"
          className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 font-sans text-sm text-destructive"
        >
          {sendError}
        </p>
      )}

      {sending && (
        <div className="flex flex-col gap-2 rounded-md border border-border bg-muted/50 px-3 py-2.5">
          <p className="font-sans text-sm font-medium text-foreground" aria-live="polite">
            {sendProgressLine(progress)}
          </p>
          <ProgressRail done={progress?.done ?? 0} total={progress?.total ?? 0} />
        </div>
      )}

      {settled && <CompletionStrip states={sendStates} onOpenHistory={onOpenHistory} />}

      {attentionOnly && visibleRows.length === 0 && (
        <p className="font-sans text-sm text-muted-foreground">
          Nothing needs you. Every bill has a vendor, a category, an amount, and a date.
        </p>
      )}

      <ul className="flex flex-col gap-4">
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
            creatingVendor={creatingVendor === row.fileHash}
            createVendorError={vendorErrors[row.fileHash] ?? null}
            onCreateVendor={(displayName) => void createVendorFor(row.fileHash, displayName)}
            onRetry={onRetry ? () => onRetry(row.fileHash) : undefined}
            onEdit={(patch) => editRow(row.fileHash, patch)}
          />
        ))}
      </ul>

      <ReviewFooter
        rows={rows}
        sending={sending}
        busy={busy}
        onSend={() => setConfirming(true)}
      />

      {/*
        The last thing between the user and their books is now an actual modal.

        It used to REPLACE the footer inline, so the answer to "wait, how many was that" was to
        cancel and start again, and Tab from the confirm button walked straight back into the nine
        editable rows the confirmation was describing. A dialog traps focus, closes on Escape (which
        is the same decision as "Not yet"), and dims the batch behind it so the count in front is
        the only thing being agreed to.
      */}
      <Dialog
        open={confirming}
        onOpenChange={(next) => {
          // A send in flight is not dismissible: the batch is already leaving.
          if (!next && !sending) setConfirming(false)
        }}
      >
        <DialogPortal>
          <DialogBackdrop />
          <DialogPopup aria-modal="true" aria-labelledby={SEND_CONFIRM_HEADING_ID}>
            <SendConfirm
              rows={includedRows(rows)}
              busy={sending}
              onConfirm={() => void runSend()}
              onCancel={() => setConfirming(false)}
            />
          </DialogPopup>
        </DialogPortal>
      </Dialog>
    </div>
  )
}
