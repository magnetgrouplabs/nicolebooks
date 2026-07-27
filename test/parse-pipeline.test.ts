// test/parse-pipeline.test.ts
//
// Wave-0 (RED) unit spec for the batch parse orchestrator — the slice that turns six
// independently-green modules into the end-to-end parse (D-13/D-15/D-21/D-22/D-26).
//
// Mirrors the ingestion-scan.test.ts lifecycle: a migrated temp DB plus injected collaborators
// (03-PATTERNS Shared Pattern B), so the whole pipeline runs with no Electron, no network and no
// API key. Until src/main/parse/pipeline.ts exists this file fails to import (RED).
//
// What this file is accountable for:
//
//   (a) PER-FILE ISOLATION (D-15). A three-file batch where the model call fails for exactly one
//       file must return that file as 'parse-failed' WITH a visible reason, and the other two as
//       'parsed'. This is the Phase 2 WR-01 guarantee carried into Phase 3: one unreadable bill
//       must never discard eleven already-paid-for parses.
//   (b) PROGRESS (D-26). One { done, total, filename, status } event per file, in order, counting
//       1/3, 2/3, 3/3 — the "parsing N/M" surface.
//   (c) THE D-22 SECOND PASS. Image-only documents get a second temperature-0 call whose
//       disagreements become confidence evidence; native PDFs (which have verbatim-text grounding)
//       must NOT pay for one. Proven by call counts on the shared fake client.
//   (d) THE IMAGE-ONLY-PDF COMPOSITION (D-07/D-19). The real test/fixtures/image-only.pdf is driven
//       end to end through parseBatch with NO document collaborators injected, so the genuine
//       route -> renderPdfPageImage -> vision path runs. It must come back 'parsed' and the request
//       must carry a real JPEG. sharp cannot decode PDF bytes, so if the pipeline ever collapses
//       the image-only branch into a single prepImage call this test is what fails.
//
// The PARSE-05 cache-hit-no-recall proof lives in test/parse-cache.test.ts, appended to the file
// that already owns the storage layer's fixtures.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { migrate } from '../src/main/db/migrate'
import { getCached } from '../src/main/parse/cache'
import {
  MAX_REFERENCE_TEXT_CHARS,
  parseBatch,
  selectPageIndexes,
  type ParseDeps
} from '../src/main/parse/pipeline'
import {
  makeChatResponse,
  makeFakeClient,
  type ChatCompletionArgs,
  type FakeOpenAIClient
} from './helpers/fake-openai-client'
import type { ParseBatchFile, ParseProgress } from '../src/shared/ipc-contract'

const IMAGE_ONLY_PDF = join(__dirname, 'fixtures', 'image-only.pdf')

/** A BillSchema-shaped model reply: raw printed strings, arithmetic that balances exactly. */
const BILL = {
  vendor: 'Nassau Plumbing Supply',
  invoice_number: 'INV-2026-0417',
  invoice_date: '07/14/2026',
  due_date: null,
  subtotal: '1,234.10',
  tax: '101.90',
  total: '1,336.00',
  currency: 'USD',
  suggested_category: 'Job Materials'
} as const

/** A second reading that disagrees on the total — the D-22 cross-call mismatch case. */
const BILL_DISAGREEING_TOTAL = { ...BILL, total: '1,338.00' }

let dir: string
let db: Database.Database

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nb-parse-pipeline-'))
  db = new Database(join(dir, 'app.db'))
  migrate(db)
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/**
 * The bytes the default reader below hands back for a file name. They carry the name so the
 * prepared image in a recorded request is traceable to the file it came from.
 */
function bytesFor(filename: string): Buffer {
  return Buffer.from(`bytes:${filename}`)
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * One batch entry, with the hash of the bytes the reader will actually return.
 *
 * The hash is REAL, not a placeholder: the pipeline re-hashes what it reads and refuses a
 * mismatch (CR-01 of this review round), because the (filename, hash) pair is renderer-supplied
 * and nothing upstream can bind the two. A test that pairs a made-up hash with real bytes would
 * be asserting the exact defect that fix removed.
 */
function batchFile(filename: string, bytes: Buffer = bytesFor(filename)): ParseBatchFile {
  return { filename, hash: sha256(bytes), batchEntryDate: '2026-07-27' }
}

/** The cache key a file lands under: the hash of its bytes. */
function hashOf(filename: string, bytes: Buffer = bytesFor(filename)): string {
  return sha256(bytes)
}

/**
 * Injected collaborators for the synthetic cases. The bytes carry their own filename, so the
 * prepared image a request ends up holding is traceable back to the file it came from — that is
 * what lets the isolation case fail exactly ONE file rather than a call index.
 */
function deps(overrides: Partial<ParseDeps> = {}): ParseDeps {
  return {
    db,
    model: 'fake-vision-model',
    baseUrl: 'https://api.openai.com/v1',
    now: () => '2026-07-27T16:00:00.000Z',
    readFile: async (filename: string) => Buffer.from(`bytes:${filename}`),
    routeFile: async ({ filename, bytes }) => ({
      route: filename.toLowerCase().endsWith('.pdf') ? 'native' : 'image-only',
      pageCount: bytes.length > 0 ? 1 : 1,
      pages: []
    }),
    extractPdfText: async (bytes: Buffer) => ({
      totalPages: 1,
      text: [`Total $1,336.00 from ${bytes.toString('utf8')}`]
    }),
    renderPdfPageImage: async (bytes: Buffer, pageIndex: number) =>
      Buffer.from(`page${pageIndex}:${bytes.toString('utf8')}`),
    prepImage: async (bytes: Buffer) => Buffer.from(`photo:${bytes.toString('utf8')}`),
    ...overrides
  }
}

/** Every image content part of one recorded request, decoded back to its bytes. */
function imageBuffers(args: ChatCompletionArgs): Buffer[] {
  const out: Buffer[] = []
  for (const message of args.messages ?? []) {
    if (typeof message.content === 'string') continue
    for (const part of message.content) {
      if (part.type !== 'image_url') continue
      const base64 = part.image_url.url.split(',')[1] ?? ''
      out.push(Buffer.from(base64, 'base64'))
    }
  }
  return out
}

/** The decoded image payload of a request, as text (the injected prep collaborators emit text). */
function imageText(args: ChatCompletionArgs): string {
  return imageBuffers(args)
    .map((b) => b.toString('utf8'))
    .join('\n')
}

/** Every text content part of one recorded request, joined. */
function requestText(args: ChatCompletionArgs): string {
  const parts: string[] = []
  for (const message of args.messages ?? []) {
    if (typeof message.content === 'string') {
      parts.push(message.content)
      continue
    }
    for (const part of message.content) {
      if (part.type === 'text') parts.push(part.text)
    }
  }
  return parts.join('\n')
}

function chatArgs(client: FakeOpenAIClient): ChatCompletionArgs[] {
  return client.chatCalls().map((call) => call.args as ChatCompletionArgs)
}

// ---------------------------------------------------------------------------
// (a) per-file isolation — D-15
// ---------------------------------------------------------------------------

describe('per-file isolation (D-15): one failure never aborts the batch', () => {
  it('marks only the failing file parse-failed and still parses the other two', async () => {
    // The fake rejects only for the request carrying file two's bytes. Every other file in the
    // batch must survive: this is the whole point of the per-file try/catch.
    const client = makeFakeClient({
      chatImpl: (args) => {
        if (imageText(args).includes('two.pdf')) {
          throw Object.assign(new Error('simulated upstream failure'), { status: 500 })
        }
        return makeChatResponse(BILL)
      }
    })

    const result = await parseBatch(
      [batchFile('one.pdf'), batchFile('two.pdf'), batchFile('three.pdf')],
      deps({ client })
    )

    expect(result.files.map((f) => [f.filename, f.status])).toEqual([
      ['one.pdf', 'parsed'],
      ['two.pdf', 'parse-failed'],
      ['three.pdf', 'parsed']
    ])
    expect(result.summary).toEqual({ total: 3, parsed: 2, failed: 1, cached: 0 })
  })

  it('gives the failed row a visible, human-readable reason (never a raw stack)', async () => {
    const client = makeFakeClient({
      chatImpl: (args) => {
        if (imageText(args).includes('two.pdf')) {
          throw Object.assign(new Error('Error: connect ECONNREFUSED 127.0.0.1:443\n    at Socket'), {
            status: 503
          })
        }
        return makeChatResponse(BILL)
      }
    })

    const result = await parseBatch(
      [batchFile('one.pdf'), batchFile('two.pdf')],
      deps({ client })
    )

    const failed = result.files[1]
    expect(failed.status).toBe('parse-failed')
    expect(typeof failed.error).toBe('string')
    expect(failed.error && failed.error.length).toBeGreaterThan(0)
    expect(failed.error).not.toContain('ECONNREFUSED')
    expect(failed.error).not.toContain('at Socket')
    expect(failed.fields).toBeUndefined()
  })

  it('keeps a file whose bytes cannot be read from aborting the batch', async () => {
    const client = makeFakeClient({ parsedObject: BILL })
    const result = await parseBatch(
      [batchFile('gone.pdf'), batchFile('here.pdf')],
      deps({
        client,
        readFile: async (filename: string) => {
          if (filename === 'gone.pdf') {
            throw Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' })
          }
          return Buffer.from(`bytes:${filename}`)
        }
      })
    )
    expect(result.files.map((f) => f.status)).toEqual(['parse-failed', 'parsed'])
    expect(result.files[0].error).toBeTruthy()
  })

  it('does not cache a failed file, so a retry is a fresh parse', async () => {
    const client = makeFakeClient({ chatError: new Error('down') })
    await parseBatch([batchFile('one.pdf')], deps({ client }))
    expect(getCached(db, hashOf('one.pdf'))).toBeNull()
  })

  it('persists a parsed file so the same bytes are never re-parsed', async () => {
    const client = makeFakeClient({ parsedObject: BILL })
    await parseBatch([batchFile('one.pdf')], deps({ client }))

    const hit = getCached(db, hashOf('one.pdf'))
    expect(hit?.fields.vendor).toBe('Nassau Plumbing Supply')
    expect(hit?.fields.totalCents).toBe(133600) // integer cents, from the raw printed '1,336.00'
    expect(hit?.fields.invoiceDate).toBe('2026-07-14') // normalized to ISO by the D-10 gate
    expect(hit?.route).toBe('native')
    expect(hit?.model).toBe('fake-vision-model')
    expect(hit?.baseUrlHost).toBe('api.openai.com') // host only, never a credential (D-05)
    expect(hit?.parsedAt).toBe('2026-07-27T16:00:00.000Z') // the injected clock
    expect(hit?.rawResponse).toContain('Nassau Plumbing Supply') // D-24 audit column
  })
})

// ---------------------------------------------------------------------------
// (b) progress — D-26
// ---------------------------------------------------------------------------

describe('progress events (D-26): the "parsing N/M" surface', () => {
  it('emits one event per file, in order, counting 1/3 2/3 3/3', async () => {
    const client = makeFakeClient({ parsedObject: BILL })
    const events: ParseProgress[] = []

    await parseBatch(
      [batchFile('one.pdf'), batchFile('two.pdf'), batchFile('three.pdf')],
      deps({ client, onProgress: (p) => events.push(p) })
    )

    expect(events).toEqual([
      { done: 1, total: 3, filename: 'one.pdf', status: 'parsed' },
      { done: 2, total: 3, filename: 'two.pdf', status: 'parsed' },
      { done: 3, total: 3, filename: 'three.pdf', status: 'parsed' }
    ])
  })

  it('reports the per-file status on the event, including a failure', async () => {
    const client = makeFakeClient({
      chatImpl: (args) => {
        if (imageText(args).includes('two.pdf')) throw new Error('nope')
        return makeChatResponse(BILL)
      }
    })
    const events: ParseProgress[] = []
    await parseBatch(
      [batchFile('one.pdf'), batchFile('two.pdf')],
      deps({ client, onProgress: (p) => events.push(p) })
    )
    expect(events.map((e) => e.status)).toEqual(['parsed', 'parse-failed'])
  })

  it('never lets a throwing progress listener abort the batch', async () => {
    const client = makeFakeClient({ parsedObject: BILL })
    const result = await parseBatch(
      [batchFile('one.pdf'), batchFile('two.pdf')],
      deps({
        client,
        onProgress: () => {
          throw new Error('a renderer window went away mid-batch')
        }
      })
    )
    expect(result.files.map((f) => f.status)).toEqual(['parsed', 'parsed'])
  })

  it('returns an empty result for an empty batch without emitting anything', async () => {
    const client = makeFakeClient()
    const events: ParseProgress[] = []
    const result = await parseBatch([], deps({ client, onProgress: (p) => events.push(p) }))
    expect(result).toEqual({ files: [], summary: { total: 0, parsed: 0, failed: 0, cached: 0 } })
    expect(events).toEqual([])
    expect(client.neverCalled()).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// (c) the D-22 second pass, and the D-06 belt-and-suspenders text pairing
// ---------------------------------------------------------------------------

describe('the D-22 second-pass agreement check', () => {
  it('makes a SECOND call for an image-only document', async () => {
    const client = makeFakeClient({ parsedObject: BILL })
    const result = await parseBatch([batchFile('receipt.jpg')], deps({ client }))

    expect(result.files[0].status).toBe('parsed')
    expect(client.callCount()).toBe(2)
    // Both passes are temperature 0 — two sampled calls would disagree by construction, which
    // would make every image-only bill look uncertain.
    for (const args of chatArgs(client)) expect(args.temperature).toBe(0)
  })

  it('does NOT make a second call for a native PDF (verbatim text already grounds it)', async () => {
    const client = makeFakeClient({ parsedObject: BILL })
    const result = await parseBatch([batchFile('invoice.pdf')], deps({ client }))

    expect(result.files[0].status).toBe('parsed')
    expect(client.callCount()).toBe(1)
  })

  it('turns a cross-call mismatch into a low-confidence flag on the disputed field', async () => {
    // The merge order is load-bearing: agreementFlags output has to reach validationFlags BEFORE
    // computeConfidence runs, or the whole second call is inert.
    const client = makeFakeClient({ parsedObject: [BILL, BILL_DISAGREEING_TOTAL] })
    const result = await parseBatch([batchFile('receipt.jpg')], deps({ client }))

    const file = result.files[0]
    expect(file.status).toBe('parsed')
    expect(file.validationFlags).toContain('agreement:totalCents')
    expect(file.confidence?.totalCents).toBe('low')
    // The primary read is KEPT, never rejected and never averaged (flag-and-keep, D-12).
    expect(file.fields?.totalCents).toBe(133600)
  })

  it('records no agreement flag when the two passes agree', async () => {
    const client = makeFakeClient({ parsedObject: BILL })
    const result = await parseBatch([batchFile('receipt.jpg')], deps({ client }))
    expect(result.files[0].validationFlags?.some((f) => f.startsWith('agreement:'))).toBe(false)
  })

  it('keeps the primary read when the second pass itself fails', async () => {
    const client = makeFakeClient({
      chatImpl: (_args, index) => {
        if (index > 0) throw Object.assign(new Error('rate limited'), { status: 429 })
        return makeChatResponse(BILL)
      }
    })
    const result = await parseBatch([batchFile('receipt.jpg')], deps({ client }))
    expect(result.files[0].status).toBe('parsed')
    expect(result.files[0].fields?.totalCents).toBe(133600)
  })

  it('pairs the embedded text with the image on the native route (D-06) and omits it otherwise', async () => {
    const nativeClient = makeFakeClient({ parsedObject: BILL })
    await parseBatch([batchFile('invoice.pdf')], deps({ client: nativeClient }))
    expect(requestText(chatArgs(nativeClient)[0])).toContain('Total $1,336.00')

    const photoClient = makeFakeClient({ parsedObject: BILL })
    await parseBatch([batchFile('receipt.jpg')], deps({ client: photoClient }))
    expect(requestText(chatArgs(photoClient)[0])).not.toContain('Total $1,336.00')
  })

  it('grounds a native-route field against the embedded text, and cannot ground a photo', async () => {
    const nativeClient = makeFakeClient({ parsedObject: BILL })
    const native = await parseBatch([batchFile('invoice.pdf')], deps({ client: nativeClient }))
    expect(native.files[0].confidence?.totalCents).toBe('high')

    const photoClient = makeFakeClient({ parsedObject: BILL })
    const photo = await parseBatch([batchFile('receipt.jpg')], deps({ client: photoClient }))
    expect(photo.files[0].confidence?.totalCents).toBe('low')
  })
})

// ---------------------------------------------------------------------------
// D-21: the 10-page cap applies to BOTH PDF branches
// ---------------------------------------------------------------------------

describe('the D-21 page cap (both PDF branches)', () => {
  it('selects every page at or under the cap', () => {
    expect(selectPageIndexes(1)).toEqual({ indexes: [0], truncated: false })
    expect(selectPageIndexes(10)).toEqual({
      indexes: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
      truncated: false
    })
  })

  it('keeps pages 1-3 plus the LAST 2 over the cap (the total lives on the last page)', () => {
    expect(selectPageIndexes(14)).toEqual({ indexes: [0, 1, 2, 12, 13], truncated: true })
  })

  it('truncates and flags an over-cap NATIVE pdf, and round-trips the flag through the cache', async () => {
    const client = makeFakeClient({ parsedObject: BILL })
    const rendered: number[] = []
    const result = await parseBatch(
      [batchFile('long-invoice.pdf')],
      deps({
        client,
        routeFile: async () => ({ route: 'native', pageCount: 14, pages: [] }),
        renderPdfPageImage: async (bytes, pageIndex) => {
          rendered.push(pageIndex)
          return Buffer.from(`page${pageIndex}`)
        }
      })
    )

    expect(rendered).toEqual([0, 1, 2, 12, 13]) // never rendered the 9 pages it would not send
    expect(imageBuffers(chatArgs(client)[0]).length).toBe(5)
    expect(result.files[0].truncated).toBe(true)
    expect(getCached(db, hashOf('long-invoice.pdf'))?.truncated).toBe(true)
  })

  it('truncates and flags an over-cap IMAGE-ONLY pdf too (not only the native branch)', async () => {
    const client = makeFakeClient({ parsedObject: BILL })
    const rendered: number[] = []
    const result = await parseBatch(
      [batchFile('long-scan.pdf')],
      deps({
        client,
        routeFile: async () => ({ route: 'image-only', pageCount: 12, pages: [] }),
        renderPdfPageImage: async (bytes, pageIndex) => {
          rendered.push(pageIndex)
          return Buffer.from(`page${pageIndex}`)
        },
        prepImage: async () => {
          throw new Error('sharp must never see PDF bytes')
        }
      })
    )

    expect(rendered).toEqual([0, 1, 2, 10, 11])
    expect(result.files[0].truncated).toBe(true)
    expect(getCached(db, hashOf('long-scan.pdf'))?.truncated).toBe(true)
  })

  // WR-03: the cap bounded the IMAGES but the belt-and-suspenders text was unbounded, and it
  // rides on the primary call AND the repair re-ask.
  it('caps the reference text and reports the clip as truncation', async () => {
    const client = makeFakeClient({ parsedObject: BILL })
    // A 400-page vendor statement: ~800k characters of embedded text.
    const pages = Array.from({ length: 400 }, (_, i) => `PAGE${i} ${'lorem ipsum '.repeat(160)}`)

    const result = await parseBatch(
      [batchFile('statement.pdf')],
      deps({
        client,
        routeFile: async () => ({ route: 'native', pageCount: 1, pages: [] }),
        extractPdfText: async () => ({ totalPages: 400, text: pages })
      })
    )

    const onTheWire = requestText(chatArgs(client)[0])
    expect(onTheWire).toContain('PAGE0 ') // the head of the document still anchors the read
    expect(onTheWire).not.toContain('PAGE399') // ...but not 800k characters of it
    // The prompt itself is a few thousand characters; the reference text is what is bounded.
    expect(onTheWire.length).toBeLessThan(MAX_REFERENCE_TEXT_CHARS + 10_000)
    expect(result.files[0].truncated).toBe(true)
    expect(getCached(db, hashOf('statement.pdf'))?.truncated).toBe(true)
  })

  it('leaves a normal bill reference text untouched and untruncated', async () => {
    const client = makeFakeClient({ parsedObject: BILL })
    const result = await parseBatch([batchFile('invoice.pdf')], deps({ client }))
    expect(requestText(chatArgs(client)[0])).toContain('Total $1,336.00')
    expect(result.files[0].truncated).toBe(false)
  })

  it('leaves truncated false for a document inside the cap', async () => {
    const client = makeFakeClient({ parsedObject: BILL })
    const result = await parseBatch([batchFile('invoice.pdf')], deps({ client }))
    expect(result.files[0].truncated).toBe(false)
    expect(getCached(db, hashOf('invoice.pdf'))?.truncated).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// (d) the real image-only PDF, end to end — D-07 / D-19
// ---------------------------------------------------------------------------

describe('an image-only PDF is rasterized, never handed to sharp (D-07/D-19)', () => {
  it('drives the real fixture end to end through parseBatch to a parsed result', async () => {
    // NOTHING document-related is injected here: the genuine routeFile (pdfjs signal loader) and
    // the genuine renderPdfPageImage (pdfjs legacy build + @napi-rs/canvas) run. If the pipeline
    // ever routes an image-only PDF to prepImage, sharp cannot decode PDF bytes and this rejects.
    const bytes = await readFile(IMAGE_ONLY_PDF)
    const client = makeFakeClient({ parsedObject: BILL })

    const result = await parseBatch([batchFile('scanned-bill.pdf', bytes)], {
      db,
      client,
      model: 'fake-vision-model',
      baseUrl: 'https://api.openai.com/v1',
      now: () => '2026-07-27T16:00:00.000Z',
      readFile: async () => bytes,
      prepImage: async () => {
        throw new Error('prepImage must never be reached for an image-only PDF')
      }
    })

    expect(result.files[0].status).toBe('parsed')
    expect(result.files[0].fields?.vendor).toBe('Nassau Plumbing Supply')
    expect(getCached(db, hashOf('scanned-bill.pdf', bytes))?.route).toBe('image-only')
  }, 60_000)

  it('puts a REAL rendered JPEG on the wire (proving the render path ran)', async () => {
    const bytes = await readFile(IMAGE_ONLY_PDF)
    const client = makeFakeClient({ parsedObject: BILL })

    await parseBatch([batchFile('scanned-bill.pdf', bytes)], {
      db,
      client,
      model: 'fake-vision-model',
      now: () => '2026-07-27T16:00:00.000Z',
      readFile: async () => bytes
    })

    const images = imageBuffers(chatArgs(client)[0])
    expect(images.length).toBe(1)
    // ffd8ff is the JPEG SOI marker: a rendered bitmap, not the PDF bytes passed through.
    expect(images[0].subarray(0, 3).toString('hex')).toBe('ffd8ff')
    expect(images[0].length).toBeGreaterThan(1000)
    expect(images[0].subarray(0, 5).toString('latin1')).not.toContain('%PDF')
  }, 60_000)

  it('gets the D-22 second pass, because an image-only PDF has no text to ground against', async () => {
    const bytes = await readFile(IMAGE_ONLY_PDF)
    const client = makeFakeClient({ parsedObject: BILL })

    await parseBatch([batchFile('scanned-bill.pdf', bytes)], {
      db,
      client,
      model: 'fake-vision-model',
      now: () => '2026-07-27T16:00:00.000Z',
      readFile: async () => bytes
    })

    expect(client.callCount()).toBe(2)
  }, 60_000)
})

// ---------------------------------------------------------------------------
// configuration and untrusted-input guards
// ---------------------------------------------------------------------------

describe('configuration and input guards', () => {
  it('fails every file with a configuration reason when no model is selected', async () => {
    const client = makeFakeClient({ parsedObject: BILL })
    const result = await parseBatch([batchFile('one.pdf')], deps({ client, model: null }))

    expect(result.files[0].status).toBe('parse-failed')
    expect(result.files[0].error).toMatch(/settings/i)
    expect(client.neverCalled()).toBe(true) // no model means no paid call, not a rejected one
  })

  // WR-06. The ladder refuses to descend on 401/403/429, but that only bounds ONE file. The batch
  // loop had no memory of why the previous file failed, so an expired key meant one
  // auth-rejected request per file (ParseBatchSchema permits 500) and a rate limit meant one per
  // file, each already retried up to maxRetries: 3 with backoff inside the SDK. Repeated auth
  // failures are what providers use to flag or lock an account.
  it('stops the batch after a rejected credential and explains it on every row', async () => {
    const client = makeFakeClient({
      chatError: Object.assign(new Error('Incorrect API key provided'), { status: 401 })
    })

    const result = await parseBatch(
      [
        batchFile('one.pdf'),
        batchFile('two.pdf'),
        batchFile('three.pdf'),
        batchFile('four.pdf'),
        batchFile('five.pdf')
      ],
      deps({ client })
    )

    // ONE doomed request, not five.
    expect(client.callCount()).toBe(1)
    expect(result.summary).toEqual({ total: 5, parsed: 0, failed: 5, cached: 0 })
    // Visibility over silence: every row still says what to fix, it just was not paid for.
    for (const file of result.files) {
      expect(file.status).toBe('parse-failed')
      expect(file.error).toMatch(/api key/i)
      expect(file.error).toMatch(/settings/i)
    }
  })

  it('stops the batch on a rate limit and tells the user to wait', async () => {
    const client = makeFakeClient({
      chatError: Object.assign(new Error('Rate limit reached'), { status: 429 })
    })
    const result = await parseBatch(
      [batchFile('one.pdf'), batchFile('two.pdf'), batchFile('three.pdf')],
      deps({ client })
    )

    expect(client.callCount()).toBe(1)
    expect(result.files.every((f) => f.status === 'parse-failed')).toBe(true)
    expect(result.files[2].error).toMatch(/wait a few minutes/i)
  })

  it('still emits one progress event per file when the batch short-circuits', async () => {
    const client = makeFakeClient({
      chatError: Object.assign(new Error('forbidden'), { status: 403 })
    })
    const events: ParseProgress[] = []
    await parseBatch(
      [batchFile('one.pdf'), batchFile('two.pdf'), batchFile('three.pdf')],
      deps({ client, onProgress: (p) => events.push(p) })
    )
    expect(events.map((e) => [e.done, e.total, e.status])).toEqual([
      [1, 3, 'parse-failed'],
      [2, 3, 'parse-failed'],
      [3, 3, 'parse-failed']
    ])
  })

  it('does NOT short-circuit on a per-document failure', async () => {
    // A 500, a timeout or an unreadable document says nothing about the next file, so the batch
    // must keep going: that is D-15's per-file isolation, and it is the case this must not break.
    const client = makeFakeClient({
      chatImpl: (args) => {
        if (imageText(args).includes('two.pdf')) {
          throw Object.assign(new Error('upstream fault'), { status: 500 })
        }
        return makeChatResponse(BILL)
      }
    })

    const result = await parseBatch(
      [batchFile('one.pdf'), batchFile('two.pdf'), batchFile('three.pdf')],
      deps({ client })
    )

    expect(result.files.map((f) => f.status)).toEqual(['parsed', 'parse-failed', 'parsed'])
    expect(client.callCount()).toBe(3)
  })

  it('still answers already-cached files after the breaker trips', async () => {
    // The breaker exists to skip doomed NETWORK calls, not to discard work that costs nothing.
    const client = makeFakeClient({
      chatError: Object.assign(new Error('Incorrect API key provided'), { status: 401 })
    })
    const first = batchFile('one.pdf')
    const second = batchFile('two.pdf')

    // Seed two.pdf into the cache by parsing it with a working client.
    const working = makeFakeClient({ parsedObject: BILL })
    await parseBatch([second], deps({ client: working }))

    const result = await parseBatch([first, second], deps({ client }))
    expect(result.files.map((f) => f.status)).toEqual(['parse-failed', 'cached'])
    expect(client.callCount()).toBe(1)
  })

  it('refuses a filename that tries to escape the inbox folder', async () => {
    // The renderer supplies the filename; the inbox path is resolved server-side. A filename
    // carrying a path separator must never become a read outside the folder (T-02-02's guard,
    // carried into the parse channel).
    const client = makeFakeClient({ parsedObject: BILL })
    const result = await parseBatch(
      [
        { filename: '../../../etc/passwd', hash: 'a'.repeat(64), batchEntryDate: '2026-07-27' },
        batchFile('ok.pdf')
      ],
      deps({ client, readFile: undefined, inboxPath: dir })
    )

    expect(result.files[0].status).toBe('parse-failed')
    expect(result.files[1].status).toBe('parse-failed') // ok.pdf is not on disk in this temp dir
    expect(client.neverCalled()).toBe(true)
  })

  // CR-03. The (filename, hash) pair is renderer-supplied and ParseBatchSchema can only check the
  // hash's LENGTH, so the pipeline has to bind the two itself by re-hashing what it read.
  it('refuses bytes whose hash does not match the declared one, and pays for no model call', async () => {
    const client = makeFakeClient({ parsedObject: BILL })
    const declared = batchFile('invoice-0912.pdf') // hashed at scan time (T1)

    const result = await parseBatch(
      [declared],
      deps({
        client,
        // The file was re-synced between the scan and the read (T2): same name, different bytes.
        readFile: async () => Buffer.from('bytes:a completely different, newer invoice')
      })
    )

    expect(result.files[0].status).toBe('parse-failed')
    expect(result.files[0].error).toMatch(/scan/i)
    expect(result.files[0].fields).toBeUndefined()
    // Not one token paid for stale bytes: the check runs before routing and before the call.
    expect(client.neverCalled()).toBe(true)
  })

  it('writes NOTHING to parsed_results when the bytes do not match the hash', async () => {
    const client = makeFakeClient({ parsedObject: BILL })
    const declared = batchFile('invoice-0912.pdf')

    await parseBatch(
      [declared],
      deps({ client, readFile: async () => Buffer.from('bytes:the newer $8,400 invoice') })
    )

    // The durable half of the defect: the OTHER document's fields under THIS file's hash. Any
    // later scan of the original bytes would then answer from that row as 'cached', with no
    // model call and no flag.
    expect(getCached(db, declared.hash)).toBeNull()
    expect(db.prepare('SELECT COUNT(*) AS n FROM parsed_results').get()).toEqual({ n: 0 })
  })

  it('isolates a changed file to its own row and parses the rest of the batch', async () => {
    const client = makeFakeClient({ parsedObject: BILL })
    const result = await parseBatch(
      [batchFile('one.pdf'), batchFile('changed.pdf'), batchFile('three.pdf')],
      deps({
        client,
        readFile: async (filename) =>
          filename === 'changed.pdf'
            ? Buffer.from('bytes:changed under us')
            : Buffer.from(`bytes:${filename}`)
      })
    )

    expect(result.files.map((f) => f.status)).toEqual(['parsed', 'parse-failed', 'parsed'])
    expect(result.summary).toEqual({ total: 3, parsed: 2, failed: 1, cached: 0 })
  })

  it('refuses a renderer-supplied hash that belongs to a different file', async () => {
    // The trust-boundary half: a compromised or buggy renderer pairing file A's name with file
    // B's hash must not be able to write A's parse into B's cache row.
    const client = makeFakeClient({ parsedObject: BILL })
    const poisoned: ParseBatchFile = {
      filename: 'one.pdf',
      hash: hashOf('two.pdf'), // a real, valid hash — of the WRONG file
      batchEntryDate: '2026-07-27'
    }

    const result = await parseBatch([poisoned], deps({ client }))

    expect(result.files[0].status).toBe('parse-failed')
    expect(getCached(db, hashOf('two.pdf'))).toBeNull()
    expect(client.neverCalled()).toBe(true)
  })

  // WR-09. path.resolve is pure string arithmetic: it never touches the filesystem and never
  // follows a link, so lexical containment is not containment. Phase 2's scan skips symlinks, but
  // parse:parse-batch takes its file names from the RENDERER, which is the boundary this guard
  // exists for, so the scan's filter is not this path's protection.
  it('refuses a link inside the inbox that resolves outside it', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'nb-outside-'))
    const target = join(outside, 'private.pdf')
    writeFileSync(target, '%PDF-1.4 a document from outside the inbox\n')
    linkOutside(target, outside, join(dir, 'escape.pdf'))

    const client = makeFakeClient({ parsedObject: BILL })
    const result = await parseBatch(
      [{ filename: 'escape.pdf', hash: 'a'.repeat(64), batchEntryDate: '2026-07-27' }],
      deps({ client, readFile: undefined, inboxPath: dir })
    )

    expect(result.files[0].status).toBe('parse-failed')
    expect(result.files[0].error).toMatch(/not a plain file/i)
    expect(client.neverCalled()).toBe(true)

    rmSync(outside, { recursive: true, force: true })
  })

  it('still reads an ordinary file that really is in the inbox', async () => {
    // The positive control: the realpath check must not reject the normal case.
    const bytes = Buffer.from('%PDF-1.4 a real bill in a real inbox\n')
    writeFileSync(join(dir, 'real-bill.pdf'), bytes)

    const client = makeFakeClient({ parsedObject: BILL })
    const result = await parseBatch(
      [batchFile('real-bill.pdf', bytes)],
      deps({
        client,
        readFile: undefined,
        inboxPath: dir,
        routeFile: async () => ({ route: 'native', pageCount: 1, pages: [] }),
        extractPdfText: async () => ({ totalPages: 1, text: ['Total $1,336.00'] }),
        renderPdfPageImage: async () => Buffer.from('page0')
      })
    )

    expect(result.files[0].status).toBe('parsed')
    expect(result.files[0].fields?.totalCents).toBe(133600)
  })

  it('refuses to decode a HEIC that declares an impossible canvas (T-03-03)', async () => {
    // heic-convert has no pixel cap of its own and runs BEFORE sharp's limitInputPixels, so a
    // hostile HEIC would be fully decoded before any guard applied. The declared canvas is read
    // from the ISOBMFF ispe box and checked first; a trip is a parse-failed row, never a crash.
    const client = makeFakeClient({ parsedObject: BILL })
    const result = await parseBatch(
      [
        batchFile('bomb.heic', heicWithDeclaredSize(60_000, 60_000)),
        batchFile('fine.jpg', Buffer.from('jpegish'))
      ],
      deps({
        client,
        readFile: async (filename) =>
          filename === 'bomb.heic' ? heicWithDeclaredSize(60_000, 60_000) : Buffer.from('jpegish'),
        prepImage: async (bytes) => Buffer.from(`photo:${bytes.toString('utf8')}`)
      })
    )

    expect(result.files[0].status).toBe('parse-failed')
    expect(result.files[1].status).toBe('parsed') // the rest of the batch is untouched
  })

  it('lets a normally-sized HEIC through the pixel budget', async () => {
    const client = makeFakeClient({ parsedObject: BILL })
    const result = await parseBatch(
      [batchFile('phone.heic', heicWithDeclaredSize(4032, 3024))],
      deps({
        client,
        readFile: async () => heicWithDeclaredSize(4032, 3024), // a real iPhone frame
        prepImage: async () => Buffer.from('photo:decoded')
      })
    )
    expect(result.files[0].status).toBe('parsed')
  })
})

/**
 * Create a link inside the inbox that resolves OUTSIDE it.
 *
 * A symlink to a FILE is the sharpest version of this case (pre-fix, readFile follows it and the
 * outside document is parsed), but Windows needs Developer Mode or elevation to create one. A
 * directory JUNCTION needs neither and exercises the same containment check, so it is the
 * fallback. On POSIX the type argument is ignored and both are ordinary symlinks.
 */
function linkOutside(targetFile: string, targetDir: string, linkPath: string): void {
  try {
    symlinkSync(targetFile, linkPath, 'file')
  } catch {
    symlinkSync(targetDir, linkPath, 'junction')
  }
}

/**
 * A minimal ISOBMFF fragment carrying one `ispe` FullBox with the given declared dimensions —
 * enough for the pre-decode budget check, without committing a real (or hostile) HEIC.
 */
function heicWithDeclaredSize(width: number, height: number): Buffer {
  const ispe = Buffer.alloc(20)
  ispe.writeUInt32BE(20, 0) // box size
  ispe.write('ispe', 4, 'latin1')
  ispe.writeUInt32BE(0, 8) // version 0 + flags 0
  ispe.writeUInt32BE(width, 12)
  ispe.writeUInt32BE(height, 16)

  const ftyp = Buffer.alloc(20)
  ftyp.writeUInt32BE(20, 0)
  ftyp.write('ftyp', 4, 'latin1')
  ftyp.write('heic', 8, 'latin1')
  ftyp.write('heic', 12, 'latin1')
  ftyp.write('mif1', 16, 'latin1')

  return Buffer.concat([ftyp, ispe])
}
