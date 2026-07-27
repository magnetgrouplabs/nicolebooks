// test/bills-upload-ui.test.ts
//
// The two new ways bills get in, at the layer the user actually meets them.
//
// The disabled rules are the same WR-07 concern that test/bills-scan-button.test.ts pins for
// "Scan now", extended to the new controls: both of them RESCAN when they finish, and a rescan
// landing on top of a running parse batch is exactly the concurrency bug that spec exists to
// prevent (two batches, wiped results, and the model charged twice for the same documents).
//
// The copy assertions are not decoration. This app has one non-technical user, and the house rule
// forbidding em dashes and en dashes applies to every string she reads.

import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  AddFilesButton,
  AddFromPhoneButton,
  PHONE_UPLOAD_HEADING_ID,
  PhoneUploadPanel,
  addFilesNotice,
  phoneReceivedLine
} from '../src/renderer/src/screens/BillsScreen'

/** The real `disabled` ATTRIBUTE, not the Tailwind `disabled:` variant in the class list. */
function isDisabled(html: string): boolean {
  return /<button[^>]*\sdisabled=""/.test(html)
}

describe('Add files button', () => {
  const render = (adding: boolean, busy: boolean): string =>
    renderToStaticMarkup(createElement(AddFilesButton, { adding, busy, onAdd: () => {} }))

  it('is enabled and labelled when nothing is running', () => {
    const html = render(false, false)
    expect(html).toContain('Add files')
    expect(isDisabled(html)).toBe(false)
  })

  it('is disabled and says so while the picker is open', () => {
    const html = render(true, false)
    expect(isDisabled(html)).toBe(true)
    expect(html).toContain('Adding...')
  })

  it('is disabled while a scan or parse is running, because it rescans when it finishes', () => {
    expect(isDisabled(render(false, true))).toBe(true)
  })
})

describe('Add from phone button', () => {
  const render = (busy: boolean): string =>
    renderToStaticMarkup(createElement(AddFromPhoneButton, { busy, onOpen: () => {} }))

  it('is enabled and labelled when nothing is running', () => {
    const html = render(false)
    expect(html).toContain('Add from phone')
    expect(isDisabled(html)).toBe(false)
  })

  it('is disabled while busy, which includes while the panel is already open', () => {
    expect(isDisabled(render(true))).toBe(true)
  })
})

describe('addFilesNotice', () => {
  it('says nothing at all when the user cancelled', () => {
    // A message about a cancel is pure noise: the user already knows what they did.
    expect(addFilesNotice({ added: 0, skipped: [] })).toBeNull()
  })

  it('counts what landed, with the right singular and plural', () => {
    expect(addFilesNotice({ added: 1, skipped: [] })).toBe('Added 1 file to your inbox.')
    expect(addFilesNotice({ added: 3, skipped: [] })).toBe('Added 3 files to your inbox.')
  })

  it('names every file it skipped, so nothing vanishes without a word', () => {
    const notice = addFilesNotice({ added: 2, skipped: ['notes.docx', 'sheet.xlsx'] })
    expect(notice).toContain('Added 2 files')
    expect(notice).toContain('notes.docx')
    expect(notice).toContain('sheet.xlsx')
    expect(notice).toContain('only takes PDF files and photos')
  })

  it('reports an all-skipped pick without claiming a success', () => {
    const notice = addFilesNotice({ added: 0, skipped: ['notes.docx'] })
    expect(notice).toContain('Nothing was added')
    expect(notice).toContain('notes.docx')
  })

  it('uses copy free of em dashes and en dashes', () => {
    const notices = [
      addFilesNotice({ added: 1, skipped: [] }),
      addFilesNotice({ added: 0, skipped: ['a.docx'] }),
      addFilesNotice({ added: 4, skipped: ['a.docx', 'b.zip'] })
    ]
    for (const notice of notices) expect(notice ?? '').not.toMatch(/[–—]/)
  })
})

describe('phoneReceivedLine', () => {
  it('invites the first scan when nothing has arrived', () => {
    expect(phoneReceivedLine(0)).toContain('Nothing sent yet')
  })

  it('counts with the right singular and plural', () => {
    expect(phoneReceivedLine(1)).toBe('1 file received so far.')
    expect(phoneReceivedLine(7)).toBe('7 files received so far.')
  })

  it('uses copy free of em dashes and en dashes', () => {
    for (const count of [0, 1, 9]) expect(phoneReceivedLine(count)).not.toMatch(/[–—]/)
  })
})

describe('PhoneUploadPanel', () => {
  const render = (props: Partial<Parameters<typeof PhoneUploadPanel>[0]> = {}): string =>
    renderToStaticMarkup(
      createElement(PhoneUploadPanel, {
        starting: false,
        url: 'http://192.168.1.44:52341/u/abc123/',
        qrDataUrl: 'data:image/png;base64,AAAA',
        receivedCount: 0,
        error: null,
        onDone: () => {},
        ...props
      })
    )

  // WHY THIS ASSERTION MOVED, since it is the one that changed shape in the design wave.
  //
  // The panel used to BE the dialog: a hand-rolled fixed overlay that set role="dialog" and
  // aria-modal="true" itself, and delivered neither of the things those attributes promise. Tab
  // walked straight out into the screen behind it, Escape did nothing, and nothing outside was
  // hidden from a screen reader. It now renders inside the real Dialog primitive, which supplies
  // all of that, and takes its accessible NAME from the heading below.
  //
  // So what is pinned here is the half that is provable without a DOM and is this component's own
  // responsibility: the panel exposes a titled heading under the exact id the popup points its
  // aria-labelledby at. Break the id and the dialog loses its name. The other half, that the thing
  // really is modal and really does close on Escape, cannot be asserted against a portalled
  // component in react-dom/server at all, so it is pinned where it is observable: e2e/dialog.spec.ts
  // opens it in the running app and checks role, aria-modal, Escape, and focus containment.
  it('supplies the heading the dialog is named by', () => {
    const html = render()
    expect(html).toContain(`id="${PHONE_UPLOAD_HEADING_ID}"`)
    expect(html).toContain('Add from phone')
    // The id BillsScreen hands to the popup's aria-labelledby, verbatim.
    expect(PHONE_UPLOAD_HEADING_ID).toBe('phone-upload-heading')
  })

  it('shows the QR code from a self-contained data URI, with alt text', () => {
    // A data: URI means the renderer fetches nothing to draw it, which matters under the app's
    // strict window/navigation rules.
    const html = render()
    expect(html).toContain('src="data:image/png;base64,AAAA"')
    expect(html).toMatch(/alt="[^"]+phone camera[^"]*"/)
  })

  it('prints the URL as selectable text for a phone whose camera will not read the screen', () => {
    const html = render()
    expect(html).toContain('http://192.168.1.44:52341/u/abc123/')
    expect(html).toContain('select-all')
  })

  it('shows the live received count and announces changes to a screen reader', () => {
    expect(render({ receivedCount: 0 })).toContain('Nothing sent yet')
    const html = render({ receivedCount: 3 })
    expect(html).toContain('3 files received so far.')
    expect(html).toContain('aria-live="polite"')
  })

  it('warns about the Windows network prompt before the user hits it', () => {
    // Without this, the first run looks like a broken feature: the phone loads nothing and there is
    // no clue that a firewall dialog behind the app is the reason.
    const html = render()
    expect(html).toContain('Windows may ask')
    expect(html).toContain('Allow')
    expect(html).toContain('same Wi-Fi')
  })

  it('shows a starting state instead of an empty box', () => {
    const html = render({ starting: true, url: null, qrDataUrl: null })
    expect(html).toContain('Starting phone upload...')
  })

  it('shows a recoverable error as an alert, with no QR and no URL', () => {
    const html = render({
      starting: false,
      url: null,
      qrDataUrl: null,
      error: 'Could not start phone upload just now. Please try again.'
    })
    expect(html).toContain('role="alert"')
    expect(html).toContain('Could not start phone upload')
    expect(html).not.toContain('<img')
  })

  it('offers a Done control, which is what stops the server', () => {
    expect(render()).toContain('Done')
  })

  it('uses copy free of em dashes and en dashes', () => {
    const states = [
      render(),
      render({ receivedCount: 5 }),
      render({ starting: true, url: null, qrDataUrl: null }),
      render({ url: null, qrDataUrl: null, error: 'Could not start phone upload just now.' })
    ]
    for (const html of states) expect(html).not.toMatch(/[–—]/)
  })
})
