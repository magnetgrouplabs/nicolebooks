import { mkdtempSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect } from '@playwright/test'
import { MAIN_ENTRY, _electron as electron } from '../playwright.config'

// SC3 relaunch persistence: an app_settings value written through window.api.settings.set on one
// launch must survive a full process restart and read back identically on the next launch. This
// proves the SQLite persistence seam (userData/app.db, forward-only migrations, WAL) is durable
// across runs, which is the load-bearing property for the audit log / dedupe ledger in later phases.
//
// Both launches point at the SAME temp userData via the Electron --user-data-dir switch, so the
// test is isolated from any real profile yet shares one database file across the two runs. The
// first launch asserts the switch is actually honored (the reported userData resolves into the
// temp dir), so a silent fallback to the real profile fails loudly instead of passing dishonestly.

const PROBE_KEY = 'e2e_probe'
// A distinctive value so the read-back match is meaningful and not a coincidental default.
const PROBE_VALUE = 'persisted-value-4b7e1a09'

test('an app_settings value survives a full relaunch against the same userData', async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), 'nb-e2e-persist-'))
  const expectedRoot = realpathSync(userDataDir)

  // First launch: write the probe value, confirm the userData switch is honored, then close.
  const first = await electron.launch({ args: [MAIN_ENTRY, `--user-data-dir=${userDataDir}`] })
  try {
    const reported = await first.evaluate(({ app }) => app.getPath('userData'))
    // Fail loudly if --user-data-dir did not take effect (would otherwise pollute the real profile).
    expect(realpathSync(reported)).toBe(expectedRoot)

    const firstWindow = await first.firstWindow()
    await firstWindow.waitForLoadState('domcontentloaded')

    const wrote = await firstWindow.evaluate(
      ({ key, value }) => window.api.settings.set(key, value),
      { key: PROBE_KEY, value: PROBE_VALUE }
    )
    expect(wrote).toBe(true)
  } finally {
    await first.close()
  }

  // Second launch against the same userData: the value must read back identically.
  const second = await electron.launch({ args: [MAIN_ENTRY, `--user-data-dir=${userDataDir}`] })
  try {
    const secondWindow = await second.firstWindow()
    await secondWindow.waitForLoadState('domcontentloaded')

    const readBack = await secondWindow.evaluate(
      (key) => window.api.settings.get(key),
      PROBE_KEY
    )
    expect(readBack).toBe(PROBE_VALUE)
  } finally {
    await second.close()
  }

  rmSync(userDataDir, { recursive: true, force: true })
})
