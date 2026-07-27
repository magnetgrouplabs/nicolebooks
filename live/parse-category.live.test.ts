// live/parse-category.live.test.ts
//
// LIVE revalidation of the suggested_category inference (the gap the sandbox drill found: a null
// category on all nine fixtures, so every review row needed its category picked by hand).
//
// WHAT MAKES THIS EVIDENCE RATHER THAN A SHAPE CHECK. Nothing here is faked. Real fixture bytes go
// through the real route gate, the real unpdf text extraction, the real pdfjs rasterizer and the
// real sharp photo preparation, into a real vision model, and the phrase that comes back is then
// ranked by the real matcher against the real sandbox chart of accounts. The only offline part is
// the account list itself (test/helpers/qbo-reference-fixture.ts), which is a frozen copy of the
// sandbox's own 44 expense accounts, so no QuickBooks call and no token refresh is needed to learn
// what a phrase resolves to.
//
// TWO GATES, both required, mirroring e2e-live/ (see vitest.live.config.ts):
//   1. vitest.live.config.ts, referenced only by `npm run test:live`. The default runner's include
//      is 'test/**/*.test.ts', so CI cannot see this file at all.
//   2. LIVE_AI=1 in the environment.
//
// THE SECRET NEVER LEAVES THIS PROCESS. The key is read from the gitignored credentials file (or
// from OPENAI_API_KEY) straight into the SDK constructor. It is never logged, never asserted on,
// never written to the report table, and never passed on a command line where a shell history or a
// process list would capture it.
//
// COVERAGE, deliberately spanning both routes: two native text PDFs, one raster phone-style photo,
// and one image-only scanned PDF. The two image-only documents also exercise the D-22 second
// cross-call, so the run is 6 model calls for 4 documents.

import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import OpenAI from 'openai'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { migrate } from '../src/main/db/migrate'
import { parseBatch } from '../src/main/parse/pipeline'
import type { VisionClientLike } from '../src/main/parse/extract-fields'
import { matchAgainst } from '../src/main/recon/match'
import { categoryCandidates } from '../src/main/recon/service'
import { fixtureReference } from '../test/helpers/qbo-reference-fixture'
import type { MatchResult, ParseBatchFile } from '../src/shared/ipc-contract'

const REPO_ROOT = resolve(__dirname, '..')
const BILLS_DIR = join(REPO_ROOT, 'test-fixtures', 'bills')

/** Gate 2. Absent, the whole file skips rather than failing on a machine with no credentials. */
const LIVE = process.env['LIVE_AI'] === '1'

/** The endpoint and model, overridable so a different provider can be revalidated the same way. */
const BASE_URL = process.env['LIVE_AI_BASE_URL'] ?? 'https://api.openai.com/v1'
const MODEL = process.env['LIVE_AI_MODEL'] ?? 'gpt-4o-mini'

/**
 * The four documents, chosen to span both routes rather than to be easy.
 *
 * `expectAccount` is what a bookkeeper would file the document under in this company, taken from
 * the manifest's own hint. It is REPORTED, never asserted: the bar for this revalidation is that
 * the matcher resolves the inferred phrase to a sensible account at 'suggested' or better, and a
 * chart of accounts with two plausible homes for a plumbing invoice ('Job Materials' and
 * 'Supplies') is a real company, not a defect.
 */
const DOCUMENTS = [
  {
    filename: 'apex-plumbing-supply-invoice-APX-84213.pdf',
    route: 'native text PDF',
    expectAccount: 'Job Expenses:Job Materials'
  },
  {
    filename: 'metro-fuel-oil-corp-invoice-MF-2026-0714.pdf',
    route: 'native text PDF',
    expectAccount: 'Automobile:Fuel'
  },
  {
    filename: 'northside-auto-parts-receipt.jpg',
    route: 'raster receipt photo',
    expectAccount: 'Automobile'
  },
  {
    filename: 'brightline-electric-supply-scan-BE-5731.pdf',
    route: 'image-only scan PDF',
    expectAccount: 'Job Expenses:Job Materials'
  }
] as const

/** The bar this revalidation has to clear. */
const MIN_RESOLVED = 3

interface Row {
  filename: string
  route: string
  phrase: string | null
  resolvedTo: string | null
  tier: MatchResult['confidence']
  score: number | null
  expectAccount: string
}

/**
 * The API key, from the environment or from the gitignored credentials file.
 *
 * Returns null rather than throwing so the suite can skip cleanly on a machine that has neither.
 * The value is returned and immediately handed to the SDK; it is never printed.
 */
function readApiKey(): string | null {
  const fromEnv = process.env['OPENAI_API_KEY'] ?? process.env['LIVE_AI_KEY']
  if (fromEnv && fromEnv.trim() !== '') return fromEnv.trim()

  const credentialsPath =
    process.env['NICOLEBOOKS_CREDENTIALS'] ?? join(REPO_ROOT, '.credentials', 'CREDENTIALS.md')
  if (!existsSync(credentialsPath)) return null
  const match = /^-\s*API key:\s*(\S+)\s*$/m.exec(readFileSync(credentialsPath, 'utf8'))
  return match ? match[1] : null
}

const API_KEY = LIVE ? readApiKey() : null

/** Round to two places so the reported score and the tier it produced always agree. */
function round2(value: number): number {
  return Math.round(value * 100) / 100
}

describe.skipIf(!LIVE || API_KEY === null)(
  'LIVE: suggested_category is inferred, and the matcher can use it',
  () => {
    let dir: string
    let db: Database.Database
    const rows: Row[] = []

    beforeAll(async () => {
      dir = mkdtempSync(join(tmpdir(), 'nb-live-category-'))
      db = new Database(join(dir, 'app.db'))
      migrate(db)

      // The real SDK, pointed at the configured endpoint. Structurally a VisionClientLike.
      const client = new OpenAI({
        apiKey: API_KEY as string,
        baseURL: BASE_URL
      }) as unknown as VisionClientLike

      const files: ParseBatchFile[] = []
      for (const doc of DOCUMENTS) {
        const bytes = await readFile(join(BILLS_DIR, doc.filename))
        files.push({
          filename: doc.filename,
          // The pipeline re-hashes the bytes it reads and refuses a mismatch, so the hash has to
          // be the real one rather than a placeholder.
          hash: createHash('sha256').update(bytes).digest('hex'),
          batchEntryDate: '2026-07-27'
        })
      }

      // No document collaborators are injected: routeFile, extractPdfText, renderPdfPageImage and
      // prepImage all default to the real implementations. Only the inbox reader is replaced, so
      // the fixtures can be read from test-fixtures/bills instead of from a seeded inbox folder.
      const result = await parseBatch(files, {
        db,
        client,
        model: MODEL,
        baseUrl: BASE_URL,
        readFile: async (filename: string) => await readFile(join(BILLS_DIR, filename))
      })

      const options = categoryCandidates(fixtureReference())
      for (const doc of DOCUMENTS) {
        const parsed = result.files.find((file) => file.filename === doc.filename)
        const phrase = parsed?.fields?.suggestedCategory ?? null
        const match = matchAgainst(phrase, options)
        rows.push({
          filename: doc.filename,
          route: doc.route,
          phrase,
          resolvedTo: match.selectedName,
          tier: match.confidence,
          score: match.candidates[0] ? round2(match.candidates[0].score) : null,
          expectAccount: doc.expectAccount
        })
      }
    })

    afterAll(() => {
      db?.close()
      if (dir) rmSync(dir, { recursive: true, force: true })

      // The report IS the deliverable of this spec, so it prints whether the assertions passed or
      // failed: a run that misses the bar is only actionable if you can see what each document
      // actually produced.
      const table = rows
        .map(
          (row) =>
            `${row.filename} [${row.route}] -> phrase: ${row.phrase ?? '(null)'} | recon: ${
              row.resolvedTo ?? '(nothing selected)'
            } | tier: ${row.tier} | score: ${row.score ?? 'n/a'} | manifest hint: ${row.expectAccount}`
        )
        .join('\n')
      console.log(`\nCATEGORY REVALIDATION (model ${MODEL})\n${table}\n`)
    })

    it('infers a non-null category phrase on at least 3 of the 4 documents', () => {
      const inferred = rows.filter((row) => row.phrase !== null && row.phrase.trim() !== '')
      expect(inferred.length).toBeGreaterThanOrEqual(MIN_RESOLVED)
    })

    it('writes SHORT phrases, which is what makes them matchable', () => {
      // A long phrase dilutes the token half of the similarity blend and reaches nothing. Four
      // words is the generous ceiling; the instruction asks for two or three.
      for (const row of rows) {
        if (row.phrase === null) continue
        expect(row.phrase.trim().split(/\s+/).length).toBeLessThanOrEqual(4)
      }
    })

    it('resolves at least 3 of the 4 to a real expense account at suggested or better', () => {
      const resolved = rows.filter(
        (row) => row.tier === 'auto' || row.tier === 'suggested'
      )
      expect(resolved.length).toBeGreaterThanOrEqual(MIN_RESOLVED)
      for (const row of resolved) {
        expect(row.resolvedTo).not.toBeNull()
      }
    })

    it('never resolves to a payment account, only to an expense account (RECON-04)', () => {
      const expenseNames = new Set(categoryCandidates(fixtureReference()).map((o) => o.name))
      for (const row of rows) {
        if (row.resolvedTo === null) continue
        expect(expenseNames.has(row.resolvedTo)).toBe(true)
      }
    })
  }
)
