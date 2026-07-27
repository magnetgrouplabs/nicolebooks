// test/upload-page.test.ts
//
// The three pages the phone sees.
//
// Two rules are pinned here that nothing else in the suite can catch. First, SELF-CONTAINMENT: the
// server has exactly two routes and serves no static directory, so any external reference in this
// markup would be a broken image or an unstyled page on a phone that has joined the network but has
// no internet. Second, the HOUSE COPY RULE: no em dashes and no en dashes in anything a person
// reads. Both are the kind of regression that ships silently because the page still renders.

import { describe, expect, it } from 'vitest'
import {
  escapeHtml,
  renderProblemPage,
  renderReceivedPage,
  renderUploadPage
} from '../src/main/upload/page'

const TOKEN = 'abc123_-XYZ'

const PAGES: Array<[string, string]> = [
  ['upload form', renderUploadPage(TOKEN)],
  ['received, with skips', renderReceivedPage(TOKEN, ['a.pdf', 'b.jpg'], ['notes.docx'])],
  ['received, nothing usable', renderReceivedPage(TOKEN, [], ['notes.docx'])],
  ['received, clean', renderReceivedPage(TOKEN, ['a.pdf'], [])],
  ['problem', renderProblemPage(TOKEN, 'One of those files is bigger than 25 MB.')]
]

/** Rough "what a person actually reads": drop the style block, the script block, and all tags. */
function visibleText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/g, ' ')
    .replace(/<script[\s\S]*?<\/script>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
}

describe('every page is self-contained', () => {
  it.each(PAGES)('%s references no external host', (_name, html) => {
    expect(html).not.toMatch(/https?:\/\//)
  })

  it.each(PAGES)('%s pulls in no stylesheet, script file, font, or image', (_name, html) => {
    expect(html).not.toContain('<link')
    expect(html).not.toContain('<img')
    expect(html).not.toMatch(/<script[^>]+src=/)
    expect(html).not.toContain('@import')
    expect(html).not.toContain('url(')
  })

  it.each(PAGES)('%s is a complete document with a mobile viewport', (_name, html) => {
    expect(html.startsWith('<!doctype html>')).toBe(true)
    expect(html).toContain('name="viewport"')
    expect(html).toContain('width=device-width')
    expect(html).toContain('<title>')
  })

  it.each(PAGES)('%s carries the brand crimson', (_name, html) => {
    expect(html).toContain('#910023')
    expect(html).toContain('NicoleBooks')
  })
})

describe('copy rules', () => {
  it.each(PAGES)('%s has no em dash and no en dash', (_name, html) => {
    expect(html).not.toMatch(/[–—]/)
  })

  it.each(PAGES)('%s stays in plain language, with no jargon leaking through', (_name, html) => {
    // Checked against the VISIBLE text, not the markup: enctype="multipart/form-data" is a
    // required attribute and is never read by a person.
    const visible = visibleText(html)
    for (const jargon of ['multipart', 'MIME', 'localhost', 'token', 'ENOENT', 'EADDRINUSE']) {
      expect(visible).not.toContain(jargon)
    }
  })
})

describe('the upload form offers both affordances', () => {
  const html = renderUploadPage(TOKEN)

  it('posts to this token\'s upload endpoint', () => {
    expect(html).toContain(`action="/u/${TOKEN}/upload"`)
    expect(html).toContain('method="post"')
    expect(html).toContain('enctype="multipart/form-data"')
  })

  it('offers a camera capture aimed at the rear camera', () => {
    // capture="environment" is what puts the phone on the camera pointed AT the receipt rather
    // than the selfie camera.
    expect(html).toMatch(/accept="image\/\*"[^>]*capture="environment"/)
    expect(html).toContain('Take a photo')
  })

  it('offers a multi-select file picker limited to the supported formats', () => {
    expect(html).toContain('accept=".pdf,.jpg,.jpeg,.png,.heic,.heif"')
    expect(html).toContain('multiple')
    expect(html).toContain('Choose files')
  })

  it('sends both inputs under the same field name the server reads', () => {
    expect(html.match(/name="files"/g)).toHaveLength(2)
  })

  it('states the limits in the units a person uses', () => {
    expect(html).toContain('20 files')
    expect(html).toContain('25 MB')
  })
})

describe('the confirmation page tells the truth about what happened', () => {
  it('names every file that landed', () => {
    const html = renderReceivedPage(TOKEN, ['Nassau Plumbing 1041.pdf', 'receipt.jpg'], [])
    expect(html).toContain('Nassau Plumbing 1041.pdf')
    expect(html).toContain('receipt.jpg')
    expect(html).toContain('2 files added')
  })

  it('names the files that were refused, instead of letting them vanish', () => {
    // A file that quietly disappears between the phone and the computer is the failure that costs
    // the most trust, because the user has no way to notice it.
    const html = renderReceivedPage(TOKEN, ['a.pdf'], ['quarterly.docx'])
    expect(html).toContain('quarterly.docx')
    expect(html).toContain('not accepted')
  })

  it('says so plainly when nothing at all was usable', () => {
    const html = renderReceivedPage(TOKEN, [], ['a.docx', 'b.zip'])
    expect(html).toContain('Nothing was added')
    expect(html).toContain('a.docx')
    expect(html).toContain('b.zip')
  })

  it('uses singular wording for one file', () => {
    expect(renderReceivedPage(TOKEN, ['a.pdf'], [])).toContain('1 file added')
  })

  it('offers a way back to send more', () => {
    expect(renderReceivedPage(TOKEN, ['a.pdf'], [])).toContain(`href="/u/${TOKEN}/"`)
    expect(renderReceivedPage(TOKEN, ['a.pdf'], [])).toContain('Add more')
  })
})

describe('escaping', () => {
  it('escapes every character that could break out of text or an attribute', () => {
    expect(escapeHtml('<b>&"\'')).toBe('&lt;b&gt;&amp;&quot;&#39;')
  })

  it('escapes a filename before printing it back', () => {
    const html = renderReceivedPage(TOKEN, ['"><img onerror=alert(1)>.pdf'], [])
    expect(html).not.toContain('<img')
    expect(html).toContain('&quot;&gt;&lt;img')
  })

  it('escapes a refused filename too', () => {
    const html = renderReceivedPage(TOKEN, [], ['<script>x</script>.docx'])
    expect(html).not.toContain('<script>x')
  })

  it('escapes the reason on the problem page', () => {
    const html = renderProblemPage(TOKEN, 'Something <broke>')
    expect(html).toContain('Something &lt;broke&gt;')
  })
})
