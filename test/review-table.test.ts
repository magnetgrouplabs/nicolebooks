// test/review-table.test.ts
//
// The review surface as the user actually meets it, rendered with react-dom/server (no DOM, the
// same pattern as test/bills-parse-flags.test.ts and test/posting-history-screen.test.ts).
//
// The pure rules are pinned in test/review-model.test.ts. What is pinned HERE is that those rules
// reach the markup, plus the three claims that are only true of the rendering:
//
//   1. WHAT THE DOCUMENT SAID STAYS ON SCREEN. A row that has been corrected still prints the
//      parsed value beside the correction. If a future refactor replaces the parsed list with the
//      editable fields, the user loses the only way they have to audit a guess, and this file
//      goes red.
//
//   2. THE DISABLED BUTTON EXPLAINS ITSELF. A Send button that is disabled with no reason is the
//      single most reliable way to make a non-technical user feel stupid.
//
//   3. THE DUPLICATE WARNING NEVER BLOCKS. It is a note with the details attached, not a gate.
//      The user is the only one who knows whether the vendor billed twice.

import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Combobox } from '../src/renderer/src/components/ui/combobox'
import {
  CompletionStrip,
  DuplicateNotice,
  MatchMarker,
  NO_REFERENCE_NOTICE,
  ReviewFooter,
  ReviewRowCard,
  STILL_READING,
  SendConfirm,
  TypeToggle,
  completionLine,
  matchMarkerText,
  sendProgressLine,
  sendStateChip
} from '../src/renderer/src/review/ReviewTable'
import { resolveRow, seedRow, type ReviewEdit, type ReviewSeed } from '../src/renderer/src/review/model'
import { reviewableFiles } from '../src/renderer/src/screens/BillsScreen'
import type {
  DuplicateWarning,
  ParseFileResult,
  ParsedFields,
  ScanFile
} from '../src/shared/ipc-contract'

const HASH_A = 'a'.repeat(64)
const BATCH_DATE = '2026-07-27'

function fields(overrides: Partial<ParsedFields> = {}): ParsedFields {
  return {
    vendor: 'Nassau Plumbing Supply',
    invoiceNumber: 'INV-2026-0417',
    invoiceDate: '2026-07-14',
    dueDate: '2026-08-14',
    subtotalCents: 123410,
    taxCents: 10190,
    totalCents: 133600,
    currency: 'USD',
    suggestedCategory: 'Job Materials',
    ...overrides
  }
}

function parsed(overrides: Partial<ParseFileResult> = {}): ParseFileResult {
  return {
    filename: 'nassau-plumbing-0417.pdf',
    hash: HASH_A,
    status: 'parsed',
    fields: fields(),
    confidence: { vendor: 'high', totalCents: 'high' },
    validationFlags: [],
    ...overrides
  }
}

const FILE: ScanFile = {
  filename: 'nassau-plumbing-0417.pdf',
  status: 'loaded',
  hash: HASH_A,
  sizeBytes: 2048
}

const VENDORS = [
  { id: '42', label: 'Nassau Plumbing Supply' },
  { id: '99', label: 'Corner Fuel' }
]
const CATEGORIES = [
  { id: '7', label: 'Job Expenses:Job Materials', hint: 'SuppliesMaterials' },
  { id: '9', label: 'Job Expenses:Equipment Rental', hint: 'EquipmentRental' }
]
const PAYMENTS = [{ id: '35', label: 'Business Checking', hint: 'Checking' }]

function seed(overrides: Partial<ReviewSeed> = {}): ReviewSeed {
  return {
    ...seedRow(FILE, BATCH_DATE, parsed()),
    vendorId: '42',
    categoryAccountId: '7',
    ...overrides
  }
}

function renderRow(
  seedOverrides: Partial<ReviewSeed> = {},
  edit: ReviewEdit = {},
  extra: {
    warnings?: DuplicateWarning[]
    sendState?: 'pending' | 'sent' | 'confirmed' | 'failed'
    sendError?: string | null
    retrying?: boolean
    onRetry?: () => void
  } = {}
): string {
  return renderToStaticMarkup(
    createElement(ReviewRowCard, {
      row: resolveRow(seed(seedOverrides), edit),
      vendorOptions: VENDORS,
      categoryOptions: CATEGORIES,
      paymentOptions: PAYMENTS,
      warnings: extra.warnings ?? [],
      sendState: extra.sendState,
      sendError: extra.sendError ?? null,
      retrying: extra.retrying,
      onRetry: extra.onRetry,
      onEdit: () => {}
    })
  )
}

function renderFooter(rows: ReturnType<typeof resolveRow>[], sending = false): string {
  return renderToStaticMarkup(
    createElement(ReviewFooter, { rows, sending, onSend: () => {} })
  )
}

/** The real `disabled` ATTRIBUTE, not the word: the branded Button carries disabled: utilities. */
function isDisabled(html: string): boolean {
  return /<button[^>]*\sdisabled=""/.test(html)
}

/**
 * The labels of the EDITABLE cells, in order.
 *
 * Matching on the label text alone would be wrong in the one place it matters: the parsed field
 * list prints 'Due date' as a <dt> on every bill that has one, so a bare `not.toContain('Due date')`
 * would pass only while the row was hiding what the document said. These are the field labels
 * specifically (the shared xs/medium/muted class the controls share), so the assertion is about the
 * CONTROLS and stays true whatever the document happens to say.
 */
function editableFields(html: string): string[] {
  return [
    ...html.matchAll(/<(?:span|label)[^>]*font-sans text-xs font-medium text-muted-foreground[^>]*>([^<]+)</g)
  ].map((found) => found[1])
}

function warning(overrides: Partial<DuplicateWarning> = {}): DuplicateWarning {
  return {
    batchId: 'batch-1',
    fileHash: 'b'.repeat(64),
    filename: 'nassau-plumbing-copy.pdf',
    entryType: 'bill',
    qboId: '55',
    vendorId: '42',
    vendorName: 'Nassau Plumbing Supply',
    amountCents: 133600,
    txnDate: '2026-07-25',
    daysApart: -2,
    postedAt: '2026-07-25T14:03:00.000Z',
    ...overrides
  }
}

// ---------------------------------------------------------------------------
// The row
// ---------------------------------------------------------------------------

describe('a review row shows what the document said AND what will be sent', () => {
  it('prints the parsed fields, labeled, above the controls', () => {
    const html = renderRow()
    expect(html).toContain('Nassau Plumbing Supply')
    expect(html).toContain('$1,336.00')
    expect(html).toContain('Invoice number')
    expect(html).toContain('INV-2026-0417')
  })

  it('KEEPS the parsed value visible after the user overrides it', () => {
    // The trust argument of the whole screen: correcting a value must never hide the claim it
    // corrected, because seeing both is the only way a non-technical user can audit a guess.
    const html = renderRow({}, { amountText: '20.00' })
    expect(html).toContain('value="20.00"') // what will be sent
    expect(html).toContain('$1,336.00') // what the document said
  })

  it('marks the field that failed a deterministic check, and says the row needs review', () => {
    const html = renderRow({
      parse: parsed({
        fields: fields({ totalCents: 0 }),
        confidence: { totalCents: 'flagged' },
        validationFlags: ['money:totalCents']
      })
    })
    expect(html).toContain('needs review')
    expect(html).toContain('Needs review')
    expect(html).toContain('text-destructive')
  })

  it('offers the editable fields a bill needs, and not the ones it does not', () => {
    expect(editableFields(renderRow())).toEqual([
      'Type',
      'Vendor',
      'Category',
      'Amount',
      'Entry date',
      'Due date',
      'Reference number'
    ])
  })

  it('reveals Paid from for an expense and drops the due date', () => {
    const html = renderRow({}, { entryType: 'expense', paidFromAccountId: '35' })
    expect(editableFields(html)).toEqual([
      'Type',
      'Vendor',
      'Category',
      'Paid from',
      'Amount',
      'Entry date',
      'Reference number'
    ])
    expect(html).toContain('Business Checking')
  })

  it('seeds the entry date from the batch and the amount from the total', () => {
    const html = renderRow()
    expect(html).toContain(`value="${BATCH_DATE}"`)
    expect(html).toContain('value="1336.00"')
  })

  it('shows the vendor the reconciler chose, by name', () => {
    expect(renderRow()).toContain('value="Nassau Plumbing Supply"')
  })

  it('shows the category by its FULLY QUALIFIED name, which is what QuickBooks shows', () => {
    // The sandbox company has two accounts called Equipment Rental under different parents; the
    // bare leaf would be unusable in a dropdown.
    expect(renderRow()).toContain('value="Job Expenses:Job Materials"')
  })

  it('marks the amount invalid when what was typed is not money', () => {
    expect(renderRow({}, { amountText: 'twenty' })).toContain('aria-invalid="true"')
  })

  it('marks an over-long reference number invalid, before QuickBooks would refuse it', () => {
    expect(renderRow({}, { refNumber: 'x'.repeat(22) })).toContain('aria-invalid="true"')
  })

  it('says what an included row still needs', () => {
    expect(renderRow({ vendorId: null })).toContain('Still needed: pick a vendor.')
  })

  it('says nothing about an EXCLUDED row, which is not asking for anything', () => {
    expect(renderRow({ vendorId: null }, { included: false })).not.toContain('Still needed')
  })

  it('renders the include checkbox in the state the row is in', () => {
    expect(renderRow()).toMatch(/<input[^>]*type="checkbox"[^>]*checked=""/)
    expect(renderRow({}, { included: false })).not.toMatch(/type="checkbox"[^>]*checked=""/)
  })

  it('flags a row that was already entered before', () => {
    expect(renderRow({ scanStatus: 'duplicate-excluded' })).toContain('Already entered before')
  })

  it('offers Retry on a document the model could not read, and says why it failed', () => {
    const html = renderRow(
      {
        parse: {
          filename: 'blurry.jpg',
          hash: HASH_A,
          status: 'parse-failed',
          error: 'Could not read this bill. Click Retry to try again.'
        }
      },
      {},
      { onRetry: () => {} }
    )
    expect(html).toContain('Could not read')
    expect(html).toContain('Click Retry to try again.')
    expect(html).toContain('Retry')
  })

  it('says a retry is running rather than looking broken', () => {
    const html = renderRow(
      { parse: { filename: 'blurry.jpg', hash: HASH_A, status: 'parse-failed' } },
      {},
      { onRetry: () => {}, retrying: true }
    )
    expect(html).toContain('Retrying...')
    expect(isDisabled(html)).toBe(true)
  })

  it('shows the per-row outcome once a batch has been sent', () => {
    expect(renderRow({}, {}, { sendState: 'confirmed' })).toContain('Entered')
    expect(renderRow({}, {}, { sendState: 'sent' })).toContain('Sending')
    expect(renderRow({}, {}, { sendState: 'pending' })).toContain('Waiting')
    const failed = renderRow({}, {}, {
      sendState: 'failed',
      sendError: 'QuickBooks would not accept this entry.'
    })
    expect(failed).toContain('Did not go in')
    expect(failed).toContain('QuickBooks would not accept this entry.')
  })
})

describe('sendStateChip', () => {
  it.each([
    ['confirmed', 'Entered', 'default'],
    ['sent', 'Sending', 'secondary'],
    ['pending', 'Waiting', 'secondary'],
    ['failed', 'Did not go in', 'destructive']
  ])('reads %s as %s', (state, label, variant) => {
    expect(sendStateChip(state as 'confirmed')).toEqual({ label, variant })
  })
})

// ---------------------------------------------------------------------------
// Reconciliation markers
// ---------------------------------------------------------------------------

describe('the confidence marker distinguishes the three tiers', () => {
  it('says nothing at all for a confident match', () => {
    // A screen where everything is marked is a screen where nothing is.
    expect(matchMarkerText('auto')).toBeNull()
    expect(renderToStaticMarkup(createElement(MatchMarker, { confidence: 'auto' }))).toBe('')
  })

  it('marks a suggestion the user should glance at', () => {
    expect(matchMarkerText('suggested')).toBe('suggested match')
    expect(renderRow({ vendorConfidence: 'suggested' })).toContain('suggested match')
  })

  it('marks an empty cell as waiting on the user, not as broken', () => {
    expect(matchMarkerText('none')).toBe('needs your pick')
    expect(renderRow({ vendorId: null, vendorConfidence: 'none' })).toContain('needs your pick')
  })

  it('says nothing when reconciliation never answered, which is plain manual selection', () => {
    expect(matchMarkerText(null)).toBeNull()
    const html = renderRow({ vendorId: null, vendorConfidence: null })
    expect(html).not.toContain('suggested match')
    expect(html).not.toContain('needs your pick')
  })
})

// ---------------------------------------------------------------------------
// The duplicate warning
// ---------------------------------------------------------------------------

describe('the duplicate warning informs and does not block', () => {
  it('renders nothing when there is nothing to warn about', () => {
    expect(renderToStaticMarkup(createElement(DuplicateNotice, { warnings: [] }))).toBe('')
  })

  it('says when it was sent, and that sending it again is allowed', () => {
    const html = renderToStaticMarkup(createElement(DuplicateNotice, { warnings: [warning()] }))
    expect(html).toContain('Looks like this was already sent on 2026-07-25.')
    expect(html).toContain('You can send it anyway.')
  })

  it('carries the prior entry details so the claim can be checked', () => {
    const html = renderToStaticMarkup(createElement(DuplicateNotice, { warnings: [warning()] }))
    expect(html).toContain('Nassau Plumbing Supply')
    expect(html).toContain('$1,336.00')
    expect(html).toContain('nassau-plumbing-copy.pdf')
    expect(html).toContain('in QuickBooks as 55')
  })

  it('appears on the row itself', () => {
    expect(renderRow({}, {}, { warnings: [warning()] })).toContain('already sent on 2026-07-25')
  })

  it('leaves the row completable, because a warning is not a gap', () => {
    const html = renderRow({}, {}, { warnings: [warning()] })
    expect(html).not.toContain('Still needed')
  })
})

// ---------------------------------------------------------------------------
// The footer and the send gate
// ---------------------------------------------------------------------------

describe('the Send button', () => {
  it('is enabled when every included row is complete, and totals the batch', () => {
    const html = renderFooter([resolveRow(seed())])
    expect(html).toContain('Send to QuickBooks')
    expect(html).toContain('1 bill selected, $1,336.00 in total')
    expect(isDisabled(html)).toBe(false)
  })

  it('is disabled with a PRINTED reason when a row is incomplete', () => {
    const html = renderFooter([resolveRow(seed({ vendorId: null }))])
    expect(isDisabled(html)).toBe(true)
    expect(html).toContain('On nassau-plumbing-0417.pdf, pick a vendor.')
  })

  it('is disabled with a reason when nothing is ticked', () => {
    const html = renderFooter([resolveRow(seed(), { included: false })])
    expect(isDisabled(html)).toBe(true)
    expect(html).toContain('Tick at least one bill to send it to QuickBooks.')
  })

  it('is disabled while a batch is in flight, and says so', () => {
    const html = renderFooter([resolveRow(seed())], true)
    expect(isDisabled(html)).toBe(true)
    expect(html).toContain('Sending...')
  })

  it('is disabled for an expense with no account, which main would refuse WHOLE', () => {
    const html = renderFooter([resolveRow(seed(), { entryType: 'expense' })])
    expect(isDisabled(html)).toBe(true)
    expect(html).toContain('pick the account that paid it')
  })
})

// ---------------------------------------------------------------------------
// The confirmation, the progress line, and the completion strip
// ---------------------------------------------------------------------------

describe('while the model is still reading', () => {
  it('reports nothing missing, because nothing is missing yet', () => {
    // Every row is legitimately empty mid-parse. A wall of "Still needed: pick a vendor" about work
    // in progress would read as a screenful of errors.
    const html = renderToStaticMarkup(
      createElement(ReviewRowCard, {
        row: resolveRow(seed({ vendorId: null, amountText: '' })),
        vendorOptions: VENDORS,
        categoryOptions: CATEGORIES,
        paymentOptions: PAYMENTS,
        warnings: [],
        busy: true,
        onEdit: () => {}
      })
    )
    expect(html).not.toContain('Still needed')
  })

  it('holds Send back and says why, rather than blaming an empty row', () => {
    const html = renderToStaticMarkup(
      createElement(ReviewFooter, {
        rows: [resolveRow(seed({ vendorId: null, amountText: '' }))],
        sending: false,
        busy: true,
        onSend: () => {}
      })
    )
    expect(isDisabled(html)).toBe(true)
    expect(html).toContain(STILL_READING)
    expect(html).not.toContain('pick a vendor')
  })

  it('says its piece without a dash', () => {
    expect(STILL_READING).not.toMatch(/[—–]/)
  })
})

describe('the send confirmation', () => {
  it('states the count, the split, and the money before anything leaves the app', () => {
    const html = renderToStaticMarkup(
      createElement(SendConfirm, {
        rows: [resolveRow(seed()), resolveRow(seed(), { entryType: 'expense', paidFromAccountId: '35' })],
        busy: false,
        onConfirm: () => {},
        onCancel: () => {}
      })
    )
    expect(html).toContain('Send 2 entries to QuickBooks as 1 bill and 1 expense')
    expect(html).toContain('Yes, send them')
    expect(html).toContain('Not yet')
  })

  it('says undo exists, and what it will refuse', () => {
    const html = renderToStaticMarkup(
      createElement(SendConfirm, {
        rows: [resolveRow(seed())],
        busy: false,
        onConfirm: () => {},
        onCancel: () => {}
      })
    )
    expect(html).toContain('reverse the whole batch')
    expect(html).toContain('History screen')
  })

  it('disables both controls while the batch is going', () => {
    const html = renderToStaticMarkup(
      createElement(SendConfirm, {
        rows: [resolveRow(seed())],
        busy: true,
        onConfirm: () => {},
        onCancel: () => {}
      })
    )
    expect(html.match(/<button[^>]*\sdisabled=""/g)).toHaveLength(2)
  })
})

describe('the progress line', () => {
  it('counts before the first event arrives', () => {
    expect(sendProgressLine(null)).toBe('Sending to QuickBooks...')
  })

  it('counts what is done out of the total', () => {
    expect(
      sendProgressLine({ batchId: 'b1', done: 2, total: 5, current: { fileHash: HASH_A, state: 'sent' } })
    ).toBe('Sending to QuickBooks: 2 of 5 done...')
  })
})

describe('the completion strip', () => {
  it('states what went in', () => {
    expect(completionLine({ a: 'confirmed', b: 'confirmed' })).toBe('2 of 2 entered in QuickBooks.')
  })

  it('states what did NOT go in, and that it can be sent again', () => {
    expect(completionLine({ a: 'confirmed', b: 'failed' })).toBe(
      '1 of 2 entered in QuickBooks. 1 did not go in, and can be sent again.'
    )
  })

  it('offers the way to the receipt', () => {
    const html = renderToStaticMarkup(
      createElement(CompletionStrip, {
        states: { a: 'confirmed' },
        onOpenHistory: () => {}
      })
    )
    expect(html).toContain('1 of 1 entered in QuickBooks.')
    expect(html).toContain('Open History for the receipt')
  })

  it('omits the link when there is nowhere to send the user', () => {
    const html = renderToStaticMarkup(createElement(CompletionStrip, { states: { a: 'confirmed' } }))
    expect(html).not.toContain('Open History')
  })
})

// ---------------------------------------------------------------------------
// The primitives
// ---------------------------------------------------------------------------

describe('the Bill and Expense toggle', () => {
  it('shows which one is chosen, without hiding the other', () => {
    const html = renderToStaticMarkup(
      createElement(TypeToggle, { value: 'bill', onChange: () => {} })
    )
    expect(html).toContain('Bill')
    expect(html).toContain('Expense')
    expect(html).toMatch(/aria-pressed="true"[^>]*>Bill/)
    expect(html).toMatch(/aria-pressed="false"[^>]*>Expense/)
  })
})

describe('the searchable combobox', () => {
  it('reads as the CHOICE at rest, not as an empty search box', () => {
    const html = renderToStaticMarkup(
      createElement(Combobox, {
        label: 'Vendor',
        value: '42',
        options: VENDORS,
        onChange: () => {}
      })
    )
    expect(html).toContain('value="Nassau Plumbing Supply"')
    expect(html).toContain('role="combobox"')
    expect(html).toContain('aria-expanded="false"')
  })

  it('renders no option list until it is opened', () => {
    const html = renderToStaticMarkup(
      createElement(Combobox, { label: 'Vendor', value: null, options: VENDORS, onChange: () => {} })
    )
    expect(html).not.toContain('role="listbox"')
    expect(html).not.toContain('Corner Fuel')
  })

  it('invites the user to type when nothing is chosen', () => {
    const html = renderToStaticMarkup(
      createElement(Combobox, { label: 'Vendor', value: null, options: VENDORS, onChange: () => {} })
    )
    expect(html).toContain('placeholder="Type to search"')
  })
})

// ---------------------------------------------------------------------------
// Degrading well, and the house copy rules
// ---------------------------------------------------------------------------

describe('the screen degrades to manual selection rather than to an error', () => {
  it('says what to do when QuickBooks is not connected, without alarming', () => {
    expect(NO_REFERENCE_NOTICE).toContain('Settings screen')
    expect(NO_REFERENCE_NOTICE).not.toMatch(/error|failed|problem/i)
  })

  it('still renders every row with empty pickers when there is no reference data', () => {
    const html = renderToStaticMarkup(
      createElement(ReviewRowCard, {
        row: resolveRow(seed({ vendorId: null, categoryAccountId: null })),
        vendorOptions: [],
        categoryOptions: [],
        paymentOptions: [],
        warnings: [],
        onEdit: () => {}
      })
    )
    expect(html).toContain('Vendor')
    expect(html).toContain('nassau-plumbing-0417.pdf')
    expect(html).toContain('Still needed: pick a vendor.')
  })
})

// ---------------------------------------------------------------------------
// Which documents reach the review table at all
// ---------------------------------------------------------------------------

describe('reviewableFiles decides what the review table is even shown', () => {
  const scan = (files: ScanFile[]): Parameters<typeof reviewableFiles>[0] => ({
    batchEntryDate: BATCH_DATE,
    inboxPath: 'C:/inbox',
    files,
    summary: { total: files.length, loaded: 0, duplicates: 0, notReady: 0, unsupported: 0 }
  })

  it('reviews every loaded document', () => {
    const files = [FILE, { ...FILE, filename: 'two.pdf', hash: 'b'.repeat(64) }]
    expect(reviewableFiles(scan(files), new Set()).map((file) => file.filename)).toEqual([
      'nassau-plumbing-0417.pdf',
      'two.pdf'
    ])
  })

  it('KEEPS an already-entered duplicate out until the user includes it anyway', () => {
    // This is where Phase 2's default-off rule for a dedupe-excluded file is enforced: not by an
    // unticked box the user has to find, but by the row not being there to send at all.
    const dupe: ScanFile = { ...FILE, status: 'duplicate-excluded', postedAt: '2026-05-02' }
    expect(reviewableFiles(scan([dupe]), new Set())).toHaveLength(0)
    expect(reviewableFiles(scan([dupe]), new Set([`${dupe.filename} ${dupe.hash}`]))).toHaveLength(1)
  })

  it('never reviews a within-scan copy, which is the same document twice', () => {
    const copy: ScanFile = { ...FILE, filename: 'copy.pdf', status: 'duplicate-in-batch' }
    expect(reviewableFiles(scan([FILE, copy]), new Set()).map((file) => file.filename)).toEqual([
      'nassau-plumbing-0417.pdf'
    ])
  })

  it('never reviews a skipped file, which has no bytes to send', () => {
    const skipped: ScanFile = { ...FILE, filename: 'notes.txt', status: 'unsupported-skipped' }
    const waiting: ScanFile = { ...FILE, filename: 'cloud.pdf', status: 'not-ready-skipped' }
    expect(reviewableFiles(scan([skipped, waiting]), new Set())).toHaveLength(0)
  })

  it('reviews nothing before a scan has run', () => {
    expect(reviewableFiles(null, new Set())).toEqual([])
  })
})

describe('house copy rules', () => {
  it('uses no em dashes or en dashes anywhere the user can see', () => {
    const rendered = [
      renderRow(),
      renderRow({ vendorId: null, vendorConfidence: 'none' }),
      renderRow({}, { entryType: 'expense', paidFromAccountId: '35' }),
      renderRow({}, {}, { warnings: [warning()], sendState: 'failed', sendError: 'It did not go in.' }),
      renderFooter([resolveRow(seed())]),
      renderFooter([resolveRow(seed({ vendorId: null }))]),
      renderToStaticMarkup(
        createElement(SendConfirm, {
          rows: [resolveRow(seed())],
          busy: false,
          onConfirm: () => {},
          onCancel: () => {}
        })
      ),
      renderToStaticMarkup(
        createElement(CompletionStrip, { states: { a: 'confirmed', b: 'failed' }, onOpenHistory: () => {} })
      ),
      NO_REFERENCE_NOTICE,
      sendProgressLine(null),
      sendProgressLine({ batchId: 'b', done: 1, total: 2, current: null })
    ].join('\n')
    expect(rendered).not.toMatch(/[—–]/)
  })
})
