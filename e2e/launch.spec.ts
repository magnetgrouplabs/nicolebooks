import { test, expect } from '@playwright/test'
import { MAIN_ENTRY, _electron as electron } from '../playwright.config'

// SC1 launch smoke test: boot the built Electron app, confirm exactly one visible
// window renders the NicoleBooks branded chrome (not a white screen), then close cleanly.
// This proves the hardened three-artifact build boots on this OS. The Mac side of the
// cross-OS gate is reproduced in plan 01-07.
test('app boots a single visible window showing the NicoleBooks logo', async () => {
  const app = await electron.launch({ args: [MAIN_ENTRY] })

  try {
    const window = await app.firstWindow()
    await window.waitForLoadState('domcontentloaded')

    expect(await window.title()).toBe('NicoleBooks')

    // Quick task 260727-k05 swapped the header's text wordmark for the logo image, so the
    // old body-text assertion no longer applies. Rather than drop to something weaker, this
    // asserts the branded chrome painted: the header logo is visible AND actually decoded.
    // naturalWidth is the load-bearing half. An <img> whose src failed to resolve still
    // matches the role and still reports visible (it has layout from width/height), but its
    // naturalWidth stays 0. Checking it decoded to its true intrinsic width proves the
    // bundled asset survived the electron-vite renderer build and resolved under the
    // packaged app's file:// base, which is exactly the thing a logo swap can break.
    const logo = window.getByRole('img', { name: 'NicoleBooks' })
    await expect(logo).toBeVisible()
    await expect
      .poll(() => logo.evaluate((el) => (el as HTMLImageElement).naturalWidth), {
        timeout: 10_000
      })
      .toBe(1931)

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
