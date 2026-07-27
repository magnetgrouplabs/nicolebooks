// test/parse-prep-image.test.ts
//
// Wave-0 (RED) unit spec for photo/scan preparation (plan 03-04, PARSE-02, decisions D-07 and
// D-19, threat T-03-03). Until src/main/parse/prep-image.ts exists this file fails to import —
// the correct Wave-0 state.
//
// Four things must hold, and each one is a real-world failure if it does not:
//   1. HEIC decodes BEFORE sharp. sharp's prebuilt libvips cannot decode HEIC (patent-encumbered),
//      so feeding .heic bytes straight to sharp throws and the bill never parses. iPhones shoot
//      HEIC by default, so this is the common case, not the edge case (RESEARCH Pitfall 2).
//   2. sharp's rotate() is called with NO angle. That, and only that, applies EXIF orientation.
//      Phone photos of receipts are routinely sideways; a model reading a rotated receipt
//      mis-extracts the total (RESEARCH Pitfall 3).
//   3. The long edge is bounded at 2000px. Over-scaling burns tokens with no accuracy gain,
//      because the provider re-tiles the image anyway (RESEARCH Pitfall 6).
//   4. A decompression bomb cannot force an unbounded raster: sharp is constructed with a
//      bounded limitInputPixels and resize uses withoutEnlargement (T-03-03).
//
// The collaborator ordering (1) is proven with INJECTED doubles that record call order, because
// the assertion is about which collaborator runs first — a committed 1 MB .heic would prove the
// same thing less directly. The EXIF/downscale behaviour (2,3) is proven against the REAL
// committed fixture through the REAL sharp, because that is exactly where a wrong pipeline order
// would hide.

import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import {
  JPEG_QUALITY,
  LONG_EDGE,
  MAX_INPUT_PIXELS,
  prepImage
} from '../src/main/parse/prep-image'
import type { SharpLike } from '../src/main/parse/prep-image'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')

interface Recorder {
  order: string[]
  sharpInput?: Buffer
  sharpOptions?: { limitInputPixels: number }
  rotateArgs?: unknown[]
  resizeOptions?: unknown
  jpegOptions?: unknown
  convertOptions?: unknown
}

/** A sharp double that records the exact pipeline the module builds, then yields a marker. */
function fakes(): { rec: Recorder; sharp: SharpLike; convert: (o: never) => Promise<ArrayBuffer> } {
  const rec: Recorder = { order: [] }
  const fakeSharp: SharpLike = (input, options) => {
    rec.order.push('sharp')
    rec.sharpInput = input
    rec.sharpOptions = options
    const pipeline = {
      rotate: (...args: unknown[]) => {
        rec.rotateArgs = args
        return pipeline
      },
      resize: (options: unknown) => {
        rec.resizeOptions = options
        return pipeline
      },
      jpeg: (options: unknown) => {
        rec.jpegOptions = options
        return pipeline
      },
      toBuffer: async () => Buffer.from('PREPPED')
    }
    return pipeline as unknown as ReturnType<SharpLike>
  }
  const fakeConvert = async (options: never): Promise<ArrayBuffer> => {
    rec.order.push('convert')
    rec.convertOptions = options
    const decoded = Buffer.from('DECODED-JPEG')
    return decoded.buffer.slice(
      decoded.byteOffset,
      decoded.byteOffset + decoded.byteLength
    ) as ArrayBuffer
  }
  return { rec, sharp: fakeSharp, convert: fakeConvert }
}

describe('prepImage — HEIC decode ordering (D-07, RESEARCH Pitfall 2)', () => {
  it('runs heic-convert BEFORE sharp for a .heic file', async () => {
    const { rec, sharp: fakeSharp, convert } = fakes()
    await prepImage(Buffer.from('HEIC-BYTES'), '.heic', { sharp: fakeSharp, convert })
    expect(rec.order).toEqual(['convert', 'sharp'])
  })

  it('hands sharp the DECODED bytes, not the original HEIC bytes', async () => {
    // Ordering alone is not enough: if the decoded buffer were dropped on the floor, sharp would
    // still receive undecodable HEIC and throw in production while this spec stayed green.
    const { rec, sharp: fakeSharp, convert } = fakes()
    await prepImage(Buffer.from('HEIC-BYTES'), '.heic', { sharp: fakeSharp, convert })
    expect(rec.sharpInput?.toString()).toBe('DECODED-JPEG')
  })

  it('decodes to JPEG at the documented quality', async () => {
    const { rec, sharp: fakeSharp, convert } = fakes()
    const bytes = Buffer.from('HEIC-BYTES')
    await prepImage(bytes, '.heic', { sharp: fakeSharp, convert })
    expect(rec.convertOptions).toEqual({ buffer: bytes, format: 'JPEG', quality: 0.9 })
  })

  it('also decodes .heif, and is case-insensitive about the extension', async () => {
    for (const ext of ['.heif', '.HEIC', 'heic']) {
      const { rec, sharp: fakeSharp, convert } = fakes()
      await prepImage(Buffer.from('HEIC-BYTES'), ext, { sharp: fakeSharp, convert })
      expect(rec.order, `ext ${ext}`).toEqual(['convert', 'sharp'])
    }
  })

  it('NEVER calls heic-convert for a .jpg', async () => {
    const { rec, sharp: fakeSharp, convert } = fakes()
    const bytes = Buffer.from('JPEG-BYTES')
    await prepImage(bytes, '.jpg', { sharp: fakeSharp, convert })
    expect(rec.order).toEqual(['sharp'])
    expect(rec.sharpInput).toBe(bytes) // passed straight through, unmodified
  })

  it('NEVER calls heic-convert for a .png', async () => {
    const { rec, sharp: fakeSharp, convert } = fakes()
    await prepImage(Buffer.from('PNG-BYTES'), '.png', { sharp: fakeSharp, convert })
    expect(rec.order).toEqual(['sharp'])
  })
})

describe('prepImage — pipeline shape (D-07, T-03-03)', () => {
  it('builds rotate() with no angle, a bounded resize, and a JPEG re-encode', async () => {
    const { rec, sharp: fakeSharp, convert } = fakes()
    await prepImage(Buffer.from('JPEG-BYTES'), '.jpg', { sharp: fakeSharp, convert })

    // rotate() with NO argument is what applies EXIF orientation. rotate(0) would not.
    expect(rec.rotateArgs).toEqual([])
    expect(rec.resizeOptions).toEqual({
      width: LONG_EDGE,
      height: LONG_EDGE,
      fit: 'inside',
      withoutEnlargement: true
    })
    expect(rec.jpegOptions).toEqual({ quality: JPEG_QUALITY })
    expect(LONG_EDGE).toBe(2000)
  })

  it('constructs sharp with a bounded limitInputPixels (decompression-bomb guard)', async () => {
    const { rec, sharp: fakeSharp, convert } = fakes()
    await prepImage(Buffer.from('JPEG-BYTES'), '.jpg', { sharp: fakeSharp, convert })
    expect(rec.sharpOptions).toEqual({ limitInputPixels: MAX_INPUT_PIXELS })
    expect(MAX_INPUT_PIXELS).toBeGreaterThan(0)
    // Well under sharp's own 268MP default, and well over any real camera or scanner output.
    expect(MAX_INPUT_PIXELS).toBeLessThan(268_402_689)
  })
})

describe('prepImage — real sideways EXIF photo (PARSE-02, RESEARCH Pitfalls 3 and 6)', () => {
  it('auto-orients and downscales the committed fixture through the REAL sharp', async () => {
    const bytes = await readFile(join(FIXTURES, 'sideways-exif.jpg'))

    // The fixture is stored 2400x1200 (landscape) tagged EXIF orientation 6.
    const source = await sharp(bytes).metadata()
    expect([source.width, source.height]).toEqual([2400, 1200])
    expect(source.orientation).toBe(6)

    const out = await sharp(await prepImage(bytes, '.jpg')).metadata()

    // Oriented: 2400x1200 becomes 1200x2400, so the output is PORTRAIT. A pipeline that ignored
    // EXIF would produce 2000x1000 here — landscape — so this cannot pass vacuously.
    expect(out.height).toBeGreaterThan(out.width!)
    expect([out.width, out.height]).toEqual([1000, 2000])
    expect(Math.max(out.width!, out.height!)).toBeLessThanOrEqual(LONG_EDGE)
    expect(out.format).toBe('jpeg')
  }, 30_000)

  it('never enlarges an already-small image', async () => {
    const small = await sharp({
      create: { width: 400, height: 300, channels: 3, background: '#ffffff' }
    })
      .jpeg()
      .toBuffer()
    const out = await sharp(await prepImage(small, '.jpg')).metadata()
    expect([out.width, out.height]).toEqual([400, 300])
  }, 30_000)
})

describe('prepImage — why image-only PDFs must NOT come here (D-07 / D-19)', () => {
  it('rejects PDF bytes, because sharp cannot decode a PDF', async () => {
    // This is the whole reason routing exists. An image-only PDF has to be rasterized by
    // renderPdfPageImage (pdfjs + @napi-rs/canvas) first; handing its bytes to prepImage is not
    // a slow path, it is a hard failure that would make every scanned bill unparseable.
    const pdfBytes = await readFile(join(FIXTURES, 'image-only.pdf'))
    await expect(prepImage(pdfBytes, '.pdf')).rejects.toThrow()
  }, 30_000)
})
