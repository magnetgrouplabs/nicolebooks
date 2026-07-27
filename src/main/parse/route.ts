// src/main/parse/route.ts
//
// The native-vs-scan routing gate (PARSE-01/PARSE-02, decisions D-07, D-08 and D-20). One
// question, asked per document: does this file have an AUTHORITATIVE embedded text layer we can
// hand the model alongside the page image (belt-and-suspenders, D-06), or is it really just a
// picture that has to go image-only?
//
// Getting it wrong in the permissive direction is the expensive failure. A scanned bill often
// carries an invisible OCR overlay, so `extractText` returns plenty of characters — and they are
// junk. Pairing that junk with the image under a prompt that calls the text a "reference
// transcription" does not waste tokens, it feeds the model a confident wrong reading of the
// totals. That is exactly why D-08 mandates a layered gate instead of a text-length check, and
// why the two "this is really a picture" rungs are evaluated FIRST.
//
// D-20, per page, in order:
//   1. painted-bitmap coverage >= 0.75           -> image-only  (Docling bitmap_area_threshold)
//   2. invisible-glyph ratio   >  0.90           -> image-only  (text-render-mode 3 OCR overlay)
//   3. >= 50 non-whitespace chars AND >= 1 font  -> native      (belt-and-suspenders)
//   4. otherwise                                 -> image-only  (fail safe)
// Whole document: native iff at least 50% of pages are native.
//
// Char count is a SOFT tiebreaker inside rung 3 and never a gate on its own: a page can extract
// thousands of characters and still be a scan (rung 2), and a page with no font resource has no
// authoritative text layer no matter how much text a broken extractor reports.
//
// The four thresholds are research STARTING values (assumption A2), not verified optima, so they
// are named module constants that the committed fixtures and real bills can retune.
//
// Shape mirrors src/main/ingestion/scan.ts: a pure classify-and-gate core with the one
// side-effecting collaborator (the pdf signal loader) injected through `deps` and defaulting to
// the real implementation. Tests feed synthetic per-page signals; production omits `deps`.

/** Which pipeline a document takes to the vision model. */
export type ParseRoute = 'native' | 'image-only'

/**
 * The four D-20 signals for ONE PDF page. Produced by extract-pdf.ts's `loadPdfSignals` from
 * pdfjs's operator list plus unpdf's extracted text; produced synthetically by the unit spec.
 */
export interface PageSignals {
  /** Painted-image area divided by page area. 1.0 means a full-page bitmap (a scan). */
  bitmapCoverage: number
  /** Share of glyph-show operators drawn under text-rendering-mode 3 (invisible OCR overlay). */
  invisibleGlyphRatio: number
  /** Non-whitespace characters in the page's embedded text layer. */
  nonWhitespaceChars: number
  /** Distinct fonts the page's content stream selects. Zero means no real text layer. */
  embeddedFontCount: number
}

/** Rung 1: painted-bitmap coverage at or above this share of the page means it IS the page. */
export const BITMAP_COVERAGE_THRESHOLD = 0.75
/** Rung 2: above this share of invisible glyph-show ops, the text layer is an OCR overlay. */
export const INVISIBLE_GLYPH_RATIO = 0.9
/** Rung 3: minimum non-whitespace characters for a page to count as carrying real text. */
export const MIN_NATIVE_CHARS = 50
/** Document rule: the share of native pages needed for the whole PDF to route native. */
export const NATIVE_PAGE_MAJORITY = 0.5

/** Extensions that are photos, never PDFs — they go straight to prepImage (D-07). */
const PDF_EXTENSION = '.pdf'

/** What routeFile resolved, including the per-page signals so callers can log/tune the gate. */
export interface RouteDecision {
  route: ParseRoute
  /** Pages in the PDF; always 1 for a photo. */
  pageCount: number
  /** Empty for photos: there is nothing to measure, they are image-only by definition. */
  pages: PageSignals[]
}

/** Injectable collaborators so the gate is unit-testable without pdfjs, bytes, or Electron. */
export interface RouteDeps {
  /** Default: the real pdfjs + unpdf loader in extract-pdf.ts. */
  loadPdfSignals?: (bytes: Buffer) => Promise<PageSignals[]>
}

/**
 * Apply the four D-20 rungs to ONE page. Exported so the thresholds can be exercised (and
 * retuned) rung by rung rather than only through a whole-document verdict.
 */
export function routePage(signals: PageSignals): ParseRoute {
  const bitmapCoverage = finite(signals?.bitmapCoverage)
  const invisibleGlyphRatio = finite(signals?.invisibleGlyphRatio)
  const nonWhitespaceChars = finite(signals?.nonWhitespaceChars)
  const embeddedFontCount = finite(signals?.embeddedFontCount)

  // 1. The page is mostly (or entirely) a painted bitmap: it is a scan or a photo pasted into a
  //    PDF wrapper. Checked first so a bitmap page with an OCR overlay never reaches rung 3.
  if (bitmapCoverage >= BITMAP_COVERAGE_THRESHOLD) return 'image-only'

  // 2. Nearly every glyph is drawn invisibly (text-rendering-mode 3). That is the signature of an
  //    OCR layer hidden under a scan — text that exists to be searchable, not to be trusted.
  if (invisibleGlyphRatio > INVISIBLE_GLYPH_RATIO) return 'image-only'

  // 3. Real, visible text from a real font: the born-digital case where the embedded text has the
  //    exact digits and vision-model number OCR does not (RESEARCH Pitfall 5).
  if (nonWhitespaceChars >= MIN_NATIVE_CHARS && embeddedFontCount >= 1) return 'native'

  // 4. Anything else — a near-empty page, text with no font resource — is not authoritative.
  return 'image-only'
}

/**
 * The whole-document verdict: native only when at least half the pages are native.
 *
 * A document with no readable pages routes image-only. That direction is deliberate: routing a
 * scan as native pairs junk text with the image (the D-08 failure), whereas routing a native PDF
 * as image-only merely forfeits the exact-text anchor. The costly mistake is the other one.
 */
export function routePdf(pages: PageSignals[]): ParseRoute {
  if (!Array.isArray(pages) || pages.length === 0) return 'image-only'
  const nativePages = pages.filter((page) => routePage(page) === 'native').length
  return nativePages / pages.length >= NATIVE_PAGE_MAJORITY ? 'native' : 'image-only'
}

/**
 * Route one loaded file by SOURCE TYPE first, then (for PDFs only) by the D-20 gate.
 *
 * The source-type branch is the load-bearing one. A raw photo (JPEG/PNG/HEIC) goes to
 * prep-image.ts; a PDF that the gate calls image-only goes to extract-pdf.ts's
 * `renderPdfPageImage`, NOT to prep-image.ts — sharp cannot decode PDF bytes, so collapsing the
 * two image-only cases into one prepImage call would make every scanned bill unparseable
 * (D-07/D-19).
 */
export async function routeFile(
  file: { filename: string; bytes: Buffer },
  deps: RouteDeps = {}
): Promise<RouteDecision> {
  if (!isPdf(file.filename)) {
    // A photo is image-only by definition; there is no text layer to measure and no reason to
    // open it as a PDF. Phase 2's scan already rejected unsupported extensions upstream.
    return { route: 'image-only', pageCount: 1, pages: [] }
  }

  // Lazily resolved so importing the pure gate never drags in pdfjs/unpdf (and so the unit spec
  // can drive every rung with zero bytes).
  const loadPdfSignals =
    deps.loadPdfSignals ?? (async (bytes: Buffer) => (await import('./extract-pdf')).loadPdfSignals(bytes))

  const pages = await loadPdfSignals(file.bytes)
  return { route: routePdf(pages), pageCount: pages.length, pages }
}

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

/** A malformed signal must not silently satisfy a threshold; treat it as absent evidence. */
function finite(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function isPdf(filename: string): boolean {
  return typeof filename === 'string' && filename.toLowerCase().endsWith(PDF_EXTENSION)
}
