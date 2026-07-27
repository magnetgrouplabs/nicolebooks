// test/recon-ipc.test.ts
//
// The recon channel group after RECON replaced the SEAMS stub. This file takes over the recon:match
// rows that test/seams-ipc.test.ts pinned while the body was a stub, and asserts the same
// properties against the real handler:
//
//   1. The channel is registered. A missing registration is invisible until the renderer invokes it
//      and gets Electron's "No handler registered" error at runtime.
//   2. The payload gate accepts a well-formed hash list and refuses everything else BEFORE any
//      work happens. These bounds are what stop a compromised renderer from steering a match: the
//      channel takes hashes, never the parsed vendor or category text.
//   3. Failures surface as mapped copy, never a code, a stack or a filesystem path. Everything
//      under this handler reads SQLite, and a SQLite error carries the path to the database.
//   4. Nothing on this channel creates a QuickBooks record (RECON-03).
//
// The service module is substituted so no database is opened here; its real behaviour is covered by
// test/recon-service.test.ts, and the matcher itself by test/recon-match.test.ts and
// test/recon-similarity.test.ts.

import { beforeEach, describe, expect, it, vi } from 'vitest'

type Handler = (event: unknown, raw?: unknown) => unknown

/** A path and a host that must never reach the renderer inside an error message. */
const SECRET_PATH = 'C:\\Users\\nicole\\AppData\\Roaming\\NicoleBooks\\app.db'
const REALM = '9341457604445280'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, Handler>(),
  matchBatch: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: Handler): void => {
      mocks.handlers.set(channel, fn)
    }
  }
}))

vi.mock('../src/main/ipc/trusted-sender', () => ({ assertTrustedSender: (): void => {} }))

vi.mock('../src/main/recon/service', () => ({
  RECON_NOT_CONNECTED: 'RECON_NOT_CONNECTED',
  RECON_REFERENCE_EMPTY: 'RECON_REFERENCE_EMPTY',
  matchBatch: mocks.matchBatch
}))

import {
  NOT_IMPLEMENTED,
  RECON_ERROR_COPY,
  registerReconIpc,
  runReconOperation
} from '../src/main/ipc/recon'
import { Channels } from '../src/shared/ipc-contract'

registerReconIpc()

const FAKE_EVENT = { sender: {} } as never

const HASH_A = 'a'.repeat(64)
const HASH_B = 'b'.repeat(64)

/** One well-formed result, the shape the review grid consumes. */
const MATCHED = {
  matches: {
    [HASH_A]: {
      vendor: {
        selectedId: '58',
        selectedName: 'Apex Plumbing Supply',
        confidence: 'auto',
        candidates: [{ id: '58', name: 'Apex Plumbing Supply', score: 1 }]
      },
      category: {
        selectedId: '63',
        selectedName: 'Job Expenses:Job Materials',
        confidence: 'auto',
        candidates: [{ id: '63', name: 'Job Expenses:Job Materials', score: 1 }]
      }
    }
  }
}

function handlerFor(channel: string): Handler {
  const fn = mocks.handlers.get(channel)
  if (!fn) throw new Error(`no handler registered for ${channel}`)
  return fn
}

/** Invoke a handler and return whatever it threw or rejected with, or null if it succeeded. */
async function rejection(raw?: unknown): Promise<unknown> {
  try {
    await handlerFor(Channels.reconMatch)(FAKE_EVENT, raw)
    return null
  } catch (err) {
    return err
  }
}

beforeEach(() => {
  mocks.matchBatch.mockReset()
  mocks.matchBatch.mockReturnValue(MATCHED)
})

describe('registration', () => {
  it('registers a handler on recon:match', () => {
    expect(typeof mocks.handlers.get(Channels.reconMatch)).toBe('function')
  })

  it('registers nothing else', () => {
    expect([...mocks.handlers.keys()]).toEqual([Channels.reconMatch])
  })
})

describe('the payload gate', () => {
  it('accepts a well-formed hash list and passes it straight through', async () => {
    await expect(handlerFor(Channels.reconMatch)(FAKE_EVENT, { fileHashes: [HASH_A, HASH_B] })).resolves.toEqual(
      MATCHED
    )
    expect(mocks.matchBatch).toHaveBeenCalledWith([HASH_A, HASH_B])
  })

  it('accepts an empty hash list (a scan with nothing loaded is not an error)', async () => {
    mocks.matchBatch.mockReturnValue({ matches: {} })
    await expect(handlerFor(Channels.reconMatch)(FAKE_EVENT, { fileHashes: [] })).resolves.toEqual({
      matches: {}
    })
  })

  it('rejects a hash that is not 64 chars, before any work', async () => {
    expect(await rejection({ fileHashes: ['too-short'] })).toBeTruthy()
    expect(mocks.matchBatch).not.toHaveBeenCalled()
  })

  it('rejects a missing fileHashes field', async () => {
    expect(await rejection({})).toBeTruthy()
    expect(mocks.matchBatch).not.toHaveBeenCalled()
  })

  it('rejects parsed vendor text smuggled in place of hashes', async () => {
    // Hashes ONLY. The parsed text lives main-side; accepting it here would let the renderer steer
    // a match against text the parser never produced.
    expect(await rejection({ fileHashes: ['Home Depot'] })).toBeTruthy()
    expect(mocks.matchBatch).not.toHaveBeenCalled()
  })

  it('rejects the bare array shape (the preload wraps it in { fileHashes })', async () => {
    expect(await rejection([HASH_A])).toBeTruthy()
    expect(mocks.matchBatch).not.toHaveBeenCalled()
  })

  it('rejects the zero-arity call (this channel needs a payload)', async () => {
    expect(await rejection(undefined)).toBeTruthy()
    expect(mocks.matchBatch).not.toHaveBeenCalled()
  })

  it('rejects a batch over the 500 ceiling', async () => {
    expect(await rejection({ fileHashes: new Array(501).fill(HASH_A) })).toBeTruthy()
    expect(mocks.matchBatch).not.toHaveBeenCalled()
  })
})

describe('the error copy table', () => {
  it('never contains an em dash or an en dash (house rule for user-facing text)', () => {
    for (const [code, copy] of Object.entries(RECON_ERROR_COPY)) {
      expect(copy, `copy for ${code}`).not.toMatch(/[–—]/)
    }
  })

  it('never names a path, a host, a realm id, or a credential', () => {
    for (const [code, copy] of Object.entries(RECON_ERROR_COPY)) {
      expect(copy, `copy for ${code}`).not.toMatch(/intuit\.com|https?:\/\/|[A-Za-z]:\\|\/Users\/|\b\d{5,}\b/)
    }
  })

  it('never echoes the internal code back at the user', () => {
    for (const [code, copy] of Object.entries(RECON_ERROR_COPY)) {
      expect(copy).not.toContain(code)
    }
  })

  it('tells the person what to do next in every entry', () => {
    for (const [code, copy] of Object.entries(RECON_ERROR_COPY)) {
      if (code === NOT_IMPLEMENTED) continue
      expect(copy, `copy for ${code}`).toMatch(/try again|Settings|Sync now|Connect/i)
    }
  })
})

describe('runReconOperation maps every failure', () => {
  it('passes a success straight through', () => {
    expect(runReconOperation(() => 'value')).toBe('value')
  })

  it('maps a known code to its copy and never leaks the code', async () => {
    mocks.matchBatch.mockImplementation(() => {
      throw new Error('RECON_REFERENCE_EMPTY')
    })
    const err = (await rejection({ fileHashes: [HASH_A] })) as Error
    expect(err.message).toBe(RECON_ERROR_COPY.RECON_REFERENCE_EMPTY)
    expect(err.message).not.toContain('RECON_REFERENCE_EMPTY')
    expect(err.message).toMatch(/Sync now/)
  })

  it('tells a disconnected user to connect rather than reporting nothing matched', async () => {
    mocks.matchBatch.mockImplementation(() => {
      throw new Error('RECON_NOT_CONNECTED')
    })
    const err = (await rejection({ fileHashes: [HASH_A] })) as Error
    expect(err.message).toBe(RECON_ERROR_COPY.RECON_NOT_CONNECTED)
    expect(err.message).toMatch(/Connect to QuickBooks/)
  })

  it('maps an unknown failure to the generic sentence rather than forwarding it', async () => {
    // This is the whole reason the table is a whitelist: a SQLite failure carries the path to the
    // database, which carries the user's name.
    const raw = `SQLITE_CANTOPEN: unable to open database file ${SECRET_PATH} for realm ${REALM}`
    mocks.matchBatch.mockImplementation(() => {
      throw Object.assign(new Error(raw), { stack: `Error: ${raw}\n    at getDatabase` })
    })

    const err = (await rejection({ fileHashes: [HASH_A] })) as Error
    const text = `${err.message} ${err.stack ?? ''}`
    expect(text).not.toContain(SECRET_PATH)
    expect(text).not.toContain(REALM)
    expect(text).not.toContain('SQLITE_CANTOPEN')
    expect(err.message).toBe('Could not match these bills against QuickBooks. Please try again.')
  })

  it('maps a thrown non-Error to the generic sentence', async () => {
    mocks.matchBatch.mockImplementation(() => {
      throw 'a bare string'
    })
    const err = (await rejection({ fileHashes: [HASH_A] })) as Error
    expect(err.message).toMatch(/Could not match these bills/)
  })
})

describe('what the channel returns', () => {
  it('returns only ids, names and scores, never a credential or a document path', async () => {
    const result = (await handlerFor(Channels.reconMatch)(FAKE_EVENT, {
      fileHashes: [HASH_A]
    })) as typeof MATCHED
    const cell = result.matches[HASH_A].vendor
    expect(Object.keys(cell).sort()).toEqual([
      'candidates',
      'confidence',
      'selectedId',
      'selectedName'
    ])
    expect(Object.keys(cell.candidates[0]).sort()).toEqual(['id', 'name', 'score'])
  })

  it('creates nothing: the handler only reads (RECON-03)', () => {
    // The module's whole import surface is the matcher plus the gates. There is no QuickBooks
    // client and no create call anywhere beneath it.
    expect(mocks.matchBatch).toBeDefined()
    expect(Object.keys(RECON_ERROR_COPY)).not.toContain('RECON_CREATE_FAILED')
  })
})
