// .planning/sprint/screens-after/capture.mjs
//
// Recaptures the DESIGN wave's after-set: the same eleven states the live drill screenshotted in
// .planning/sprint/screens/, plus three light-theme frames, so the two sets can be flipped between.
//
//   node .planning/sprint/screens-after/capture.mjs
//
// It drives the REAL built app (out/main + out/renderer) through Playwright's Electron handle, the
// same way e2e/ does. What it does not do is touch a live service: the drill's states came from a
// QuickBooks sandbox and a vision model, and reproducing them for a screenshot pass would mean
// spending money and needing credentials this agent is not given.
//
// So the main process's ipcMain handlers are replaced in place with stateful fakes carrying the
// drill's own documents and vendors. Everything above the IPC boundary is the shipping app: the
// real renderer bundle, the real components, the real theme. Only the answers are fixtures.
//
// The window is sized to 1779x1106 to match the before-set exactly, so the two directories can be
// compared frame by frame without scaling anything.

import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright-core'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..', '..', '..')
const MAIN_ENTRY = join(REPO, 'out', 'main', 'index.js')

const WIDTH = 1779
const HEIGHT = 1106

/**
 * Frame names are written out rather than auto-numbered, because 01 to 11 have to keep the exact
 * names the drill's before-set uses so the two directories line up file for file. The states this
 * pass adds carry a letter (05a) or continue past the end (12 onward).
 */
async function shot(page, name) {
  const file = join(HERE, `${name}.png`)
  await page.screenshot({ path: file })
  console.log('captured', file)
}

async function main() {
  const userDataDir = join(tmpdir(), `nb-screens-${Date.now()}`)
  mkdirSync(userDataDir, { recursive: true })
  const app = await electron.launch({ args: [MAIN_ENTRY, `--user-data-dir=${userDataDir}`] })

  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.waitForFunction(() => typeof window.api !== 'undefined')

    await app.evaluate(({ BrowserWindow, nativeTheme }, size) => {
      nativeTheme.themeSource = 'dark'
      const win = BrowserWindow.getAllWindows()[0]
      win.setContentSize(size.width, size.height)
      win.center()
    }, { width: WIDTH, height: HEIGHT })

    await installFakes(app)
    await page.reload()
    await page.waitForFunction(() => typeof window.api !== 'undefined')
    await page.waitForTimeout(400)

    // ---------------------------------------------------------------------
    // 01 / 02: a fresh batch, read and reconciled.
    // ---------------------------------------------------------------------
    await page.getByRole('button', { name: 'Scan now' }).click()
    await page.waitForTimeout(900)
    await shot(page, '01-parse-complete')

    await page.mouse.wheel(0, 620)
    await page.waitForTimeout(500)
    await shot(page, '02-reconciled')

    // ---------------------------------------------------------------------
    // 03 / 04: the unknown supplier, and the vendor the user creates for it.
    // ---------------------------------------------------------------------
    const unknownRow = page
      .locator('li')
      .filter({ hasText: 'quality-craft-tools-invoice-QCT-1188.pdf' })
      .last()
    await unknownRow.scrollIntoViewIfNeeded()
    await page.waitForTimeout(400)
    await shot(page, '03-add-vendor-panel')

    await unknownRow.getByRole('button', { name: 'Add to QuickBooks' }).click()
    await page.waitForTimeout(900)
    await unknownRow.scrollIntoViewIfNeeded()
    await page.waitForTimeout(300)
    await shot(page, '04-vendor-created')

    // ---------------------------------------------------------------------
    // 05: every row complete, so the send gate opens.
    // ---------------------------------------------------------------------
    await completeEveryRow(page)
    await page.mouse.wheel(0, -6000)
    await page.waitForTimeout(500)
    await shot(page, '05-rows-completed')

    // ---------------------------------------------------------------------
    // 06 / 07: the send confirmation, the send itself, and the receipt strip.
    // ---------------------------------------------------------------------
    await page.getByRole('button', { name: 'Send to QuickBooks' }).click()
    await page.waitForTimeout(500)
    await shot(page, '05a-send-confirm')

    await page.getByRole('button', { name: 'Yes, send them' }).click()
    await page.waitForTimeout(700)
    await shot(page, '06-sending')

    await page.waitForTimeout(2200)
    await shot(page, '07-send-complete')

    // ---------------------------------------------------------------------
    // 08: rescanning the same folder, now that the documents are in the books.
    // ---------------------------------------------------------------------
    await app.evaluate(() => {
      globalThis.__nbScreens.scanMode = 'dedupe'
    })
    await page.getByRole('button', { name: 'Scan now' }).click()
    await page.waitForTimeout(1200)
    await shot(page, '08-dedupe-rescan')

    // ---------------------------------------------------------------------
    // 09 / 10: the history receipt, and the undo that reverses it.
    // ---------------------------------------------------------------------
    await page.getByRole('button', { name: 'History' }).click()
    await page.waitForTimeout(500)
    await page.getByRole('button', { name: /entered/ }).first().click()
    await page.waitForTimeout(600)
    await shot(page, '09-history-batch')

    await page.getByRole('button', { name: 'Undo last batch' }).click()
    await page.waitForTimeout(300)
    await page.getByRole('button', { name: 'Yes, remove them' }).click()
    await page.waitForTimeout(900)
    await shot(page, '10-undo-complete')

    // ---------------------------------------------------------------------
    // 11: back on Bills, the documents are enterable again.
    // ---------------------------------------------------------------------
    await app.evaluate(() => {
      globalThis.__nbScreens.scanMode = 'after-undo'
    })
    await page.getByRole('button', { name: 'Bills' }).click()
    await page.waitForTimeout(300)
    await page.getByRole('button', { name: 'Scan now' }).click()
    await page.waitForTimeout(1400)
    await shot(page, '11-after-undo-rescan')

    // ---------------------------------------------------------------------
    // 12 to 14: the surfaces the drill never framed, and the light theme.
    // ---------------------------------------------------------------------
    await page.getByRole('button', { name: 'Add from phone' }).click()
    await page.waitForTimeout(700)
    await shot(page, '12-phone-upload-dialog')

    await page.keyboard.press('Escape')
    await page.waitForTimeout(400)

    await app.evaluate(({ nativeTheme }) => {
      nativeTheme.themeSource = 'light'
    })
    await page.waitForTimeout(500)
    await page.mouse.wheel(0, 700)
    await page.waitForTimeout(400)
    await shot(page, '13-light-review')

    await page.getByRole('button', { name: 'Settings' }).click()
    await page.waitForTimeout(500)
    await shot(page, '14-light-settings')

    await page.getByRole('button', { name: 'History' }).click()
    await page.waitForTimeout(500)
    await page.getByRole('button', { name: /removed/ }).first().click()
    await page.waitForTimeout(600)
    await shot(page, '15-light-history')
  } finally {
    await app.close()
  }

  rmSync(userDataDir, { recursive: true, force: true })
}

/**
 * Fill in what the user would: every empty Category, and the amount on the row whose total the
 * model could not read (which is deliberately left at a flagged $0.00 for frames 01 to 04, because
 * a flagged money value is exactly what the review screen exists to catch).
 */
async function completeEveryRow(page) {
  const boxes = page.locator('input[role="combobox"]')
  const empties = await page.evaluate(() => {
    const found = []
    document.querySelectorAll('input[role="combobox"]').forEach((el, index) => {
      const label = el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`) : null
      if (label?.textContent?.trim() === 'Category' && el.value === '') found.push(index)
    })
    return found
  })

  for (const index of empties) {
    const box = boxes.nth(index)
    await box.scrollIntoViewIfNeeded()
    await box.click()
    await page.waitForTimeout(150)
    const option = page.getByRole('option').first()
    if (await option.isVisible().catch(() => false)) {
      await option.click()
    } else {
      await page.keyboard.press('Escape')
    }
    await page.waitForTimeout(120)
  }

  const invalid = page.locator('input[aria-invalid="true"]')
  const invalidCount = await invalid.count()
  for (let index = 0; index < invalidCount; index += 1) {
    const field = invalid.nth(0)
    if ((await field.count()) === 0) break
    await field.scrollIntoViewIfNeeded()
    await field.fill('412.00')
    await page.waitForTimeout(150)
  }
}

/**
 * Replace the main process's handlers with stateful fakes.
 *
 * Everything below is data the live drill produced, retyped: the same six documents, the same
 * vendors, the same unmatched supplier. The one deliberate difference is that the send always
 * succeeds, because a failed row is a state the before-set never framed.
 */
async function installFakes(app) {
  await app.evaluate(({ ipcMain, BrowserWindow }) => {
    const send = (channel, payload) => {
      const win = BrowserWindow.getAllWindows()[0]
      if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
    }

    const hash = (seed) => seed.repeat(64).slice(0, 64)

    const DOCS = [
      {
        filename: 'apex-plumbing-supply-invoice-APX-84213.pdf',
        hash: hash('a'),
        vendorId: '58',
        fields: {
          vendor: 'Apex Plumbing Supply',
          invoiceNumber: 'APX-84213',
          invoiceDate: '2026-07-08',
          dueDate: '2026-08-07',
          subtotalCents: 57995,
          taxCents: 5002,
          totalCents: 62997,
          currency: 'USD',
          suggestedCategory: 'Job Materials'
        }
      },
      {
        filename: 'apex-plumbing-supply-credit-memo-CM-3307.pdf',
        hash: hash('b'),
        vendorId: '58',
        fields: {
          vendor: 'Apex Plumbing Supply',
          invoiceNumber: 'CM-3307',
          invoiceDate: '2026-07-23',
          dueDate: null,
          subtotalCents: 13580,
          taxCents: 1171,
          totalCents: 14751,
          currency: 'USD',
          suggestedCategory: 'Job Materials'
        }
      },
      {
        filename: 'pinnacle-office-supplies-PN-2026-4419.pdf',
        hash: hash('c'),
        vendorId: '61',
        fields: {
          vendor: 'Pinnacle Office Supplies',
          invoiceNumber: 'PN-2026-4419',
          invoiceDate: '2026-07-20',
          dueDate: null,
          subtotalCents: 26171,
          taxCents: 2257,
          totalCents: 28428,
          currency: 'USD',
          suggestedCategory: 'Office Supplies'
        }
      },
      {
        filename: 'metro-fuel-oil-delivery-2026-07-19.jpg',
        hash: hash('d'),
        vendorId: '60',
        // The flagged one: the total read "N/A", so validate.ts recorded 0 cents WITH its flag.
        flagged: true,
        fields: {
          vendor: 'Metro Fuel Oil Corp',
          invoiceNumber: 'MF-77120',
          invoiceDate: '2026-07-19',
          dueDate: null,
          subtotalCents: 41200,
          taxCents: null,
          totalCents: 0,
          currency: 'USD',
          suggestedCategory: 'Fuel'
        }
      },
      {
        filename: 'quality-craft-tools-invoice-QCT-1188.pdf',
        hash: hash('e'),
        vendorId: null, // deliberately absent from the company: this is the create-vendor row
        fields: {
          vendor: 'Quality Craft Tools LLC',
          invoiceNumber: 'QCT-1188',
          invoiceDate: '2026-07-21',
          dueDate: '2026-08-20',
          subtotalCents: 34195,
          taxCents: 2949,
          totalCents: 37144,
          currency: 'USD',
          suggestedCategory: 'Job Materials'
        }
      },
      {
        filename: 'corner-fuel-receipt-2026-07-24.jpg',
        hash: hash('f'),
        vendorId: '99',
        expense: true,
        fields: {
          vendor: 'Corner Fuel',
          invoiceNumber: null,
          invoiceDate: '2026-07-24',
          dueDate: null,
          subtotalCents: 9174,
          taxCents: 826,
          totalCents: 10000,
          currency: 'USD',
          suggestedCategory: 'Fuel'
        }
      }
    ]

    const account = (id, name, type, sub) => ({
      id,
      name,
      active: true,
      accountType: type,
      accountSubType: sub,
      shortName: name.split(':').pop()
    })

    const state = {
      scanMode: 'fresh',
      completeEveryRow: false,
      batchSeq: 0,
      batches: [],
      reference: {
        vendors: [
          { id: '58', name: 'Apex Plumbing Supply', active: true },
          { id: '99', name: 'Corner Fuel', active: true },
          { id: '60', name: 'Metro Fuel Oil Corp', active: true },
          { id: '42', name: 'Nassau Plumbing Supply', active: true },
          { id: '61', name: 'Pinnacle Office Supplies', active: true }
        ],
        expenseAccounts: [
          account('18', 'Automobile:Fuel', 'Expense', 'Auto'),
          account('9', 'Job Expenses:Equipment Rental', 'Expense', 'EquipmentRental'),
          account('7', 'Job Expenses:Job Materials', 'Expense', 'SuppliesMaterials'),
          account('12', 'Office Expenses', 'Expense', 'OfficeGeneralAdministrative'),
          account('15', 'Utilities:Gas and Electric', 'Expense', 'Utilities')
        ],
        paymentAccounts: [
          account('35', 'Business Checking', 'Bank', 'Checking'),
          account('36', 'Mastercard', 'CreditCard', 'CreditCard')
        ],
        items: [],
        syncedAt: '2026-07-27T18:02:00.000Z'
      }
    }
    globalThis.__nbScreens = state

    const replace = (channel, handler) => {
      ipcMain.removeHandler(channel)
      ipcMain.handle(channel, (_event, payload) => handler(payload))
    }

    // --- ingestion -------------------------------------------------------
    replace('ingestion:resolve-inbox', () => ({
      path: 'C:\\Users\\anthony\\Documents\\NicoleBooks\\Inbox',
      created: false
    }))
    replace('ingestion:pick-files', () => ({ added: 0, skipped: [] }))

    replace('ingestion:scan', () => {
      const posted = state.batches.find((b) => b.state === 'complete')
      const files = DOCS.map((doc) => {
        const excluded = state.scanMode === 'dedupe' && posted !== undefined
        return {
          filename: doc.filename,
          status: excluded ? 'duplicate-excluded' : 'loaded',
          hash: doc.hash,
          sizeBytes: 24576,
          ...(excluded ? { postedAt: posted.createdAt } : {})
        }
      })
      // The drill's folder also held one thing the app cannot read, and one still syncing.
      files.push({ filename: 'job-notes-week-30.docx', status: 'unsupported-skipped' })
      if (state.scanMode !== 'dedupe') {
        files.push({ filename: 'onedrive-pending-scan.pdf', status: 'not-ready-skipped' })
      }
      const loaded = files.filter((f) => f.status === 'loaded').length
      const duplicates = files.filter((f) => f.status === 'duplicate-excluded').length
      return {
        batchEntryDate: '2026-07-27',
        inboxPath: 'C:\\Users\\anthony\\Documents\\NicoleBooks\\Inbox',
        files,
        summary: {
          total: files.length,
          loaded,
          duplicates,
          notReady: files.filter((f) => f.status === 'not-ready-skipped').length,
          unsupported: files.filter((f) => f.status === 'unsupported-skipped').length
        }
      }
    })

    // --- parse -----------------------------------------------------------
    replace('parse:parse-batch', async (files) => {
      const results = []
      let done = 0
      for (const file of files ?? []) {
        const doc = DOCS.find((d) => d.hash === file.hash)
        done += 1
        send('parse:progress', {
          done,
          total: files.length,
          filename: file.filename,
          status: 'parsed'
        })
        await new Promise((r) => setTimeout(r, 90))
        if (!doc) continue
        results.push({
          filename: doc.filename,
          hash: doc.hash,
          status: 'parsed',
          fields: doc.fields,
          confidence: doc.flagged
            ? { vendor: 'high', totalCents: 'flagged' }
            : { vendor: 'high', totalCents: 'high' },
          validationFlags: doc.flagged ? ['money:totalCents'] : [],
          truncated: false
        })
      }
      return {
        files: results,
        summary: { total: results.length, parsed: results.length, failed: 0, cached: 0 }
      }
    })
    replace('parse:reparse', () => ({ filename: '', hash: '', status: 'parse-failed' }))

    // --- qbo -------------------------------------------------------------
    const status = {
      state: 'connected',
      companyName: 'Sandbox Company US 0b8b',
      realmId: '9341457604445280',
      lastSyncAt: '2026-07-27T18:02:00.000Z'
    }
    replace('qbo:status', () => status)
    replace('qbo:get-reference', () => state.reference)
    replace('qbo:create-vendor', (payload) => {
      const displayName = payload?.displayName ?? ''
      const record = { id: '64', name: displayName, active: true }
      state.reference.vendors = state.reference.vendors
        .filter((v) => v.id !== record.id)
        .concat(record)
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
      const doc = DOCS.find((d) => d.fields.vendor === displayName)
      if (doc) doc.vendorId = record.id
      return record
    })

    // --- recon -----------------------------------------------------------
    replace('recon:match', (payload) => {
      const matches = {}
      for (const fileHash of payload?.fileHashes ?? []) {
        const doc = DOCS.find((d) => d.hash === fileHash)
        if (!doc) continue
        const vendor = state.reference.vendors.find((v) => v.id === doc.vendorId) ?? null
        // Category is where the drill left every row: reconciliation found nothing it would
        // stand behind, so the cell waits on the user. One row gets a suggestion, which is the
        // other tier the marker has to show.
        const suggested = doc.fields.suggestedCategory === 'Office Supplies'
        matches[fileHash] = {
          vendor: vendor
            ? {
                selectedId: vendor.id,
                selectedName: vendor.name,
                confidence: 'auto',
                candidates: [{ id: vendor.id, name: vendor.name, score: 0.98 }]
              }
            : { selectedId: null, selectedName: null, confidence: 'none', candidates: [] },
          category: suggested
            ? {
                selectedId: '12',
                selectedName: 'Office Expenses',
                confidence: 'suggested',
                candidates: [{ id: '12', name: 'Office Expenses', score: 0.71 }]
              }
            : { selectedId: null, selectedName: null, confidence: 'none', candidates: [] }
        }
      }
      return { matches }
    })

    // --- posting ---------------------------------------------------------
    replace('posting:check-duplicates', () => ({ warnings: {} }))

    replace('posting:send', async (payload) => {
      const rows = payload?.rows ?? []
      state.batchSeq += 1
      const batchId = `batch-${state.batchSeq}`
      const createdAt = new Date().toISOString()
      const batch = {
        batchId,
        createdAt,
        total: rows.length,
        confirmed: rows.length,
        failed: 0,
        undone: 0,
        state: 'complete',
        entries: rows.map((row, index) => {
          const doc = DOCS.find((d) => d.hash === row.fileHash)
          return {
            fileHash: row.fileHash,
            filename: doc?.filename ?? null,
            entryType: row.entryType,
            qboId: String(700 + index),
            syncToken: '0',
            state: 'confirmed',
            error: null,
            undoneAt: null,
            undoReason: null,
            row
          }
        })
      }
      state.batches.unshift(batch)

      void (async () => {
        let done = 0
        for (const entry of batch.entries) {
          await new Promise((r) => setTimeout(r, 260))
          done += 1
          send('posting:progress', {
            batchId,
            done,
            total: batch.entries.length,
            current: { fileHash: entry.fileHash, state: 'confirmed' }
          })
        }
        await new Promise((r) => setTimeout(r, 200))
        send('posting:progress', {
          batchId,
          done: batch.entries.length,
          total: batch.entries.length,
          current: null
        })
      })()

      return { batchId }
    })

    replace('posting:batches', () => ({
      batches: state.batches.map(({ entries, ...row }) => row)
    }))
    replace('posting:batch-detail', (payload) => {
      const batch = state.batches.find((b) => b.batchId === payload?.batchId)
      return { entries: (batch?.entries ?? []).map(({ row, ...entry }) => entry) }
    })
    replace('posting:undo-last', () => {
      const batch = state.batches[0]
      if (!batch) return { batchId: null, results: [] }
      for (const entry of batch.entries) {
        entry.undoneAt = new Date().toISOString()
      }
      batch.undone = batch.entries.length
      batch.state = 'undone'
      return {
        batchId: batch.batchId,
        results: batch.entries.map((entry) => ({
          qboId: entry.qboId,
          undone: true,
          reason: null
        }))
      }
    })
    replace('posting:summary', (payload) => {
      const batchId = payload?.batchId
      const batch = state.batches.find((b) => b.batchId === batchId)
      const entries = batch?.entries ?? []
      const nameOf = (list, id) => list.find((r) => r.id === id)?.name ?? id
      const live = entries.filter((e) => e.undoneAt === null)
      return {
        batchId: batchId ?? '',
        createdAt: batch?.createdAt ?? new Date().toISOString(),
        companyName: 'Sandbox Company US 0b8b',
        realmId: '9341457604445280',
        state: batch?.state ?? 'complete',
        totals: {
          entries: entries.length,
          confirmed: entries.length,
          failed: 0,
          undone: entries.length - live.length,
          amountCents: live.reduce((sum, e) => sum + e.row.amountCents, 0)
        },
        lines: entries.map((entry) => ({
          fileHash: entry.fileHash,
          filename: entry.filename ?? entry.fileHash.slice(0, 12),
          vendorName: nameOf(state.reference.vendors, entry.row.vendorId),
          categoryName: nameOf(state.reference.expenseAccounts, entry.row.categoryAccountId),
          paidFromName:
            entry.row.paidFromAccountId === null
              ? null
              : nameOf(state.reference.paymentAccounts, entry.row.paidFromAccountId),
          entryType: entry.entryType,
          txnDate: entry.row.txnDate,
          refNumber: entry.row.refNumber,
          amountCents: entry.row.amountCents,
          state: entry.state,
          qboId: entry.qboId,
          error: null,
          undoneAt: entry.undoneAt
        }))
      }
    })

    // --- upload ----------------------------------------------------------
    // A 1x1 transparent PNG stands in for the QR: the code encodes a LAN address this machine
    // does not have while disconnected, and a real one would be a different image every run.
    replace('upload:start', () => ({
      url: 'http://192.168.1.44:52341/u/8f3ca91d/',
      qrDataUrl:
        'data:image/svg+xml;base64,' +
        Buffer.from(
          `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 29 29" shape-rendering="crispEdges">` +
            `<rect width="29" height="29" fill="#fff"/>` +
            Array.from({ length: 29 * 29 }, (_, i) => {
              const x = i % 29
              const y = Math.floor(i / 29)
              const finder =
                (x < 7 && y < 7) || (x > 21 && y < 7) || (x < 7 && y > 21)
                  ? (x % 6 === 0 || y % 6 === 0 || (x > 1 && x < 5 && y > 1 && y < 5)) &&
                    !(x === 7 || y === 7)
                  : ((x * 7 + y * 13 + ((x * y) % 5)) % 3 === 0)
              return finder ? `<rect x="${x}" y="${y}" width="1" height="1" fill="#0a0a0f"/>` : ''
            }).join('') +
            `</svg>`
        ).toString('base64')
    }))
    replace('upload:stop', () => ({ stopped: true }))
    replace('upload:status', () => ({ running: false, url: null }))
  })
}

await main()
