// test/parse-extract-pdf-teardown.test.ts
//
// WR-01 regression pin: every pdfjs document this module opens gets torn down.
//
// pdfjs 6 dropped PDFDocumentProxy.destroy(), so the LOADING TASK that produced a proxy owns
// teardown. `loadPdfSignals` and `renderPdfPageImage` both honour that; `extractPdfText` did not.
// It handed raw bytes to unpdf's extractText, and unpdf then builds a proxy internally
// (node_modules/unpdf/dist/index.mjs: `const pdf = isPDFDocumentProxy(data) ? data : await
// getDocumentProxy(data)`), never destroys it, and returns no handle — so the caller had nothing
// to tear down. One loading task, transport, worker and retained copy of the PDF bytes leaked per
// native-route bill, in a main process that stays up for days.
//
// The leak is not observable through the real library (pdfjs's Node build uses a fake worker and
// exposes no live-task count), so unpdf is mocked here and the two things that actually matter are
// asserted directly: extractText is handed a DOCUMENT, and that document's loadingTask is
// destroyed exactly once, including when extraction throws.
//
// The real-library behaviour of all three functions stays covered by test/parse-route.test.ts.

import { beforeEach, describe, expect, it, vi } from 'vitest'

interface FakeDoc {
  numPages: number
  loadingTask: { destroy: () => Promise<void> }
  getPage: (n: number) => Promise<{ getViewport: () => { width: number; height: number } }>
}

const mocks = vi.hoisted(() => ({
  destroyed: 0,
  documentsCreated: 0,
  /** What extractText was called with, so "a document, not raw bytes" is provable. */
  extractTextArgs: [] as unknown[],
  extractTextImpl: null as null | (() => never)
}))

vi.mock('unpdf', () => ({
  definePDFJSModule: async (): Promise<void> => {},
  getResolvedPDFJS: async () => ({ OPS: {} }),
  createIsomorphicCanvasFactory: async () => ({}),
  renderPageAsImage: async () => new Uint8Array(),
  getDocumentProxy: async (): Promise<FakeDoc> => {
    mocks.documentsCreated += 1
    return {
      numPages: 2,
      loadingTask: {
        destroy: async (): Promise<void> => {
          mocks.destroyed += 1
        }
      },
      getPage: async () => ({ getViewport: () => ({ width: 612, height: 792 }) })
    }
  },
  extractText: async (data: unknown) => {
    mocks.extractTextArgs.push(data)
    if (mocks.extractTextImpl) mocks.extractTextImpl()
    return { totalPages: 2, text: ['page one text', 'page two text'] }
  }
}))

import { extractPdfText } from '../src/main/parse/extract-pdf'

const BYTES = Buffer.from('%PDF-1.7 pretend bill\n')

beforeEach(() => {
  mocks.destroyed = 0
  mocks.documentsCreated = 0
  mocks.extractTextArgs = []
  mocks.extractTextImpl = null
})

describe('extractPdfText owns the document it opens (WR-01)', () => {
  it('returns the per-page text', async () => {
    await expect(extractPdfText(BYTES)).resolves.toEqual({
      totalPages: 2,
      text: ['page one text', 'page two text']
    })
  })

  it('hands extractText a DOCUMENT, not raw bytes, so teardown has a handle', async () => {
    await extractPdfText(BYTES)
    expect(mocks.documentsCreated).toBe(1)
    const passed = mocks.extractTextArgs[0] as FakeDoc
    expect(passed).not.toBeInstanceOf(Uint8Array)
    expect(typeof passed?.loadingTask?.destroy).toBe('function')
  })

  it('destroys the loading task exactly once', async () => {
    await extractPdfText(BYTES)
    expect(mocks.destroyed).toBe(1)
  })

  it('destroys the loading task even when extraction throws', async () => {
    mocks.extractTextImpl = (): never => {
      throw new Error('malformed content stream')
    }
    await expect(extractPdfText(BYTES)).rejects.toThrow('malformed content stream')
    expect(mocks.destroyed).toBe(1)
  })

  it('leaks nothing across a batch of bills', async () => {
    for (let i = 0; i < 12; i += 1) await extractPdfText(BYTES)
    expect(mocks.documentsCreated).toBe(12)
    expect(mocks.destroyed).toBe(12)
  })
})
