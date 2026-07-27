// test/upload-filename.test.ts
//
// The sanitizer is the security boundary for every name that arrives from outside the app. A
// multipart filename is just a string a client chose, so these cases are not hypotheticals: they
// are what a scanner sends at an upload endpoint within seconds of finding one.
//
// Two of the assertions here are about SILENCE rather than safety, and they matter just as much.
// src/main/ingestion/filetype.ts drops leading-dot and AppleDouble names as OS junk, so a file
// saved as '.bill.pdf' would sit in the inbox and never appear in a scan, with no message anywhere.
// A phone that says "sent" and a Bills screen that shows nothing is the worst outcome this feature
// can produce, and it is invisible without a test that names it.

import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  copyIntoInbox,
  isSupportedName,
  moveIntoInbox,
  resolveCollision,
  sanitizeFilename
} from '../src/main/upload/filename'
import { isJunk, isSupported } from '../src/main/ingestion/filetype'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nb-filename-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('sanitizeFilename strips everything that could escape the inbox', () => {
  it('keeps a well-formed name untouched', () => {
    expect(sanitizeFilename('Nassau Plumbing Invoice 1041.pdf')).toBe(
      'Nassau Plumbing Invoice 1041.pdf'
    )
  })

  it('reduces a POSIX traversal to its last segment', () => {
    expect(sanitizeFilename('../../../etc/passwd.pdf')).toBe('passwd.pdf')
  })

  it('reduces a Windows traversal to its last segment', () => {
    expect(sanitizeFilename('..\\..\\Windows\\System32\\drivers\\hosts.pdf')).toBe('hosts.pdf')
  })

  it('reduces an absolute Windows path to its last segment', () => {
    expect(sanitizeFilename('C:\\Users\\anthony\\bill.pdf')).toBe('bill.pdf')
  })

  it('drops a bare .. with nothing else', () => {
    // '..' is only dots, so every character is stripped and the fallback takes over. The result
    // must never be '..', which would resolve to the inbox's PARENT when joined.
    expect(sanitizeFilename('..')).toBe('upload')
    expect(sanitizeFilename('../..')).toBe('upload')
  })

  it('strips control characters, including a null byte truncation attempt', () => {
    expect(sanitizeFilename('bill\u0000.pdf.exe')).toBe('bill.pdf.exe')
    expect(sanitizeFilename('re\u001bceipt\u007f.jpg')).toBe('receipt.jpg')
  })

  it('strips characters Windows refuses outright', () => {
    expect(sanitizeFilename('in<vo>ice:"|?*.pdf')).toBe('invoice.pdf')
  })

  it('trims trailing dots and spaces, which Windows silently drops at create time', () => {
    // If these survived, the name on disk would differ from the name we told the user we saved.
    expect(sanitizeFilename('receipt.pdf. ')).toBe('receipt.pdf')
    expect(sanitizeFilename('receipt.pdf   ')).toBe('receipt.pdf')
  })

  it('collapses whitespace runs, including tabs', () => {
    // Tabs become spaces rather than vanishing: dropping them outright would silently weld two
    // words together and hand the user back a name they do not recognize.
    expect(sanitizeFilename('home   depot\t\treceipt.jpg')).toBe('home depot receipt.jpg')
  })

  it('caps the length while keeping the extension, which is what the scan classifies on', () => {
    const long = `${'a'.repeat(400)}.pdf`
    const out = sanitizeFilename(long)
    expect(out.length).toBeLessThanOrEqual(180)
    expect(out.endsWith('.pdf')).toBe(true)
    expect(isSupported(out)).toBe(true)
  })

  it('never returns an empty string', () => {
    for (const raw of ['', '   ', '.', '...', '/', '\\', '///', '\u0000']) {
      expect(sanitizeFilename(raw)).not.toBe('')
    }
  })
})

describe('sanitizeFilename produces names the Phase 2 scan will actually see', () => {
  // isJunk() silently DROPS these, so a file saved under one of them is lost with no message.
  it('strips a leading dot so the file is not treated as a hidden dotfile', () => {
    const name = sanitizeFilename('.bill.pdf')
    expect(name).toBe('bill.pdf')
    expect(isJunk(name)).toBe(false)
  })

  it('strips an AppleDouble prefix so the file is not treated as a resource fork', () => {
    const name = sanitizeFilename('._receipt.jpg')
    expect(name).toBe('receipt.jpg')
    expect(isJunk(name)).toBe(false)
  })

  it('never produces a name the junk filter would drop', () => {
    const hostile = [
      '.bill.pdf',
      '._bill.pdf',
      '.....invoice.pdf',
      '..\\.hidden.pdf',
      '/.DS_Store.pdf'
    ]
    for (const raw of hostile) expect(isJunk(sanitizeFilename(raw))).toBe(false)
  })
})

describe('isSupportedName delegates to the shipped extension list', () => {
  it('accepts every supported bill format, in any case', () => {
    for (const name of ['a.pdf', 'a.PDF', 'a.jpg', 'a.jpeg', 'a.png', 'a.heic', 'a.HEIF']) {
      expect(isSupportedName(name)).toBe(true)
    }
  })

  it('refuses everything else', () => {
    for (const name of ['a.docx', 'a.exe', 'a.pdf.exe', 'a', 'a.gif', 'a.svg', 'a.zip']) {
      expect(isSupportedName(name)).toBe(false)
    }
  })
})

describe('resolveCollision never overwrites', () => {
  it('returns the name unchanged when nothing is in the way', () => {
    expect(resolveCollision(dir, 'receipt.jpg')).toBe('receipt.jpg')
  })

  it('counts up past every existing copy', () => {
    writeFileSync(join(dir, 'receipt.jpg'), 'one')
    expect(resolveCollision(dir, 'receipt.jpg')).toBe('receipt (2).jpg')
    writeFileSync(join(dir, 'receipt (2).jpg'), 'two')
    expect(resolveCollision(dir, 'receipt.jpg')).toBe('receipt (3).jpg')
  })

  it('handles a name with no extension', () => {
    writeFileSync(join(dir, 'receipt'), 'one')
    expect(resolveCollision(dir, 'receipt')).toBe('receipt (2)')
  })
})

describe('copyIntoInbox and moveIntoInbox', () => {
  it('copies, leaving the source where the user left it', async () => {
    const source = join(dir, 'source.pdf')
    writeFileSync(source, 'bytes')
    const inbox = mkdtempSync(join(tmpdir(), 'nb-inbox-'))
    try {
      const saved = await copyIntoInbox(inbox, source, 'source.pdf')
      expect(saved).toBe('source.pdf')
      expect(existsSync(source)).toBe(true) // NOT a move: the original is untouched
      expect(await readdir(inbox)).toEqual(['source.pdf'])
    } finally {
      rmSync(inbox, { recursive: true, force: true })
    }
  })

  it('moves, and sanitizes a hostile name on the way in', async () => {
    const staged = join(dir, 'staged.tmp')
    writeFileSync(staged, 'bytes')
    const inbox = mkdtempSync(join(tmpdir(), 'nb-inbox-'))
    try {
      const saved = await moveIntoInbox(inbox, staged, '../../../evil.pdf')
      expect(saved).toBe('evil.pdf')
      expect(existsSync(staged)).toBe(false) // moved, not copied
      expect(await readdir(inbox)).toEqual(['evil.pdf'])
    } finally {
      rmSync(inbox, { recursive: true, force: true })
    }
  })

  it('gives two same-named files two distinct names', async () => {
    const inbox = mkdtempSync(join(tmpdir(), 'nb-inbox-'))
    try {
      for (const n of [1, 2, 3]) {
        const staged = join(dir, `s${n}.tmp`)
        writeFileSync(staged, `bytes-${n}`)
        await moveIntoInbox(inbox, staged, 'image.jpg')
      }
      expect((await readdir(inbox)).sort()).toEqual([
        'image (2).jpg',
        'image (3).jpg',
        'image.jpg'
      ])
    } finally {
      rmSync(inbox, { recursive: true, force: true })
    }
  })
})
