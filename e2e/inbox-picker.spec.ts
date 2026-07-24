import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect } from '@playwright/test'
import { MAIN_ENTRY, _electron as electron } from '../playwright.config'

// ING-02 / D-01, proven end-to-end on the running app. This is an INVOCATION proof, not a shape
// check: the main-process folder picker (dialog.showOpenDialog) is stubbed so no native dialog
// blocks and so a click is observable. The stubbed path can only surface in the UI if the
// Settings "Change inbox folder" button actually called window.api.ingestion.chooseInbox, which
// routes ingestion:choose-inbox -> persistInboxPath. A merely-exposed-but-unwired button could
// never make the stub path appear. The harness mirrors e2e/ipc-boundary.spec.ts (temp
// --user-data-dir, firstWindow, try/finally close, rmSync) and the app.evaluate main-process
// stub mirrors e2e/secret-roundtrip.spec.ts.

test('Change inbox folder invokes chooseInbox, reflects the chosen path, and no-ops on cancel', async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), 'nb-e2e-inbox-'))
  const chosenDir = mkdtempSync(join(tmpdir(), 'nb-e2e-chosen-'))
  const app = await electron.launch({ args: [MAIN_ENTRY, `--user-data-dir=${userDataDir}`] })

  try {
    const window = await app.firstWindow()
    await window.waitForLoadState('domcontentloaded')
    await window.waitForFunction(() => typeof window.api !== 'undefined')

    // Stub the native picker to return our distinctive temp dir (no native dialog opens).
    await app.evaluate(async ({ dialog }, dir) => {
      ;(dialog as unknown as { showOpenDialog: unknown }).showOpenDialog = async () => ({
        canceled: false,
        filePaths: [dir]
      })
    }, chosenDir)

    // Navigate to Settings so the "Change inbox folder" control mounts.
    await window.getByRole('button', { name: 'Settings' }).click()

    // Click the picker; the displayed inbox path must become the stubbed path. This passes ONLY
    // if SettingsScreen actually invoked window.api.ingestion.chooseInbox.
    await window.getByRole('button', { name: 'Change inbox folder' }).click()
    await expect(window.getByText(chosenDir)).toBeVisible()

    // Cancel path: re-stub so the dialog reports canceled; the displayed path stays unchanged.
    await app.evaluate(async ({ dialog }) => {
      ;(dialog as unknown as { showOpenDialog: unknown }).showOpenDialog = async () => ({
        canceled: true,
        filePaths: []
      })
    })
    await window.getByRole('button', { name: 'Change inbox folder' }).click()
    await expect(window.getByText(chosenDir)).toBeVisible()
  } finally {
    await app.close()
  }

  rmSync(userDataDir, { recursive: true, force: true })
  rmSync(chosenDir, { recursive: true, force: true })
})
