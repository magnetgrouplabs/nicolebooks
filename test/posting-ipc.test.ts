// test/posting-ipc.test.ts
//
// The posting IPC handlers with real bodies behind them: the gates still run first, and NOTHING
// that reaches the renderer carries raw provider text.
//
// electron is mocked so ipcMain.handle registrations are captured instead of touching a real IPC
// bus, trusted-sender is a no-op so this targets the PAYLOAD gate, and db/connection is pointed at
// a real temp SQLite file so the handlers exercise the genuine engine rather than a stub.
//
// The error-copy assertions are the reason this file is long. An Intuit fault message is assembled
// from the provider's response body and routinely embeds the request URL and the realm id; a
// better-sqlite3 error carries a filesystem path. Every exit from this module is checked against
// both, plus the house rule on dashes.

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { migrate } from '../src/main/db/migrate'

type Handler = (event: unknown, raw?: unknown) => unknown

const dir = mkdtempSync(join(tmpdir(), 'nb-posting-ipc-'))
const dbPath = join(dir, 'app.db')

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, Handler>(),
  sent: [] as Array<{ channel: string; payload: unknown }>
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: Handler): void => {
      mocks.handlers.set(channel, fn)
    }
  },
  BrowserWindow: {
    getAllWindows: () => [],
    fromWebContents: () => ({
      isDestroyed: () => false,
      webContents: {
        send: (channel: string, payload: unknown) => mocks.sent.push({ channel, payload })
      }
    })
  }
}))

vi.mock('../src/main/ipc/trusted-sender', () => ({
  assertTrustedSender: (): void => {}
}))

let db: Database.Database

vi.mock('../src/main/db/connection', () => ({
  getDatabase: () => db,
  openDatabase: (path: string) => new Database(path)
}))

import { registerPostingIpc } from '../src/main/ipc/posting'
import { setQboApiProvider } from '../src/main/posting/qbo-api'
import { resetPostingInFlight } from '../src/main/posting/send'
import { Channels, type PostingProgress } from '../src/shared/ipc-contract'
import { FakeQboApi } from './helpers/fake-qbo-api'
import { billRow, expenseRow, hash } from './helpers/posting-fixtures'

registerPostingIpc()

const FAKE_EVENT = { sender: {} } as never

function handlerFor(channel: string): Handler {
  const fn = mocks.handlers.get(channel)
  if (!fn) throw new Error(`no handler registered for ${channel}`)
  return fn
}

async function invoke(channel: string, raw?: unknown): Promise<unknown> {
  return await handlerFor(channel)(FAKE_EVENT, raw)
}

async function rejection(channel: string, raw?: unknown): Promise<Error | null> {
  try {
    await invoke(channel, raw)
    return null
  } catch (err) {
    return err as Error
  }
}

/** Wait for the fire-and-forget send loop the handler deliberately does not await. */
async function settle(): Promise<void> {
  for (let i = 0; i < 50; i += 1) await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
}

let api: FakeQboApi

beforeEach(() => {
  db = new Database(dbPath)
  migrate(db)
  db.prepare('DELETE FROM posting_entries').run()
  db.prepare('DELETE FROM posting_batches').run()
  db.prepare('DELETE FROM posted_file_hashes').run()
  mocks.sent.length = 0
  resetPostingInFlight()
  api = new FakeQboApi()
  setQboApiProvider(() => api)
})

afterEach(() => {
  setQboApiProvider(null)
  resetPostingInFlight()
  db.close()
})

afterAll(() => {
  // Windows will not unlink a file whose handle is still open, and every handle is closed above.
  rmSync(dir, { recursive: true, force: true })
})

describe('the payload gates still run first', () => {
  it('rejects a malformed send before any batch is created', async () => {
    const err = await rejection(Channels.postingSend, {
      rows: [{ ...billRow(), amountCents: 123.45 }]
    })
    expect(err).toBeTruthy()
    expect(db.prepare('SELECT COUNT(*) AS n FROM posting_batches').get()).toEqual({ n: 0 })
  })

  it('accepts the zero-arity call on the payload-free channels', async () => {
    // The ingestion:scan defect in miniature: the preload invokes these with NO argument, so a
    // bare Schema.parse(raw) would reject every real call.
    await expect(invoke(Channels.postingBatches, undefined)).resolves.toEqual({ batches: [] })
  })

  it('rejects a smuggled payload on a payload-free channel', async () => {
    const err = await rejection(Channels.postingBatches, { realmId: '9341457604445280' })
    expect(err).toBeTruthy()
  })

  it('rejects the zero-arity call on the channels that need a batch id', async () => {
    expect(await rejection(Channels.postingBatchDetail, undefined)).toBeTruthy()
    expect(await rejection(Channels.postingSummary, undefined)).toBeTruthy()
  })
})

describe('posting:send', () => {
  it('returns a batch id as soon as the entries are durable, then sends behind the broadcast', async () => {
    const result = (await invoke(Channels.postingSend, { rows: [billRow()] })) as {
      batchId: string
    }
    expect(typeof result.batchId).toBe('string')

    // Durable BEFORE the sends run: this is the crash window, and the key is already on disk.
    const pending = db
      .prepare('SELECT state, request_id FROM posting_entries WHERE batch_id = ?')
      .all(result.batchId) as Array<{ state: string; request_id: string }>
    expect(pending).toHaveLength(1)
    expect(pending[0].request_id.length).toBeGreaterThan(0)

    await settle()
    const detail = (await invoke(Channels.postingBatchDetail, {
      batchId: result.batchId
    })) as { entries: Array<{ state: string; qboId: string | null }> }
    expect(detail.entries[0]).toMatchObject({ state: 'confirmed', qboId: '1' })
  })

  it('broadcasts progress on posting:progress to the window that started the batch', async () => {
    await invoke(Channels.postingSend, { rows: [billRow()] })
    await settle()

    const progress = mocks.sent.filter((s) => s.channel === Channels.postingProgress)
    expect(progress.length).toBeGreaterThan(0)
    const last = progress.at(-1)?.payload as PostingProgress
    expect(last).toMatchObject({ done: 1, total: 1, current: null })
  })

  it('maps a cross-field violation to plain copy without leaking the internal code', async () => {
    const err = await rejection(Channels.postingSend, {
      rows: [{ ...expenseRow(), paidFromAccountId: null }]
    })
    expect(err?.message).toContain('which account paid it')
    expect(err?.message).not.toContain('POSTING_')
    expect(err?.message).not.toMatch(/[–—]/)
  })

  it('maps a missing QuickBooks connection to a sentence that says what to do', async () => {
    setQboApiProvider(null)
    const err = await rejection(Channels.postingSend, { rows: [billRow()] })
    expect(err?.message).toContain('Connect on the Settings screen')
    expect(err?.message).not.toContain('POSTING_NOT_CONNECTED')
  })

  it('never forwards raw provider text from a per-entry failure', async () => {
    const leaky = new FakeQboApi({
      failCreate: () =>
        new Error(
          'Error 400 at https://sandbox-quickbooks.api.intuit.com/v3/company/9341457604445280/bill?requestid=abc: ValidationFault'
        )
    })
    setQboApiProvider(() => leaky)

    const { batchId } = (await invoke(Channels.postingSend, { rows: [billRow()] })) as {
      batchId: string
    }
    await settle()

    const detail = (await invoke(Channels.postingBatchDetail, { batchId })) as {
      entries: Array<{ error: string | null }>
    }
    const message = detail.entries[0].error as string
    expect(message).toBeTruthy()
    expect(message).not.toContain('intuit.com')
    expect(message).not.toContain('9341457604445280')
    expect(message).not.toContain('requestid')
    expect(message).not.toMatch(/[–—]/)
  })
})

describe('posting:undo-last', () => {
  it('reverses the last batch and reports per-entity outcomes', async () => {
    const { batchId } = (await invoke(Channels.postingSend, { rows: [billRow()] })) as {
      batchId: string
    }
    await settle()

    const undone = (await invoke(Channels.postingUndoLast, undefined)) as {
      batchId: string | null
      results: Array<{ qboId: string; undone: boolean; reason: string | null }>
    }
    expect(undone.batchId).toBe(batchId)
    expect(undone.results).toEqual([{ qboId: '1', undone: true, reason: null }])
    expect(api.liveEntities()).toHaveLength(0)
  })

  it('says plainly that there is nothing to undo', async () => {
    const err = await rejection(Channels.postingUndoLast, undefined)
    expect(err?.message).toBe('There is nothing to undo. No batch has been sent to QuickBooks yet.')
    expect(err?.message).not.toMatch(/[–—]/)
  })

  it('accepts no payload at all, so undo can never be pointed at a named batch', async () => {
    // Accepting a batch id would turn a one-step undo into "void any batch you can name".
    const err = await rejection(Channels.postingUndoLast, { batchId: 'someone-elses-batch' })
    expect(err).toBeTruthy()
    expect(err?.message).not.toContain('nothing to undo')
  })
})

describe('posting:batches and posting:summary', () => {
  it('lists a sent batch and renders its report', async () => {
    const { batchId } = (await invoke(Channels.postingSend, {
      rows: [billRow(), billRow({ fileHash: hash('b'), amountCents: 500 })]
    })) as { batchId: string }
    await settle()

    const list = (await invoke(Channels.postingBatches, undefined)) as {
      batches: Array<{ batchId: string; total: number; confirmed: number }>
    }
    expect(list.batches[0]).toMatchObject({ batchId, total: 2, confirmed: 2 })

    const summary = (await invoke(Channels.postingSummary, { batchId })) as {
      totals: { amountCents: number }
      lines: unknown[]
    }
    expect(summary.totals.amountCents).toBe(12345 + 500)
    expect(summary.lines).toHaveLength(2)
  })

  it('maps an unknown batch id to plain copy', async () => {
    const err = await rejection(Channels.postingSummary, { batchId: 'no-such-batch' })
    expect(err?.message).toBe('That batch is no longer in your history.')
  })
})

describe('every mapped sentence obeys the house copy rules', () => {
  it('uses no em dashes or en dashes anywhere in the posting error table', async () => {
    const { POSTING_ERROR_COPY, GENERIC_POSTING_ERROR } = await import(
      '../src/main/posting/errors'
    )
    for (const copy of [...Object.values(POSTING_ERROR_COPY), GENERIC_POSTING_ERROR]) {
      expect(copy).not.toMatch(/[–—]/)
      expect(copy).not.toContain('POSTING_')
    }
  })

  it('falls back to a generic sentence for an unmapped failure', async () => {
    const { recoverablePostingReason, GENERIC_POSTING_ERROR } = await import(
      '../src/main/posting/errors'
    )
    expect(recoverablePostingReason(new Error('ENOENT: no such file, open /Users/anthony/x'))).toBe(
      GENERIC_POSTING_ERROR
    )
    expect(recoverablePostingReason('a bare string')).toBe(GENERIC_POSTING_ERROR)
    expect(recoverablePostingReason(null)).toBe(GENERIC_POSTING_ERROR)
  })
})
