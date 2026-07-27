import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect } from '@playwright/test'
import { MAIN_ENTRY, _electron as electron } from '../playwright.config'

// ING-01 / ING-02, proven end-to-end on the running app. This spec exists because Phase 2 shipped
// with a permanently-rejecting ingestion:scan handler and every suite stayed green:
// e2e/ipc-boundary.spec.ts only asserted that `scan` was PRESENT on the window.api bridge, which a
// handler that always throws passes trivially. So this is an INVOCATION proof — it actually calls
// window.api.ingestion.scan() and asserts it RESOLVES with a well-formed ScanResult, then clicks
// the real "Scan now" button and asserts the user-visible success surface renders with no error
// alert (the broken build rendered "Could not scan your inbox folder..." in a role="alert").
//
// The scan is pointed at a temp inbox rather than the developer's real Documents/NicoleBooks/Inbox:
// the main-process dialog.showOpenDialog is stubbed (same technique as e2e/inbox-picker.spec.ts)
// and chooseInbox is invoked, which persists the temp path through the real handler. The seed file
// is written BEFORE the app launches, so it is already settled when the scan's 750ms poll samples
// it and its status is deterministically 'loaded'.
//
// NOT asserted here, deliberately: "a non-empty payload rejects". src/preload/index.ts:40 is
// zero-arity (`scan: () => ipcRenderer.invoke(Channels.ingestionScan)`) and silently discards any
// caller argument, so window.api.ingestion.scan({...}) RESOLVES — the payload never crosses the
// bridge. That half of the strict-empty gate (threat T-02-02) is reachable only at the
// main-process handler and is pinned in test/ingestion-ipc-scan.test.ts.

// A real scan pays the settling poll plus, on Windows, one batched PowerShell attribute read, and
// this spec runs the scan twice (once through the bridge, once through the button).
test.setTimeout(60_000)

const SEED_FILENAME = 'nb-e2e-seed-bill.pdf'

test('window.api.ingestion.scan() resolves and the Scan now button renders a scan summary', async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), 'nb-e2e-scan-'))
  const inboxDir = mkdtempSync(join(tmpdir(), 'nb-e2e-inbox-'))
  // Written before launch so the size+mtime settling poll sees a stable file on its first sample.
  // Phase 2 stats and SHA-256 hashes bytes and never reads content, so dummy bytes are enough.
  writeFileSync(join(inboxDir, SEED_FILENAME), '%PDF-1.4 nicolebooks e2e seed\n')

  const app = await electron.launch({ args: [MAIN_ENTRY, `--user-data-dir=${userDataDir}`] })

  try {
    const window = await app.firstWindow()
    await window.waitForLoadState('domcontentloaded')
    await window.waitForFunction(() => typeof window.api !== 'undefined')

    // Stub the native folder picker so chooseInbox persists our temp inbox and no dialog blocks.
    await app.evaluate(async ({ dialog }, dir) => {
      ;(dialog as unknown as { showOpenDialog: unknown }).showOpenDialog = async () => ({
        canceled: false,
        filePaths: [dir]
      })
    }, inboxDir)

    // Route the app at the temp inbox through the REAL ingestion:choose-inbox handler, so the scan
    // below enumerates a controlled folder instead of the developer's real Documents inbox.
    const chosen = await window.evaluate(async () => window.api.ingestion.chooseInbox())
    expect(chosen).toEqual({ canceled: false, path: inboxDir })

    // 1. INVOCATION PROOF. The regression was that this call ALWAYS rejected. Call it for real and
    //    report which branch was taken, so a failure names the rejection instead of timing out.
    const outcome = await window.evaluate(async () => {
      try {
        const result = await window.api.ingestion.scan()
        return { resolved: true as const, result }
      } catch (err) {
        return { resolved: false as const, error: String(err) }
      }
    })

    expect(outcome.resolved, `scan() rejected: ${'error' in outcome ? outcome.error : ''}`).toBe(
      true
    )

    // The resolved value is a well-formed ScanResult describing the seeded inbox.
    const result = outcome.resolved ? outcome.result : null
    expect(result?.inboxPath).toBe(inboxDir)
    expect(result?.batchEntryDate).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(result?.summary).toEqual({
      total: 1,
      loaded: 1,
      duplicates: 0,
      notReady: 0,
      unsupported: 0
    })
    expect(result?.files).toHaveLength(1)
    expect(result?.files[0].filename).toBe(SEED_FILENAME)
    expect(result?.files[0].status).toBe('loaded')
    expect(result?.files[0].hash).toMatch(/^[0-9a-f]{64}$/)

    // 2. UI PROOF — what actually broke for the user. Bills is the default screen; clicking
    //    "Scan now" must render the summary, not the recoverable-error alert.
    await window.getByRole('button', { name: 'Scan now' }).click()
    await expect(window.getByText(/^Batch date: \d{4}-\d{2}-\d{2}$/)).toBeVisible()
    await expect(window.getByText(SEED_FILENAME)).toBeVisible()
    // The broken build put "Could not scan your inbox folder..." in a role="alert" paragraph.
    await expect(window.getByRole('alert')).toHaveCount(0)
  } finally {
    await app.close()
  }

  rmSync(userDataDir, { recursive: true, force: true })
  rmSync(inboxDir, { recursive: true, force: true })
})
