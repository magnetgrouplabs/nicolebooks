// Phase 7: the History screen (AUDIT-03, AUDIT-04, REPORT-01).
//
// Three surfaces, in one column, in the order a user actually needs them:
//   1. PAST BATCHES. Newest first, each with what happened to it in plain words.
//   2. BATCH DETAIL. Every entry in the selected batch, its state, and, when something went wrong,
//      the sentence explaining it. A refused undo says so on the row it refused.
//   3. THE REPORT. A printable summary of the selected batch, with a Print button that prints the
//      report region alone.
//
// Undo lives here rather than on the Bills screen because it is a history operation, and it is
// guarded by a confirmation panel that states EXACTLY what will happen: how many entries, what
// will be removed from QuickBooks, and what will not be. A destructive action against somebody's
// books does not get a bare "Are you sure?".
//
// The renderer performs zero direct fs, db, or network access: everything comes through the
// posting IPC group, and every id has already been resolved to a name main-side, so this file
// never joins anything. All colors are semantic theme classes; no hardcoded hex. No em dashes or
// en dashes in any user-facing string (house rule).

import { useCallback, useEffect, useState } from 'react'

import { History, Printer } from 'lucide-react'

import { ipcErrorMessage } from '../lib/ipc-error'
import { EmptyState } from '../components/EmptyState'
import { Badge } from '../components/ui/badge'
import { Button } from '../components/ui/button'
import { Separator } from '../components/ui/separator'
import type {
  PostingBatchDetail,
  PostingBatchEntry,
  PostingBatchSummaryRow,
  PostingBatchesResult,
  PostingSummary,
  PostingUndoResult
} from '@shared/ipc-contract'

type BadgeVariant = 'default' | 'secondary' | 'outline' | 'destructive'

/** The DOM id of the print region, so the print stylesheet can isolate it. */
export const PRINT_REGION_ID = 'posting-batch-report'

/**
 * Render integer cents as printed money. String math only, never cents / 100: the value arrived
 * from the main process as an exact integer and a float round trip is how it stops being one.
 * Same function as the Bills screen uses, kept local so neither screen imports the other.
 */
export function formatCents(cents: number): string {
  const negative = cents < 0
  const digits = Math.abs(cents).toString().padStart(3, '0')
  const whole = digits.slice(0, -2).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return `${negative ? '-' : ''}$${whole}.${digits.slice(-2)}`
}

/** An ISO timestamp as a short local date and time, or the raw value if it will not parse. */
export function formatTimestamp(iso: string): string {
  const parsed = new Date(iso)
  if (Number.isNaN(parsed.getTime())) return iso
  return parsed.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  })
}

/**
 * The one-line description of what happened to a batch.
 *
 * Counts are stated rather than implied. "3 sent" and "3 sent, 3 later removed" are different
 * facts about the same batch, and a screen that showed only the first would tell the user money is
 * in QuickBooks that is not.
 */
export function batchSummaryLine(batch: PostingBatchSummaryRow): string {
  const parts: string[] = []
  const live = batch.confirmed - batch.undone
  parts.push(`${live} of ${batch.total} entered`)
  if (batch.failed > 0) parts.push(`${batch.failed} did not go in`)
  if (batch.undone > 0) parts.push(`${batch.undone} later removed`)
  return parts.join(', ')
}

/** The batch-level chip. Color carries meaning: default good, destructive needs you, outline gone. */
export function batchChip(batch: PostingBatchSummaryRow): { label: string; variant: BadgeVariant } {
  if (batch.state === 'undone') return { label: 'Removed', variant: 'outline' }
  if (batch.state === 'partially-undone') return { label: 'Partly removed', variant: 'secondary' }
  if (batch.failed > 0) return { label: 'Needs another try', variant: 'destructive' }
  if (batch.state === 'complete') return { label: 'Sent', variant: 'default' }
  return { label: 'Not finished', variant: 'secondary' }
}

/**
 * The per-entry chip.
 *
 * 'confirmed' with an undo timestamp reads "Removed", not "Entered": the entry really was
 * confirmed, which is why the stored state stays 'confirmed', but what is TRUE IN QUICKBOOKS NOW
 * is that it is gone, and that is what a person reading this screen needs.
 */
export function entryChip(entry: PostingBatchEntry): { label: string; variant: BadgeVariant } {
  if (entry.state === 'confirmed' && entry.undoneAt !== null) {
    return { label: 'Removed', variant: 'outline' }
  }
  if (entry.state === 'confirmed') return { label: 'Entered', variant: 'default' }
  if (entry.state === 'failed') return { label: 'Did not go in', variant: 'destructive' }
  if (entry.state === 'sent') return { label: 'Sending', variant: 'secondary' }
  return { label: 'Waiting', variant: 'secondary' }
}

/**
 * The exact sentence the undo confirmation shows.
 *
 * It names the count, the company, and the two things people get wrong about undo: it only ever
 * touches the LAST batch, and it will refuse anything that has been worked on in QuickBooks since.
 * Exported so the wording is pinned by a test rather than by a screenshot.
 */
export function undoConfirmBody(batch: PostingBatchSummaryRow): string {
  const live = batch.confirmed - batch.undone
  const noun = live === 1 ? 'entry' : 'entries'
  return [
    `This removes ${live} ${noun} from QuickBooks, the ones NicoleBooks entered in this batch on ${formatTimestamp(batch.createdAt)}.`,
    'Anything that was changed, paid, or linked in QuickBooks since it was entered is left alone, and NicoleBooks will tell you which ones those were.',
    'The documents behind the removed entries become available to enter again.'
  ].join(' ')
}

/** A recoverable failure line, styled the same way everywhere in the app. */
function ErrorLine({ children }: { children: string }): React.JSX.Element {
  return (
    <p
      role="alert"
      className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 font-sans text-sm text-destructive"
    >
      {children}
    </p>
  )
}

/** The screen's section rule: a tracked cap over a hairline, matching the Bills screen. */
function SectionLabel({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <p className="border-b border-border pb-2 font-sans text-xs font-semibold tracking-[0.08em] text-muted-foreground uppercase">
      {children}
    </p>
  )
}

/**
 * The undo confirmation panel.
 *
 * An inline panel rather than a modal on purpose: it sits directly under the button that opened
 * it, next to the batch it describes, so the thing being destroyed stays on screen while the user
 * decides. Its own component so the copy and the disabled rule are provable without a DOM.
 */
export function UndoConfirm({
  batch,
  busy,
  onConfirm,
  onCancel
}: {
  batch: PostingBatchSummaryRow
  busy: boolean
  onConfirm: () => void
  onCancel: () => void
}): React.JSX.Element {
  return (
    <div
      role="group"
      aria-label="Confirm undo"
      className="flex flex-col gap-3 rounded-lg border border-destructive/30 bg-destructive/[0.06] p-4"
    >
      <p className="font-heading text-base font-semibold text-foreground">
        Remove this batch from QuickBooks?
      </p>
      <p className="max-w-prose font-sans text-sm text-muted-foreground">
        {undoConfirmBody(batch)}
      </p>
      <div className="flex flex-row-reverse justify-end gap-2">
        <Button variant="destructive" disabled={busy} onClick={onConfirm}>
          {busy ? 'Removing...' : 'Yes, remove them'}
        </Button>
        <Button variant="ghost" disabled={busy} onClick={onCancel}>
          Keep them
        </Button>
      </div>
    </div>
  )
}

/** One row of the batch history list. */
export function BatchRow({
  batch,
  selected,
  onSelect
}: {
  batch: PostingBatchSummaryRow
  selected: boolean
  onSelect: () => void
}): React.JSX.Element {
  const chip = batchChip(batch)
  return (
    <li>
      {/*
        Selection is carried by a brand rail down the left edge and a lifted surface, the same
        language the sidebar uses for the current destination, rather than by a 1px crimson outline
        that was almost invisible against the row beside it. cursor-pointer is explicit because a
        row-shaped control that does not change the cursor does not read as clickable.
      */}
      <button
        type="button"
        aria-pressed={selected}
        onClick={onSelect}
        className={`relative flex w-full cursor-pointer items-center justify-between gap-4 overflow-hidden rounded-md border px-4 py-3 text-left transition-colors duration-150 ease-standard ${
          selected
            ? 'border-border bg-muted before:absolute before:inset-y-0 before:left-0 before:w-[3px] before:bg-primary-vivid before:content-[""]'
            : 'border-border bg-card hover:bg-muted'
        }`}
      >
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="font-sans text-sm font-semibold text-card-foreground">
            {formatTimestamp(batch.createdAt)}
          </span>
          <span className="font-sans text-sm text-muted-foreground">
            {batchSummaryLine(batch)}
          </span>
        </span>
        <Badge variant={chip.variant}>{chip.label}</Badge>
      </button>
    </li>
  )
}

/**
 * What to call one entry on screen.
 *
 * The FILENAME, because that is the only handle a person has on a document: they recognise
 * "apex-plumbing-supply-invoice-APX-84213.pdf" and they recognise nothing at all in
 * "2df39da7907f...". The live drill screenshotted a whole batch listed as truncated hashes.
 *
 * The hash remains the fallback rather than an empty cell, because a row with no label at all is
 * worse than a row with a useless one: at least the hash can be matched against the audit log.
 */
export function entryLabel(entry: PostingBatchEntry): string {
  if (entry.filename !== null && entry.filename.trim() !== '') return entry.filename
  return `${entry.fileHash.slice(0, 12)}...`
}

/** One entry inside the selected batch. */
export function EntryRow({ entry }: { entry: PostingBatchEntry }): React.JSX.Element {
  const chip = entryChip(entry)
  return (
    <li className="flex items-start justify-between gap-3 rounded-md border border-border bg-card px-4 py-2.5">
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="truncate font-mono text-sm font-medium text-card-foreground">
          {entryLabel(entry)}
        </span>
        <span className="font-sans text-sm text-muted-foreground">
          {entry.entryType === 'bill' ? 'Bill' : 'Expense'}
          {entry.qboId !== null ? ` in QuickBooks as ${entry.qboId}` : ''}
        </span>
        {entry.error !== null && (
          <span className="font-sans text-sm text-destructive">{entry.error}</span>
        )}
        {/* A refused undo is the outcome users most need told: the entry is STILL in QuickBooks. */}
        {entry.undoReason !== null && (
          <span className="font-sans text-sm text-destructive">{entry.undoReason}</span>
        )}
      </div>
      <Badge variant={chip.variant}>{chip.label}</Badge>
    </li>
  )
}

/**
 * Print rules, carried by the component rather than by the global stylesheet.
 *
 * Without them Print produces the header, the sidebar, the batch list and the report, which is not
 * a document anybody files. The rule hides the app frame, then re-shows the report region and lifts
 * it to the top of the page. It lives here (rather than in globals.css) so the whole print
 * behaviour of this screen is readable in one file and no other agent's stylesheet edit collides
 * with it.
 */
const PRINT_STYLES = `
@media print {
  body * { visibility: hidden; }
  #${PRINT_REGION_ID}, #${PRINT_REGION_ID} * { visibility: visible; }
  #${PRINT_REGION_ID} {
    position: absolute;
    inset-inline-start: 0;
    inset-block-start: 0;
    width: 100%;
    border: 0;
    padding: 0;
  }
}
`

/**
 * The printable report.
 *
 * A plain table inside a region the print rules above isolate, so Print produces the report and
 * not the sidebar, the header, and the batch list. Every value is already resolved main-side.
 */
export function BatchReport({ summary }: { summary: PostingSummary }): React.JSX.Element {
  return (
    <section
      id={PRINT_REGION_ID}
      aria-label="Batch report"
      className="flex flex-col gap-4 rounded-lg border border-border bg-card p-5 shadow-raised"
    >
      <style>{PRINT_STYLES}</style>
      <div className="flex flex-col gap-1">
        <h3 className="font-heading text-lg font-semibold tracking-[-0.015em] text-card-foreground">
          Batch report
        </h3>
        <p className="font-sans text-sm text-muted-foreground">
          {summary.companyName ?? 'QuickBooks company'}, sent {formatTimestamp(summary.createdAt)}
        </p>
        <p className="font-sans text-sm text-muted-foreground">
          {summary.totals.confirmed - summary.totals.undone} of {summary.totals.entries} entered,
          total {formatCents(summary.totals.amountCents)}
          {summary.totals.failed > 0 ? `, ${summary.totals.failed} did not go in` : ''}
          {summary.totals.undone > 0 ? `, ${summary.totals.undone} later removed` : ''}
        </p>
      </div>
      <Separator />
      {/*
        A filed document, so it is set like one. Column headers are METADATA, not content: 11px,
        tracked, uppercase, muted. They were 14px semibold, the same size as the data underneath
        them, which is the table equivalent of shouting the labels. Figures (dates, money, ids) go
        in the mono face and the money column is right aligned, because a column of amounts is read
        by comparing the last digits and left-aligned money cannot be.
      */}
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-left">
          <thead>
            <tr className="border-b border-border">
              {['Document', 'Vendor', 'Category', 'Type', 'Date'].map((heading) => (
                <th
                  key={heading}
                  className="py-2 pr-4 font-sans text-[0.6875rem] font-semibold tracking-[0.06em] text-muted-foreground uppercase"
                >
                  {heading}
                </th>
              ))}
              <th className="py-2 pr-4 text-right font-sans text-[0.6875rem] font-semibold tracking-[0.06em] text-muted-foreground uppercase">
                Amount
              </th>
              <th className="py-2 pr-4 font-sans text-[0.6875rem] font-semibold tracking-[0.06em] text-muted-foreground uppercase">
                QuickBooks id
              </th>
              <th className="py-2 font-sans text-[0.6875rem] font-semibold tracking-[0.06em] text-muted-foreground uppercase">
                Status
              </th>
            </tr>
          </thead>
          <tbody>
            {summary.lines.map((line) => (
              <tr key={line.fileHash} className="border-b border-border/60 last:border-b-0">
                <td className="py-2 pr-4 font-mono text-sm text-card-foreground">
                  {line.filename}
                </td>
                <td className="py-2 pr-4 font-sans text-sm text-card-foreground">
                  {line.vendorName}
                </td>
                <td className="py-2 pr-4 font-sans text-sm text-card-foreground">
                  {line.categoryName}
                </td>
                <td className="py-2 pr-4 font-sans text-sm text-muted-foreground">
                  {line.entryType === 'bill' ? 'Bill' : 'Expense'}
                </td>
                <td className="py-2 pr-4 font-mono text-sm text-muted-foreground">
                  {line.txnDate}
                </td>
                <td className="py-2 pr-4 text-right font-mono text-sm font-medium text-card-foreground">
                  {formatCents(line.amountCents)}
                </td>
                <td className="py-2 pr-4 font-mono text-sm text-muted-foreground">
                  {line.qboId ?? ''}
                </td>
                <td className="py-2 font-sans text-sm text-card-foreground">
                  {reportStatus(line.state, line.undoneAt)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

/** The printed status word. Plain English, because this page gets filed and read by somebody else. */
export function reportStatus(state: PostingBatchEntry['state'], undoneAt: string | null): string {
  if (state === 'confirmed' && undoneAt !== null) return 'Removed'
  if (state === 'confirmed') return 'Entered'
  if (state === 'failed') return 'Did not go in'
  if (state === 'sent') return 'Sending'
  return 'Waiting'
}

export function HistoryScreen(): React.JSX.Element {
  const [batches, setBatches] = useState<PostingBatchSummaryRow[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<PostingBatchDetail | null>(null)
  const [summary, setSummary] = useState<PostingSummary | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [undoError, setUndoError] = useState<string | null>(null)
  const [undoResult, setUndoResult] = useState<PostingUndoResult | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [undoing, setUndoing] = useState(false)
  const [loading, setLoading] = useState(true)

  const loadBatches = useCallback(async (): Promise<PostingBatchesResult | null> => {
    try {
      const result = await window.api.posting.batches()
      setBatches(result.batches)
      setLoadError(null)
      return result
    } catch {
      setLoadError('Could not load your batch history just now. Please try again.')
      return null
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadBatches()
  }, [loadBatches])

  // A batch sent from the Bills screen finishes behind the posting:progress broadcast, so this
  // screen refreshes when a batch settles rather than waiting for a remount. The subscription
  // returns a disposer, so the effect cleanup removes exactly its own listener.
  useEffect(() => {
    return window.api.posting.onProgress((progress) => {
      if (progress.current === null) void loadBatches()
    })
  }, [loadBatches])

  const selectBatch = useCallback(async (batchId: string): Promise<void> => {
    setSelectedId(batchId)
    setUndoResult(null)
    setConfirming(false)
    try {
      const [nextDetail, nextSummary] = await Promise.all([
        window.api.posting.batchDetail(batchId),
        window.api.posting.summary(batchId)
      ])
      setDetail(nextDetail)
      setSummary(nextSummary)
      setLoadError(null)
    } catch {
      setDetail(null)
      setSummary(null)
      setLoadError('Could not open that batch just now. Please try again.')
    }
  }, [])

  async function runUndo(): Promise<void> {
    setUndoing(true)
    setUndoError(null)
    try {
      const result = await window.api.posting.undoLast()
      setUndoResult(result)
      setConfirming(false)
      await loadBatches()
      if (result.batchId !== null) await selectBatch(result.batchId)
    } catch (err) {
      // Main already mapped this to a recoverable sentence; anything else falls back to one here.
      // Unwrapped first, because Electron rejects an invoke with its own error whose message puts
      // the channel name and the word Error in front of whatever main said.
      const message = ipcErrorMessage(err)
      setUndoError(message.length > 0 ? message : 'Could not undo that batch just now. Please try again.')
    } finally {
      setUndoing(false)
    }
  }

  // The most recent batch is the only one undo can touch, and only while it still has entries in
  // QuickBooks. Offering the control on any other row would promise something undo cannot do.
  const newest = batches[0] ?? null
  const canUndo = newest !== null && newest.confirmed - newest.undone > 0

  if (loading) {
    return (
      <p className="font-sans text-sm text-muted-foreground" aria-live="polite">
        Loading your batch history...
      </p>
    )
  }

  if (batches.length === 0) {
    return (
      <div className="flex flex-col gap-4">
        {loadError && <ErrorLine>{loadError}</ErrorLine>}
        <EmptyState
          icon={History}
          heading="No history yet"
          body="Batches you send to QuickBooks will be listed here, along with the entries in each."
        />
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-6">
      {loadError && <ErrorLine>{loadError}</ErrorLine>}
      {undoError && <ErrorLine>{undoError}</ErrorLine>}

      <div className="flex flex-wrap items-end justify-between gap-4 border-b border-border pb-4">
        <div className="flex flex-col gap-1">
          <h2 className="font-sans text-xs font-semibold tracking-[0.08em] text-muted-foreground uppercase">
            Past batches
          </h2>
          <p className="font-sans text-sm text-foreground">
            {batches.length} {batches.length === 1 ? 'batch' : 'batches'} sent to QuickBooks
          </p>
        </div>
        {canUndo && !confirming && (
          <Button variant="outline" onClick={() => setConfirming(true)}>
            Undo last batch
          </Button>
        )}
      </div>

      {confirming && newest && (
        <UndoConfirm
          batch={newest}
          busy={undoing}
          onConfirm={() => void runUndo()}
          onCancel={() => setConfirming(false)}
        />
      )}

      {undoResult && (
        <div className="flex flex-col gap-2 rounded-lg border border-border bg-card p-4 shadow-raised">
          <p className="font-sans text-sm font-semibold text-card-foreground">
            {undoResult.results.filter((r) => r.undone).length} of {undoResult.results.length}{' '}
            removed from QuickBooks
          </p>
          {undoResult.results
            .filter((r) => !r.undone)
            .map((r) => (
              <p key={r.qboId} className="font-sans text-sm text-destructive">
                {r.qboId}: {r.reason ?? 'This entry was left in QuickBooks.'}
              </p>
            ))}
        </div>
      )}

      <ul className="flex flex-col gap-1.5">
        {batches.map((batch) => (
          <BatchRow
            key={batch.batchId}
            batch={batch}
            selected={batch.batchId === selectedId}
            onSelect={() => void selectBatch(batch.batchId)}
          />
        ))}
      </ul>

      {detail && (
        <div className="flex flex-col gap-3">
          <SectionLabel>Entries in this batch</SectionLabel>
          <ul className="flex flex-col gap-2">
            {detail.entries.map((entry) => (
              <EntryRow key={entry.fileHash} entry={entry} />
            ))}
          </ul>
        </div>
      )}

      {summary && (
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between gap-4 border-b border-border pb-2">
            <p className="font-sans text-xs font-semibold tracking-[0.08em] text-muted-foreground uppercase">
              Report
            </p>
            <Button variant="outline" size="sm" onClick={() => window.print()}>
              <Printer aria-hidden="true" />
              Print
            </Button>
          </div>
          <BatchReport summary={summary} />
        </div>
      )}
    </div>
  )
}
