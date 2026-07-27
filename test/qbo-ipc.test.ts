// test/qbo-ipc.test.ts
//
// The qbo channel group's error discipline, in the shape test/ai-ipc.test.ts established: no
// handler forwards raw error text, and the one place that decides a connection has gone bad does
// so consistently.
//
// WHY THIS MATTERS MORE FOR QUICKBOOKS THAN FOR THE AI CLIENT. Every carrier of secret detail here
// is routine rather than exotic:
//   an Intuit fault message is built from the response body and embeds the request URL,
//   the request URL embeds the realm id,
//   a token endpoint error embeds the client id,
//   a loopback bind error embeds a port.
// So the table is the contract: a code that is not in it falls through to a generic sentence, and
// nothing else is ever surfaced.
//
// The second half pins the reauth seam. A refresh that comes back invalid_grant must flip the
// stored state to 'expired' and broadcast, from ONE place, so every window switches to Reconnect
// without each call site remembering to.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { QBO_REAUTH_REQUIRED, QBO_REQUEST_FAILED } from '../src/main/qbo/errors'

type Handler = (event: unknown, raw?: unknown) => unknown

/** A realm id and a host that must never appear in anything the renderer can see. */
const REALM = '9341457604445280'
const SECRET_HOST = 'sandbox-quickbooks.api.intuit.com'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, Handler>(),
  sends: [] as Array<{ channel: string; payload: unknown }>,
  readStatus: vi.fn(),
  connect: vi.fn(),
  disconnect: vi.fn(),
  syncReference: vi.fn(),
  getReference: vi.fn(),
  markConnectionExpired: vi.fn(),
  openExternal: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: Handler): void => {
      mocks.handlers.set(channel, fn)
    }
  },
  BrowserWindow: {
    getAllWindows: () => [
      {
        isDestroyed: () => false,
        webContents: {
          send: (channel: string, payload: unknown): void => {
            mocks.sends.push({ channel, payload })
          }
        }
      }
    ]
  },
  shell: { openExternal: mocks.openExternal }
}))

vi.mock('../src/main/ipc/trusted-sender', () => ({
  assertTrustedSender: (): void => {}
}))

vi.mock('../src/main/qbo/service', () => ({
  readStatus: mocks.readStatus,
  connect: mocks.connect,
  disconnect: mocks.disconnect,
  syncReference: mocks.syncReference,
  getReference: mocks.getReference,
  markConnectionExpired: mocks.markConnectionExpired
}))

import { QBO_ERROR_COPY, registerQboIpc, runQboOperation } from '../src/main/ipc/qbo'
import { Channels } from '../src/shared/ipc-contract'

registerQboIpc()

const FAKE_EVENT = { sender: {} } as never

const DISCONNECTED = { state: 'disconnected', companyName: null, realmId: null, lastSyncAt: null }
const CONNECTED = {
  state: 'connected',
  companyName: 'Sandbox Company US 0b8b',
  realmId: REALM,
  lastSyncAt: null
}
const EXPIRED = { ...CONNECTED, state: 'expired' }

function handlerFor(channel: string): Handler {
  const fn = mocks.handlers.get(channel)
  if (!fn) throw new Error(`no handler registered for ${channel}`)
  return fn
}

beforeEach(() => {
  mocks.sends.length = 0
  for (const fn of [
    mocks.readStatus,
    mocks.connect,
    mocks.disconnect,
    mocks.syncReference,
    mocks.getReference,
    mocks.markConnectionExpired,
    mocks.openExternal
  ]) {
    fn.mockReset()
  }
  mocks.readStatus.mockReturnValue(DISCONNECTED)
})

describe('the error copy table', () => {
  it('never contains an em dash or an en dash (house rule for user-facing text)', () => {
    for (const [code, copy] of Object.entries(QBO_ERROR_COPY)) {
      expect(copy, `copy for ${code}`).not.toMatch(/[–—]/)
    }
  })

  it('never names a host, a realm id, a port, or a credential', () => {
    for (const [code, copy] of Object.entries(QBO_ERROR_COPY)) {
      expect(copy, `copy for ${code}`).not.toMatch(/intuit\.com|https?:\/\/|localhost|\b\d{5,}\b/)
    }
  })

  it('never echoes the internal code back at the user', () => {
    for (const [code, copy] of Object.entries(QBO_ERROR_COPY)) {
      expect(copy).not.toContain(code)
    }
  })

  it('tells the person what to do next in every entry', () => {
    for (const [code, copy] of Object.entries(QBO_ERROR_COPY)) {
      if (code === 'NOT_IMPLEMENTED') continue
      expect(copy, `copy for ${code}`).toMatch(/try again|Reconnect|Settings|Sync now|Connect/i)
    }
  })
})

describe('runQboOperation maps every failure', () => {
  it('passes a success straight through', async () => {
    await expect(runQboOperation(() => 'value')).resolves.toBe('value')
  })

  it('maps a known code to its copy and never leaks the code', async () => {
    const rejection = await runQboOperation(() => {
      throw new Error(QBO_REQUEST_FAILED)
    }).catch((err: unknown) => err)

    expect((rejection as Error).message).toBe(QBO_ERROR_COPY[QBO_REQUEST_FAILED])
    expect((rejection as Error).message).not.toContain(QBO_REQUEST_FAILED)
  })

  it('maps an unknown failure to the generic sentence rather than forwarding it', async () => {
    // This is the whole reason the table is a whitelist. An Intuit fault carries the request URL,
    // and the request URL carries the realm id.
    const fault = `Fault AuthenticationFailed at https://${SECRET_HOST}/v3/company/${REALM}/query?minorversion=75`
    const rejection = await runQboOperation(() => {
      throw Object.assign(new Error(fault), { stack: `Error: ${fault}\n    at qboGet` })
    }).catch((err: unknown) => err)

    const text = `${(rejection as Error).message} ${(rejection as Error).stack ?? ''}`
    expect(text).not.toContain(SECRET_HOST)
    expect(text).not.toContain(REALM)
    expect(text).not.toContain('AuthenticationFailed')
    expect((rejection as Error).message).toMatch(/internet connection/i)
  })

  it('maps a thrown non-Error to the generic sentence', async () => {
    const rejection = await runQboOperation(() => {
      throw 'a bare string'
    }).catch((err: unknown) => err)
    expect((rejection as Error).message).toMatch(/internet connection/i)
  })
})

describe('the reauth seam', () => {
  it('flips the connection to expired and broadcasts when a refresh comes back invalid_grant', async () => {
    mocks.readStatus.mockReturnValue(EXPIRED)

    const rejection = await runQboOperation(() => {
      throw new Error(QBO_REAUTH_REQUIRED)
    }).catch((err: unknown) => err)

    expect(mocks.markConnectionExpired).toHaveBeenCalledTimes(1)
    expect(mocks.sends).toEqual([{ channel: Channels.qboStatusChanged, payload: EXPIRED }])
    expect((rejection as Error).message).toBe(QBO_ERROR_COPY[QBO_REAUTH_REQUIRED])
    expect((rejection as Error).message).toMatch(/Reconnect/)
  })

  it('does NOT flip the state for an ordinary request failure', async () => {
    // Telling somebody to reauthorize over a dropped connection would cost them a browser round
    // trip and still fail.
    await runQboOperation(() => {
      throw new Error(QBO_REQUEST_FAILED)
    }).catch(() => null)

    expect(mocks.markConnectionExpired).not.toHaveBeenCalled()
    expect(mocks.sends).toEqual([])
  })
})

describe('the handlers', () => {
  it('qbo:status returns the computed status and broadcasts nothing', async () => {
    mocks.readStatus.mockReturnValue(CONNECTED)
    await expect(handlerFor(Channels.qboStatus)(FAKE_EVENT, undefined)).resolves.toEqual(CONNECTED)
    expect(mocks.sends).toEqual([])
  })

  it('qbo:connect broadcasts the resulting status so every window updates at once', async () => {
    mocks.connect.mockResolvedValue(CONNECTED)
    await expect(handlerFor(Channels.qboConnect)(FAKE_EVENT, undefined)).resolves.toEqual(CONNECTED)
    expect(mocks.sends).toEqual([{ channel: Channels.qboStatusChanged, payload: CONNECTED }])
  })

  it('qbo:connect hands the browser opener down rather than importing it into the OAuth module', async () => {
    mocks.connect.mockResolvedValue(CONNECTED)
    await handlerFor(Channels.qboConnect)(FAKE_EVENT, undefined)
    const passed = mocks.connect.mock.calls[0]?.[0] as { openExternal?: unknown }
    expect(typeof passed.openExternal).toBe('function')
  })

  it('qbo:disconnect broadcasts the disconnected status', async () => {
    mocks.disconnect.mockReturnValue(DISCONNECTED)
    await expect(handlerFor(Channels.qboDisconnect)(FAKE_EVENT, undefined)).resolves.toEqual(
      DISCONNECTED
    )
    expect(mocks.sends).toEqual([{ channel: Channels.qboStatusChanged, payload: DISCONNECTED }])
  })

  it('qbo:sync-reference returns the counts and broadcasts the refreshed sync time', async () => {
    const result = {
      vendors: 32,
      expenseAccounts: 44,
      paymentAccounts: 4,
      items: 18,
      syncedAt: '2026-07-27T20:17:07.067Z'
    }
    mocks.syncReference.mockResolvedValue(result)
    mocks.readStatus.mockReturnValue({ ...CONNECTED, lastSyncAt: result.syncedAt })

    await expect(handlerFor(Channels.qboSyncReference)(FAKE_EVENT, undefined)).resolves.toEqual(result)
    expect(mocks.sends[0].channel).toBe(Channels.qboStatusChanged)
  })

  it('qbo:get-reference returns the cache and broadcasts nothing', async () => {
    const reference = {
      vendors: [{ id: '58', name: 'Apex Plumbing Supply', active: true }],
      expenseAccounts: [],
      paymentAccounts: [],
      items: [],
      syncedAt: null
    }
    mocks.getReference.mockReturnValue(reference)
    await expect(handlerFor(Channels.qboGetReference)(FAKE_EVENT, undefined)).resolves.toEqual(
      reference
    )
    expect(mocks.sends).toEqual([])
  })

  it('rejects a smuggled payload before any service call', async () => {
    // A smuggled realmId would be an attempt to point the app at a different company.
    await expect(
      handlerFor(Channels.qboSyncReference)(FAKE_EVENT, { realmId: '999' })
    ).rejects.toThrow()
    expect(mocks.syncReference).not.toHaveBeenCalled()
  })

  it('surfaces a failed connect as mapped copy without broadcasting a bogus status', async () => {
    mocks.connect.mockRejectedValue(new Error(`connect ECONNREFUSED 127.0.0.1:8734`))
    const rejection = await handlerFor(Channels.qboConnect)(FAKE_EVENT, undefined).catch(
      (err: unknown) => err
    )
    expect((rejection as Error).message).not.toContain('8734')
    expect(mocks.sends).toEqual([])
  })
})

describe('no qbo channel ever returns a credential', () => {
  it('returns only connection state and reference data, never a token', async () => {
    mocks.readStatus.mockReturnValue(CONNECTED)
    const status = (await handlerFor(Channels.qboStatus)(FAKE_EVENT, undefined)) as Record<
      string,
      unknown
    >
    expect(Object.keys(status).sort()).toEqual(['companyName', 'lastSyncAt', 'realmId', 'state'])
  })
})
