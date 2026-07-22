import { test, expect } from '@playwright/test'
import { MAIN_ENTRY, _electron as electron } from '../playwright.config'

// SC1 launch smoke test: boot the built Electron app, confirm exactly one visible
// window renders the NicoleBooks wordmark (not a white screen), then close cleanly.
// This proves the hardened three-artifact build boots on this OS. The Mac side of the
// cross-OS gate is reproduced in plan 01-07.
test('app boots a single visible window showing the NicoleBooks wordmark', async () => {
  const app = await electron.launch({ args: [MAIN_ENTRY] })

  try {
    const window = await app.firstWindow()
    await window.waitForLoadState('domcontentloaded')

    // The window title and body both carry the wordmark; body text proves the renderer
    // actually painted rather than white-screening.
    expect(await window.title()).toBe('NicoleBooks')
    await expect(window.locator('body')).toContainText('NicoleBooks')

    // Exactly one window, and it is visible (checked in the Electron main process).
    const windowCount = await app.evaluate(
      ({ BrowserWindow }) => BrowserWindow.getAllWindows().length
    )
    expect(windowCount).toBe(1)

    await expect
      .poll(
        () =>
          app.evaluate(
            ({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible() ?? false
          ),
        { timeout: 10_000 }
      )
      .toBe(true)
  } finally {
    await app.close()
  }
})
