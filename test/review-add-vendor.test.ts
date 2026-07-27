// test/review-add-vendor.test.ts
//
// The unknown-supplier escape hatch on the review screen.
//
// THE RULE THIS FILE GUARDS IS A NEGATIVE ONE (RECON-03). Nothing in this app may create a
// QuickBooks record as a side effect of matching, of parsing, or of a field losing focus. A vendor
// comes into existence only when a person clicks a button that says it will do that. The test corpus
// is built around this: "Quality Craft Tools LLC" is deliberately absent from the sandbox, and an
// app that quietly created it would look like it was working perfectly.
//
// So what is pinned here is WHEN the affordance appears, WHAT it starts as, and in WHAT ORDER a
// successful create updates the screen. Rendered with react-dom/server (no DOM, the same pattern as
// test/review-table.test.ts); the click path itself is exercised against the live sandbox by the
// drill in e2e-live/.

import { describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  ADD_VENDOR_HINT,
  AddVendorPanel,
  ReviewRowCard,
  VENDOR_CREATE_FALLBACK,
  canOfferVendorCreate,
  runVendorCreate,
  vendorCreatePrefill,
  withCreatedVendor
} from '../src/renderer/src/review/ReviewTable'
import { VENDOR_NAME_MAX, resolveRow, seedRow } from '../src/renderer/src/review/model'
import type {
  ParseFileResult,
  ParsedFields,
  QboRefRecord,
  QboReference,
  ScanFile
} from '../src/shared/ipc-contract'

const HASH = 'q'.repeat(64)
const BATCH_DATE = '2026-07-27'

/** The fixture the sandbox deliberately has no vendor for (test-fixtures/MANIFEST.md). */
const PRINTED_VENDOR = 'Quality Craft Tools LLC'
const CREATED: QboRefRecord = { id: '64', name: PRINTED_VENDOR, active: true }

const FILE: ScanFile = {
  filename: 'quality-craft-tools-invoice-QCT-1188.pdf',
  status: 'loaded',
  hash: HASH,
  sizeBytes: 4096
}

function fields(overrides: Partial<ParsedFields> = {}): ParsedFields {
  return {
    vendor: PRINTED_VENDOR,
    invoiceNumber: 'QCT-1188',
    invoiceDate: '2026-07-21',
    dueDate: '2026-08-20',
    subtotalCents: 34195,
    taxCents: 2949,
    totalCents: 37144,
    currency: 'USD',
    suggestedCategory: 'Supplies',
    ...overrides
  }
}

function parse(overrides: Partial<ParseFileResult> = {}): ParseFileResult {
  return {
    filename: FILE.filename,
    hash: HASH,
    status: 'parsed',
    fields: fields(),
    confidence: {},
    validationFlags: [],
    ...overrides
  }
}

function row(edit: Record<string, unknown> = {}) {
  return resolveRow(seedRow(FILE, BATCH_DATE, parse()), edit as never)
}

function reference(vendors: QboRefRecord[] = []): QboReference {
  return { vendors, expenseAccounts: [], paymentAccounts: [], items: [], syncedAt: null }
}

describe('canOfferVendorCreate', () => {
  it('offers on a row reconciliation could not match', () => {
    expect(canOfferVendorCreate(row())).toBe(true)
  })

  it('offers on a row whose suggestion the user cleared', () => {
    expect(canOfferVendorCreate(row({ vendorId: null }))).toBe(true)
  })

  it('does not offer once a vendor is picked, because the fix there is to change the pick', () => {
    expect(canOfferVendorCreate(row({ vendorId: '58' }))).toBe(false)
  })

  it('never offers on a row already handed to QuickBooks', () => {
    expect(canOfferVendorCreate(row(), true)).toBe(false)
  })
})

describe('vendorCreatePrefill', () => {
  it('starts from the name the parser read off the document', () => {
    expect(vendorCreatePrefill(row())).toBe(PRINTED_VENDOR)
  })

  it('is empty when the document could not be read, rather than showing a stale guess', () => {
    const failed = resolveRow(seedRow(FILE, BATCH_DATE, parse({ status: 'parse-failed', fields: undefined })))
    expect(vendorCreatePrefill(failed)).toBe('')
  })
})

describe('withCreatedVendor', () => {
  it('adds the new record so the dropdown has an option for it immediately', () => {
    const next = withCreatedVendor(reference([{ id: '58', name: 'Apex Plumbing Supply', active: true }]), CREATED)
    expect(next.vendors.map((v) => v.id)).toEqual(['58', '64'])
  })

  // The cache reads ORDER BY name COLLATE NOCASE, so a differently ordered local splice would make
  // the list jump the moment the authoritative re-read landed.
  it('keeps the case-insensitive name order the cache read uses', () => {
    const next = withCreatedVendor(
      reference([
        { id: '60', name: 'metro fuel oil corp', active: true },
        { id: '58', name: 'Apex Plumbing Supply', active: true }
      ]),
      CREATED
    )
    expect(next.vendors.map((v) => v.name)).toEqual([
      'Apex Plumbing Supply',
      'metro fuel oil corp',
      PRINTED_VENDOR
    ])
  })

  it('replaces rather than duplicates when the id is already known', () => {
    const next = withCreatedVendor(reference([{ id: '64', name: 'Old Name', active: true }]), CREATED)
    expect(next.vendors).toEqual([CREATED])
  })

  it('works from nothing, which is the not-connected starting state', () => {
    expect(withCreatedVendor(null, CREATED).vendors).toEqual([CREATED])
  })

  it('leaves the account and item lists alone', () => {
    const base: QboReference = {
      ...reference(),
      expenseAccounts: [
        { id: '20', name: 'Supplies', active: true, accountType: 'Expense', accountSubType: null, shortName: 'Supplies' }
      ],
      syncedAt: '2026-07-27T12:00:00.000Z'
    }
    const next = withCreatedVendor(base, CREATED)
    expect(next.expenseAccounts).toEqual(base.expenseAccounts)
    expect(next.syncedAt).toBe(base.syncedAt)
  })
})

describe('runVendorCreate', () => {
  function io(overrides: Record<string, unknown> = {}) {
    const calls: string[] = []
    const base = {
      calls,
      createVendor: vi.fn(async () => {
        calls.push('create')
        return CREATED
      }),
      getReference: vi.fn(async () => {
        calls.push('re-read')
        return reference([CREATED])
      }),
      setReference: vi.fn(() => calls.push('set-reference')),
      select: vi.fn(() => calls.push('select')),
      fail: vi.fn(() => calls.push('fail'))
    }
    return { ...base, ...overrides }
  }

  // The option has to exist before anything selects it. Reversed, the combobox renders blank over a
  // row that is actually complete, and the click reads as having done nothing.
  it('puts the new vendor in the list BEFORE it selects it', async () => {
    const deps = io()
    await runVendorCreate(PRINTED_VENDOR, reference(), deps)
    expect(deps.calls).toEqual(['create', 'set-reference', 'select', 're-read', 'set-reference'])
  })

  it('selects the id QuickBooks assigned, not the name that was typed', async () => {
    const deps = io()
    await runVendorCreate(PRINTED_VENDOR, reference(), deps)
    expect(deps.select).toHaveBeenCalledWith('64')
  })

  it('surfaces main\'s own sentence verbatim, so a duplicate name says to pick the existing one', async () => {
    const duplicate = 'A vendor with this name already exists in QuickBooks. Pick it from the list instead.'
    const deps = io({
      createVendor: vi.fn(async () => {
        throw new Error(duplicate)
      })
    })
    await runVendorCreate(PRINTED_VENDOR, reference(), deps)
    expect(deps.fail).toHaveBeenCalledWith(duplicate)
    expect(deps.select).not.toHaveBeenCalled()
    expect(deps.setReference).not.toHaveBeenCalled()
  })

  it('falls back to a plain sentence when a rejection carried no message at all', async () => {
    const deps = io({
      createVendor: vi.fn(async () => {
        throw new Error('')
      })
    })
    await runVendorCreate(PRINTED_VENDOR, reference(), deps)
    expect(deps.fail).toHaveBeenCalledWith(VENDOR_CREATE_FALLBACK)
  })

  // The vendor exists and the row is set. A red bar about a failed list refresh would report a
  // problem the user cannot act on, about an action that succeeded.
  it('keeps the row selected when the authoritative re-read fails', async () => {
    const deps = io({
      getReference: vi.fn(async () => {
        throw new Error('offline')
      })
    })
    await expect(runVendorCreate(PRINTED_VENDOR, reference(), deps)).resolves.toBeUndefined()
    expect(deps.select).toHaveBeenCalledWith('64')
    expect(deps.fail).not.toHaveBeenCalled()
  })
})

describe('AddVendorPanel markup', () => {
  const render = (props: Record<string, unknown> = {}): string =>
    renderToStaticMarkup(
      createElement(AddVendorPanel, {
        suggestedName: PRINTED_VENDOR,
        onCreate: () => {},
        ...props
      } as never)
    )

  it('prefills the parsed name and says what the button will do', () => {
    const html = render()
    expect(html).toContain(`value="${PRINTED_VENDOR}"`)
    expect(html).toContain('Add to QuickBooks')
    expect(html).toContain(ADD_VENDOR_HINT)
  })

  it('leaves the field editable, because a receipt header is rarely the ledger name', () => {
    expect(render()).not.toContain('readonly')
  })

  it('refuses an empty name at the button, so a blank vendor can never be created', () => {
    expect(render({ suggestedName: '   ' })).toContain('disabled')
  })

  it('says so before the click when the name is over the QuickBooks limit', () => {
    const html = render({ suggestedName: 'x'.repeat(VENDOR_NAME_MAX + 1) })
    expect(html).toContain(`Shorten this name to ${VENDOR_NAME_MAX} characters or fewer.`)
    expect(html).toContain('disabled')
  })

  it('shows the create in flight rather than leaving the button looking unpressed', () => {
    expect(render({ busy: true })).toContain('Adding...')
  })

  it('renders a refusal where the user is looking', () => {
    const html = render({ error: 'A vendor with this name already exists in QuickBooks.' })
    expect(html).toContain('A vendor with this name already exists in QuickBooks.')
    expect(html).toContain('role="alert"')
  })

  it('uses no em dash or en dash anywhere', () => {
    expect(render({ error: 'x' })).not.toMatch(/[–—]/)
    expect(ADD_VENDOR_HINT).not.toMatch(/[–—]/)
    expect(VENDOR_CREATE_FALLBACK).not.toMatch(/[–—]/)
  })
})

describe('the panel appears on exactly the rows that need it', () => {
  const card = (props: Record<string, unknown>): string =>
    renderToStaticMarkup(
      createElement(ReviewRowCard, {
        row: row(),
        vendorOptions: [],
        categoryOptions: [],
        paymentOptions: [],
        warnings: [],
        onEdit: () => {},
        onCreateVendor: () => {},
        ...props
      } as never)
    )

  it('appears on an unmatched row', () => {
    expect(card({})).toContain('Add to QuickBooks')
  })

  it('does not appear once a vendor is chosen', () => {
    expect(card({ row: row({ vendorId: '58' }) })).not.toContain('Add to QuickBooks')
  })

  // Mid-parse every row is legitimately vendorless. Offering to create nine vendors at once is an
  // invitation to make a mess of somebody's books.
  it('does not appear while the batch is still being read', () => {
    expect(card({ busy: true })).not.toContain('Add to QuickBooks')
  })

  it('does not appear on a row already sent to QuickBooks', () => {
    expect(card({ sendState: 'confirmed' })).not.toContain('Add to QuickBooks')
  })

  it('does not appear when the screen supplies no create handler', () => {
    expect(card({ onCreateVendor: undefined })).not.toContain('Add to QuickBooks')
  })
})
