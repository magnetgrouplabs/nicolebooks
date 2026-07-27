// test/parse-route.test.ts
//
// Wave-0 (RED) unit spec for the native-vs-scan routing gate (plan 03-04, PARSE-01/PARSE-02,
// decisions D-19 / D-20). Until src/main/parse/route.ts and src/main/parse/extract-pdf.ts exist
// this file fails to import — the correct Wave-0 state.
//
// Why the gate is LAYERED rather than a text-length check (D-08/D-20): a scanned bill carrying an
// invisible OCR overlay extracts plenty of text, and that text is junk. Pairing it with the page
// image under the belt-and-suspenders prompt (D-06) does not merely waste tokens — it feeds the
// model a confident, wrong transcription of the totals. The gate therefore runs four rungs in a
// fixed order per page, with the two "this is really a picture" rungs FIRST:
//
//   1. painted-bitmap coverage >= 0.75          -> image-only   (Docling bitmap_area_threshold)
//   2. invisible-glyph ratio   >  0.90          -> image-only   (text-render-mode 3 OCR overlay)
//   3. >= 50 non-whitespace chars AND >= 1 font -> native       (belt-and-suspenders)
//   4. otherwise                                -> image-only
//
// and a whole PDF is native only when at least 50% of its pages are native.
//
// The rung cases below drive SYNTHETIC per-page signals through the injectable deps seam
// (src/main/ingestion/scan.ts ScanDeps convention). Hand-authoring a PDF that exhibits a 0.91
// invisible-glyph ratio would prove nothing the injected case does not, and would make the
// thresholds untunable. The REAL fixture (test/fixtures/image-only.pdf) covers the two things
// injection cannot: that the real pdfjs signal loader routes a real image-only PDF `image-only`,
// and that such a page renders to a real JPEG through pdfjs + @napi-rs/canvas (D-19).

import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  BITMAP_COVERAGE_THRESHOLD,
  INVISIBLE_GLYPH_RATIO,
  MIN_NATIVE_CHARS,
  NATIVE_PAGE_MAJORITY,
  routeFile,
  routePdf
} from '../src/main/parse/route'
import type { PageSignals } from '../src/main/parse/route'
import {
  RENDER_LONG_EDGE,
  RENDER_MAX_PIXELS,
  RENDER_MAX_SCALE,
  computeRenderScale,
  extractPdfText,
  renderPdfPageImage
} from '../src/main/parse/extract-pdf'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')

/** A page that trips no rung: a little text, one font, no bitmap. Overridden per case. */
function page(overrides: Partial<PageSignals> = {}): PageSignals {
  return {
    bitmapCoverage: 0,
    invisibleGlyphRatio: 0,
    nonWhitespaceChars: 200,
    embeddedFontCount: 1,
    ...overrides
  }
}

const NATIVE_PAGE = page()
const SCAN_PAGE = page({ bitmapCoverage: 0.98, nonWhitespaceChars: 0, embeddedFontCount: 0 })

describe('D-20 thresholds', () => {
  it('exposes the locked starting values as tunable module constants', () => {
    // These four numbers ARE decision D-20. They are research starting values (assumption A2),
    // so they live as named constants that the committed fixtures can retune against real bills.
    expect(BITMAP_COVERAGE_THRESHOLD).toBe(0.75)
    expect(INVISIBLE_GLYPH_RATIO).toBe(0.9)
    expect(MIN_NATIVE_CHARS).toBe(50)
    expect(NATIVE_PAGE_MAJORITY).toBe(0.5)
  })
})

describe('routePdf — per-page rungs (D-20)', () => {
  it('rung 1: a bitmap-heavy page routes image-only even with plenty of text', () => {
    // 0.85 coverage over the page area. The text is deliberately generous (rung 3 would say
    // native) to prove the ordering: coverage is checked FIRST and wins.
    expect(routePdf([page({ bitmapCoverage: 0.85, nonWhitespaceChars: 900 })])).toBe('image-only')
  })

  it('rung 1: coverage exactly at the threshold routes image-only (>=, not >)', () => {
    expect(routePdf([page({ bitmapCoverage: BITMAP_COVERAGE_THRESHOLD })])).toBe('image-only')
  })

  it('rung 1: coverage just under the threshold does not trip it', () => {
    expect(routePdf([page({ bitmapCoverage: 0.74 })])).toBe('native')
  })

  it('rung 2: an invisible-OCR-overlay page routes image-only despite extracting text', () => {
    // The exact D-08 failure mode: 95% of glyph-show ops are text-render-mode 3, i.e. an OCR
    // layer painted under a full-page scan. The extracted text is junk and must never be paired.
    expect(
      routePdf([page({ invisibleGlyphRatio: 0.95, nonWhitespaceChars: 1200 })])
    ).toBe('image-only')
  })

  it('rung 2: a ratio exactly at the threshold is NOT an overlay (>, not >=)', () => {
    // 90% invisible still leaves a tenth of the glyphs genuinely painted; D-20 says "> 0.90".
    expect(routePdf([page({ invisibleGlyphRatio: INVISIBLE_GLYPH_RATIO })])).toBe('native')
  })

  it('rung 3: a text page with an embedded font and low coverage routes native', () => {
    expect(
      routePdf([page({ nonWhitespaceChars: 200, embeddedFontCount: 1, bitmapCoverage: 0.1 })])
    ).toBe('native')
  })

  it('rung 3: char count is a soft signal — text without an embedded font is not native', () => {
    // Char count is never the sole gate (D-20). No font resource means no authoritative text layer.
    expect(routePdf([page({ nonWhitespaceChars: 5000, embeddedFontCount: 0 })])).toBe('image-only')
  })

  it('rung 4: a nearly textless page routes image-only', () => {
    expect(routePdf([page({ nonWhitespaceChars: 10 })])).toBe('image-only')
  })

  it('rung 4: exactly MIN_NATIVE_CHARS is enough (>=, not >)', () => {
    expect(routePdf([page({ nonWhitespaceChars: MIN_NATIVE_CHARS })])).toBe('native')
    expect(routePdf([page({ nonWhitespaceChars: MIN_NATIVE_CHARS - 1 })])).toBe('image-only')
  })
})

describe('routePdf — whole-document majority (D-20)', () => {
  it('3 native of 4 pages -> native', () => {
    expect(routePdf([NATIVE_PAGE, NATIVE_PAGE, NATIVE_PAGE, SCAN_PAGE])).toBe('native')
  })

  it('2 native of 4 pages -> still native (>= 50%, not a strict majority)', () => {
    expect(routePdf([NATIVE_PAGE, NATIVE_PAGE, SCAN_PAGE, SCAN_PAGE])).toBe('native')
  })

  it('1 native of 4 pages -> image-only', () => {
    expect(routePdf([NATIVE_PAGE, SCAN_PAGE, SCAN_PAGE, SCAN_PAGE])).toBe('image-only')
  })

  it('a PDF with no readable pages routes image-only, never native', () => {
    // Fail safe: with zero signal there is no authoritative text layer to pair (D-08).
    expect(routePdf([])).toBe('image-only')
  })
})

describe('routeFile — dispatch by source type (D-07)', () => {
  it('routes a photo image-only WITHOUT ever opening it as a PDF', async () => {
    // The load-bearing branch of this plan: a JPEG/PNG/HEIC is a photo, so it goes straight to
    // prepImage; it must never be handed to the pdf signal loader.
    let pdfLoaderCalls = 0
    for (const filename of ['receipt.jpg', 'receipt.JPEG', 'receipt.png', 'receipt.heic']) {
      const decision = await routeFile(
        { filename, bytes: Buffer.from('not a pdf') },
        {
          loadPdfSignals: async () => {
            pdfLoaderCalls += 1
            return []
          }
        }
      )
      expect(decision.route).toBe('image-only')
      expect(decision.pageCount).toBe(1)
    }
    expect(pdfLoaderCalls).toBe(0)
  })

  it('routes a PDF through the injected signal loader and reports its page count', async () => {
    const decision = await routeFile(
      { filename: 'invoice.pdf', bytes: Buffer.from('%PDF-1.7') },
      { loadPdfSignals: async () => [NATIVE_PAGE, NATIVE_PAGE] }
    )
    expect(decision.route).toBe('native')
    expect(decision.pageCount).toBe(2)
    expect(decision.pages).toHaveLength(2)
  })

  it('routes a scanned PDF image-only through the injected signal loader', async () => {
    const decision = await routeFile(
      { filename: 'scan.pdf', bytes: Buffer.from('%PDF-1.7') },
      { loadPdfSignals: async () => [SCAN_PAGE] }
    )
    expect(decision.route).toBe('image-only')
  })
})

describe('real image-only PDF fixture (D-19 / D-20 end-to-end)', () => {
  it('extracts no usable text from the fixture', async () => {
    const bytes = await readFile(join(FIXTURES, 'image-only.pdf'))
    const { totalPages, text } = await extractPdfText(bytes)
    expect(totalPages).toBe(1)
    // A scanned page has no embedded text layer at all; this is what makes rung 3 unreachable.
    expect(text[0].replace(/\s/g, '')).toHaveLength(0)
  })

  it('routes the fixture image-only through the REAL pdfjs signal loader', async () => {
    const bytes = await readFile(join(FIXTURES, 'image-only.pdf'))
    const decision = await routeFile({ filename: 'image-only.pdf', bytes })
    expect(decision.route).toBe('image-only')
    expect(decision.pageCount).toBe(1)
    // The full-page image XObject is the reason: coverage 1.0, no glyphs, no fonts.
    expect(decision.pages[0].bitmapCoverage).toBeGreaterThanOrEqual(BITMAP_COVERAGE_THRESHOLD)
    expect(decision.pages[0].nonWhitespaceChars).toBe(0)
    expect(decision.pages[0].embeddedFontCount).toBe(0)
  }, 30_000)

  it('renders the fixture page to a real JPEG via pdfjs + @napi-rs/canvas (D-19)', async () => {
    // THE anti-pattern proof for this plan. sharp cannot decode PDF bytes, so an image-only PDF
    // reaches the vision model only if this render path exists and works. pageIndex is 0-based.
    const bytes = await readFile(join(FIXTURES, 'image-only.pdf'))
    const jpeg = await renderPdfPageImage(bytes, 0)
    expect(Buffer.isBuffer(jpeg)).toBe(true)
    expect(jpeg.length).toBeGreaterThan(1000)
    expect(jpeg.subarray(0, 3).toString('hex')).toBe('ffd8ff') // JPEG SOI + marker, not PNG
  }, 30_000)

  it('rejects an out-of-range page index rather than returning an empty buffer', async () => {
    const bytes = await readFile(join(FIXTURES, 'image-only.pdf'))
    await expect(renderPdfPageImage(bytes, 5)).rejects.toThrow()
  }, 30_000)
})

// ---------------------------------------------------------------------------
// CR-02: the render bound is on OUTPUT PIXELS, not on the multiplier
// ---------------------------------------------------------------------------
//
// The scale used to be clamped to a MINIMUM of 1, so any page whose long edge exceeded
// RENDER_LONG_EDGE was rendered at full size. PDF allows a 14400x14400 MediaBox, and
// createCanvas(14400, 14400) measures ~875 MB RSS before unpdf's PNG data-URL round trip and
// encodeJpeg's second canvas. An OOM abort is NOT catchable by the pipeline's per-file try/catch,
// so one hostile (or merely large-format) PDF took the whole batch down with the app.

describe('computeRenderScale — the output-pixel ceiling (CR-02)', () => {
  it('down-scales an enormous MediaBox instead of rendering it 1:1', () => {
    const scale = computeRenderScale(14_400, 14_400)
    expect(scale).toBeLessThan(1) // the pre-fix floor of 1 is exactly the defect
    expect(14_400 * scale * (14_400 * scale)).toBeLessThanOrEqual(RENDER_MAX_PIXELS)
  })

  it('keeps every page under the pixel ceiling, whatever its geometry', () => {
    const geometries: Array<[number, number]> = [
      [14_400, 14_400],
      [14_400, 100],
      [5000, 5000],
      [3000, 4000],
      [612, 792], // US Letter
      [595, 842], // A4
      [200, 200]
    ]
    for (const [w, h] of geometries) {
      const scale = computeRenderScale(w, h)
      expect(w * scale * (h * scale)).toBeLessThanOrEqual(RENDER_MAX_PIXELS + 1)
      expect(scale).toBeGreaterThan(0)
      expect(scale).toBeLessThanOrEqual(RENDER_MAX_SCALE)
    }
  })

  it('still up-scales a small page toward the target long edge (capped at 4x)', () => {
    // A US Letter page: 792 * 2.525 ~= 2000, the legible-small-print target.
    expect(computeRenderScale(612, 792)).toBeCloseTo(RENDER_LONG_EDGE / 792, 6)
    // A tiny receipt-sized MediaBox is capped rather than blown up 20x.
    expect(computeRenderScale(100, 100)).toBe(RENDER_MAX_SCALE)
  })

  it('degrades to 1 on a nonsense viewport instead of NaN or Infinity', () => {
    for (const [w, h] of [
      [0, 0],
      [Number.NaN, 100],
      [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY],
      [-10, -10]
    ] as Array<[number, number]>) {
      const scale = computeRenderScale(w, h)
      expect(Number.isFinite(scale)).toBe(true)
      expect(scale).toBeGreaterThan(0)
    }
  })
})

describe('renderPdfPageImage — a large-MediaBox page cannot allocate an unbounded raster', () => {
  it('renders a synthetic 14400x14400 page at or under RENDER_MAX_PIXELS', async () => {
    const jpeg = await renderPdfPageImage(syntheticPdf(14_400, 14_400), 0)
    const { width, height } = await jpegSize(jpeg)
    expect(width * height).toBeLessThanOrEqual(RENDER_MAX_PIXELS)
    expect(Math.max(width, height)).toBeLessThanOrEqual(RENDER_LONG_EDGE)
  }, 60_000)

  it('renders a merely oversized page (5000x5000) under the ceiling too', async () => {
    // Pre-fix this rendered 5000x5000 = 25 megapixels, 25x over the bound.
    const jpeg = await renderPdfPageImage(syntheticPdf(5000, 5000), 0)
    const { width, height } = await jpegSize(jpeg)
    expect(width * height).toBeLessThanOrEqual(RENDER_MAX_PIXELS)
  }, 60_000)
})

/** Decode a rendered JPEG far enough to read its dimensions. */
async function jpegSize(jpeg: Buffer): Promise<{ width: number; height: number }> {
  const { loadImage } = await import('@napi-rs/canvas')
  const image = await loadImage(jpeg)
  return { width: image.width, height: image.height }
}

/**
 * A minimal, valid one-page PDF with the given MediaBox, built with real xref offsets so pdfjs
 * loads it without falling back to recovery. Everything is ASCII, so byte offsets equal string
 * lengths.
 */
function syntheticPdf(width: number, height: number): Buffer {
  const content = `0.2 0.4 0.9 rg 0 0 ${width} ${height} re f`
  const bodies = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Resources << >> /Contents 4 0 R >>`,
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`
  ]

  let pdf = '%PDF-1.4\n'
  const offsets: number[] = []
  bodies.forEach((body, index) => {
    offsets.push(pdf.length)
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`
  })

  const xrefAt = pdf.length
  pdf += `xref\n0 ${bodies.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets) pdf += `${offset.toString().padStart(10, '0')} 00000 n \n`
  pdf += `trailer\n<< /Size ${bodies.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`
  return Buffer.from(pdf, 'latin1')
}
