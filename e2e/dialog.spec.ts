import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect } from '@playwright/test'
import { MAIN_ENTRY, _electron as electron } from '../playwright.config'

// The modal contract, proven on the running app.
//
// WHY THIS SPEC EXISTS. Both modal surfaces in this app used to be hand-rolled `position: fixed`
// divs that declared role="dialog" and aria-modal="true" and then honoured neither: Tab walked
// straight out of the panel into the screen behind it, Escape did nothing, and nothing outside was
// hidden from a screen reader. An accessible name and a modal role are a PROMISE about behaviour,
// and a panel that makes it without keeping it is worse than one that never claimed to be modal.
//
// The design wave replaced them with the Base UI Dialog primitive (components/ui/dialog.tsx). That
// behaviour cannot be asserted in the unit suite: the primitive renders through a portal, so
// react-dom/server produces an empty string for anything inside it, and the suite runs in the node
// environment with no DOM. So it is pinned here, where the dialog is real.
//
// The phone-upload dialog is the one under test because it is reachable with a single click from a
// cold start, with no QuickBooks connection and no documents. Its LAN server may or may not start
// on this machine, and the spec deliberately does not care: whether the panel shows a QR code or a
// recoverable error, it is the same dialog with the same frame, and the frame is the subject.
//
// Harness mirrors e2e/inbox-picker.spec.ts: temp --user-data-dir, firstWindow, try/finally close.

test('the phone upload panel is a real modal: named, focus-trapped, and dismissed by Escape', async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), 'nb-e2e-dialog-'))
  const app = await electron.launch({ args: [MAIN_ENTRY, `--user-data-dir=${userDataDir}`] })

  try {
    const window = await app.firstWindow()
    await window.waitForLoadState('domcontentloaded')
    await window.waitForFunction(() => typeof window.api !== 'undefined')

    const dialog = window.getByRole('dialog')
    await expect(dialog).toBeHidden()

    await window.getByRole('button', { name: 'Add from phone' }).click()
    await expect(dialog).toBeVisible()

    // NAMED. The popup takes its accessible name from the panel's own heading, which is the half
    // test/bills-upload-ui.test.ts pins without a DOM. Here the wiring itself is checked.
    await expect(dialog).toHaveAttribute('aria-modal', 'true')
    await expect(dialog).toHaveAttribute('aria-labelledby', 'phone-upload-heading')
    await expect(dialog.getByRole('heading', { name: 'Add from phone' })).toBeVisible()

    // THERE IS A SCRIM. The old overlay drew its own with `bg-foreground/40`, which in dark mode is
    // --foreground #f0f0f0: the "dim" behind a dark modal was a white wash.
    await expect(window.locator('[data-slot="dialog-backdrop"]')).toBeVisible()

    // FOCUS TRAPPED. Tab never comes to rest anywhere but inside the popup, however many times it
    // is pressed. The old overlay failed this on the very first Tab: focus left for the sidebar,
    // which stayed fully operable underneath a panel claiming to be modal.
    //
    // Each press is followed by a poll rather than an immediate read, because a focus trap works by
    // parking focus on a sentinel guard outside the popup and bouncing it back on the next frame.
    // Reading synchronously would be asserting against the mechanism mid-flight; what is promised,
    // and what a person pressing Tab experiences, is where focus SETTLES.
    const focusIsInsideDialog = (): Promise<boolean> =>
      window.evaluate(
        () =>
          document.querySelector('[data-slot="dialog-popup"]')?.contains(document.activeElement) ??
          false
      )

    await expect.poll(focusIsInsideDialog, { timeout: 5_000 }).toBe(true)
    for (let press = 0; press < 6; press += 1) {
      await window.keyboard.press('Tab')
      await expect.poll(focusIsInsideDialog, { timeout: 2_000 }).toBe(true)
    }

    // Said the other way round, because it is the failure that mattered: the navigation behind the
    // scrim never receives focus.
    expect(
      await window.evaluate(
        () =>
          document.querySelector('nav[aria-label="Primary"]')?.contains(document.activeElement) ??
          false
      )
    ).toBe(false)

    // ESCAPE CLOSES IT, which is the same intent as the Done button and now has the same effect.
    await window.keyboard.press('Escape')
    await expect(dialog).toBeHidden()

    // ...and the app underneath is live again, not left behind a stuck scrim.
    await window.getByRole('button', { name: 'History' }).click()
    await expect(window.getByRole('button', { name: 'History' })).toHaveAttribute(
      'aria-current',
      'page'
    )
  } finally {
    await app.close()
  }

  rmSync(userDataDir, { recursive: true, force: true })
})
