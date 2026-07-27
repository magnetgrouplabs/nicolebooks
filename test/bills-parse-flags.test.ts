// test/bills-parse-flags.test.ts
//
// WR-10 regression pin: the Bills row never shows parsed money without its validation flag.
//
// validate.ts is explicit that an unreadable total is recorded as 0 "but only ever alongside its
// flag, which is what makes the fallback visible instead of silent (D-12)". ParseFileResult
// carries validationFlags and confidence across the IPC boundary; the screen used neither. So the
// exact case that module is proudest of catching — a total reading "N/A" must not become a
// confident $0.00 — was caught in the data layer and then presented to Nicole as a normal,
// successfully parsed $0.00 bill next to a default-variant "Parsed" badge.
//
// D-18 puts the rich per-field flagging UI in Phase 6 and this is deliberately not that. The rule
// being pinned is narrower: this screen chose to display a VALUE, and displaying a value without
// its flag is worse than displaying neither.
//
// Rendered with createElement + react-dom/server so the assertion is on the MARKUP the user gets,
// with no DOM harness and no change to the node test environment. Every assertion is on a
// semantic token class, never a color literal.

import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ScanRow, isFlagged } from '../src/renderer/src/screens/BillsScreen'
import type { ParseFileResult, ScanFile } from '../src/shared/ipc-contract'

const FILE: ScanFile = {
  filename: 'nassau-plumbing-0417.pdf',
  status: 'loaded',
  hash: 'a'.repeat(64),
  sizeBytes: 2048
}

function parsed(overrides: Partial<ParseFileResult> = {}): ParseFileResult {
  return {
    filename: FILE.filename,
    hash: FILE.hash as string,
    status: 'parsed',
    fields: {
      vendor: 'Nassau Plumbing Supply',
      invoiceNumber: 'INV-2026-0417',
      invoiceDate: '2026-07-14',
      dueDate: null,
      subtotalCents: 123410,
      taxCents: 10190,
      totalCents: 133600,
      currency: 'USD',
      suggestedCategory: 'Job Materials'
    },
    confidence: { vendor: 'high', totalCents: 'high' },
    validationFlags: [],
    truncated: false,
    ...overrides
  }
}

/** A total that read "N/A": recorded as 0 cents, flagged, and kept (D-12). */
function unreadableTotal(): ParseFileResult {
  return parsed({
    fields: { ...parsed().fields!, totalCents: 0 },
    confidence: { vendor: 'high', totalCents: 'flagged' },
    validationFlags: ['money:totalCents']
  })
}

function renderRow(parse?: ParseFileResult): string {
  return renderToStaticMarkup(createElement(ScanRow, { file: FILE, parse }))
}

describe('ScanRow shows the validation flag next to the money (WR-10)', () => {
  it('renders an unreadable total as needing review, not as a clean $0.00', () => {
    const html = renderRow(unreadableTotal())
    expect(html).toContain('$0.00') // flag-and-KEEP: the value is still shown
    expect(html).toContain('needs review') // ...and never without its flag
    expect(html).toContain('Needs review')
    expect(html).toContain('text-destructive')
  })

  it('leaves a clean parse quiet', () => {
    const html = renderRow(parsed())
    expect(html).toContain('Nassau Plumbing Supply $1,336.00')
    expect(html).not.toContain('needs review')
    expect(html).not.toContain('Needs review')
    expect(html).toContain('text-muted-foreground')
  })

  it('flags a row whose arithmetic cross-check failed', () => {
    const html = renderRow(parsed({ validationFlags: ['arithmetic:subtotal+tax!=total'] }))
    expect(html).toContain('needs review')
  })

  it('flags a cached row too, because the flag was stored alongside the row', () => {
    const html = renderRow({ ...unreadableTotal(), status: 'cached' })
    expect(html).toContain('Cached')
    expect(html).toContain('needs review')
  })

  it('shows no money at all for a failed parse, only the recoverable reason', () => {
    const html = renderRow({
      filename: FILE.filename,
      hash: FILE.hash as string,
      status: 'parse-failed',
      error: 'Could not read this bill. Click Retry to try again.'
    })
    expect(html).not.toContain('$')
    expect(html).toContain('Click Retry')
  })

  it('reads both the flag list and a flagged confidence level', () => {
    expect(isFlagged(parsed())).toBe(false)
    expect(isFlagged(parsed({ validationFlags: ['date:invoiceDate'] }))).toBe(true)
    expect(isFlagged(parsed({ confidence: { taxCents: 'flagged' } }))).toBe(true)
    expect(isFlagged(parsed({ confidence: { taxCents: 'low' } }))).toBe(false)
    expect(isFlagged(undefined)).toBe(false)
  })
})
