// src/main/parse/pipeline.ts
//
// The batch parse orchestrator (PARSE-05, decisions D-07, D-13, D-14, D-15, D-19, D-21, D-22,
// D-24, D-25, D-26). This is the file that turns six independently-green modules into the
// capability: for each loaded file, cache lookup -> route -> extract/prep -> vision -> validate +
// confidence -> cache write, with progress streamed per file.
//
// Structural template: src/main/ingestion/scan.ts's runScan. Injectable collaborators with real
// defaults (03-PATTERNS Shared Pattern B) so the whole pipeline is vitest-drivable with a fake
// client, no Electron and no network; a per-file try/catch (Shared Pattern C) so one bad document
// costs one row and never the batch.
//
// FOUR INVARIANTS THIS MODULE IS ACCOUNTABLE FOR:
//
//   1. CACHE FIRST, ALWAYS (PARSE-05/D-14). getCached runs before the bytes are even read. A hit
//      returns immediately, so the paid model is never called twice for the same bytes — which is
//      the requirement in one sentence. `force` (the D-14 explicit Re-parse override) is the only
//      way past it.
//   2. AN IMAGE-ONLY PDF IS RASTERIZED, NEVER HANDED TO sharp (D-07/D-19). The branch is on SOURCE
//      TYPE first: a raw photo goes to prepImage (heic-convert -> sharp), a PDF goes to
//      renderPdfPageImage (pdfjs legacy build + @napi-rs/canvas) whichever route the D-20 gate
//      picked. sharp cannot decode PDF bytes at all, so collapsing the two image-only cases would
//      not be a slow path, it would make every scanned or faxed bill permanently unparseable.
//   3. AGREEMENT FLAGS ARE MERGED BEFORE THE SCORER RUNS (D-22). agreementFlags output is
//      concatenated onto validationFlags and only THEN passed to computeConfidence. Merging after
//      (or not at all) leaves the entire second cross-call inert while still paying for it.
//   4. ONE FILE'S FAILURE IS ONE ROW (D-15). Every throw becomes a 'parse-failed' result carrying
//      a plain recoverable reason, and the loop continues. Mirrors Phase 2's WR-01 isolation.
//   5. NOTHING IS CACHED UNDER A HASH THIS MODULE DID NOT VERIFY. The (filename, hash) pair comes
//      from the renderer and no schema can bind the two, so the bytes are re-hashed after the read
//      and a mismatch is a per-file failure BEFORE any paid call. Without it, a file re-synced
//      between the scan and the read stores the new document's fields under the old file's hash,
//      and every later scan of the old file answers from that row as 'cached' with no flag.
//
// SECRET BOUNDARY (threat T-03-01): the API key lives inside the injected/lazily-built client and
// is never read here. Only the base URL's HOST is persisted, and cache.ts derives it. This module
// logs nothing; a failure reason is fixed, human-readable copy, never a raw error or a stack —
// SDK and fs errors routinely embed a URL or an absolute path.
//
// PATH BOUNDARY (threat T-02-02, carried from Phase 2): the inbox folder is resolved server-side
// and the renderer-supplied `filename` is validated to be a plain name inside it before any read.

import type Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { readFile as readFileFromDisk } from 'node:fs/promises'
import { extname, join, resolve, sep } from 'node:path'
import type {
  ParseBatchFile,
  ParseBatchResult,
  ParseFileResult,
  ParseProgress
} from '../../shared/ipc-contract'
import { AI_BASE_URL_SECRET } from '../ai/client'
import { getSelectedModel } from '../ai/models'
import { getDatabase } from '../db/connection'
import { resolveInboxPath } from '../ingestion/inbox'
import { secretStore } from '../secrets/secret-store'
import { getCached, putCached } from './cache'
import { agreementFlags, computeConfidence } from './confidence'
import {
  extractFields,
  HEAD_PAGE_IMAGES,
  MAX_PAGE_IMAGES,
  TAIL_PAGE_IMAGES,
  type ExtractFailureReason,
  type VisionClientLike
} from './extract-fields'
import { extractPdfText as realExtractPdfText, renderPdfPageImage as realRenderPdfPageImage, type PdfText } from './extract-pdf'
import { MAX_INPUT_PIXELS, prepImage as realPrepImage } from './prep-image'
import { routeFile as realRouteFile, type RouteDecision } from './route'
import { validateBill } from './validate'

/** Injectable collaborators, all defaulting to the real implementation (Shared Pattern B). */
export interface ParseDeps {
  /** Default: the main-process singleton. Tests pass a migrated temp handle. */
  db?: Database.Database
  /** Default: built lazily from the keychain inside extractFields. Tests inject the fake double. */
  client?: VisionClientLike
  /** The selected model id (AI-04). Default: app_settings via getSelectedModel. */
  model?: string | null
  /** The configured base URL. Only its HOST is persisted (D-05); default: read from the keychain. */
  baseUrl?: string | null
  /** The inbox folder. Default: resolved server-side — never renderer-supplied (T-02-02). */
  inboxPath?: string
  /** Read one inbox file's bytes by name. Default: a containment-checked read from inboxPath. */
  readFile?: (filename: string) => Promise<Buffer>
  /** ISO clock, frozen in tests (the role localDateStamp plays in runScan). */
  now?: () => string
  /** Per-file progress, forwarded to the renderer as the parse:progress broadcast (D-26). */
  onProgress?: (progress: ParseProgress) => void
  /** D-14's explicit Re-parse override: skip the cache lookup and force a fresh model call. */
  force?: boolean
  /** D-22's second-pass agreement check. Behind a flag so latency can be traded away. */
  secondPass?: boolean
  /** Default: the real D-20 gate in route.ts. */
  routeFile?: (file: { filename: string; bytes: Buffer }) => Promise<RouteDecision>
  /** Default: the real unpdf extractor. */
  extractPdfText?: (bytes: Buffer) => Promise<PdfText>
  /** Default: the real pdfjs + @napi-rs/canvas rasterizer. ZERO-based page index. */
  renderPdfPageImage?: (bytes: Buffer, pageIndex: number) => Promise<Buffer>
  /** Default: the real heic-convert -> sharp photo preparation. RAW PHOTOS ONLY. */
  prepImage?: (bytes: Buffer, ext: string) => Promise<Buffer>
}

// ---------------------------------------------------------------------------
// Failure copy. Fixed sentences only: never a raw error, never a stack, never a path.
// ---------------------------------------------------------------------------

const NO_MODEL_COPY =
  'Choose an AI model in Settings, then click Retry. Nothing was sent to the AI service.'

const UNSAFE_FILENAME_COPY =
  'That file name is not a plain file in your inbox folder, so it was not opened.'

const MISSING_BYTES_COPY =
  'That file is no longer readable in your inbox folder. Re-scan, then try again.'

const STALE_BYTES_COPY =
  'That file changed since the last scan, so it was not read. Click Scan now, then try again.'

const PIXEL_BUDGET_COPY =
  'That photo claims to be far larger than any real camera produces, so it was not opened. Replace it with a normal photo or a PDF.'

const GENERIC_FAILURE_COPY = 'Could not read this bill. Click Retry to try again.'

/** extractFields reports failure as data; each reason maps to copy the user can act on. */
const EXTRACT_FAILURE_COPY: Readonly<Record<ExtractFailureReason, string>> = {
  'client-unavailable':
    'Enter your API key and base URL in Settings, then click Retry.',
  'call-failed': 'The AI service could not be reached for this file. Click Retry to try again.',
  'schema-invalid':
    'The AI could not read this bill into the expected fields. Click Retry, or enter it by hand.'
}

/** Internal sentinels thrown by the guards below, mapped to copy by recoverableReason. */
const UNSAFE_FILENAME = 'PARSE_UNSAFE_FILENAME'
const PIXEL_BUDGET = 'PARSE_PIXEL_BUDGET'

// ---------------------------------------------------------------------------
// D-21: the page cap, applied to BOTH pdf branches
// ---------------------------------------------------------------------------

/**
 * Which page indexes (ZERO-based) to send for a PDF of `pageCount` pages.
 *
 * At or under the cap, every page. Over it, pages 1-3 plus the LAST 2: a naive "first N"
 * truncation would drop the single most important number on a long invoice, because the total
 * almost always lives on the final page.
 *
 * Deliberately applied HERE, before rendering, not only inside extractFields: rasterizing 60 pages
 * to then discard 55 of them would spend the render budget the cap exists to bound (T-03-02). The
 * cap constants are imported from extract-fields.ts so the two layers cannot drift, and that
 * module still applies its own cap as the backstop for any other caller.
 */
export function selectPageIndexes(pageCount: number): { indexes: number[]; truncated: boolean } {
  const count = Number.isFinite(pageCount) && pageCount > 0 ? Math.floor(pageCount) : 1
  if (count <= MAX_PAGE_IMAGES) return { indexes: range(0, count), truncated: false }
  return {
    indexes: [...range(0, HEAD_PAGE_IMAGES), ...range(count - TAIL_PAGE_IMAGES, count)],
    truncated: true
  }
}

// ---------------------------------------------------------------------------
// parseBatch
// ---------------------------------------------------------------------------

/** Everything one file's parse needs, resolved once per batch. */
interface ParseContext {
  db: Database.Database
  client?: VisionClientLike
  model: string | null
  baseUrl: string | null
  force: boolean
  secondPass: boolean
  now: () => string
  readFile: (filename: string) => Promise<Buffer>
  routeFile: NonNullable<ParseDeps['routeFile']>
  extractPdfText: NonNullable<ParseDeps['extractPdfText']>
  renderPdfPageImage: NonNullable<ParseDeps['renderPdfPageImage']>
  prepImage: NonNullable<ParseDeps['prepImage']>
}

/**
 * Parse a batch of loaded files, in order, with per-file isolation.
 *
 * Sequential on purpose. Parallelism would multiply peak memory (a rasterized page is tens of
 * megabytes) and turn one rate-limit response into a burst of them, for no benefit at Nicole's
 * volume of 5-20 bills a week. It also makes the "parsing N/M" counter mean what it says.
 */
export async function parseBatch(
  files: readonly ParseBatchFile[],
  deps: ParseDeps = {}
): Promise<ParseBatchResult> {
  const db = deps.db ?? getDatabase()
  const ctx: ParseContext = {
    db,
    client: deps.client,
    model: deps.model ?? readSelectedModel(db),
    baseUrl: deps.baseUrl ?? readBaseUrl(),
    force: deps.force === true,
    secondPass: deps.secondPass !== false, // D-22 on by default; the flag exists to disable it
    now: deps.now ?? (() => new Date().toISOString()),
    readFile: deps.readFile ?? makeInboxReader(db, deps.inboxPath),
    routeFile: deps.routeFile ?? realRouteFile,
    extractPdfText: deps.extractPdfText ?? realExtractPdfText,
    renderPdfPageImage: deps.renderPdfPageImage ?? realRenderPdfPageImage,
    prepImage: deps.prepImage ?? realPrepImage
  }

  const list = Array.isArray(files) ? files : []
  const total = list.length
  const results: ParseFileResult[] = []
  let done = 0

  for (const file of list) {
    const result = await parseOne(file, ctx)
    results.push(result)
    done += 1
    emitProgress(deps.onProgress, {
      done,
      total,
      filename: result.filename,
      status: result.status
    })
  }

  return {
    files: results,
    summary: {
      total,
      parsed: results.filter((f) => f.status === 'parsed').length,
      failed: results.filter((f) => f.status === 'parse-failed').length,
      cached: results.filter((f) => f.status === 'cached').length
    }
  }
}

/**
 * Parse exactly one file. NEVER throws — every failure path becomes a 'parse-failed' row so the
 * batch loop above can continue (D-15, Shared Pattern C).
 */
async function parseOne(file: ParseBatchFile, ctx: ParseContext): Promise<ParseFileResult> {
  const filename = typeof file?.filename === 'string' ? file.filename : ''
  const hash = typeof file?.hash === 'string' ? file.hash : ''

  try {
    // ---- 1. CACHE FIRST (PARSE-05). Before the bytes, before the client, before anything. ----
    // getCached can return null for a row that EXISTS (a SCHEMA_VERSION mismatch); null always
    // means "parse it", never "the file is unknown".
    if (!ctx.force) {
      const hit = getCached(ctx.db, hash)
      if (hit) {
        return {
          filename,
          hash,
          status: 'cached',
          fields: hit.fields,
          confidence: hit.confidence,
          validationFlags: hit.validationFlags,
          truncated: hit.truncated
        }
      }
    }

    // A missing model is a configuration problem, not a document problem. Failing here means no
    // paid call is made and no rejected one either; the row tells the user exactly what to fix.
    if (!ctx.model) return failedResult(filename, hash, NO_MODEL_COPY)

    const bytes = await ctx.readFile(filename)

    // ---- 2. BIND THE HASH TO THE BYTES, before a single token is paid for. ----
    // The (filename, hash) pair arrives from the RENDERER and nothing upstream can bind the two:
    // ParseBatchSchema only checks that the hash is 64 characters long. Two ways an unverified
    // pairing produces a durable wrong answer:
    //   1. TOCTOU, the realistic one. runScan hashes at T1; this reads at T2, minutes later for
    //      the last file of a batch (sequential, two model calls per image-only document). This
    //      app deliberately targets cloud-synced folders — Phase 2 ships a whole materialization
    //      gate because files DO change underneath it. Re-syncing bill.pdf in that window would
    //      store the NEW document's fields under the OLD hash.
    //   2. Trust boundary. A renderer bug or compromise could poison any cache row at will.
    // The damage is durable because the cache is authoritative: a later scan of the original
    // bytes returns the other document's vendor, dates and total as 'cached', with no model call
    // and no flag. parse:reparse already resolves by hash (parse.ts findInboxFileByHash), so this
    // makes the batch path consistent with it rather than adding a new rule.
    if (sha256(bytes) !== hash) return failedResult(filename, hash, STALE_BYTES_COPY)

    // ---- 3. ROUTE (D-20). Native-with-authoritative-text, or image-only. ----
    const decision = await ctx.routeFile({ filename, bytes })

    // ---- 4. PREPARE the request content (D-06/D-07/D-19/D-21). ----
    const prepared = await prepareDocument(filename, bytes, decision, ctx)

    // ---- 5. EXTRACT (D-23/D-25). Never throws; failure arrives as a reason code. ----
    const primary = await extractFields({
      model: ctx.model,
      referenceText: prepared.referenceText,
      imageDataUrls: prepared.imageDataUrls,
      client: ctx.client
    })
    if (!primary.ok) {
      return failedResult(filename, hash, EXTRACT_FAILURE_COPY[primary.reason] ?? GENERIC_FAILURE_COPY)
    }

    const validated = validateBill(primary.bill)
    const validationFlags = [...validated.validationFlags]
    // `primary.truncated` is what actually went on the wire; `prepared.truncated` is what this
    // module dropped before handing pages over. Either one means pages were omitted.
    const truncated = prepared.truncated || primary.truncated

    // ---- 6. THE D-22 SECOND PASS — image-only documents only. ----
    // A native PDF is already grounded against its own verbatim text, so a second call would buy
    // nothing. On an image-only document nothing grounds, and two temperature-0 reads disagreeing
    // is real evidence of an unstable read rather than sampling noise.
    if (ctx.secondPass && decision.route === 'image-only') {
      const second = await extractFields({
        model: ctx.model,
        referenceText: prepared.referenceText,
        imageDataUrls: prepared.imageDataUrls,
        client: ctx.client
      })
      if (second.ok) {
        // MERGED BEFORE THE SCORER RUNS. This concatenation is the entire point of the second
        // call; without it the agreement signal never reaches a confidence value.
        validationFlags.push(...agreementFlags(validated.fields, validateBill(second.bill).fields))
      }
      // A failed second pass is not a reason to discard a good primary read (flag-and-keep, D-12).
      // The affected fields simply stay at their ungrounded 'low'.
    }

    // ---- 7. CONFIDENCE, then CACHE LAST. ----
    const confidence = computeConfidence(validated.fields, prepared.referenceText, validationFlags)

    putCached(ctx.db, {
      fileHash: hash,
      originalFilename: filename,
      route: decision.route,
      pageCount: decision.pageCount,
      model: ctx.model,
      baseUrl: ctx.baseUrl, // cache.ts reduces this to a host; a credential cannot reach SQLite
      fields: validated.fields,
      confidence,
      validationFlags,
      rawResponse: primary.rawResponse, // the D-24 audit column: stored, never logged
      parsedAt: ctx.now(),
      truncated
    })

    return {
      filename,
      hash,
      status: 'parsed',
      fields: validated.fields,
      confidence,
      validationFlags,
      truncated
    }
  } catch (error) {
    return failedResult(filename, hash, recoverableReason(error))
  }
}

// ---------------------------------------------------------------------------
// Document preparation
// ---------------------------------------------------------------------------

interface PreparedDocument {
  /** The embedded PDF text on the native route (D-06); null everywhere else. */
  referenceText: string | null
  /** One prepared JPEG data URL per selected page, in page order. */
  imageDataUrls: string[]
  /** True when the D-21 cap dropped pages before the request was built. */
  truncated: boolean
}

/**
 * Turn one file's bytes into the content the vision call carries.
 *
 * THE BRANCH IS ON SOURCE TYPE FIRST, and that ordering is the whole reason this function exists
 * as its own unit. A PDF — native or image-only — is rasterized by pdfjs. A raw photo goes to
 * sharp. The two never cross: sharp's libvips cannot decode PDF bytes, so an image-only PDF sent
 * to prepImage is a hard failure, not a slow path (D-07/D-19).
 */
async function prepareDocument(
  filename: string,
  bytes: Buffer,
  decision: RouteDecision,
  ctx: ParseContext
): Promise<PreparedDocument> {
  if (isPdf(filename)) {
    const selection = selectPageIndexes(decision.pageCount)

    // D-06 belt-and-suspenders: on the native route send the exact embedded text ALONGSIDE the
    // rendered pages. The prompt declares the image ground truth and the text a noisy reference,
    // so the text anchors totals without being able to override a correctly-read page.
    let referenceText: string | null = null
    if (decision.route === 'native') {
      const extracted = await ctx.extractPdfText(bytes)
      const joined = (extracted?.text ?? []).join('\n\n').trim()
      referenceText = joined === '' ? null : joined
    }

    const imageDataUrls: string[] = []
    for (const pageIndex of selection.indexes) {
      imageDataUrls.push(toJpegDataUrl(await ctx.renderPdfPageImage(bytes, pageIndex)))
    }
    return { referenceText, imageDataUrls, truncated: selection.truncated }
  }

  // A raw photo: one image, no text layer to pair, and the pre-decode pixel budget first.
  assertPixelBudget(bytes, filename)
  const jpeg = await ctx.prepImage(bytes, extname(filename))
  return { referenceText: null, imageDataUrls: [toJpegDataUrl(jpeg)], truncated: false }
}

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

const HEIC_EXTENSIONS = new Set(['.heic', '.heif'])

/** How far into a file to look for the ISOBMFF `ispe` box. Metadata boxes precede `mdat`. */
const HEIC_HEADER_SCAN_BYTES = 65_536

/** An `ispe` FullBox is exactly 20 bytes: size(4) type(4) version+flags(4) width(4) height(4). */
const ISPE_BOX_SIZE = 20

/**
 * Pre-decode pixel budget for HEIC/HEIF (threat T-03-03; the residual gap 03-04 logged as
 * deferred item 3).
 *
 * prepImage's decompression-bomb guard is sharp's `limitInputPixels`, but a HEIC MUST pass through
 * heic-convert first — sharp's prebuilt libvips cannot decode HEIC at all — and heic-convert
 * exposes no pixel or memory cap. So a hostile HEIC declaring a 60000x60000 canvas would be fully
 * decoded before sharp's guard ever applied. Byte size is a useless proxy (a bomb is small by
 * definition), so the DECLARED canvas is read instead, from the ISOBMFF `ispe` box, and compared
 * against the same MAX_INPUT_PIXELS ceiling sharp uses. A trip is a 'parse-failed' row (D-15),
 * never an exception through the batch.
 *
 * An unreadable or absent `ispe` ALLOWS the file. That direction is deliberate and matches Phase
 * 2's inconclusive-detection rule (WR-01: load on total detection failure, skip only on positive
 * evidence) — a real bill must never be false-skipped by a header this parser could not read, and
 * heic-convert needs the same box to decode anyway.
 */
function assertPixelBudget(bytes: Buffer, filename: string): void {
  if (!HEIC_EXTENSIONS.has(extname(filename).toLowerCase())) return
  if (declaredPixels(bytes) > MAX_INPUT_PIXELS) throw new Error(PIXEL_BUDGET)
}

/** The largest width*height any `ispe` box in the header region declares, or 0 if none is read. */
function declaredPixels(bytes: Buffer): number {
  if (!Buffer.isBuffer(bytes)) return 0
  const limit = Math.min(bytes.length, HEIC_HEADER_SCAN_BYTES)
  let largest = 0
  let at = bytes.indexOf('ispe', 0, 'latin1')

  while (at >= 4 && at < limit) {
    // Validate the surrounding box before trusting the numbers: the four preceding bytes must be
    // the exact FullBox length and the version byte must be 0. Without that, four bytes of image
    // data spelling "ispe" could refuse a legitimate photo.
    const boxSize = bytes.readUInt32BE(at - 4)
    if (boxSize === ISPE_BOX_SIZE && at + 16 <= bytes.length && bytes[at + 4] === 0) {
      const width = bytes.readUInt32BE(at + 8)
      const height = bytes.readUInt32BE(at + 12)
      if (width > 0 && height > 0) largest = Math.max(largest, width * height)
    }
    at = bytes.indexOf('ispe', at + 1, 'latin1')
  }
  return largest
}

/**
 * Build the default byte reader: the inbox folder resolved server-side, plus a containment check
 * on the renderer-supplied file name.
 *
 * The path-injection guard from Phase 2 (T-02-02) says no renderer-supplied PATH reaches fs. The
 * parse channel carries a NAME, which is different, so the name is checked to be a plain file name
 * and the joined result is checked to still be inside the inbox before it is opened.
 */
function makeInboxReader(
  db: Database.Database,
  inboxPath?: string
): (filename: string) => Promise<Buffer> {
  let folder = inboxPath
  return async (filename: string) => {
    folder ??= resolveInboxPath({ db }).path
    return readFileFromDisk(safeInboxPath(folder, filename))
  }
}

/** Resolve `filename` inside `folder`, or throw. Exported-free: only the reader above calls it. */
function safeInboxPath(folder: string, filename: string): string {
  if (
    typeof filename !== 'string' ||
    filename === '' ||
    filename === '.' ||
    filename === '..' ||
    filename.includes('/') ||
    filename.includes('\\') ||
    filename.includes('\0') ||
    /^[A-Za-z]:/.test(filename) // a Windows drive-relative name is not a plain file name
  ) {
    throw new Error(UNSAFE_FILENAME)
  }

  const root = resolve(folder)
  const full = resolve(join(root, filename))
  // Belt and suspenders: even with the checks above, prove the result is still inside the folder.
  if (full !== root && !full.startsWith(root.endsWith(sep) ? root : root + sep)) {
    throw new Error(UNSAFE_FILENAME)
  }
  return full
}

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

function failedResult(filename: string, hash: string, error: string): ParseFileResult {
  // No fields, no confidence, and NOTHING written to the cache: a failed parse must never
  // become a row, or the retry would answer from the cache instead of re-calling the model.
  return { filename, hash, status: 'parse-failed', error }
}

/**
 * Map a thrown value to fixed, human-readable copy.
 *
 * Never forwards the error's own text. fs errors carry absolute paths and SDK errors routinely
 * embed the request URL; both would ride straight onto the Bills screen (threat T-03-01), and
 * neither tells a non-technical user anything actionable.
 */
function recoverableReason(error: unknown): string {
  const code = error instanceof Error ? error.message : ''
  if (code === UNSAFE_FILENAME) return UNSAFE_FILENAME_COPY
  if (code === PIXEL_BUDGET) return PIXEL_BUDGET_COPY

  const errno = (error as { code?: unknown } | null)?.code
  if (errno === 'ENOENT' || errno === 'EACCES' || errno === 'EPERM' || errno === 'EBUSY') {
    return MISSING_BYTES_COPY
  }
  return GENERIC_FAILURE_COPY
}

/**
 * Emit one progress event. A listener that throws (a window closed mid-batch, a renderer that went
 * away) must not take the batch down with it — progress is a notification, not a step.
 */
function emitProgress(
  onProgress: ParseDeps['onProgress'],
  progress: ParseProgress
): void {
  if (!onProgress) return
  try {
    onProgress(progress)
  } catch {
    // Reporting is best-effort by design.
  }
}

/** The selected model id, or null. Never throws: a DB fault must not abort the whole batch. */
function readSelectedModel(db: Database.Database): string | null {
  try {
    return getSelectedModel({ db })
  } catch {
    return null
  }
}

/**
 * The configured base URL, for the D-24 host-only provenance column (cache.ts reduces it to a
 * host, so nothing here can leak a credential). Read defensively: safeStorage needs Electron to be
 * ready, and missing provenance is never worth failing an already-paid-for parse over.
 */
function readBaseUrl(): string | null {
  try {
    return secretStore.get(AI_BASE_URL_SECRET)
  } catch {
    return null
  }
}

function isPdf(filename: string): boolean {
  return typeof filename === 'string' && filename.toLowerCase().endsWith('.pdf')
}

/**
 * SHA-256 of the bytes actually read, in the same lowercase hex form Phase 2's sha256File
 * produces. Buffered rather than streamed because the bytes are already in memory here, and the
 * pre-decode pixel budget plus Phase 2's own size handling bound what can get this far.
 */
function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function toJpegDataUrl(jpeg: Buffer): string {
  return `data:image/jpeg;base64,${jpeg.toString('base64')}`
}

function range(from: number, to: number): number[] {
  const out: number[] = []
  for (let i = Math.max(0, from); i < to; i += 1) out.push(i)
  return out
}
