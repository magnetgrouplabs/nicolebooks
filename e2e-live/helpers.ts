// e2e-live/helpers.ts
//
// Shared machinery for the live sandbox drill: the QuickBooks read-back channel, the parsed-result
// reader, the review-grid drivers, and the scorecard writer.
//
// EVERY VERIFICATION IN THIS DIRECTORY IS INDEPENDENT OF THE APP'S OPINION. The app saying a batch
// posted is not evidence that it posted. So amounts, dates, document numbers, entity types, and
// payment methods are all read back out of the QuickBooks company itself, and compared against
// test-fixtures/manifest.json, which is the ground truth the corpus was generated from.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'

export const REPO_ROOT = resolve(__dirname, '..')

/**
 * The profile the dev CLI seeds, which the drill MUST launch against.
 *
 * This is not a detail. Playwright launches Electron with the built main script as an argument
 * rather than the project directory, and Electron then resolves the app name to "Electron" instead
 * of to package.json's "nicolebooks": the app quietly gets %APPDATA%/Electron and reports itself
 * disconnected, no matter what was seeded. Naming the directory explicitly is what makes
 * `npx electron . --dev-seed-qbo` and this drill agree about which profile they are talking about.
 *
 * NICOLEBOOKS_USER_DATA overrides it, for a machine whose profile lives somewhere else.
 */
export function liveUserDataDir(): string {
  const override = process.env['NICOLEBOOKS_USER_DATA']
  if (override) return resolve(override)
  if (process.platform === 'win32') {
    return join(process.env['APPDATA'] ?? '', 'nicolebooks')
  }
  if (process.platform === 'darwin') {
    return join(process.env['HOME'] ?? '', 'Library', 'Application Support', 'nicolebooks')
  }
  return join(process.env['HOME'] ?? '', '.config', 'nicolebooks')
}
export const FIXTURES_DIR = join(REPO_ROOT, 'test-fixtures')
export const SCREENS_DIR = join(REPO_ROOT, '.planning', 'sprint', 'screens')
export const SCORECARD_PATH = join(REPO_ROOT, '.planning', 'sprint', 'LIVE-DRILL.md')

/** One document's ground truth, as test-fixtures/manifest.json records it. */
export interface ManifestDocument {
  file: string
  kind: string
  docType: string
  printedVendor: string
  expectedMatch: { type: string; vendorDisplayName: string | null; vendorId: string | null }
  referenceNumber: string
  txnDate: string
  dueDate: string | null
  subtotalCents: number | null
  taxCents: number | null
  totalCents: number
  lineCount: number
  hint: { type: string; account: string; paidFrom: string | null }
}

export interface Manifest {
  realmId: string
  documents: ManifestDocument[]
}

export function readManifest(): Manifest {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, 'manifest.json'), 'utf8')) as Manifest
}

/** The bare filename of a manifest entry ('bills/x.pdf' -> 'x.pdf'). */
export function basename(file: string): string {
  return file.split('/').pop() ?? file
}

// ---------------------------------------------------------------------------
// The QuickBooks read-back channel
// ---------------------------------------------------------------------------

/**
 * Run one Accounting API query through the RUNNING APP's authenticated client.
 *
 * Going through the app rather than calling Intuit directly is deliberate. The refresh token rolls,
 * so a spec that refreshed on its own would invalidate the shared credentials file everybody else
 * seeds from; the app already handles rotation correctly in one place. It is also the cheapest
 * possible proof that the posting bridge is wired: if the provider were still unregistered, every
 * call here would fail with the not-connected code.
 */
export async function qboQuery(app: ElectronApplication, statement: string): Promise<unknown[]> {
  return await app.evaluate(async (_electron, stmt) => {
    const hooks = (globalThis as Record<string, unknown>)['__nicolebooksE2E'] as
      | { qboQuery(s: string): Promise<unknown[]> }
      | undefined
    if (!hooks) throw new Error('the e2e read hooks are not installed (NICOLEBOOKS_E2E=1?)')
    return await hooks.qboQuery(stmt)
  }, statement)
}

/** Read one entity by id. null is the answer undo produces, and it is the answer undo is checked on. */
export async function qboRead(
  app: ElectronApplication,
  entity: 'Bill' | 'Purchase',
  id: string
): Promise<{ id: string; syncToken: string } | null> {
  return await app.evaluate(async (_electron, arg) => {
    const hooks = (globalThis as Record<string, unknown>)['__nicolebooksE2E'] as
      | { qboRead(e: string, i: string): Promise<{ id: string; syncToken: string } | null> }
      | undefined
    if (!hooks) throw new Error('the e2e read hooks are not installed (NICOLEBOOKS_E2E=1?)')
    return await hooks.qboRead(arg.entity, arg.id)
  }, { entity, id })
}

/**
 * Rename a leftover vendor out of the way, restoring the corpus's documented fixture state.
 *
 * The corpus is built around one supplier being ABSENT from the company, because that absence is
 * what proves the app never invents a vendor. A drill run creates it, so every later run would be
 * testing a company whose fixture state the previous run consumed. QuickBooks cannot delete a
 * vendor and a deactivated name still collides, so parking it is the only way back.
 */
export async function parkVendor(
  app: ElectronApplication,
  displayName: string
): Promise<string | null> {
  return await app.evaluate(async (_electron, name) => {
    const hooks = (globalThis as Record<string, unknown>)['__nicolebooksE2E'] as
      | { qboParkVendor(n: string): Promise<string | null> }
      | undefined
    if (!hooks) throw new Error('the e2e hooks are not installed (NICOLEBOOKS_E2E=1?)')
    return await hooks.qboParkVendor(name)
  }, displayName)
}

/** A posted entity as the drill checks it, with money kept as the decimal STRING Intuit returned. */
export interface PostedEntity {
  Id: string
  DocNumber?: string
  TxnDate?: string
  TotalAmt?: number
  DueDate?: string
  PaymentType?: string
  AccountRef?: { value: string; name?: string }
  VendorRef?: { value: string; name?: string }
  EntityRef?: { value: string; name?: string; type?: string }
  Line?: Array<{
    Amount?: number
    AccountBasedExpenseLineDetail?: { AccountRef?: { value: string; name?: string } }
  }>
}

/** Fetch one posted entity in full, by id, so every field can be compared to the manifest. */
export async function fetchEntity(
  app: ElectronApplication,
  entity: 'Bill' | 'Purchase',
  id: string
): Promise<PostedEntity | null> {
  const rows = (await qboQuery(app, `SELECT * FROM ${entity} WHERE Id = '${id}'`)) as PostedEntity[]
  return rows[0] ?? null
}

// ---------------------------------------------------------------------------
// What the parser produced
// ---------------------------------------------------------------------------

/** One row of the main-side parsed_results cache, which is what the review grid was seeded from. */
export interface ParsedRow {
  file_hash: string
  original_filename: string
  route: string
  page_count: number
  vendor: string | null
  invoice_number: string | null
  invoice_date: string | null
  due_date: string | null
  subtotal_cents: number | null
  tax_cents: number | null
  total_cents: number
  validation_flags: string | null
  truncated: number
}

/**
 * Read every parsed row straight out of the app's SQLite cache.
 *
 * The cache rather than the DOM, because the scorecard compares CENTS and the screen shows dollars,
 * and because a rounding difference introduced by a display formatter would be indistinguishable
 * from a parse error. Opened read-only, so the running app stays the only writer.
 */
export async function readParsedResults(
  app: ElectronApplication
): Promise<Record<string, ParsedRow>> {
  const userData = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'))
  // Required lazily and from the spec process, which has the same better-sqlite3 build vitest uses.
  const Database = (await import('better-sqlite3')).default
  const db = new Database(join(userData, 'app.db'), { readonly: true })
  try {
    const rows = db.prepare('SELECT * FROM parsed_results').all() as ParsedRow[]
    const byFilename: Record<string, ParsedRow> = {}
    for (const row of rows) byFilename[row.original_filename] = row
    return byFilename
  } finally {
    db.close()
  }
}

// ---------------------------------------------------------------------------
// Driving the review grid
// ---------------------------------------------------------------------------

/**
 * The review row card for one document, located by the filename it prints.
 *
 * FIRST, not last. A duplicate notice inside a row renders its own nested <li> that also names the
 * file, and the scan list further down the screen renders another one for an excluded duplicate.
 * The review row is the outermost and therefore the earliest of the three in document order.
 */
export function rowFor(window: Page, filename: string) {
  return window.locator('li').filter({ has: window.locator(`text="${filename}"`) }).first()
}

/**
 * Choose an option in one of the row's comboboxes.
 *
 * The combobox swaps its own value between "the choice" (closed) and "the search box" (open), so
 * the sequence is: focus to open, type to narrow, click the option. Clicking the option rather than
 * pressing Enter, because Enter depends on the active index and the click is what a user does.
 */
/**
 * One labelled INPUT inside a row.
 *
 * `.and(locator('input'))` is load-bearing. An open combobox renders its popup as
 * `<ul role="listbox" aria-label="Category">`, which is a second element carrying that accessible
 * name, so a bare getByLabel('Category') becomes ambiguous the moment the list is open. Narrowing
 * to the input is what makes the locator stable across the open and closed states.
 */
export function field(row: ReturnType<typeof rowFor>, label: string) {
  return row.getByLabel(label, { exact: true }).and(row.locator('input'))
}

/**
 * Which reconciliation tier ONE cell landed in: 'auto', 'suggested', 'none', or 'manual'.
 *
 * Scoped to the cell's own label row, which matters more than it looks. The markers are badges
 * beside each label, and a row carries three comboboxes: reading "needs your pick" anywhere in the
 * row reports the CATEGORY's tier as if it were the vendor's, which is exactly the wrong answer on
 * a screen whose whole job is telling those two apart.
 *
 * 'manual' is the fourth, quieter state: reconciliation said nothing about this cell (it did not
 * run, or it rejected), so there is no marker and no selection to explain.
 */
export async function cellTier(
  row: ReturnType<typeof rowFor>,
  label: string
): Promise<'auto' | 'suggested' | 'none' | 'manual'> {
  const labelRow = row.locator('label').filter({ hasText: new RegExp(`^${label}$`) }).locator('xpath=..')
  const text = (await labelRow.textContent()) ?? ''
  if (text.includes('needs your pick')) return 'none'
  if (text.includes('suggested match')) return 'suggested'
  const value = await field(row, label).inputValue()
  return value === '' ? 'manual' : 'auto'
}

export async function pickCombobox(
  window: Page,
  row: ReturnType<typeof rowFor>,
  label: string,
  optionLabel: string
): Promise<void> {
  const control = field(row, label)
  await control.click()
  await control.fill(optionLabel)
  // Matched on the option's leading text, NOT on its accessible name. An account option renders its
  // name and then its subtype as a quiet second line, so its accessible name is
  // "Job Expenses:Job MaterialsSuppliesMaterials" and an exact-name match would never hit. Anchoring
  // at the start is also what keeps "Supplies" from selecting "Office Supplies".
  const option = row
    .locator('[role="option"]')
    .filter({ hasText: new RegExp(`^${escapeRegExp(optionLabel)}`) })
    .first()
  await option.waitFor({ state: 'visible', timeout: 10_000 })
  await option.click()
  // The panel closes on the click; give React the tick it needs before the next field is touched.
  await window.waitForTimeout(50)
}

/** Escape a QuickBooks name for use inside a RegExp. Account names carry ':' and '&'. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Fill one of the row's labeled text or date inputs. */
export async function fillField(
  row: ReturnType<typeof rowFor>,
  label: string,
  value: string
): Promise<void> {
  await field(row, label).fill(value)
}

// ---------------------------------------------------------------------------
// Screenshots and the scorecard
// ---------------------------------------------------------------------------

let shotIndex = 0

/** Save a numbered full-page screenshot. The numbers are the drill's order of events. */
export async function shot(window: Page, name: string): Promise<string> {
  shotIndex += 1
  const file = `${String(shotIndex).padStart(2, '0')}-${name}.png`
  const path = join(SCREENS_DIR, file)
  mkdirSync(dirname(path), { recursive: true })
  await window.screenshot({ path, fullPage: true })
  return file
}

/** Write the drill scorecard, which is committed for the design and release waves to read. */
export function writeScorecard(lines: string[]): void {
  mkdirSync(dirname(SCORECARD_PATH), { recursive: true })
  writeFileSync(SCORECARD_PATH, lines.join('\n') + '\n', 'utf8')
}

/** Money as the manifest states it, for a report line. */
export function dollars(cents: number): string {
  const sign = cents < 0 ? '-' : ''
  const digits = Math.abs(cents).toString().padStart(3, '0')
  return `${sign}$${digits.slice(0, -2)}.${digits.slice(-2)}`
}

/** Intuit returns TotalAmt as a JSON number. Compare in cents, never in floats. */
export function amountToCents(amount: number | undefined): number | null {
  if (typeof amount !== 'number') return null
  return Math.round(amount * 100)
}
