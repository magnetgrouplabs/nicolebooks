// test/upload-server.test.ts
//
// The phone-upload server, driven over real HTTP on an ephemeral loopback port.
//
// It is exercised through fetch rather than through a mocked express, because every property worth
// asserting here is a property of the wire: what a wrong token gets back, what multer does with an
// oversized part, what actually lands on disk after a multipart body is parsed. A mock of express
// would only prove that this file and the mock agree.
//
// Loopback, not 0.0.0.0: the production lifecycle binds every interface (that is the point of the
// feature) but a test suite must never pop a firewall prompt on the machine running it.
//
// The section that matters most is the last one. This process listens on a network interface, in a
// folder full of a small business's invoices, so "you cannot read anything back out" is not a nice
// property, it is the reason the design has exactly two routes. It is asserted by uploading a file
// and then failing to GET it at every path shape it could plausibly be served from.

import { mkdtempSync, rmSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MAX_FILES, MAX_FILE_BYTES, createUploadApp } from '../src/main/upload/app'

const TOKEN = 'test-token-0123456789abcdef'

let inbox: string
let staging: string
let server: Server
let base: string
let received: string[][]

beforeEach(async () => {
  inbox = mkdtempSync(join(tmpdir(), 'nb-inbox-'))
  staging = mkdtempSync(join(tmpdir(), 'nb-staging-'))
  received = []

  const app = createUploadApp({
    token: TOKEN,
    inboxPath: inbox,
    stagingDir: staging,
    onReceived: (filenames) => received.push(filenames)
  })

  server = createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  base = `http://127.0.0.1:${address.port}`
})

afterEach(async () => {
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  rmSync(inbox, { recursive: true, force: true })
  rmSync(staging, { recursive: true, force: true })
})

function bill(name: string, type = 'application/pdf', bytes = 64): File {
  return new File([new Uint8Array(bytes).fill(65)], name, { type })
}

/** POST a multipart body. A limit breach can reset the socket mid-send, so a throw is a real outcome. */
async function postFiles(
  token: string,
  files: File[],
  field = 'files'
): Promise<{ status: number; body: string } | { networkError: true }> {
  const form = new FormData()
  for (const file of files) form.append(field, file)
  try {
    const res = await fetch(`${base}/u/${token}/upload`, { method: 'POST', body: form })
    return { status: res.status, body: await res.text() }
  } catch {
    return { networkError: true }
  }
}

// ---------------------------------------------------------------------------
// 1. The token is the only gate, and a miss looks like nothing is there
// ---------------------------------------------------------------------------

describe('token gate', () => {
  it('serves the upload page under the right token', async () => {
    const res = await fetch(`${base}/u/${TOKEN}/`)
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('Take a photo')
    expect(html).toContain('Choose files')
  })

  it('serves the page with or without the trailing slash', async () => {
    expect((await fetch(`${base}/u/${TOKEN}`)).status).toBe(200)
    expect((await fetch(`${base}/u/${TOKEN}/`)).status).toBe(200)
  })

  it('404s a wrong token with a BARE body', async () => {
    // Not 401, not an error page. A body that explained the failure would confirm to a scanner
    // that a token-shaped secret is what unlocks this port.
    const res = await fetch(`${base}/u/wrong-token-0123456789abcde/`)
    expect(res.status).toBe(404)
    expect(await res.text()).toBe('')
  })

  it('404s a token that is a prefix of the real one', async () => {
    const res = await fetch(`${base}/u/${TOKEN.slice(0, 10)}/`)
    expect(res.status).toBe(404)
    expect(await res.text()).toBe('')
  })

  it('404s a missing token and the site root', async () => {
    for (const path of ['/', '/u', '/u/', '/index.html']) {
      const res = await fetch(`${base}${path}`)
      expect(res.status).toBe(404)
      expect(await res.text()).toBe('')
    }
  })

  it('404s an upload POST under a wrong token, and writes nothing', async () => {
    const result = await postFiles('not-the-token', [bill('sneaky.pdf')])
    expect('status' in result && result.status).toBe(404)
    expect(await readdir(inbox)).toEqual([])
    expect(received).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 2. Uploading works, and reports honestly
// ---------------------------------------------------------------------------

describe('successful uploads', () => {
  it('saves a single file into the inbox and confirms it by name', async () => {
    const result = await postFiles(TOKEN, [bill('Nassau Plumbing 1041.pdf')])
    expect('status' in result && result.status).toBe(200)
    expect('body' in result && result.body).toContain('Nassau Plumbing 1041.pdf')
    expect(await readdir(inbox)).toEqual(['Nassau Plumbing 1041.pdf'])
  })

  it('saves a whole batch in one request', async () => {
    const files = [
      bill('a.pdf'),
      bill('b.jpg', 'image/jpeg'),
      bill('c.png', 'image/png'),
      bill('d.heic', 'image/heic')
    ]
    const result = await postFiles(TOKEN, files)
    expect('status' in result && result.status).toBe(200)
    expect((await readdir(inbox)).sort()).toEqual(['a.pdf', 'b.jpg', 'c.png', 'd.heic'])
  })

  it('broadcasts the saved names exactly once per request', async () => {
    await postFiles(TOKEN, [bill('a.pdf'), bill('b.jpg', 'image/jpeg')])
    expect(received).toHaveLength(1)
    expect(received[0].sort()).toEqual(['a.pdf', 'b.jpg'])
  })

  it('writes the real bytes, not a truncated or empty file', async () => {
    await postFiles(TOKEN, [bill('a.pdf', 'application/pdf', 5000)])
    const written = await readFile(join(inbox, 'a.pdf'))
    expect(written.length).toBe(5000)
    expect(written[0]).toBe(65)
    expect(written[4999]).toBe(65)
  })

  it('leaves the staging directory empty afterwards', async () => {
    await postFiles(TOKEN, [bill('a.pdf'), bill('b.jpg', 'image/jpeg')])
    expect(await readdir(staging)).toEqual([])
  })

  it('never overwrites: three phone photos all called image.jpg become three files', async () => {
    // A phone reuses names constantly. Overwriting would silently discard a bill nobody entered.
    for (const _ of [1, 2, 3]) await postFiles(TOKEN, [bill('image.jpg', 'image/jpeg')])
    expect((await readdir(inbox)).sort()).toEqual(['image (2).jpg', 'image (3).jpg', 'image.jpg'])
  })

  it('an offer with no files at all is a no-op, not an error', async () => {
    const result = await postFiles(TOKEN, [])
    expect('status' in result && result.status).toBe(200)
    expect(await readdir(inbox)).toEqual([])
    expect(received).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 3. Type screening happens HERE, not in the page's accept attribute
// ---------------------------------------------------------------------------

describe('type filtering', () => {
  it('refuses an unsupported extension and says so in plain language', async () => {
    const result = await postFiles(TOKEN, [bill('quarterly.docx', 'application/pdf')])
    expect('status' in result && result.status).toBe(200)
    expect('body' in result && result.body).toContain('quarterly.docx')
    expect('body' in result && result.body).toContain('not accepted')
    expect(await readdir(inbox)).toEqual([])
    expect(received).toEqual([])
  })

  it('refuses a supported extension carrying a mismatched MIME type', async () => {
    // The extension and the declared type must BOTH pass. A '.pdf' announced as text/plain is
    // either a confused client or a probe.
    const result = await postFiles(TOKEN, [bill('payload.pdf', 'text/plain')])
    expect('status' in result && result.status).toBe(200)
    expect(await readdir(inbox)).toEqual([])
  })

  it('refuses an executable dressed as a document', async () => {
    for (const name of ['setup.exe', 'invoice.pdf.exe', 'run.sh']) {
      const result = await postFiles(TOKEN, [bill(name, 'application/pdf')])
      expect('status' in result && result.status).toBe(200)
    }
    expect(await readdir(inbox)).toEqual([])
  })

  it('refuses image types the pipeline cannot read, even though they are images', async () => {
    // A prefix test on 'image/' would let both of these through; svg is also executable markup.
    await postFiles(TOKEN, [bill('logo.svg', 'image/svg+xml')])
    await postFiles(TOKEN, [bill('anim.gif', 'image/gif')])
    expect(await readdir(inbox)).toEqual([])
  })

  it('keeps the good files in a mixed batch and only skips the bad one', async () => {
    // One stray screenshot must not lose the receipts beside it.
    const result = await postFiles(TOKEN, [
      bill('good.pdf'),
      bill('bad.docx', 'application/pdf'),
      bill('also-good.jpg', 'image/jpeg')
    ])
    expect('status' in result && result.status).toBe(200)
    expect((await readdir(inbox)).sort()).toEqual(['also-good.jpg', 'good.pdf'])
    expect('body' in result && result.body).toContain('bad.docx')
    expect(received).toEqual([expect.arrayContaining(['good.pdf', 'also-good.jpg'])])
  })

  it('accepts the non-standard image/jpg some Android cameras send', async () => {
    await postFiles(TOKEN, [bill('camera.jpg', 'image/jpg')])
    expect(await readdir(inbox)).toEqual(['camera.jpg'])
  })

  it('accepts a MIME type carrying a parameter', async () => {
    await postFiles(TOKEN, [bill('scan.pdf', 'application/pdf; charset=binary')])
    expect(await readdir(inbox)).toEqual(['scan.pdf'])
  })
})

// ---------------------------------------------------------------------------
// 4. Limits
// ---------------------------------------------------------------------------

describe('size and count limits', () => {
  it('refuses a file over 25 MB and leaves the inbox untouched', async () => {
    const oversized = new File(
      [new Uint8Array(MAX_FILE_BYTES + 1024)],
      'huge.pdf',
      { type: 'application/pdf' }
    )
    const result = await postFiles(TOKEN, [oversized])
    // Multer aborts mid-stream, so the socket may be reset before the 400 is read. Either way the
    // invariant that matters is the same: no partial file is left behind in the inbox.
    if ('status' in result) {
      expect(result.status).toBe(400)
      expect(result.body).toContain('bigger than 25 MB')
    }
    expect(await readdir(inbox)).toEqual([])
    expect(received).toEqual([])
  }, 30_000)

  it('refuses more than 20 files in one request', async () => {
    const many = Array.from({ length: MAX_FILES + 1 }, (_, i) => bill(`f${i}.pdf`))
    const result = await postFiles(TOKEN, many)
    if ('status' in result) {
      expect(result.status).toBe(400)
      expect(result.body).toContain('20 files')
    }
    // Nothing is committed: files only move out of staging after the whole body parses cleanly.
    expect(await readdir(inbox)).toEqual([])
    expect(received).toEqual([])
  })

  it('accepts exactly 20 files', async () => {
    const many = Array.from({ length: MAX_FILES }, (_, i) => bill(`f${i}.pdf`))
    const result = await postFiles(TOKEN, many)
    expect('status' in result && result.status).toBe(200)
    expect(await readdir(inbox)).toHaveLength(MAX_FILES)
  })

  it('refuses a file posted under an unexpected field name', async () => {
    const result = await postFiles(TOKEN, [bill('a.pdf')], 'avatar')
    if ('status' in result) expect(result.status).toBe(400)
    expect(await readdir(inbox)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 5. Sanitization, on the wire this time
// ---------------------------------------------------------------------------

describe('filename sanitization over HTTP', () => {
  it('cannot escape the inbox with a traversal filename', async () => {
    await postFiles(TOKEN, [bill('../../../evil.pdf')])
    expect(await readdir(inbox)).toEqual(['evil.pdf'])
    expect(await readdir(staging)).toEqual([])
  })

  it('cannot escape with a Windows path', async () => {
    await postFiles(TOKEN, [bill('..\\..\\Windows\\hosts.pdf')])
    expect(await readdir(inbox)).toEqual(['hosts.pdf'])
  })

  it('cannot land a name the scan would silently drop as junk', async () => {
    await postFiles(TOKEN, [bill('.hidden.pdf'), bill('._fork.jpg', 'image/jpeg')])
    expect((await readdir(inbox)).sort()).toEqual(['fork.jpg', 'hidden.pdf'])
  })

  it('refuses the whole request when a filename carries a raw control character', async () => {
    // The multipart parser refuses a part header containing a control byte, so this never even
    // reaches the sanitizer. Pinned because it IS the honest outcome, and because the alternative
    // (a file landing under a name nobody can type or find) would be worse than a refusal.
    const result = await postFiles(TOKEN, [bill('receipt.pdf')])
    if ('status' in result) expect(result.status).not.toBe(200)
    expect(await readdir(inbox)).toEqual([])
    expect(received).toEqual([])
  })

  it('never lets angle brackets survive into the saved name', async () => {
    const result = await postFiles(TOKEN, [bill('a<script>alert(1)</script>.pdf')])
    expect('body' in result && result.body).not.toContain('<script>alert(1)</script>')
    for (const name of await readdir(inbox)) {
      expect(name).not.toContain('<')
      expect(name).not.toContain('>')
    }
  })

  it('escapes the reported name so it cannot inject markup into the confirmation page', async () => {
    // Ampersand and apostrophe legitimately survive sanitization, so they are exactly the
    // characters the confirmation page has to escape before printing a name back.
    const result = await postFiles(TOKEN, [bill("Tom & Jerry's Diner.pdf")])
    expect(await readdir(inbox)).toEqual(["Tom & Jerry's Diner.pdf"])
    expect('body' in result && result.body).toContain('Tom &amp; Jerry&#39;s Diner.pdf')
  })
})

// ---------------------------------------------------------------------------
// 6. Upload-only: the server can add to the inbox and can do nothing else with it
// ---------------------------------------------------------------------------

describe('the surface is upload-only', () => {
  it('cannot GET back a file it just accepted, under any path shape', async () => {
    await postFiles(TOKEN, [bill('secret-invoice.pdf')])
    expect(await readdir(inbox)).toEqual(['secret-invoice.pdf'])

    const paths = [
      `/u/${TOKEN}/secret-invoice.pdf`,
      `/u/${TOKEN}/files/secret-invoice.pdf`,
      `/u/${TOKEN}/upload/secret-invoice.pdf`,
      '/secret-invoice.pdf',
      '/files/secret-invoice.pdf'
    ]
    for (const path of paths) {
      const res = await fetch(`${base}${path}`)
      expect(res.status).toBe(404)
      expect(await res.text()).toBe('')
    }
  })

  it('cannot list the inbox', async () => {
    await postFiles(TOKEN, [bill('a.pdf')])
    for (const path of [`/u/${TOKEN}/files`, `/u/${TOKEN}/list`, `/u/${TOKEN}/inbox`]) {
      const res = await fetch(`${base}${path}`)
      expect(res.status).toBe(404)
    }
  })

  it('does not answer a GET on the upload endpoint', async () => {
    const res = await fetch(`${base}/u/${TOKEN}/upload`)
    expect(res.status).toBe(404)
  })

  it('advertises no server software', async () => {
    const res = await fetch(`${base}/u/${TOKEN}/`)
    expect(res.headers.get('x-powered-by')).toBeNull()
  })
})
