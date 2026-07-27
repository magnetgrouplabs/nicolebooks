// src/main/parse/prep-image.ts
//
// Photo/scan preparation for the vision model (PARSE-02, decisions D-07, threat T-03-03):
// HEIC decode -> EXIF auto-orient -> downscale -> JPEG re-encode.
//
// SCOPE, and it is narrow on purpose: this module only ever sees RAW PHOTO BYTES — JPEG, PNG,
// HEIC/HEIF. An image-only PDF does NOT come here. sharp cannot decode PDF bytes, so routing a
// scanned bill through prepImage is not a slow path, it is a hard failure. Image-only PDFs are
// rasterized by extract-pdf.ts's renderPdfPageImage (pdfjs + @napi-rs/canvas) and only the
// resulting bitmap reaches the model (D-07/D-19). route.ts owns that branch.
//
// Each step is here because of a specific, common real-world failure:
//   - heic-convert FIRST, because sharp's prebuilt libvips cannot decode HEIC (patent-encumbered)
//     and iPhones shoot HEIC by default, so this is the normal case (RESEARCH Pitfall 2).
//   - rotate() with NO angle, because that is what applies EXIF orientation. Phone photos of
//     receipts are routinely sideways and a model reading a rotated receipt mis-extracts the
//     total (RESEARCH Pitfall 3).
//   - resize into a 2000px box, because providers re-tile the image anyway; over-scaling burns
//     tokens with no accuracy gain (RESEARCH Pitfall 6).
//   - limitInputPixels + withoutEnlargement, because inbox bytes are untrusted: a decompression
//     bomb declaring 60000x60000 must be refused at decode, not materialized (T-03-03).
//
// Collaborators are injectable with real defaults (the src/main/ingestion/scan.ts ScanDeps
// convention) so the spec can prove the HEIC-before-sharp ORDERING without committing a HEIC.

import sharpDefault from 'sharp'

/** Downscale target for the long edge. Small print stays legible; token cost stays bounded. */
export const LONG_EDGE = 2000

/** Output JPEG quality. Matches extract-pdf.ts so both routes hand the model the same fidelity. */
export const JPEG_QUALITY = 80

/**
 * Decompression-bomb ceiling (T-03-03). 100 MP is roughly 300 MB of raw RGB — far above any real
 * phone camera or flatbed scanner output, far below sharp's own 268 MP default, and low enough
 * that a hostile file cannot exhaust main-process memory before `resize` ever runs.
 */
export const MAX_INPUT_PIXELS = 100_000_000

/** Quality for the HEIC->JPEG decode. High: this is an intermediate, not the final encode. */
export const HEIC_DECODE_QUALITY = 0.9

const HEIC_EXTENSIONS = new Set(['heic', 'heif'])

/** The exact sharp surface this module uses — small enough to double honestly in a test. */
export interface SharpPipelineLike {
  rotate(): SharpPipelineLike
  resize(options: {
    width: number
    height: number
    fit: 'inside'
    withoutEnlargement: boolean
  }): SharpPipelineLike
  jpeg(options: { quality: number }): SharpPipelineLike
  toBuffer(): Promise<Buffer>
}

export type SharpLike = (
  input: Buffer,
  options: { limitInputPixels: number }
) => SharpPipelineLike

/** heic-convert's call shape (the package ships no type declarations). */
export type HeicConvertLike = (options: {
  buffer: Buffer
  format: 'JPEG'
  quality: number
}) => Promise<ArrayBuffer>

export interface PrepImageDeps {
  /** Default: the real sharp. */
  sharp?: SharpLike
  /** Default: the real heic-convert, imported lazily and only for HEIC/HEIF input. */
  convert?: HeicConvertLike
}

/**
 * Normalize one photo into a model-ready JPEG.
 *
 * `ext` is the source file's extension, with or without the leading dot, any case. It decides one
 * thing only: whether the bytes need decoding before sharp can read them.
 */
export async function prepImage(
  bytes: Buffer,
  ext: string,
  deps: PrepImageDeps = {}
): Promise<Buffer> {
  const sharp = deps.sharp ?? sharpDefault
  let input = bytes

  if (isHeic(ext)) {
    // Must run BEFORE sharp, and its OUTPUT is what sharp reads. Passing the original bytes on
    // would throw in production while an ordering-only assertion stayed green.
    const convert = deps.convert ?? (await loadHeicConvert())
    input = Buffer.from(
      await convert({ buffer: bytes, format: 'JPEG', quality: HEIC_DECODE_QUALITY })
    )
  }

  return sharp(input, { limitInputPixels: MAX_INPUT_PIXELS })
    .rotate() // no angle: apply EXIF orientation (Pitfall 3)
    .resize({ width: LONG_EDGE, height: LONG_EDGE, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: JPEG_QUALITY })
    .toBuffer()
}

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

function isHeic(ext: string): boolean {
  if (typeof ext !== 'string') return false
  const normalized = ext.trim().toLowerCase().replace(/^\./, '')
  return HEIC_EXTENSIONS.has(normalized)
}

/**
 * Load heic-convert on demand. Lazy because it pulls a WASM decoder that the JPEG/PNG path (the
 * majority of files) never needs, and because the unit spec injects a double instead.
 *
 * The package ships no type declarations, hence the suppression. If it ever adds them, typecheck
 * fails on an unused directive and this cast can go.
 */
async function loadHeicConvert(): Promise<HeicConvertLike> {
  // @ts-expect-error heic-convert@2.1.0 ships no TypeScript declarations
  const mod = await import('heic-convert')
  return (mod.default ?? mod) as HeicConvertLike
}
