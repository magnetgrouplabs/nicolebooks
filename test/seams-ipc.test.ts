// test/seams-ipc.test.ts
//
// Finish-sprint seam coverage (SEAMS). Four handler modules -- qbo, recon, posting, upload -- are
// being filled in by four agents working in parallel worktrees. This suite pins what all four must
// keep true, so a downstream agent replacing a stub body cannot quietly drop a gate:
//
//   1. EVERY new channel is actually registered. A missing registration is otherwise invisible
//      until the renderer invokes it and gets Electron's "No handler registered" error at runtime.
//   2. PAYLOAD-FREE channels resolve for the zero-arity preload call AND reject smuggled input.
//      The resolve half is the ingestion:scan regression in miniature: those handlers must parse
//      `raw ?? {}`, because the preload invokes them with no argument and
//      z.object({}).strict().parse(undefined) throws 'expected object, received undefined'. A
//      handler that parsed a bare `raw` would reject EVERY real call while still passing a
//      reject-only test, which is exactly how that defect shipped for a whole phase.
//   3. PAYLOAD channels reject malformed input: a bad hash, a bad date, a float amount, a missing
//      field, a wrong-typed field. These bounds are what stop a mis-parse or a compromised
//      renderer from reaching QuickBooks.
//   4. Every stub rejects with the NOT_IMPLEMENTED user copy, not with a code, a stack, or raw
//      error text. This is the same no-raw-error-text discipline test/ai-ipc.test.ts pins.
//
// AS EACH GROUP LANDS its rows move out of the stub lists below and into that group's own spec,
// which asserts the SAME four properties against the real body. The registration list at the top
// stays exhaustive either way, so a group that loses a channel still fails here.
//   - upload + ingestion:pick-files (INGEST-UX): now covered by test/upload-ipc.test.ts.
//   - recon:match (RECON): now covered by test/recon-ipc.test.ts.
//
// electron is mocked so ipcMain.handle registrations are captured instead of touching a real IPC
// bus (the test/ingestion-ipc-scan.test.ts pattern), and trusted-sender is a no-op so this targets
// the PAYLOAD gate rather than the sender gate (e2e/ipc-boundary.spec.ts covers the latter).

import { describe, expect, it, vi } from 'vitest'

type Handler = (event: unknown, raw?: unknown) => unknown

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, Handler>()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: Handler): void => {
      mocks.handlers.set(channel, fn)
    }
  },
  // The broadcast helpers import BrowserWindow at module load; never exercised here.
  BrowserWindow: { getAllWindows: () => [], fromWebContents: () => null },
  // registerUploadIpc attaches its quit hook at registration time, and the picker imports the
  // dialog at module load. Neither is exercised here (test/upload-ipc.test.ts drives both).
  // qbo.ts injects shell.openExternal into the OAuth flow. Never invoked here, because the service
  // layer below is mocked, but the export has to exist or the mock throws on the reference.
  app: { on: (): void => {}, getPath: (): string => '', isPackaged: false },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  shell: { openExternal: async (): Promise<void> => {} }
}))

vi.mock('../src/main/ipc/trusted-sender', () => ({
  assertTrustedSender: (): void => {}
}))

/**
 * QBO-CONNECT landed the real qbo bodies, so those five channels no longer reject with the stub
 * copy. The SERVICE layer is mocked here (not the network, not the database) so this file keeps
 * testing exactly what it was written to test: that the sender gate and the payload gate still run
 * first, in that order, on every finish-sprint channel. The QuickBooks behaviour itself is covered
 * by test/qbo-*.test.ts.
 */
const QBO_STATUS = { state: 'disconnected', companyName: null, realmId: null, lastSyncAt: null }

vi.mock('../src/main/qbo/service', () => ({
  readStatus: () => QBO_STATUS,
  connect: async () => QBO_STATUS,
  disconnect: () => QBO_STATUS,
  syncReference: async () => ({
    vendors: 0,
    expenseAccounts: 0,
    paymentAccounts: 0,
    items: 0,
    syncedAt: '2026-07-27T00:00:00.000Z'
  }),
  getReference: () => ({
    vendors: [],
    expenseAccounts: [],
    paymentAccounts: [],
    items: [],
    syncedAt: null
  }),
  markConnectionExpired: (): void => {}
}))

/**
 * RECON landed the real recon:match body, so that channel no longer rejects with the stub copy. Its
 * SERVICE layer is mocked here for the same reason the qbo one is: this file keeps testing that the
 * sender gate and the payload gate still run first, in that order, while the matching behaviour
 * itself is covered by test/recon-match.test.ts and test/recon-service.test.ts.
 */
vi.mock('../src/main/recon/service', () => ({
  RECON_NOT_CONNECTED: 'RECON_NOT_CONNECTED',
  RECON_REFERENCE_EMPTY: 'RECON_REFERENCE_EMPTY',
  matchBatch: () => ({ matches: {} })
}))

import { registerQboIpc } from '../src/main/ipc/qbo'
import { registerReconIpc } from '../src/main/ipc/recon'
import { registerPostingIpc } from '../src/main/ipc/posting'
import { registerUploadIpc } from '../src/main/ipc/upload'
import { Channels } from '../src/shared/ipc-contract'

registerQboIpc()
registerReconIpc()
registerPostingIpc()
registerUploadIpc()

/** The sender gate is mocked out, so the event only needs to be a value. */
const FAKE_EVENT = { sender: {} } as never

/** The exact copy every stub must surface. No em dash, no en dash (house rule). */
const NOT_IMPLEMENTED_COPY = 'This feature is still being built.'

function handlerFor(channel: string): Handler {
  const fn = mocks.handlers.get(channel)
  if (!fn) throw new Error(`no handler registered for ${channel}`)
  return fn
}

/** Invoke a handler and return whatever it threw or rejected with, or null if it succeeded. */
async function rejection(channel: string, raw?: unknown): Promise<unknown> {
  try {
    await handlerFor(channel)(FAKE_EVENT, raw)
    return null
  } catch (err) {
    return err
  }
}

/** A well-formed SHA-256 hex hash. */
const HASH_A = 'a'.repeat(64)
const HASH_B = 'b'.repeat(64)

/** A minimal valid posting row, cloned and mutated per assertion. */
const VALID_ROW = {
  fileHash: HASH_A,
  entryType: 'bill' as const,
  vendorId: '42',
  categoryAccountId: '7',
  paidFromAccountId: null,
  txnDate: '2026-07-27',
  dueDate: '2026-08-26',
  refNumber: 'INV-1001',
  amountCents: 12345,
  memo: null
}

// ---------------------------------------------------------------------------
// 1. Registration
// ---------------------------------------------------------------------------

describe('every finish-sprint channel is registered', () => {
  const invocable = [
    Channels.qboStatus,
    Channels.qboConnect,
    Channels.qboDisconnect,
    Channels.qboSyncReference,
    Channels.qboGetReference,
    Channels.reconMatch,
    Channels.postingSend,
    Channels.postingBatches,
    Channels.postingBatchDetail,
    Channels.postingUndoLast,
    Channels.postingSummary,
    Channels.ingestionPickFiles,
    Channels.uploadStart,
    Channels.uploadStop,
    Channels.uploadStatus
  ]

  it.each(invocable)('registers a handler on %s', (channel) => {
    expect(typeof mocks.handlers.get(channel)).toBe('function')
  })

  it('registers exactly the invocable channels and no broadcast-only ones', () => {
    // The three broadcast channels are main->renderer sends, never ipcMain.handle targets.
    // Registering a handler on one would mean somebody misread the direction of the seam.
    expect(mocks.handlers.has(Channels.qboStatusChanged)).toBe(false)
    expect(mocks.handlers.has(Channels.postingProgress)).toBe(false)
    expect(mocks.handlers.has(Channels.uploadReceived)).toBe(false)
    expect(mocks.handlers.size).toBe(invocable.length)
  })
})

// ---------------------------------------------------------------------------
// 2. Payload-free channels: accept the zero-arity call, reject smuggled input
// ---------------------------------------------------------------------------

describe('payload-free channels gate correctly', () => {
  const payloadFree = [
    Channels.postingBatches,
    Channels.postingUndoLast
    // upload:start / upload:stop / upload:status / ingestion:pick-files are implemented; the same
    // two assertions run against their real bodies in test/upload-ipc.test.ts.
  ]

  // The zero-arity preload call sends undefined. A handler that parsed a bare `raw` would fail
  // here with a Zod 'expected object, received undefined' message rather than the stub copy --
  // that is the ingestion:scan defect, caught at the seam instead of a phase later.
  it.each(payloadFree)('%s accepts the zero-arity preload call (raw === undefined)', async (channel) => {
    const err = await rejection(channel, undefined)
    expect((err as Error).message).toBe(NOT_IMPLEMENTED_COPY)
  })

  it.each(payloadFree)('%s accepts an explicit empty object', async (channel) => {
    const err = await rejection(channel, {})
    expect((err as Error).message).toBe(NOT_IMPLEMENTED_COPY)
  })

  // A smuggled payload must die at the strict-empty gate, so the failure text is Zod's, not the
  // stub's. When a real body replaces the stub this assertion keeps meaning "the gate ran first".
  it.each(payloadFree)('%s rejects a smuggled non-empty payload at the gate', async (channel) => {
    const err = await rejection(channel, { realmId: '9341457604445280', force: true })
    expect(err).toBeTruthy()
    expect((err as Error).message).not.toBe(NOT_IMPLEMENTED_COPY)
  })
})

// The qbo group is implemented, so the same two halves are asserted against a RESOLVED value rather
// than against the stub copy. The zero-arity half is still the ingestion:scan regression in
// miniature: a handler that parsed a bare `raw` would reject every real call from the preload.
describe('implemented qbo channels keep both halves of the payload gate', () => {
  const qboChannels = [
    Channels.qboStatus,
    Channels.qboConnect,
    Channels.qboDisconnect,
    Channels.qboSyncReference,
    Channels.qboGetReference
  ]

  it.each(qboChannels)('%s resolves for the zero-arity preload call (raw === undefined)', async (channel) => {
    await expect(handlerFor(channel)(FAKE_EVENT, undefined)).resolves.toBeTruthy()
  })

  it.each(qboChannels)('%s resolves for an explicit empty object', async (channel) => {
    await expect(handlerFor(channel)(FAKE_EVENT, {})).resolves.toBeTruthy()
  })

  it.each(qboChannels)('%s rejects a smuggled non-empty payload at the gate', async (channel) => {
    // A smuggled realmId would be an attempt to point the app at a different company.
    const err = await rejection(channel, { realmId: '9341457604445280', force: true })
    expect(err).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// 3. Payload channels: malformed input is refused before any work
// ---------------------------------------------------------------------------

// The recon group is implemented, so its gate is asserted against a RESOLVED value rather than
// against the stub copy. The full behaviour lives in test/recon-ipc.test.ts; what stays here is the
// seam-level property the registration list exists for: the payload gate runs, and it runs first.
describe('recon:match payload gate', () => {
  it('accepts a well-formed hash list', async () => {
    await expect(
      handlerFor(Channels.reconMatch)(FAKE_EVENT, { fileHashes: [HASH_A, HASH_B] })
    ).resolves.toEqual({ matches: {} })
  })

  it('accepts an empty hash list (a scan with nothing loaded is not an error)', async () => {
    await expect(
      handlerFor(Channels.reconMatch)(FAKE_EVENT, { fileHashes: [] })
    ).resolves.toEqual({ matches: {} })
  })

  it('rejects a hash that is not 64 chars', async () => {
    expect(await rejection(Channels.reconMatch, { fileHashes: ['too-short'] })).toBeTruthy()
  })

  it('rejects a missing fileHashes field', async () => {
    expect(await rejection(Channels.reconMatch, {})).toBeTruthy()
  })

  it('rejects parsed vendor text smuggled in place of hashes', async () => {
    // Hashes ONLY. The parsed text lives main-side; accepting it here would let the renderer
    // steer a match against text the parser never produced.
    expect(await rejection(Channels.reconMatch, { fileHashes: ['Home Depot'] })).toBeTruthy()
  })

  it('rejects the bare array shape (the preload wraps it in { fileHashes })', async () => {
    expect(await rejection(Channels.reconMatch, [HASH_A])).toBeTruthy()
  })

  it('rejects the zero-arity call (this channel needs a payload)', async () => {
    expect(await rejection(Channels.reconMatch, undefined)).toBeTruthy()
  })
})

describe('posting:send payload gate', () => {
  it('accepts a well-formed bill row', async () => {
    const err = await rejection(Channels.postingSend, { rows: [VALID_ROW] })
    expect((err as Error).message).toBe(NOT_IMPLEMENTED_COPY)
  })

  it('accepts a well-formed expense row that names what paid it', async () => {
    const row = { ...VALID_ROW, entryType: 'expense' as const, paidFromAccountId: '35', dueDate: null }
    const err = await rejection(Channels.postingSend, { rows: [row] })
    expect((err as Error).message).toBe(NOT_IMPLEMENTED_COPY)
  })

  it('rejects an empty batch', async () => {
    const err = await rejection(Channels.postingSend, { rows: [] })
    expect((err as Error).message).not.toBe(NOT_IMPLEMENTED_COPY)
  })

  it('rejects a float amount (money is integer cents end to end)', async () => {
    const err = await rejection(Channels.postingSend, { rows: [{ ...VALID_ROW, amountCents: 123.45 }] })
    expect((err as Error).message).not.toBe(NOT_IMPLEMENTED_COPY)
  })

  it('rejects a zero or negative amount', async () => {
    const zero = await rejection(Channels.postingSend, { rows: [{ ...VALID_ROW, amountCents: 0 }] })
    const negative = await rejection(Channels.postingSend, { rows: [{ ...VALID_ROW, amountCents: -500 }] })
    expect((zero as Error).message).not.toBe(NOT_IMPLEMENTED_COPY)
    expect((negative as Error).message).not.toBe(NOT_IMPLEMENTED_COPY)
  })

  it('rejects a non-ISO transaction date', async () => {
    const err = await rejection(Channels.postingSend, { rows: [{ ...VALID_ROW, txnDate: '07/27/2026' }] })
    expect((err as Error).message).not.toBe(NOT_IMPLEMENTED_COPY)
  })

  it('rejects a hash that is not 64 chars', async () => {
    const err = await rejection(Channels.postingSend, { rows: [{ ...VALID_ROW, fileHash: 'nope' }] })
    expect((err as Error).message).not.toBe(NOT_IMPLEMENTED_COPY)
  })

  it('rejects an unknown entry type', async () => {
    const err = await rejection(Channels.postingSend, { rows: [{ ...VALID_ROW, entryType: 'journal' }] })
    expect((err as Error).message).not.toBe(NOT_IMPLEMENTED_COPY)
  })

  it('rejects a refNumber over the QuickBooks DocNumber limit of 21', async () => {
    const err = await rejection(Channels.postingSend, {
      rows: [{ ...VALID_ROW, refNumber: 'X'.repeat(22) }]
    })
    expect((err as Error).message).not.toBe(NOT_IMPLEMENTED_COPY)
  })

  it('rejects a missing required field', async () => {
    const { vendorId: _dropped, ...withoutVendor } = VALID_ROW
    const err = await rejection(Channels.postingSend, { rows: [withoutVendor] })
    expect((err as Error).message).not.toBe(NOT_IMPLEMENTED_COPY)
  })
})

describe('posting:batch-detail and posting:summary payload gates', () => {
  const withBatchId = [Channels.postingBatchDetail, Channels.postingSummary]

  it.each(withBatchId)('%s accepts a well-formed batch id', async (channel) => {
    const err = await rejection(channel, { batchId: 'batch-2026-07-27-01' })
    expect((err as Error).message).toBe(NOT_IMPLEMENTED_COPY)
  })

  it.each(withBatchId)('%s rejects an empty batch id', async (channel) => {
    const err = await rejection(channel, { batchId: '' })
    expect((err as Error).message).not.toBe(NOT_IMPLEMENTED_COPY)
  })

  it.each(withBatchId)('%s rejects a missing batch id', async (channel) => {
    const err = await rejection(channel, {})
    expect((err as Error).message).not.toBe(NOT_IMPLEMENTED_COPY)
  })

  it.each(withBatchId)('%s rejects a non-string batch id', async (channel) => {
    const err = await rejection(channel, { batchId: 7 })
    expect((err as Error).message).not.toBe(NOT_IMPLEMENTED_COPY)
  })

  it.each(withBatchId)('%s rejects the zero-arity call (this channel needs a payload)', async (channel) => {
    const err = await rejection(channel, undefined)
    expect((err as Error).message).not.toBe(NOT_IMPLEMENTED_COPY)
  })
})

// ---------------------------------------------------------------------------
// 4. Stub error mapping
// ---------------------------------------------------------------------------

describe('stubs reject with mapped copy, never a code or raw error text', () => {
  // The qbo and recon entries are gone from this list because QBO-CONNECT and RECON replaced those
  // bodies. Each remaining group drops its own rows here as it lands.
  const everyStub: Array<[string, unknown]> = [
    [Channels.postingSend, { rows: [VALID_ROW] }],
    [Channels.postingBatches, undefined],
    [Channels.postingBatchDetail, { batchId: 'b1' }],
    [Channels.postingUndoLast, undefined],
    [Channels.postingSummary, { batchId: 'b1' }]
    // The upload group is implemented; its error mapping is pinned in test/upload-ipc.test.ts.
  ]

  it.each(everyStub)('%s rejects with the NOT_IMPLEMENTED user copy', async (channel, raw) => {
    const err = await rejection(channel as string, raw)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toBe(NOT_IMPLEMENTED_COPY)
  })

  it.each(everyStub)('%s never leaks the internal code to the renderer', async (channel, raw) => {
    const err = await rejection(channel as string, raw)
    // The code is the internal key; the renderer must only ever see the mapped sentence.
    expect((err as Error).message).not.toContain('NOT_IMPLEMENTED')
  })

  it('uses copy free of em dashes and en dashes (house rule for user-facing text)', () => {
    expect(NOT_IMPLEMENTED_COPY).not.toMatch(/[–—]/)
  })
})
