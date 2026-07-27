// test/upload-ipc.test.ts
//
// The upload channel group after INGEST-UX replaced the SEAMS stubs. This file takes over the four
// upload rows that test/seams-ipc.test.ts pinned while they were stubs, and asserts the same
// properties against the real bodies:
//
//   1. Every channel is registered. A missing registration is invisible until the renderer invokes
//      it and gets Electron's "No handler registered" error at runtime.
//   2. Payload-free channels RESOLVE for the zero-arity preload call and REJECT smuggled input.
//      The resolve half is the ingestion:scan regression in miniature: these handlers must parse
//      `raw ?? {}`, because the preload invokes them with no argument and
//      z.object({}).strict().parse(undefined) throws 'expected object, received undefined'. A
//      handler that parsed a bare `raw` would reject every real call while still passing a
//      reject-only test, which is exactly how that defect shipped for a whole phase.
//   3. The gate runs BEFORE the work. A smuggled payload must never reach the dialog or the bind.
//   4. Failures surface as mapped copy, never a code, a stack, a path, or a port. A bind error
//      carries a port and a filesystem error carries a path, and neither belongs in the renderer.
//
// The server and picker modules are substituted so no dialog opens and no socket binds here; their
// real behaviour is covered by test/upload-lifecycle.test.ts, test/upload-server.test.ts and
// test/upload-pick-files.test.ts.

import { describe, expect, it, vi } from 'vitest'

type Handler = (event: unknown, raw?: unknown) => unknown

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, Handler>(),
  sent: [] as Array<{ channel: string; payload: unknown }>,
  start: vi.fn(),
  stop: vi.fn(),
  status: vi.fn(),
  pick: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: Handler): void => {
      mocks.handlers.set(channel, fn)
    }
  },
  app: { on: (): void => {} },
  BrowserWindow: {
    getAllWindows: () => [
      {
        isDestroyed: () => false,
        webContents: {
          send: (channel: string, payload: unknown) => mocks.sent.push({ channel, payload })
        }
      }
    ],
    fromWebContents: () => null
  }
}))

vi.mock('../src/main/ipc/trusted-sender', () => ({ assertTrustedSender: (): void => {} }))

vi.mock('../src/main/upload/server', () => ({
  UPLOAD_START_FAILED: 'UPLOAD_START_FAILED',
  UPLOAD_STOP_FAILED: 'UPLOAD_STOP_FAILED',
  startUploadServer: mocks.start,
  stopUploadServer: mocks.stop,
  getUploadStatus: mocks.status
}))

vi.mock('../src/main/upload/pick-files', () => ({
  PICK_FILES_FAILED: 'PICK_FILES_FAILED',
  pickFilesIntoInbox: mocks.pick
}))

import { broadcastUploadReceived, registerUploadIpc } from '../src/main/ipc/upload'
import { Channels } from '../src/shared/ipc-contract'

registerUploadIpc()

/** The sender gate is mocked out, so the event only needs to be a value. */
const FAKE_EVENT = { sender: {} } as never

function handlerFor(channel: string): Handler {
  const fn = mocks.handlers.get(channel)
  if (!fn) throw new Error(`no handler registered for ${channel}`)
  return fn
}

async function invoke(channel: string, raw?: unknown): Promise<unknown> {
  return await handlerFor(channel)(FAKE_EVENT, raw)
}

async function rejection(channel: string, raw?: unknown): Promise<unknown> {
  try {
    await handlerFor(channel)(FAKE_EVENT, raw)
    return null
  } catch (err) {
    return err
  }
}

const ALL = [
  Channels.ingestionPickFiles,
  Channels.uploadStart,
  Channels.uploadStop,
  Channels.uploadStatus
]

function resetMocks(): void {
  mocks.start.mockReset().mockResolvedValue({ url: 'http://192.168.1.4:5000/u/tok/', qrDataUrl: 'data:image/png;base64,AAAA' })
  mocks.stop.mockReset().mockResolvedValue({ stopped: true })
  mocks.status.mockReset().mockReturnValue({ running: false, url: null, receivedCount: 0 })
  mocks.pick.mockReset().mockResolvedValue({ added: 2, skipped: ['notes.docx'] })
  mocks.sent.length = 0
}

// ---------------------------------------------------------------------------
// 1. Registration
// ---------------------------------------------------------------------------

describe('registration', () => {
  it.each(ALL)('registers a handler on %s', (channel) => {
    expect(typeof mocks.handlers.get(channel)).toBe('function')
  })

  it('registers no handler on the broadcast channel', () => {
    // upload:received is a main->renderer send, never an ipcMain.handle target. A handler here
    // would mean somebody misread the direction of the seam.
    expect(mocks.handlers.has(Channels.uploadReceived)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 2 and 3. The payload gate, on real handlers
// ---------------------------------------------------------------------------

describe('payload-free gates', () => {
  it.each(ALL)('%s accepts the zero-arity preload call (raw === undefined)', async (channel) => {
    resetMocks()
    await expect(invoke(channel, undefined)).resolves.toBeDefined()
  })

  it.each(ALL)('%s accepts an explicit empty object', async (channel) => {
    resetMocks()
    await expect(invoke(channel, {})).resolves.toBeDefined()
  })

  it.each(ALL)('%s rejects a smuggled payload', async (channel) => {
    resetMocks()
    const err = await rejection(channel, { inboxPath: 'C:\\Users\\anthony', port: 8080 })
    expect(err).toBeTruthy()
  })

  it.each(ALL)('%s does no work at all when the gate rejects', async (channel) => {
    // A renderer-supplied path or port must never reach the dialog or the bind. The gate runs
    // first, so none of the four workers is called.
    resetMocks()
    await rejection(channel, { inboxPath: '/etc', port: 22 })
    expect(mocks.start).not.toHaveBeenCalled()
    expect(mocks.stop).not.toHaveBeenCalled()
    expect(mocks.status).not.toHaveBeenCalled()
    expect(mocks.pick).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// 4. Results pass through unchanged
// ---------------------------------------------------------------------------

describe('results', () => {
  it('ingestion:pick-files returns the added count and the skipped NAMES', async () => {
    resetMocks()
    await expect(invoke(Channels.ingestionPickFiles)).resolves.toEqual({
      added: 2,
      skipped: ['notes.docx']
    })
  })

  it('upload:start returns the pairing URL and a self-contained QR data URI', async () => {
    resetMocks()
    const result = (await invoke(Channels.uploadStart)) as { url: string; qrDataUrl: string }
    expect(result.url).toContain('/u/')
    expect(result.qrDataUrl.startsWith('data:image/png;base64,')).toBe(true)
  })

  it('upload:start wires the broadcast, so a phone upload reaches every window', async () => {
    resetMocks()
    await invoke(Channels.uploadStart)
    const onReceived = mocks.start.mock.calls[0][0].onReceived as (names: string[]) => void
    onReceived(['receipt.jpg'])
    expect(mocks.sent).toEqual([
      { channel: Channels.uploadReceived, payload: { filenames: ['receipt.jpg'] } }
    ])
  })

  it('upload:stop and upload:status pass their result straight through', async () => {
    resetMocks()
    await expect(invoke(Channels.uploadStop)).resolves.toEqual({ stopped: true })
    await expect(invoke(Channels.uploadStatus)).resolves.toEqual({
      running: false,
      url: null,
      receivedCount: 0
    })
  })

  it('the broadcast carries file NAMES only, never a path (T-02-02)', async () => {
    resetMocks()
    broadcastUploadReceived({ filenames: ['a.pdf', 'b.jpg'] })
    expect(mocks.sent[0].payload).toEqual({ filenames: ['a.pdf', 'b.jpg'] })
  })
})

// ---------------------------------------------------------------------------
// 5. Error mapping: no code, no stack, no path, no port, no dashes
// ---------------------------------------------------------------------------

describe('error mapping', () => {
  const cases: Array<[string, string, () => void]> = [
    [Channels.uploadStart, 'UPLOAD_START_FAILED', () => mocks.start.mockRejectedValue(new Error('UPLOAD_START_FAILED'))],
    [Channels.uploadStop, 'UPLOAD_STOP_FAILED', () => mocks.stop.mockRejectedValue(new Error('UPLOAD_STOP_FAILED'))],
    [Channels.ingestionPickFiles, 'PICK_FILES_FAILED', () => mocks.pick.mockRejectedValue(new Error('PICK_FILES_FAILED'))]
  ]

  it.each(cases)('%s maps its failure to plain recoverable copy', async (channel, code, arrange) => {
    resetMocks()
    arrange()
    const err = (await rejection(channel)) as Error
    expect(err).toBeInstanceOf(Error)
    expect(err.message).not.toContain(code)
    expect(err.message).not.toContain('Error:')
    expect(err.message.length).toBeGreaterThan(10)
  })

  it('never forwards raw error text, which carries ports and paths', async () => {
    // The exact shape of a real bind failure. Forwarding it would put the port, and often the
    // interface address, straight into the renderer.
    resetMocks()
    mocks.start.mockRejectedValue(
      new Error('listen EADDRINUSE: address already in use 192.168.1.44:52341')
    )
    const err = (await rejection(Channels.uploadStart)) as Error
    expect(err.message).not.toContain('EADDRINUSE')
    expect(err.message).not.toContain('192.168.1.44')
    expect(err.message).not.toContain('52341')
  })

  it('never forwards a filesystem path from the picker', async () => {
    resetMocks()
    mocks.pick.mockRejectedValue(new Error("EACCES: permission denied, open 'C:\\Users\\nicole\\bill.pdf'"))
    const err = (await rejection(Channels.ingestionPickFiles)) as Error
    expect(err.message).not.toContain('C:\\Users')
    expect(err.message).not.toContain('EACCES')
  })

  it('uses copy free of em dashes and en dashes (house rule for user-facing text)', async () => {
    resetMocks()
    for (const [channel, , arrange] of cases) {
      resetMocks()
      arrange()
      const err = (await rejection(channel)) as Error
      expect(err.message).not.toMatch(/[\u2013\u2014]/)
    }
  })
})
