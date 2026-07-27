// test/posting-duplicates-ipc.test.ts
//
// posting:check-duplicates, the one channel REVIEW-UI added.
//
// It exists because the Phase 2 dedupe check answers a different question. Dedupe catches the same
// FILE by hash. This catches the same BILL arriving as different bytes: a re-scanned paper copy, a
// PDF that was also photographed, a vendor's duplicate email. Same money, different hash, so the
// ledger says nothing and the user is one click from entering it twice.
//
// Three properties are pinned here, in the order they matter:
//   1. The gates run first, exactly like every other posting channel, and the payload is a REAL
//      payload, so a bare parse(raw) is correct (this channel is not payload-free).
//   2. It is a READ. Nothing it does writes a row, so calling it while the user types is safe.
//   3. It NEVER forwards raw text. The warning carries names and amounts that came from our own
//      tables, never a provider message.
//
// Same harness as test/posting-ipc.test.ts: electron mocked so handle() registrations are captured,
// trusted-sender stubbed to a no-op so the PAYLOAD gate is what is under test, and a real temp
// SQLite file so findPriorConfirmedEntries runs against genuine SQL rather than a stub.

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { migrate } from '../src/main/db/migrate'

type Handler = (event: unknown, raw?: unknown) => unknown

const dir = mkdtempSync(join(tmpdir(), 'nb-dupe-ipc-'))
const dbPath = join(dir, 'app.db')

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, Handler>()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: Handler): void => {
      mocks.handlers.set(channel, fn)
    }
  },
  BrowserWindow: {
    getAllWindows: () => [],
    fromWebContents: () => null
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
import { Channels, type PostingDuplicatesResult } from '../src/shared/ipc-contract'
import { FakeQboApi } from './helpers/fake-qbo-api'
import { billRow, hash } from './helpers/posting-fixtures'

registerPostingIpc()

const FAKE_EVENT = { sender: {} } as never

async function invoke(channel: string, raw?: unknown): Promise<unknown> {
  const fn = mocks.handlers.get(channel)
  if (!fn) throw new Error(`no handler registered for ${channel}`)
  return await fn(FAKE_EVENT, raw)
}

async function rejection(channel: string, raw?: unknown): Promise<Error | null> {
  try {
    await invoke(channel, raw)
    return null
  } catch (err) {
    return err as Error
  }
}

/** Wait for the fire-and-forget send loop the send handler deliberately does not await. */
async function settle(): Promise<void> {
  for (let i = 0; i < 50; i += 1) await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
}

async function check(
  probes: Array<{ rowKey: string; vendorId: string; amountCents: number; txnDate: string }>
): Promise<PostingDuplicatesResult> {
  return (await invoke(Channels.postingCheckDuplicates, { probes })) as PostingDuplicatesResult
}

/** Send one bill through the real engine so a CONFIRMED prior entry exists to match against. */
async function sendConfirmed(overrides: Parameters<typeof billRow>[0] = {}): Promise<void> {
  await invoke(Channels.postingSend, { rows: [billRow(overrides)] })
  await settle()
}

let api: FakeQboApi

beforeEach(() => {
  db = new Database(dbPath)
  migrate(db)
  db.prepare('DELETE FROM posting_entries').run()
  db.prepare('DELETE FROM posting_batches').run()
  db.prepare('DELETE FROM posted_file_hashes').run()
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
  rmSync(dir, { recursive: true, force: true })
})

describe('the payload gate runs before any lookup', () => {
  it('rejects the zero-arity call, because this channel is not payload-free', async () => {
    expect(await rejection(Channels.postingCheckDuplicates, undefined)).toBeTruthy()
  })

  it('rejects a float amount, the same bound posting:send enforces', async () => {
    const err = await rejection(Channels.postingCheckDuplicates, {
      probes: [{ rowKey: 'r1', vendorId: '42', amountCents: 123.45, txnDate: '2026-07-27' }]
    })
    expect(err).toBeTruthy()
  })

  it('rejects a date that is not ISO', async () => {
    const err = await rejection(Channels.postingCheckDuplicates, {
      probes: [{ rowKey: 'r1', vendorId: '42', amountCents: 100, txnDate: '07/27/2026' }]
    })
    expect(err).toBeTruthy()
  })

  it('rejects an empty rowKey, which could never be attached to a row anyway', async () => {
    const err = await rejection(Channels.postingCheckDuplicates, {
      probes: [{ rowKey: '', vendorId: '42', amountCents: 100, txnDate: '2026-07-27' }]
    })
    expect(err).toBeTruthy()
  })

  it('accepts an empty probe list, because a debounced check can fire with nothing complete', async () => {
    await expect(check([])).resolves.toEqual({ warnings: {} })
  })
})

describe('what it warns about', () => {
  it('says nothing when there is no prior entry', async () => {
    const result = await check([
      { rowKey: 'r1', vendorId: '42', amountCents: 12345, txnDate: '2026-07-27' }
    ])
    expect(result.warnings).toEqual({})
  })

  it('finds the same bill arriving as a DIFFERENT file, which the hash ledger cannot', async () => {
    await sendConfirmed()

    // Same vendor, same money, same day, different bytes: dedupe by hash is blind to this.
    const result = await check([
      { rowKey: 'row-b', vendorId: '42', amountCents: 12345, txnDate: '2026-07-27' }
    ])
    expect(result.warnings['row-b']).toHaveLength(1)
    expect(result.warnings['row-b'][0]).toMatchObject({
      vendorId: '42',
      amountCents: 12345,
      txnDate: '2026-07-27',
      daysApart: 0
    })
  })

  it('keys every answer by the rowKey that asked, and omits rows with nothing to say', async () => {
    await sendConfirmed()

    const result = await check([
      { rowKey: 'clean', vendorId: '42', amountCents: 999, txnDate: '2026-07-27' },
      { rowKey: 'suspect', vendorId: '42', amountCents: 12345, txnDate: '2026-07-27' }
    ])
    expect(Object.keys(result.warnings)).toEqual(['suspect'])
  })

  it('looks a few days either side, and reports how far off the prior entry was', async () => {
    await sendConfirmed()

    const near = await check([
      { rowKey: 'r', vendorId: '42', amountCents: 12345, txnDate: '2026-07-29' }
    ])
    expect(near.warnings['r'][0].daysApart).toBe(-2)

    const far = await check([
      { rowKey: 'r', vendorId: '42', amountCents: 12345, txnDate: '2026-08-27' }
    ])
    expect(far.warnings).toEqual({})
  })

  it('does not warn about a batch the user already reversed', async () => {
    await sendConfirmed()
    await invoke(Channels.postingUndoLast, undefined)

    const result = await check([
      { rowKey: 'r', vendorId: '42', amountCents: 12345, txnDate: '2026-07-27' }
    ])
    expect(result.warnings).toEqual({})
  })

  it('does not warn about a different vendor at the same amount', async () => {
    await sendConfirmed()
    const result = await check([
      { rowKey: 'r', vendorId: '99', amountCents: 12345, txnDate: '2026-07-27' }
    ])
    expect(result.warnings).toEqual({})
  })
})

describe('it is a read, and it leaks nothing', () => {
  it('writes no rows, so it is safe to call while the user is typing', async () => {
    await sendConfirmed()
    const before = db.prepare('SELECT COUNT(*) AS n FROM posting_entries').get() as { n: number }

    await check([
      { rowKey: 'r1', vendorId: '42', amountCents: 12345, txnDate: '2026-07-27' },
      { rowKey: 'r2', vendorId: '42', amountCents: 1, txnDate: '2026-07-27' }
    ])

    expect(db.prepare('SELECT COUNT(*) AS n FROM posting_entries').get()).toEqual(before)
    expect(db.prepare('SELECT COUNT(*) AS n FROM posting_batches').get()).toEqual({ n: 1 })
  })

  it('carries only our own field values, never a provider message or a path', async () => {
    await sendConfirmed({ fileHash: hash('c') })
    const result = await check([
      { rowKey: 'r', vendorId: '42', amountCents: 12345, txnDate: '2026-07-27' }
    ])
    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain('intuit.com')
    expect(serialized).not.toContain('POSTING_')
    expect(serialized).not.toMatch(/[–—]/)
  })
})
