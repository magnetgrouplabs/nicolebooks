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
// Quick task 260727-iv0 restructured the row into labeled label/value pairs with one status chip,
// so the marker now points at the FIELD that failed instead of smearing one blanket warning across
// the row. Exactly two assertions below moved with that change (the old concatenated
// "vendor $total" string, and the incidental "Cached" chip text on the flagged cached row); every
// other assertion here is the original and must stay that way. If one of them goes red, the
// implementation is wrong, not the test.
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

function renderRowFor(file: ScanFile, parse?: ParseFileResult): string {
  return renderToStaticMarkup(createElement(ScanRow, { file, parse }))
}

/**
 * The one label/value pair rendered for `label`, tag and all, or null when the field was omitted.
 * `<dt[^>]*>Total</dt>` cannot match `>Subtotal<`, because the `>` has to sit immediately before
 * the label text.
 */
function pair(html: string, label: string): string | null {
  const match = new RegExp(`<dt[^>]*>${label}</dt><dd[^>]*>[^<]*</dd>`).exec(html)
  return match ? match[0] : null
}

/** How many Badges the row rendered. `group/badge` is the first token of the badge base class. */
function badgeCount(html: string): number {
  return (html.match(/group\/badge/g) ?? []).length
}

describe('ScanRow shows the validation flag next to the money (WR-10)', () => {
  it('renders an unreadable total as needing review, not as a clean $0.00', () => {
    const html = renderRow(unreadableTotal())
    expect(html).toContain('$0.00') // flag-and-KEEP: the value is still shown
    expect(html).toContain('needs review') // ...and never without its flag
    expect(html).toContain('Needs review')
    expect(html).toContain('text-destructive')
  })

  it('points the marker at the field that failed, not at the whole row', () => {
    // The point of the restructure: Total is condemned, Vendor is not, and the user can see which.
    const html = renderRow(unreadableTotal())
    const total = pair(html, 'Total')
    expect(total).toContain('$0.00')
    expect(total).toContain('needs review')
    expect(total).toContain('text-destructive')

    const vendor = pair(html, 'Vendor')
    expect(vendor).toContain('Nassau Plumbing Supply')
    expect(vendor).not.toContain('needs review')
    expect(vendor).not.toContain('text-destructive')
  })

  it('leaves a clean parse quiet', () => {
    const html = renderRow(parsed())
    // Vendor and total are separate labeled pairs now, not one concatenated string.
    expect(html).toContain('Vendor')
    expect(html).toContain('Nassau Plumbing Supply')
    expect(html).toContain('Total')
    expect(html).toContain('$1,336.00')
    expect(html).not.toContain('needs review')
    expect(html).not.toContain('Needs review')
    expect(html).toContain('text-muted-foreground')
  })

  it('flags a row whose arithmetic cross-check failed', () => {
    const html = renderRow(parsed({ validationFlags: ['arithmetic:subtotal+tax!=total'] }))
    expect(html).toContain('needs review')
  })

  it('marks all three money fields for the arithmetic flag, not zero of them', () => {
    // 'arithmetic:subtotal+tax!=total' has a colon whose suffix is NOT a field name, so a naive
    // per-field split would attribute it to nothing and silently drop the whole check.
    const html = renderRow(parsed({ validationFlags: ['arithmetic:subtotal+tax!=total'] }))
    for (const label of ['Subtotal', 'Tax', 'Total']) {
      expect(pair(html, label)).toContain('needs review')
    }
  })

  it('flags a cached row too, because the flag was stored alongside the row', () => {
    const html = renderRow({ ...unreadableTotal(), status: 'cached' })
    // "Needs review" now outranks the cache-hit signal in the single chip. The cache hit was
    // always incidental to this test; the `needs review` marker below is the WR-10 half and the
    // reason the test exists.
    expect(html).toContain('Needs review')
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

describe('null fields are omitted unless the flag itself is the thing to show', () => {
  it('omits a null field nobody flagged', () => {
    // The default fixture has dueDate: null and no date flag. A cash receipt with no tax line
    // legitimately has taxCents: null too; rendering "not found" on every such row is noise.
    const html = renderRow(parsed())
    expect(html).not.toContain('Due date')
    expect(pair(html, 'Due date')).toBeNull()
  })

  it('renders a null field that WAS flagged, with an explicit Not found', () => {
    // money:taxCents only fires when the document HAD a tax value and it was unreadable, so
    // hiding this row would hide a failed check.
    const html = renderRow(
      parsed({
        fields: { ...parsed().fields!, taxCents: null },
        validationFlags: ['money:taxCents']
      })
    )
    const tax = pair(html, 'Tax')
    expect(tax).toContain('Not found')
    expect(tax).toContain('needs review')
    expect(tax).toContain('text-destructive')
  })
})

// Every shape whose flag the renderer has to survive, including two it cannot attribute to any
// field. This is the rendering-layer half of the unattributed-flag backstop; the helper-layer half
// is in test/bills-row-status.test.ts.
const FLAGGED_FIXTURES: Array<{ name: string; parse: ParseFileResult }> = [
  { name: 'an unreadable total', parse: unreadableTotal() },
  {
    name: 'the arithmetic cross-check',
    parse: parsed({ validationFlags: ['arithmetic:subtotal+tax!=total'] })
  },
  { name: 'a flagged confidence level', parse: parsed({ confidence: { taxCents: 'flagged' } }) },
  { name: 'a date check', parse: parsed({ validationFlags: ['date:invoiceDate'] }) },
  { name: 'a D-22 agreement disagreement', parse: parsed({ validationFlags: ['agreement:taxCents'] }) },
  {
    name: 'a flag string this build does not recognize',
    parse: parsed({ validationFlags: ['future:somethingNew'] })
  },
  { name: 'a flag with no colon at all', parse: parsed({ validationFlags: ['weird'] }) },
  {
    name: 'a flagged confidence under an unknown key',
    parse: parsed({ confidence: { somethingNew: 'flagged' } })
  },
  { name: 'a cached row carrying its stored flag', parse: { ...unreadableTotal(), status: 'cached' } }
]

describe('isFlagged always reaches the markup (the WR-10 property)', () => {
  for (const { name, parse } of FLAGGED_FIXTURES) {
    it(`shows a review marker for ${name}`, () => {
      expect(isFlagged(parse)).toBe(true)
      expect(parse.fields).toBeDefined()
      expect(renderRow(parse)).toContain('needs review')
    })
  }
})

// One representative row per chip state, so the structural guarantees below are checked against
// every branch of the precedence table rather than only the happy path.
const CHIP_STATES: Array<{ name: string; file: ScanFile; parse?: ParseFileResult }> = [
  { name: 'loaded, not read yet', file: FILE },
  { name: 'a clean parse', file: FILE, parse: parsed() },
  { name: 'a cache hit', file: FILE, parse: parsed({ status: 'cached' }) },
  { name: 'a flagged row', file: FILE, parse: unreadableTotal() },
  {
    name: 'a failed read',
    file: FILE,
    parse: {
      filename: FILE.filename,
      hash: FILE.hash as string,
      status: 'parse-failed',
      error: 'Could not read this bill. Click Retry to try again.'
    }
  },
  {
    name: 'an already-posted duplicate',
    file: { ...FILE, status: 'duplicate-excluded', postedAt: '2026-05-02' }
  },
  { name: 'a within-scan duplicate', file: { ...FILE, status: 'duplicate-in-batch' } },
  { name: 'a file still downloading', file: { ...FILE, status: 'not-ready-skipped' } },
  { name: 'an unsupported file', file: { ...FILE, status: 'unsupported-skipped' } }
]

describe('the row renders exactly one status chip, in plain text', () => {
  for (const { name, file, parse } of CHIP_STATES) {
    it(`renders one Badge and no dashes for ${name}`, () => {
      const html = renderRowFor(file, parse)
      expect(badgeCount(html)).toBe(1)
      expect(html).not.toMatch(/[\u2014\u2013]/)
    })
  }

  it('does not render a separate In batch badge next to the toggle that already says so', () => {
    const file: ScanFile = { ...FILE, status: 'duplicate-excluded', postedAt: '2026-05-02' }
    const html = renderToStaticMarkup(
      createElement(ScanRow, { file, included: true, onToggleInclude: () => {} })
    )
    expect(html).not.toContain('In batch')
    expect(html).toContain('Remove from batch')
    expect(badgeCount(html)).toBe(1)
  })
})
