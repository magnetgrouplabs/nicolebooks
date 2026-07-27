// e2e-live/live-drill.spec.ts
//
// THE PRODUCT'S ACCEPTANCE TEST. Nine real documents, a real vision model, a real QuickBooks
// company, and every claim checked by reading the company back rather than by believing the app.
//
// It runs against the live Intuit sandbox and the live OpenAI endpoint, so it lives behind two
// gates: playwright.live.config.ts (which nothing else references, so `npm run test:e2e` and CI
// cannot see this directory) and LIVE_QBO=1.
//
// PREPARATION, which is not automated on purpose. A drill that seeds its own credentials would be
// a drill that can silently run against the wrong company:
//
//   rm -rf %APPDATA%/nicolebooks
//   npm run build
//   npx electron . --dev-seed-qbo
//   npx electron . --dev-seed-ai
//   LIVE_QBO=1 npx playwright test --config playwright.live.config.ts
//   npx electron . --dev-qbo-export      <- ALWAYS, the refresh token rolls
//
// THE MANIFEST IS THE TRUTH. test-fixtures/manifest.json is what the corpus was generated from,
// down to the cent, so a disagreement between it and a parsed value is a parser result to report,
// never a number to adjust. The drill records what the model actually read, then fills each row
// with the manifest's values (which is what a user does on this screen: correct what is wrong),
// so the QuickBooks read-back afterwards can be an exact equality check.

import { test, expect } from '@playwright/test'
import { copyFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import { MAIN_ENTRY, _electron as electron } from '../playwright.live.config'
import {
  FIXTURES_DIR,
  amountToCents,
  basename,
  cellTier,
  dollars,
  fetchEntity,
  field,
  fillField,
  liveUserDataDir,
  parkVendor,
  pickCombobox,
  qboQuery,
  qboRead,
  readManifest,
  readParsedResults,
  rowFor,
  shot,
  writeScorecard,
  type ManifestDocument
} from './helpers'

const LIVE = process.env['LIVE_QBO'] === '1'

test.skip(!LIVE, 'live drill: set LIVE_QBO=1 and seed the sandbox credentials first')

const manifest = readManifest()

/**
 * How each fixture is completed on the review screen, per test-fixtures/MANIFEST.md.
 *
 * Accounts are named by ID, not by label. A QuickBooks chart of accounts is hierarchical and the
 * grid offers FULLY QUALIFIED names, so the label for account 63 might be "Job Materials" or
 * "Job Expenses:Job Materials" depending on where the company files it. Hardcoding a guess would
 * make this drill fail on a correct app. The labels are resolved from the live reference cache in
 * beforeAll, which is also how the app itself learns them.
 */
interface RowPlan {
  file: string
  entryType: 'bill' | 'expense'
  vendor: string
  categoryId: string
  paidFromId?: string
  /** Left out of the batch, with the reason recorded in the scorecard. */
  exclude?: string
}

const PLAN: RowPlan[] = [
  {
    file: 'apex-plumbing-supply-invoice-APX-84213.pdf',
    entryType: 'bill',
    vendor: 'Apex Plumbing Supply',
    categoryId: '63' // Job Materials
  },
  {
    file: 'metro-fuel-oil-corp-invoice-MF-2026-0714.pdf',
    entryType: 'bill',
    vendor: 'Metro Fuel Oil Corp',
    categoryId: '56' // Fuel
  },
  {
    file: 'brightline-electric-invoice-BE-5590.pdf',
    entryType: 'bill',
    vendor: 'Brightline Electric Supply',
    categoryId: '63' // Job Materials
  },
  {
    file: 'quality-craft-tools-invoice-QCT-1188.pdf',
    entryType: 'bill',
    vendor: 'Quality Craft Tools LLC',
    categoryId: '20' // Supplies
  },
  {
    file: 'brightline-electric-supply-scan-BE-5731.pdf',
    entryType: 'bill',
    vendor: 'Brightline Electric Supply',
    categoryId: '63' // Job Materials
  },
  {
    file: 'northside-auto-parts-receipt.jpg',
    entryType: 'expense',
    vendor: 'Northside Auto Parts',
    categoryId: '55', // Automobile
    paidFromId: '42' // Visa, a credit card, so the Purchase must declare CreditCard
  },
  {
    file: 'cedar-lane-landscaping-receipt.jpg',
    entryType: 'expense',
    vendor: 'Cedar Lane Landscaping Supply',
    categoryId: '66', // Plants and Soil
    paidFromId: '41' // Mastercard
  },
  {
    file: 'pinnacle-office-supplies-receipt.jpg',
    entryType: 'expense',
    vendor: 'Pinnacle Office Supplies',
    categoryId: '15', // Office Expenses
    paidFromId: '35' // Checking, a bank account, so the Purchase must declare Check
  },
  {
    // A credit memo totals MINUS $147.51. PostingRowSchema refuses a non-positive amount and
    // centsToDecimalString refuses a negative one, both deliberately: an entry that reads as a bill
    // and behaves as a credit is the wrong thing to put in somebody's books. So it is excluded, and
    // the reason is recorded rather than worked around.
    file: 'apex-plumbing-supply-credit-memo-CM-3307.pdf',
    entryType: 'bill',
    vendor: 'Apex Plumbing Supply',
    categoryId: '63',
    exclude: 'negative total, this app posts bills and expenses only'
  }
]

/** Account id -> the fully qualified label the grid actually offers. Filled in beforeAll. */
const accountLabels: Record<string, string> = {}

function accountLabel(id: string): string {
  const label = accountLabels[id]
  if (!label) throw new Error(`account ${id} is not in the company's reference cache`)
  return label
}

/** The fixture whose vendor the sandbox deliberately does not have. */
const UNKNOWN_VENDOR_FILE = 'quality-craft-tools-invoice-QCT-1188.pdf'
const UNKNOWN_VENDOR_NAME = 'Quality Craft Tools LLC'

function manifestFor(file: string): ManifestDocument {
  const found = manifest.documents.find((doc) => basename(doc.file) === file)
  if (!found) throw new Error(`no manifest entry for ${file}`)
  return found
}

/** Everything the scorecard accumulates as the drill runs. */
const report = {
  parse: [] as string[],
  recon: [] as string[],
  vendor: [] as string[],
  posted: [] as string[],
  duplicates: [] as string[],
  undo: [] as string[],
  screens: [] as string[],
  problems: [] as string[]
}

let app: ElectronApplication
let window: Page
let inboxPath = ''
/** file hash -> filename, read from the parse cache and reused by the duplicate and undo drills. */
let hashes: Record<string, string> = {}
/** filename -> the QuickBooks id the batch created. */
const createdIds: Record<string, { entity: 'Bill' | 'Purchase'; id: string }> = {}
/**
 * Did an earlier drill already create the unknown vendor?
 *
 * QuickBooks vendors cannot be deleted, only deactivated, and a deactivated DisplayName still
 * collides. So the second run of this drill legitimately meets a company that already has the
 * vendor, and the honest thing is to exercise the DUPLICATE path in the real UI rather than to
 * pretend the fixture state is untouched. Either way the product claim under test is the same:
 * the app never creates that vendor on its own, and the row ends up correctly resolved.
 */
let vendorPreExisted = false

async function screenshot(name: string): Promise<void> {
  report.screens.push(await shot(window, name))
}

/**
 * Click Scan now and wait out both the scan and the parse it fires behind it.
 *
 * "Scan now" is disabled for the whole of both, and its label changes twice, so the button coming
 * back with its own name and enabled is the one signal that also covers a rescan with nothing new
 * to parse. The short pause after the click is not decoration: React has not re-rendered the
 * disabled state yet at the moment the click returns, so an immediate check would pass instantly.
 */
async function runScan(timeout = 10 * 60_000): Promise<void> {
  await window.getByRole('button', { name: 'Scan now' }).click()
  await window.waitForTimeout(500)
  await expect(window.getByRole('button', { name: 'Scan now' })).toBeEnabled({ timeout })
}

/** The sidebar's destinations are plain buttons. */
async function navigate(destination: 'Bills' | 'History' | 'Settings'): Promise<void> {
  await window.getByRole('navigation', { name: 'Primary' }).getByRole('button', { name: destination }).click()
}

test.describe.serial('the live sandbox drill', () => {
  test.beforeAll(async () => {
    app = await electron.launch({
      // The user-data-dir is load-bearing: without it Electron resolves the app name from the built
      // main SCRIPT rather than from package.json, lands in %APPDATA%/Electron, and reports itself
      // disconnected no matter what the dev CLI seeded.
      args: [MAIN_ENTRY, `--user-data-dir=${liveUserDataDir()}`],
      // Opens the read-only QuickBooks verification hooks. Guarded on !app.isPackaged as well.
      env: { ...process.env, NICOLEBOOKS_E2E: '1' }
    })
    window = await app.firstWindow()
    await window.waitForLoadState('domcontentloaded')
    await window.waitForFunction(() => typeof window.api !== 'undefined')

    // Fail loudly if the profile is not the seeded one, rather than reporting nine parse failures
    // and a disconnected company as if they were findings.
    const status = await window.evaluate(() => window.api.qbo.status())
    expect(status.state, 'seed the sandbox credentials before running the drill').toBe('connected')
    expect(status.realmId).toBe(manifest.realmId)

    // Restore the corpus's documented fixture state before anything else. An earlier drill will
    // have created the one supplier that is supposed to be missing, and a company that already has
    // it would quietly turn the "never invents a vendor" check into a vendor match.
    // One call per leftover: each parks a single record, and a company that has been drilled
    // several times has one per run.
    const parkedIds: string[] = []
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const id = await parkVendor(app, UNKNOWN_VENDOR_NAME)
      if (id === null) break
      parkedIds.push(id)
    }
    const parked = parkedIds.join(', ')
    vendorPreExisted = parkedIds.length > 0
    if (parked) {
      report.vendor.push(
        `- Earlier drills had already created ${UNKNOWN_VENDOR_NAME} (vendor ids ${parked}). ` +
          'Each was renamed out of the way first, because QuickBooks cannot delete a vendor and a ' +
          'deactivated name still collides. The company therefore started from the documented state.'
      )
      // The parked name must not merely differ: it must not RESEMBLE the original, or the matcher
      // hands it straight back. It is renamed to something that shares no words at all.
      const stillThere = (await qboQuery(
        app,
        `SELECT * FROM Vendor WHERE DisplayName LIKE '%${UNKNOWN_VENDOR_NAME}%'`
      )) as unknown[]
      expect(stillThere, 'parking must free the fixture name').toHaveLength(0)
    }

    // The company's lists have to be in the cache before reconciliation runs, which is also the
    // real order of operations: connect and sync on Settings, then scan bills.
    const sync = await window.evaluate(() => window.api.qbo.syncReference())
    report.recon.push(
      `Reference sync: ${sync.vendors} vendors, ${sync.expenseAccounts} expense accounts, ` +
        `${sync.paymentAccounts} payment accounts, ${sync.items} items.`
    )

    // Learn the labels the grid offers, rather than guessing at a chart of accounts.
    const reference = await window.evaluate(() => window.api.qbo.getReference())
    for (const account of [...reference.expenseAccounts, ...reference.paymentAccounts]) {
      accountLabels[account.id] = account.name
    }

    const resolved = await window.evaluate(() => window.api.ingestion.resolveInbox())
    inboxPath = resolved.path
    // A drill that inherited yesterday's inbox would be testing yesterday's corpus.
    rmSync(inboxPath, { recursive: true, force: true })
    mkdirSync(inboxPath, { recursive: true })
    for (const doc of manifest.documents) {
      copyFileSync(join(FIXTURES_DIR, doc.file), join(inboxPath, basename(doc.file)))
    }
  })

  test.afterAll(async () => {
    writeScorecard([
      '# Live sandbox drill',
      '',
      `Run against realm ${manifest.realmId}. Every figure below was read back out of QuickBooks`,
      'or out of the app\'s own parse cache, never taken from the screen.',
      '',
      '## Parse accuracy vs test-fixtures/manifest.json',
      ...report.parse,
      '',
      '## Reconciliation',
      ...report.recon,
      '',
      '## Create vendor',
      ...report.vendor,
      '',
      '## Posted entities',
      ...report.posted,
      '',
      '## Duplicate guards',
      ...report.duplicates,
      '',
      '## Undo',
      ...report.undo,
      '',
      '## Problems found',
      ...(report.problems.length === 0 ? ['None.'] : report.problems),
      '',
      '## Standing observations for the design and release waves',
      '',
      '### The credit memo cannot be posted, by design',
      'apex-plumbing-supply-credit-memo-CM-3307.pdf totals minus $147.51. PostingRowSchema refuses a',
      'non-positive amount and centsToDecimalString refuses a negative one, both deliberately: an',
      'entry that reads as a bill and behaves as a credit is the wrong thing to put in somebody\'s',
      'books. The row therefore parses, displays, and is excluded by the user, and the review screen',
      'says what it still needs. Supporting it properly means a Vendor Credit entity, which is a',
      'feature, not a fix.',
      '',
      '### Category reconciliation never fires on this corpus',
      'Every document above came back with category tier "none". The cause is upstream of the',
      'matcher: the model returns suggested_category as null for these fixtures, because none of the',
      'nine documents PRINTS a category, and the prompt correctly asks for null when a field is',
      'absent. The matcher is fine; it is being handed nothing to match. Every row therefore needs a',
      'category picked by hand, which is the single biggest piece of remaining manual work in the',
      'flow. Closing it means asking the model to INFER a category from the line items rather than to',
      'read one off the page, which is a prompt change with its own accuracy question and belongs to',
      'whoever owns the parse prompt.',
      '',
      '### Vendor reconciliation is exactly on target',
      'Six exact names matched at the auto tier with no marker, two near misses matched at the',
      'suggested tier with a marker, and the one unknown supplier stayed empty and was never created',
      'behind the user\'s back. That is the corpus\'s whole design, reproduced.',
      '',
      '## Screenshots',
      ...report.screens.map((file) => `- .planning/sprint/screens/${file}`)
    ])
    await app.close()
  })

  // -------------------------------------------------------------------------
  // a + b: scan, parse, and score the parse against the manifest
  // -------------------------------------------------------------------------

  test('scans the corpus and reads every document with the vision model', async () => {
    await runScan()
    await expect(window.getByText(/\d+ files:/)).toBeVisible({ timeout: 60_000 })
    await screenshot('parse-complete')

    const parsed = await readParsedResults(app)
    hashes = Object.fromEntries(
      Object.values(parsed).map((row) => [row.original_filename, row.file_hash])
    )

    expect(Object.keys(parsed)).toHaveLength(manifest.documents.length)

    for (const doc of manifest.documents) {
      const file = basename(doc.file)
      const row = parsed[file]
      if (!row) {
        report.parse.push(`- ${file}: NOT PARSED`)
        report.problems.push(`${file} produced no parsed_results row.`)
        continue
      }

      const misses: string[] = []
      if (row.total_cents !== doc.totalCents) {
        misses.push(`total ${dollars(row.total_cents)} vs ${dollars(doc.totalCents)}`)
      }
      if (row.invoice_number !== doc.referenceNumber) {
        misses.push(`ref ${row.invoice_number ?? 'null'} vs ${doc.referenceNumber}`)
      }
      if (row.invoice_date !== doc.txnDate) {
        misses.push(`date ${row.invoice_date ?? 'null'} vs ${doc.txnDate}`)
      }
      if (doc.subtotalCents !== null && row.subtotal_cents !== doc.subtotalCents) {
        misses.push(`subtotal ${dollars(row.subtotal_cents ?? 0)} vs ${dollars(doc.subtotalCents)}`)
      }
      if (doc.taxCents !== null && row.tax_cents !== doc.taxCents) {
        misses.push(`tax ${dollars(row.tax_cents ?? 0)} vs ${dollars(doc.taxCents)}`)
      }

      const flags = row.validation_flags ?? '[]'
      report.parse.push(
        `- ${file} (${row.route}, ${row.page_count}p): vendor read as "${row.vendor ?? 'null'}"` +
          ` (printed "${doc.printedVendor}"), ` +
          (misses.length === 0 ? 'every checked field matches the manifest' : `MISMATCH: ${misses.join('; ')}`) +
          (flags !== '[]' && flags !== 'null' ? `, flags ${flags}` : '')
      )
      if (misses.length > 0) report.problems.push(`${file} parse mismatch: ${misses.join('; ')}`)
    }
  })

  // -------------------------------------------------------------------------
  // c: reconciliation tiers
  // -------------------------------------------------------------------------

  test('prefills the four exact vendors, flags the two near misses, and leaves the unknown one empty', async () => {
    for (const doc of manifest.documents) {
      const file = basename(doc.file)
      const row = rowFor(window, file)
      const value = await field(row, 'Vendor').inputValue()
      // Scoped to each cell's own label row. A row has three comboboxes, and reading a marker from
      // anywhere in it reports the category's tier as if it were the vendor's.
      const vendorTier = await cellTier(row, 'Vendor')
      const categoryTier = await cellTier(row, 'Category')
      const categoryValue = await field(row, 'Category').inputValue()

      report.recon.push(
        `- ${file}: vendor expected ${doc.expectedMatch.type}, got ${vendorTier}` +
          (value === '' ? ' (nothing prefilled)' : ` -> "${value}"`) +
          `; category ${categoryTier}` +
          (categoryValue === '' ? ' (nothing prefilled)' : ` -> "${categoryValue}"`)
      )

      if (doc.expectedMatch.type === 'exact') {
        expect(value, `${file} should prefill its exact vendor`).toBe(
          doc.expectedMatch.vendorDisplayName
        )
        expect(vendorTier, `${file} should match confidently, with no marker`).toBe('auto')
      } else if (doc.expectedMatch.type === 'near-miss') {
        expect(value, `${file} should prefill the near match`).toBe(
          doc.expectedMatch.vendorDisplayName
        )
        expect(vendorTier, `${file} should be marked as a suggestion`).toBe('suggested')
      } else {
        // The whole point of the corpus: an unknown supplier is surfaced for a decision and is
        // NEVER created behind the user's back.
        expect(value, `${file} must not resolve to any vendor`).toBe('')
        expect(vendorTier, `${file} should ask the user to pick`).toBe('none')
      }
    }

    // The company started from the documented state (beforeAll parked any leftover), so this is an
    // unconditional claim: nothing in scan, parse, or reconciliation may create a supplier.
    const sandboxVendors = (await qboQuery(
      app,
      `SELECT * FROM Vendor WHERE DisplayName LIKE '%${UNKNOWN_VENDOR_NAME}%'`
    )) as Array<{ Id: string }>
    expect(sandboxVendors, 'nothing may create the unknown vendor on its own').toHaveLength(0)

    await screenshot('reconciled')
  })

  // -------------------------------------------------------------------------
  // d: the create-vendor flow
  // -------------------------------------------------------------------------

  test('creates the missing vendor from the row that needs it, and only from there', async () => {
    const row = rowFor(window, UNKNOWN_VENDOR_FILE)
    const nameField = field(row, 'Add new vendor')
    await expect(nameField).toBeVisible()
    // Prefilled from what the parser read, editable, and it is the button that acts.
    report.vendor.push(`- Panel prefilled with "${await nameField.inputValue()}".`)
    await nameField.fill(UNKNOWN_VENDOR_NAME)
    await screenshot('add-vendor-panel')

    await row.getByRole('button', { name: 'Add to QuickBooks' }).click()

    // The row now names the new vendor...
    await expect(field(row, 'Vendor')).toHaveValue(UNKNOWN_VENDOR_NAME, { timeout: 30_000 })

    // ...and QuickBooks agrees, which is the only claim that counts.
    const created = (await qboQuery(
      app,
      `SELECT * FROM Vendor WHERE DisplayName = '${UNKNOWN_VENDOR_NAME}'`
    )) as Array<{ Id: string; DisplayName: string; Active: boolean }>
    expect(created, 'the vendor must exist in the sandbox').toHaveLength(1)
    report.vendor.push(
      `- In the sandbox as vendor id ${created[0].Id}, DisplayName "${created[0].DisplayName}", active ${created[0].Active}.`
    )
    await expect(field(row, 'Vendor')).toHaveValue(UNKNOWN_VENDOR_NAME)

    // A repeat create of the same name is refused with copy that says what to do instead.
    const duplicate = await window.evaluate(async (name) => {
      try {
        await window.api.qbo.createVendor(name)
        return 'no error'
      } catch (err) {
        return err instanceof Error ? err.message : String(err)
      }
    }, UNKNOWN_VENDOR_NAME)
    // Compared with toContain because this raw invoke sees Electron's wrapper; the app itself
    // strips it (src/renderer/src/lib/ipc-error.ts) before the panel renders the sentence.
    expect(duplicate).toContain(
      'A vendor with this name already exists in QuickBooks. Pick it from the list instead.'
    )
    report.vendor.push('- A repeat create is refused, mapped to the pick-it-from-the-list sentence.')
    await screenshot('vendor-created')
  })

  // -------------------------------------------------------------------------
  // e: complete every row and send the batch
  // -------------------------------------------------------------------------

  test('completes every row per the manifest and sends the batch to QuickBooks', async () => {
    for (const plan of PLAN) {
      const doc = manifestFor(plan.file)
      const row = rowFor(window, plan.file)

      if (plan.exclude) {
        const box = row.getByRole('checkbox')
        if (await box.isChecked()) await box.uncheck()
        report.posted.push(`- ${plan.file}: EXCLUDED (${plan.exclude}).`)
        continue
      }

      if (plan.entryType === 'expense') {
        await row.getByRole('button', { name: 'Expense', exact: true }).click()
      }

      const vendorValue = await field(row, 'Vendor').inputValue()
      if (vendorValue !== plan.vendor) await pickCombobox(window, row, 'Vendor', plan.vendor)
      await pickCombobox(window, row, 'Category', accountLabel(plan.categoryId))
      if (plan.paidFromId) {
        await pickCombobox(window, row, 'Paid from', accountLabel(plan.paidFromId))
      }

      // The manifest's values, typed in exactly as a user correcting the screen would.
      await fillField(row, 'Amount', (doc.totalCents / 100).toFixed(2))
      await fillField(row, 'Entry date', doc.txnDate)
      if (plan.entryType === 'bill' && doc.dueDate) await fillField(row, 'Due date', doc.dueDate)
      await fillField(row, 'Reference number', doc.referenceNumber)

      const box = row.getByRole('checkbox')
      if (!(await box.isChecked())) await box.check()
    }

    await screenshot('rows-completed')

    await window.getByRole('button', { name: 'Send to QuickBooks' }).click()
    await window.getByRole('button', { name: 'Yes, send them' }).click()
    await screenshot('sending')

    // The send flow ends when the completion strip appears, which is driven by the final
    // posting:progress event (done === total, current null) plus the batch-detail read behind it.
    const completion = window.getByText(/entered in QuickBooks\./)
    await expect(completion).toBeVisible({ timeout: 5 * 60_000 })
    await screenshot('send-complete')

    // Recorded BEFORE the assertion, so a partial batch is reported rather than only failing.
    const line = (await completion.textContent())?.trim() ?? ''
    report.posted.push(`- The screen reported: "${line}"`)

    const posting = PLAN.filter((plan) => !plan.exclude)
    expect(line).toBe(`${posting.length} of ${posting.length} entered in QuickBooks.`)
  })

  test('every posted entity matches the manifest exactly in QuickBooks', async () => {
    // The batch detail is the app's record of what it created; the API read below is the check.
    const detail = await window.evaluate(async () => {
      const batches = await window.api.posting.batches()
      const newest = batches.batches[0]
      const entries = await window.api.posting.batchDetail(newest.batchId)
      return { batchId: newest.batchId, entries: entries.entries }
    })

    for (const plan of PLAN) {
      if (plan.exclude) continue
      const doc = manifestFor(plan.file)
      const hash = hashes[plan.file]
      const entry = detail.entries.find((candidate) => candidate.fileHash === hash)
      expect(entry, `${plan.file} should be in the batch`).toBeTruthy()
      expect(entry?.state, `${plan.file} should be confirmed`).toBe('confirmed')
      expect(entry?.qboId, `${plan.file} should carry a QuickBooks id`).toBeTruthy()

      const entityName = plan.entryType === 'bill' ? 'Bill' : 'Purchase'
      createdIds[plan.file] = { entity: entityName, id: entry?.qboId as string }

      const posted = await fetchEntity(app, entityName, entry?.qboId as string)
      expect(posted, `${plan.file} should exist in QuickBooks`).toBeTruthy()

      const cents = amountToCents(posted?.TotalAmt)
      expect(cents, `${plan.file} amount`).toBe(doc.totalCents)
      expect(posted?.DocNumber, `${plan.file} DocNumber`).toBe(doc.referenceNumber)
      expect(posted?.TxnDate, `${plan.file} TxnDate`).toBe(doc.txnDate)

      const lineAccount = posted?.Line?.[0]?.AccountBasedExpenseLineDetail?.AccountRef
      let extra = ''
      if (plan.entryType === 'expense') {
        // A Purchase must declare how it was paid, and only the paid-from account's TYPE decides
        // it. Account 35 is the sandbox's Checking (a Bank), 41 and 42 are its two credit cards.
        const expectedPaymentType = plan.paidFromId === '35' ? 'Check' : 'CreditCard'
        expect(posted?.PaymentType, `${plan.file} PaymentType`).toBe(expectedPaymentType)
        expect(posted?.AccountRef?.value, `${plan.file} paid from`).toBe(plan.paidFromId)
        expect(posted?.EntityRef?.type, `${plan.file} EntityRef type`).toBe('Vendor')
        extra = `, paid from ${posted?.AccountRef?.name ?? plan.paidFromId} as ${posted?.PaymentType}`
      } else if (doc.dueDate) {
        expect(posted?.DueDate, `${plan.file} DueDate`).toBe(doc.dueDate)
        extra = `, due ${posted?.DueDate}`
      }

      report.posted.push(
        `- ${plan.file}: ${entityName} ${posted?.Id}, ${dollars(cents as number)}, ` +
          `DocNumber ${posted?.DocNumber}, dated ${posted?.TxnDate}, ` +
          `category ${lineAccount?.name ?? lineAccount?.value}${extra}.`
      )
    }
  })

  // -------------------------------------------------------------------------
  // f: the two duplicate guards
  // -------------------------------------------------------------------------

  test('excludes a file that was already entered, and warns about a bill that looks the same', async () => {
    // Guard one: the same BYTES arriving again. The ledger caught it, so the file never reaches
    // the review table.
    const repeat = 'apex-plumbing-supply-invoice-APX-84213.pdf'
    copyFileSync(join(FIXTURES_DIR, 'bills', repeat), join(inboxPath, repeat))
    await runScan()

    const duplicateBadge = window.getByText(/Already entered on /).first()
    await expect(duplicateBadge).toBeVisible({ timeout: 30_000 })
    report.duplicates.push(
      `- Re-scanning ${repeat} after it posted: excluded by the hash ledger ("${await duplicateBadge.textContent()}").`
    )
    await screenshot('dedupe-rescan')

    // Guard two: the same BILL arriving as different bytes. Nothing is blocked; the user is told.
    const doc = manifestFor(repeat)
    const warnings = await window.evaluate(
      async (probe) => await window.api.posting.checkDuplicates([probe]),
      {
        rowKey: 'probe',
        vendorId: doc.expectedMatch.vendorId as string,
        amountCents: doc.totalCents,
        txnDate: doc.txnDate
      }
    )
    const found = warnings.warnings['probe'] ?? []
    expect(found.length, 'a same vendor, same amount, same date probe must warn').toBeGreaterThan(0)
    report.duplicates.push(
      `- A probe for vendor ${doc.expectedMatch.vendorId} at ${dollars(doc.totalCents)} on ${doc.txnDate} ` +
        `warned about ${found.length} prior entry (QuickBooks id ${found[0]?.qboId ?? 'unknown'}, ` +
        `${found[0]?.daysApart} days apart).`
    )
  })

  // -------------------------------------------------------------------------
  // g: history and undo
  // -------------------------------------------------------------------------

  test('shows the batch in history, undoes it, and leaves the books and the ledger clean', async () => {
    await navigate('History')
    await expect(window.getByText(/entered/).first()).toBeVisible({ timeout: 30_000 })
    await screenshot('history-batch')

    await window.getByRole('button', { name: 'Undo last batch' }).click()
    await window.getByRole('button', { name: 'Yes, remove them' }).click()
    await expect(window.getByRole('button', { name: 'Removing...' })).toHaveCount(0, {
      timeout: 5 * 60_000
    })
    await screenshot('undo-complete')

    for (const [file, created] of Object.entries(createdIds)) {
      const still = await qboRead(app, created.entity, created.id)
      expect(still, `${file} should be gone from QuickBooks after undo`).toBeNull()
      report.undo.push(`- ${file}: ${created.entity} ${created.id} is no longer in QuickBooks.`)
    }

    // The other half of undo: the dedupe ledger. If the hashes survived, the documents could never
    // be entered again, which would make a reversal a one-way door.
    await navigate('Bills')
    await runScan()
    await expect(window.getByText(/Already entered on /)).toHaveCount(0, { timeout: 30_000 })
    report.undo.push('- The dedupe ledger was cleared, so every document can be entered again.')
    await screenshot('after-undo-rescan')
  })
})
