// src/main/parse/extract-pdf.ts
//
// Everything the pipeline needs out of a PDF (PARSE-01/PARSE-02, decisions D-06, D-19, D-20):
// the embedded text layer, the four D-20 routing signals, and a rasterized page image.
//
// THE RULE THIS MODULE EXISTS TO ENFORCE: an image-only PDF is rasterized HERE, by pdfjs +
// @napi-rs/canvas, and only the resulting bitmap goes to the vision model. It must never be
// handed to prep-image.ts — sharp cannot decode PDF bytes at all, so that route is not a slow
// path, it is a hard failure that would leave every scanned or faxed bill unparseable (D-07/D-19).
//
// Two library facts are load-bearing and were both verified the hard way in plan 03-01:
//
//   1. pdfjs-dist's DEFAULT build cannot load in the Electron main process. It throws
//      `ReferenceError: DOMMatrix is not defined` because main is Node with no DOM, and the
//      package itself warns "Please use the 'legacy' build in Node.js environments." Only the
//      legacy build below exposes a working `getDocument` + `OPS` pair, and D-20's gate needs
//      `OPS` for `paintImageXObject` and text-rendering-mode 3.
//   2. unpdf defaults to a serverless PDF.js bundle that cannot rasterize, and in Node its
//      renderer additionally REQUIRES a canvas provider (RESEARCH Pitfall 1). `definePDFJSModule`
//      (unpdf 1.6.2's replacement for the now-deprecated `configureUnPDF`, which is removed in
//      v2) points it at the official legacy build, and `canvasImport` supplies @napi-rs/canvas.
//
// Byte access stays main-only, the Phase 1 boundary that src/main/ingestion/hash.ts established.
// Every pdfjs entry gets a fresh copy of the caller's bytes, because pdfjs may transfer (and
// thereby detach) the typed array it is given.

import {
  createIsomorphicCanvasFactory,
  definePDFJSModule,
  extractText,
  getDocumentProxy,
  getResolvedPDFJS,
  renderPageAsImage
} from 'unpdf'
import type { PageSignals } from './route'

/**
 * The ONLY pdfjs build that works in the Electron main process. See note 1 above; do not change
 * this to 'pdfjs-dist' without re-verifying, it fails at import time with no DOM.
 */
const PDFJS_LEGACY_BUILD = (): Promise<unknown> => import('pdfjs-dist/legacy/build/pdf.mjs')

/** The Node canvas provider unpdf's renderer requires (D-19). Prebuilt N-API, no rebuild. */
const CANVAS_IMPORT = (): Promise<typeof import('@napi-rs/canvas')> => import('@napi-rs/canvas')

/** Target long edge for a rendered page: legible small print, bounded tokens (Pitfall 6). */
export const RENDER_LONG_EDGE = 2000
/** Never up-scale beyond 4x: a tiny MediaBox must not be blown up into a huge raster. */
export const RENDER_MAX_SCALE = 4
/**
 * The absolute ceiling on OUTPUT pixels, whatever the page geometry claims (T-03-02/T-03-03).
 *
 * Bounding the multiplier alone is not a bound: the raster is pageSize * scale, so a floor of 1
 * on the scale guaranteed that an oversized page rendered at FULL size. PDF permits a MediaBox up
 * to 14400x14400 units, and `createCanvas(14400, 14400)` measures at ~875 MB RSS on this machine
 * before unpdf's PNG data-URL round trip and encodeJpeg's second canvas — several gigabytes for
 * one page. An OOM abort is not catchable by the pipeline's per-file try/catch, so it would take
 * the whole app (and the rest of the batch) down with it, defeating D-15.
 */
export const RENDER_MAX_PIXELS = 4_000_000 // ~2000x2000
/** JPEG quality for the rendered page; matches prep-image.ts so both routes look the same. */
export const RENDER_JPEG_QUALITY = 80

/** unpdf's per-page text extraction result (mergePages: false). */
export interface PdfText {
  totalPages: number
  /** One entry per page, in page order. */
  text: string[]
}

/**
 * Resolve pdfjs ONCE per process, to the legacy build. Memoized on the promise (not a boolean)
 * so concurrent parses in a batch cannot race two resolutions.
 */
let pdfjsReady: Promise<void> | null = null
async function ensurePdfjs(): Promise<void> {
  pdfjsReady ??= definePDFJSModule(PDFJS_LEGACY_BUILD)
  await pdfjsReady
}

/**
 * Extract the embedded text layer, one string per page (D-06's exact-text half).
 *
 * Whether that text is AUTHORITATIVE is not this function's call — route.ts decides that from the
 * signals below. A scan with an OCR overlay returns plenty of text here and must still be routed
 * image-only.
 *
 * The document is created HERE rather than by handing raw bytes to unpdf, because of the teardown
 * rule in the note below `closeDocument`. Given bytes, unpdf builds a proxy internally
 * (`const pdf = isPDFDocumentProxy(data) ? data : await getDocumentProxy(data)`) and never
 * destroys it, and returns no handle, so the caller has nothing to tear down: one leaked loading
 * task, transport, worker and retained copy of the PDF bytes per native-route bill, for the life
 * of a main process that stays up for days.
 */
export async function extractPdfText(bytes: Buffer): Promise<PdfText> {
  await ensurePdfjs()
  const doc = await getDocumentProxy(pdfjsBytes(bytes))
  try {
    const { totalPages, text } = await extractText(doc, { mergePages: false })
    return { totalPages, text }
  } finally {
    await closeDocument(doc)
  }
}

/**
 * Read the four D-20 signals for every page.
 *
 * Text comes from unpdf; the structural signals come from pdfjs's operator list, which is the only
 * place they exist:
 *   - bitmap coverage: the current transform matrix in force at each image-paint op maps the unit
 *     square onto the page, so |det(CTM)| IS the painted area in points. Summed and divided by the
 *     page area. Reference: Docling's bitmap_area_threshold.
 *   - invisible-glyph ratio: `setTextRenderingMode` arg 3 is INVISIBLE — the OCR-overlay marker.
 *     Counted as a share of all glyph-show ops.
 *   - embedded fonts: distinct `setFont` resources. No font means no real text layer.
 */
export async function loadPdfSignals(bytes: Buffer): Promise<PageSignals[]> {
  await ensurePdfjs()
  const { OPS } = await getResolvedPDFJS()
  const doc = await getDocumentProxy(pdfjsBytes(bytes))
  try {
    const { text } = await extractText(doc, { mergePages: false })
    const signals: PageSignals[] = []

    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
      const page = await doc.getPage(pageNumber)
      const viewport = page.getViewport({ scale: 1 })
      const pageArea = Math.abs(viewport.width * viewport.height)
      const operators = await page.getOperatorList()
      const measured = measureOperators(OPS, operators.fnArray, operators.argsArray)

      signals.push({
        bitmapCoverage: pageArea > 0 ? measured.bitmapArea / pageArea : 0,
        invisibleGlyphRatio:
          measured.glyphShowOps > 0 ? measured.invisibleShowOps / measured.glyphShowOps : 0,
        nonWhitespaceChars: countNonWhitespace(text[pageNumber - 1]),
        embeddedFontCount: measured.fonts.size
      })

      page.cleanup()
    }

    return signals
  } finally {
    await closeDocument(doc)
  }
}

/**
 * Rasterize one page to a JPEG buffer — the image-only-PDF route to the vision model (D-19).
 *
 * `pageIndex` is ZERO-based (the caller iterates pages, not PDF page numbers); unpdf takes
 * one-based page numbers, so the conversion happens here and nowhere else.
 *
 * The render scale is derived from the page's own geometry by computeRenderScale, so an A4 invoice
 * and a wide receipt both land near RENDER_LONG_EDGE while an enormous MediaBox is DOWN-scaled
 * under the RENDER_MAX_PIXELS ceiling rather than rendered at full size. unpdf's renderer emits
 * PNG (canvas.toDataURL defaults to it), so the
 * bitmap is re-encoded to JPEG by @napi-rs/canvas — deliberately NOT by sharp, which keeps the
 * entire PDF path sharp-free and the D-07 boundary unambiguous.
 */
export async function renderPdfPageImage(bytes: Buffer, pageIndex: number): Promise<Buffer> {
  await ensurePdfjs()
  const CanvasFactory = await createIsomorphicCanvasFactory(CANVAS_IMPORT)
  const doc = await getDocumentProxy(pdfjsBytes(bytes), { CanvasFactory })
  try {
    const pageNumber = pageIndex + 1
    if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > doc.numPages) {
      throw new Error(
        `Cannot render page index ${pageIndex}: the document has ${doc.numPages} page(s).`
      )
    }

    const page = await doc.getPage(pageNumber)
    const viewport = page.getViewport({ scale: 1 })
    const scale = computeRenderScale(viewport.width, viewport.height)

    const png = await renderPageAsImage(doc, pageNumber, { canvasImport: CANVAS_IMPORT, scale })
    return await encodeJpeg(Buffer.from(png))
  } finally {
    await closeDocument(doc)
  }
}

/**
 * The render scale for a page of `width` x `height` PDF units.
 *
 * Two bounds, and the second one is the load-bearing one:
 *   1. aim the long edge at RENDER_LONG_EDGE, never up-scaling past RENDER_MAX_SCALE;
 *   2. cap the OUTPUT PIXEL COUNT at RENDER_MAX_PIXELS, which requires allowing a scale BELOW 1
 *      for an oversized page. A floor of 1 (the pre-fix behaviour) meant a 14400x14400 MediaBox
 *      rendered at full size, so the "never above 4x" comment bounded the multiplier while the
 *      raster stayed unbounded.
 *
 * Exported so the bound is unit-testable without rasterizing anything.
 */
export function computeRenderScale(width: number, height: number): number {
  const w = Number.isFinite(width) && width > 0 ? width : 0
  const h = Number.isFinite(height) && height > 0 ? height : 0
  const longEdge = Math.max(w, h)
  if (longEdge <= 0) return 1

  // Down-scaling is explicitly allowed here: that is the whole fix.
  let scale = Math.min(RENDER_LONG_EDGE / longEdge, RENDER_MAX_SCALE)
  const pixels = w * h * scale * scale
  if (pixels > RENDER_MAX_PIXELS) scale *= Math.sqrt(RENDER_MAX_PIXELS / pixels)

  return Number.isFinite(scale) && scale > 0 ? scale : 1
}

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

type PdfDocument = Awaited<ReturnType<typeof getDocumentProxy>>

/**
 * Release a document's worker/transport. pdfjs 6 dropped `PDFDocumentProxy.destroy()`; the task
 * that produced the proxy owns teardown now. A batch parses many files in one long-lived main
 * process, so skipping this leaks a worker per bill.
 *
 * Never allowed to throw: this runs in a `finally`, where a teardown error would mask both the
 * parsed result and any real parse failure the pipeline needs to flag (D-15).
 */
async function closeDocument(doc: PdfDocument): Promise<void> {
  try {
    await doc.loadingTask.destroy()
  } catch {
    // Teardown is best-effort by design.
  }
}

/** A 2x3 PDF transform: [a, b, c, d, e, f]. */
type Matrix = [number, number, number, number, number, number]
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0]

/** pdfjs's text-rendering-mode 3: draw nothing. The invisible OCR overlay marker. */
const TEXT_RENDERING_MODE_INVISIBLE = 3

interface OperatorMeasurements {
  bitmapArea: number
  glyphShowOps: number
  invisibleShowOps: number
  fonts: Set<string>
}

/**
 * Walk one page's operator list, tracking the graphics state, and total the D-20 signals.
 *
 * Repeat/group image ops are counted once at the current CTM rather than once per placement,
 * which UNDER-estimates coverage. Deliberate: under-estimating can only push a page toward the
 * native rungs, where the text/font requirements still have to be met independently, so it can
 * never turn a textless scan into a "native" verdict on its own.
 */
function measureOperators(
  OPS: Record<string, number>,
  fnArray: number[] | Int32Array,
  argsArray: unknown[]
): OperatorMeasurements {
  const imagePaintOps = opSet(OPS, [
    'paintImageXObject',
    'paintImageXObjectRepeat',
    'paintInlineImageXObject',
    'paintInlineImageXObjectGroup',
    'paintImageMaskXObject',
    'paintImageMaskXObjectRepeat',
    'paintImageMaskXObjectGroup'
  ])
  const glyphShowOps = opSet(OPS, [
    'showText',
    'showSpacedText',
    'nextLineShowText',
    'nextLineSetSpacingShowText'
  ])

  const measured: OperatorMeasurements = {
    bitmapArea: 0,
    glyphShowOps: 0,
    invisibleShowOps: 0,
    fonts: new Set<string>()
  }

  let ctm: Matrix = IDENTITY
  let textRenderingMode = 0
  const stack: { ctm: Matrix; textRenderingMode: number }[] = []

  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i]
    const args = argsArray[i]

    if (fn === OPS.save) {
      stack.push({ ctm, textRenderingMode })
    } else if (fn === OPS.restore) {
      const restored = stack.pop()
      ctm = restored?.ctm ?? IDENTITY
      textRenderingMode = restored?.textRenderingMode ?? 0
    } else if (fn === OPS.transform && isMatrix(args)) {
      ctm = multiply(ctm, args)
    } else if (fn === OPS.setTextRenderingMode && Array.isArray(args)) {
      textRenderingMode = typeof args[0] === 'number' ? args[0] : textRenderingMode
    } else if (fn === OPS.setFont && Array.isArray(args) && typeof args[0] === 'string') {
      measured.fonts.add(args[0])
    } else if (imagePaintOps.has(fn)) {
      // |det(CTM)| is the area the unit-square image occupies in page space.
      measured.bitmapArea += Math.abs(determinant(ctm))
    } else if (glyphShowOps.has(fn)) {
      measured.glyphShowOps += 1
      if (textRenderingMode === TEXT_RENDERING_MODE_INVISIBLE) measured.invisibleShowOps += 1
    }
  }

  return measured
}

/** Resolve op names to codes, skipping any this pdfjs build does not define. */
function opSet(OPS: Record<string, number>, names: string[]): Set<number> {
  const codes = new Set<number>()
  for (const name of names) {
    const code = OPS[name]
    if (typeof code === 'number') codes.add(code)
  }
  return codes
}

function isMatrix(args: unknown): args is Matrix {
  return Array.isArray(args) && args.length === 6 && args.every((n) => typeof n === 'number')
}

/** pdfjs Util.transform semantics. Only |det| is read, and det is multiplicative either way. */
function multiply(m: Matrix, n: Matrix): Matrix {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5]
  ]
}

function determinant(m: Matrix): number {
  return m[0] * m[3] - m[1] * m[2]
}

function countNonWhitespace(text: string | undefined): number {
  if (typeof text !== 'string') return 0
  return text.replace(/\s/g, '').length
}

/**
 * Re-encode the rendered PNG as JPEG with @napi-rs/canvas. sharp would do this in one call, but
 * keeping sharp out of the PDF path entirely is the point: the only sharp entry in this pipeline
 * is prep-image.ts, which only ever sees raw photo bytes.
 */
async function encodeJpeg(png: Buffer): Promise<Buffer> {
  const { createCanvas, loadImage } = await CANVAS_IMPORT()
  const image = await loadImage(png)
  const canvas = createCanvas(image.width, image.height)
  canvas.getContext('2d').drawImage(image, 0, 0)
  return canvas.toBuffer('image/jpeg', RENDER_JPEG_QUALITY)
}

/**
 * Hand pdfjs its OWN copy of the bytes. pdfjs may transfer the typed array it is given, which
 * detaches the caller's buffer — and the pipeline reads the same bytes again (hash, render,
 * signals), so a detached buffer would surface as a mysterious empty read later on.
 */
function pdfjsBytes(bytes: Buffer): Uint8Array {
  return new Uint8Array(bytes)
}
