import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect } from '@playwright/test'
import { MAIN_ENTRY, _electron as electron } from '../playwright.config'

// SC1 theme mirror: the renderer follows the OS color scheme. main.tsx awaits
// window.api.theme.get() (main reads nativeTheme.shouldUseDarkColors) and toggles the `dark`
// class on the documentElement before the first paint. This spec asserts the two agree on the
// running app: the documentElement carries the `dark` class exactly when the native theme value
// is dark, and omits it when the native theme value is light. It reads the truth from the same
// public bridge the app uses, so it stays correct on either a light or a dark CI/host machine.

test('the documentElement dark class matches the native OS theme value', async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), 'nb-e2e-theme-'))
  const app = await electron.launch({ args: [MAIN_ENTRY, `--user-data-dir=${userDataDir}`] })

  try {
    const window = await app.firstWindow()
    await window.waitForLoadState('domcontentloaded')
    await window.waitForFunction(() => typeof window.api !== 'undefined')

    // The native dark-mode preference the renderer mirrors its class from.
    const isDark = await window.evaluate(() => window.api.theme.get())

    // main.tsx toggles the class before the first React render; poll to avoid a startup race.
    await expect
      .poll(
        () => window.evaluate(() => document.documentElement.classList.contains('dark')),
        { timeout: 10_000 }
      )
      .toBe(isDark)
  } finally {
    await app.close()
  }

  rmSync(userDataDir, { recursive: true, force: true })
})
