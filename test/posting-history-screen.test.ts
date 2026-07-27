// test/posting-history-screen.test.ts
//
// The History screen's pure pieces, rendered with react-dom/server (no DOM, matching the
// test/bills-scan-button.test.ts pattern).
//
// What is worth pinning here is COPY and STATE MAPPING, not layout:
//   * A reversed entry must read "Removed", not "Entered". The stored state stays 'confirmed'
//     because it really was confirmed, so a screen that rendered the raw state would tell the user
//     money is in QuickBooks that is not.
//   * The undo confirmation must say exactly what will happen. A destructive action against
//     somebody's books does not get a bare "Are you sure?".
//   * No em dash and no en dash anywhere the user can see it (house rule).

import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  BatchReport,
  BatchRow,
  EntryRow,
  PRINT_REGION_ID,
  UndoConfirm,
  batchChip,
  batchSummaryLine,
  entryChip,
  formatCents,
  reportStatus,
  undoConfirmBody
} from '../src/renderer/src/screens/HistoryScreen'
import type {
  PostingBatchEntry,
  PostingBatchSummaryRow,
  PostingSummary
} from '../src/shared/ipc-contract'

const HASH_A = 'a'.repeat(64)

function batch(overrides: Partial<PostingBatchSummaryRow> = {}): PostingBatchSummaryRow {
  return {
    batchId: 'batch-1',
    createdAt: '2026-07-27T14:03:00.000Z',
    total: 3,
    confirmed: 3,
    failed: 0,
    undone: 0,
    state: 'complete',
    ...overrides
  }
}

function entry(overrides: Partial<PostingBatchEntry> = {}): PostingBatchEntry {
  return {
    fileHash: HASH_A,
    entryType: 'bill',
    qboId: '55',
    syncToken: '0',
    state: 'confirmed',
    error: null,
    undoneAt: null,
    undoReason: null,
    ...overrides
  }
}

function summary(overrides: Partial<PostingSummary> = {}): PostingSummary {
  return {
    batchId: 'batch-1',
    createdAt: '2026-07-27T14:03:00.000Z',
    companyName: 'Stepdad Service Co',
    realmId: '9341457604445280',
    state: 'complete',
    totals: { entries: 2, confirmed: 2, failed: 0, undone: 0, amountCents: 133600 },
    lines: [
      {
        fileHash: HASH_A,
        filename: 'march-electric-bill.pdf',
        vendorName: 'Nassau Plumbing Supply',
        categoryName: 'Job Materials',
        paidFromName: null,
        entryType: 'bill',
        txnDate: '2026-07-27',
        refNumber: 'INV-1001',
        amountCents: 123600,
        state: 'confirmed',
        qboId: '55',
        error: null,
        undoneAt: null
      },
      {
        fileHash: 'b'.repeat(64),
        filename: 'gas-receipt.jpg',
        vendorName: 'Corner Fuel',
        categoryName: 'Vehicle Fuel',
        paidFromName: 'Business Checking',
        entryType: 'expense',
        txnDate: '2026-07-26',
        refNumber: null,
        amountCents: 10000,
        state: 'confirmed',
        qboId: '56',
        error: null,
        undoneAt: null
      }
    ],
    ...overrides
  }
}

describe('formatCents', () => {
  it.each([
    [0, '$0.00'],
    [1, '$0.01'],
    [99, '$0.99'],
    [100, '$1.00'],
    [133600, '$1,336.00'],
    [123456789, '$1,234,567.89']
  ])('renders %i as %s with string math only', (cents, expected) => {
    expect(formatCents(cents)).toBe(expected)
  })
})

describe('batchSummaryLine', () => {
  it('states what went in, out of how many', () => {
    expect(batchSummaryLine(batch())).toBe('3 of 3 entered')
  })

  it('calls out rows that did not go in', () => {
    expect(batchSummaryLine(batch({ confirmed: 2, failed: 1 }))).toBe(
      '2 of 3 entered, 1 did not go in'
    )
  })

  it('subtracts reversed entries from the live count and says so separately', () => {
    // "3 entered" and "3 entered, 3 later removed" are different facts about the same batch.
    expect(batchSummaryLine(batch({ undone: 3, state: 'undone' }))).toBe(
      '0 of 3 entered, 3 later removed'
    )
  })
})

describe('batchChip', () => {
  it.each([
    [batch(), 'Sent', 'default'],
    [batch({ failed: 1, confirmed: 2, state: 'open' }), 'Needs another try', 'destructive'],
    [batch({ undone: 3, state: 'undone' }), 'Removed', 'outline'],
    [batch({ undone: 1, state: 'partially-undone' }), 'Partly removed', 'secondary'],
    [batch({ confirmed: 0, state: 'open' }), 'Not finished', 'secondary']
  ])('labels a batch %#', (input, label, variant) => {
    expect(batchChip(input as PostingBatchSummaryRow)).toEqual({ label, variant })
  })
})

describe('entryChip', () => {
  it('reads a confirmed entry as Entered', () => {
    expect(entryChip(entry())).toEqual({ label: 'Entered', variant: 'default' })
  })

  it('reads a REVERSED entry as Removed, not as Entered', () => {
    // The stored state stays 'confirmed' (it really was), so rendering the raw state would say
    // "Entered" about something that is no longer in QuickBooks.
    expect(entryChip(entry({ undoneAt: '2026-07-27T15:00:00.000Z' }))).toEqual({
      label: 'Removed',
      variant: 'outline'
    })
  })

  it('reads a failed entry as needing action', () => {
    expect(entryChip(entry({ state: 'failed', qboId: null }))).toEqual({
      label: 'Did not go in',
      variant: 'destructive'
    })
  })

  it('reads pending and sent as in progress', () => {
    expect(entryChip(entry({ state: 'pending' })).label).toBe('Waiting')
    expect(entryChip(entry({ state: 'sent' })).label).toBe('Sending')
  })
})

describe('reportStatus', () => {
  it('prints plain English, because the report gets filed and read by somebody else', () => {
    expect(reportStatus('confirmed', null)).toBe('Entered')
    expect(reportStatus('confirmed', '2026-07-27T15:00:00.000Z')).toBe('Removed')
    expect(reportStatus('failed', null)).toBe('Did not go in')
    expect(reportStatus('pending', null)).toBe('Waiting')
  })
})

describe('the undo confirmation says exactly what will happen', () => {
  it('names the count, the scope, and what it will refuse', () => {
    const body = undoConfirmBody(batch())
    expect(body).toContain('removes 3 entries from QuickBooks')
    expect(body).toContain('in this batch')
    expect(body).toContain('changed, paid, or linked')
    expect(body).toContain('available to enter again')
  })

  it('uses the singular for one entry', () => {
    expect(undoConfirmBody(batch({ total: 1, confirmed: 1 }))).toContain('removes 1 entry from')
  })

  it('counts only entries still in QuickBooks', () => {
    expect(undoConfirmBody(batch({ confirmed: 3, undone: 2 }))).toContain('removes 1 entry from')
  })

  it('renders both a confirm and a cancel control, and disables both while running', () => {
    const idle = renderToStaticMarkup(
      createElement(UndoConfirm, {
        batch: batch(),
        busy: false,
        onConfirm: () => {},
        onCancel: () => {}
      })
    )
    expect(idle).toContain('Yes, remove them')
    expect(idle).toContain('Keep them')
    expect(idle).not.toMatch(/<button[^>]*\sdisabled=""/)

    const busy = renderToStaticMarkup(
      createElement(UndoConfirm, {
        batch: batch(),
        busy: true,
        onConfirm: () => {},
        onCancel: () => {}
      })
    )
    expect(busy).toContain('Removing...')
    expect(busy.match(/<button[^>]*\sdisabled=""/g)).toHaveLength(2)
  })
})

describe('rendered rows', () => {
  it('shows the batch summary and its chip', () => {
    const html = renderToStaticMarkup(
      createElement(BatchRow, { batch: batch({ failed: 1, confirmed: 2 }), selected: false, onSelect: () => {} })
    )
    expect(html).toContain('2 of 3 entered, 1 did not go in')
    expect(html).toContain('Needs another try')
    expect(html).toContain('aria-pressed="false"')
  })

  it('shows a failed entry reason', () => {
    const html = renderToStaticMarkup(
      createElement(EntryRow, {
        entry: entry({
          state: 'failed',
          qboId: null,
          error: 'Could not reach QuickBooks. Check your internet connection, then send this batch again.'
        })
      })
    )
    expect(html).toContain('Could not reach QuickBooks')
    expect(html).toContain('Did not go in')
  })

  it('shows WHY an undo was refused, because the entry is still in QuickBooks', () => {
    const html = renderToStaticMarkup(
      createElement(EntryRow, {
        entry: entry({
          undoReason:
            'This entry was changed in QuickBooks after NicoleBooks sent it, so it was left alone.'
        })
      })
    )
    expect(html).toContain('was changed in QuickBooks after NicoleBooks sent it')
  })
})

describe('the printable report', () => {
  it('renders one row per line with names, amounts, and QuickBooks ids', () => {
    const html = renderToStaticMarkup(createElement(BatchReport, { summary: summary() }))
    expect(html).toContain('Nassau Plumbing Supply')
    expect(html).toContain('Job Materials')
    expect(html).toContain('march-electric-bill.pdf')
    expect(html).toContain('$1,236.00')
    expect(html).toContain('Corner Fuel')
    expect(html).toContain('$100.00')
    expect(html).toContain('Stepdad Service Co')
  })

  it('states the batch totals in words the user can check', () => {
    const html = renderToStaticMarkup(
      createElement(BatchReport, {
        summary: summary({
          totals: { entries: 3, confirmed: 2, failed: 1, undone: 0, amountCents: 133600 }
        })
      })
    )
    expect(html).toContain('2 of 3 entered')
    expect(html).toContain('$1,336.00')
    expect(html).toContain('1 did not go in')
  })

  it('carries print rules that isolate the report region', () => {
    const html = renderToStaticMarkup(createElement(BatchReport, { summary: summary() }))
    expect(html).toContain(`id="${PRINT_REGION_ID}"`)
    expect(html).toContain('@media print')
    expect(html).toContain(`#${PRINT_REGION_ID}, #${PRINT_REGION_ID} * { visibility: visible; }`)
  })

  it('shows a reversed line as Removed on the printed page', () => {
    const base = summary()
    const html = renderToStaticMarkup(
      createElement(BatchReport, {
        summary: {
          ...base,
          lines: [{ ...base.lines[0], undoneAt: '2026-07-27T15:00:00.000Z' }]
        }
      })
    )
    expect(html).toContain('Removed')
  })
})

describe('house copy rules', () => {
  it('uses no em dashes or en dashes in any rendered string', () => {
    const rendered = [
      renderToStaticMarkup(
        createElement(UndoConfirm, {
          batch: batch(),
          busy: false,
          onConfirm: () => {},
          onCancel: () => {}
        })
      ),
      renderToStaticMarkup(
        createElement(BatchRow, { batch: batch(), selected: true, onSelect: () => {} })
      ),
      renderToStaticMarkup(createElement(EntryRow, { entry: entry() })),
      renderToStaticMarkup(createElement(BatchReport, { summary: summary() }))
    ].join('\n')
    expect(rendered).not.toMatch(/[–—]/)
  })
})
