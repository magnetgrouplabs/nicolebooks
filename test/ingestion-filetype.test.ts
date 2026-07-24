// test/ingestion-filetype.test.ts
//
// Wave-0 (RED) unit spec for the pure file-type classifier (ING-05, D-12, D-13).
// Mirrors the describe/it shape of test/ipc-contract.test.ts: pure inputs -> pure outputs,
// no fs and no DB. Until src/main/ingestion/filetype.ts exists this file fails to import
// (RED), which is the correct Wave-0 state.
//
// Coverage:
//   - isSupported accepts the case-insensitive supported set (.pdf .jpg .jpeg .png .heic
//     .heif) and rejects everything else (.docx .zip .txt).
//   - isJunk silently drops OS/system junk (.DS_Store, Thumbs.db, desktop.ini, .localized,
//     AppleDouble ._*, hidden dotfiles) but does NOT drop a .<name>.icloud sentinel (D-13):
//     the sentinel is translated to a placeholder signal BEFORE the generic dotfile rule.
//   - iCloudSentinelTarget maps ".bill.pdf.icloud" -> "bill.pdf" and returns null otherwise.
//   - localDateStamp formats the LOCAL calendar day (never UTC/toISOString), D-05.

import { describe, it, expect } from 'vitest'
import {
  isJunk,
  isSupported,
  iCloudSentinelTarget,
  localDateStamp
} from '../src/main/ingestion/filetype'

describe('isSupported', () => {
  it('accepts the supported extensions case-insensitively', () => {
    for (const name of [
      'invoice.pdf',
      'receipt.PDF',
      'photo.jpg',
      'photo.JPG',
      'scan.jpeg',
      'scan.JPEG',
      'shot.png',
      'shot.PNG',
      'iphone.heic',
      'iphone.HEIC',
      'iphone.heif',
      'iphone.HEIF'
    ]) {
      expect(isSupported(name)).toBe(true)
    }
  })

  it('rejects unsupported extensions', () => {
    for (const name of ['contract.docx', 'archive.zip', 'notes.txt', 'noextension']) {
      expect(isSupported(name)).toBe(false)
    }
  })
})

describe('isJunk', () => {
  it('flags OS/system junk and hidden dotfiles', () => {
    for (const name of [
      '.DS_Store',
      'Thumbs.db',
      'desktop.ini',
      '.localized',
      '._foo.pdf',
      '.hidden'
    ]) {
      expect(isJunk(name)).toBe(true)
    }
  })

  it('does not flag a real bill file', () => {
    expect(isJunk('bill.pdf')).toBe(false)
  })

  it('does NOT treat a .<name>.icloud sentinel as junk (D-13 ordering)', () => {
    // The sentinel must survive the junk filter so scan.ts can translate it into a
    // placeholder signal for <name> before the generic leading-dot rule applies.
    expect(isJunk('.bill.pdf.icloud')).toBe(false)
  })
})

describe('iCloudSentinelTarget', () => {
  it('maps a sentinel name to its real target', () => {
    expect(iCloudSentinelTarget('.bill.pdf.icloud')).toBe('bill.pdf')
  })

  it('returns null for a normal file name', () => {
    expect(iCloudSentinelTarget('bill.pdf')).toBeNull()
  })
})

describe('localDateStamp', () => {
  it('formats the local calendar day as YYYY-MM-DD (not UTC)', () => {
    // Month is 0-indexed in the Date constructor: month 6 = July. This is a LOCAL date,
    // so the stamp must be 2026-07-24 regardless of timezone (toISOString would be UTC).
    expect(localDateStamp(new Date(2026, 6, 24))).toBe('2026-07-24')
  })

  it('zero-pads single-digit months and days', () => {
    expect(localDateStamp(new Date(2026, 0, 5))).toBe('2026-01-05')
  })
})
