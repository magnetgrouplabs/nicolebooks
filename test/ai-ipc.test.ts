// test/ai-ipc.test.ts
//
// WR-02 regression pin: no handler in the ai channel group forwards raw SDK or system error text
// to the renderer.
//
// The module header of src/main/ipc/ai.ts says "the raw error is never forwarded, so an SDK
// message carrying the endpoint URL (or a stack) cannot ride out to the renderer", and
// ipc-contract.ts calls carrying "the credential or the endpoint URL" across this boundary a
// contract violation. ai:test-connection honoured that; ai:list-models had no try/catch at all,
// so any rejection propagated and ipcMain.handle serialised the thrown message straight into the
// renderer's rejection. Two realistic carriers: an undici DNS failure reads
// `getaddrinfo ENOTFOUND gw.example.com`, and an SDK APIError message is built from the
// provider's response body. The base URL lives in the keychain precisely because it is secret.
//
// electron is mocked to capture ipcMain.handle registrations (the test/ingestion-ipc-scan.test.ts
// pattern) and trusted-sender is a no-op, so this targets the ERROR-MAPPING behaviour.

import { beforeEach, describe, expect, it, vi } from 'vitest'

type Handler = (event: unknown, raw?: unknown) => unknown

/** A host that must never appear in anything the renderer can see. */
const SECRET_HOST = 'private-gateway-7f31c9.internal'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, raw?: unknown) => unknown>(),
  buildClient: vi.fn(),
  listModels: vi.fn(),
  setSelectedModel: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: Handler): void => {
      mocks.handlers.set(channel, fn)
    }
  }
}))

vi.mock('../src/main/ipc/trusted-sender', () => ({
  assertTrustedSender: (): void => {}
}))

vi.mock('../src/main/ai/client', () => ({
  buildClient: mocks.buildClient,
  AI_API_KEY_SECRET: 'ai-api-key',
  AI_BASE_URL_SECRET: 'ai-base-url'
}))

vi.mock('../src/main/ai/models', () => ({
  listModels: mocks.listModels,
  setSelectedModel: mocks.setSelectedModel
}))

import { registerAiIpc } from '../src/main/ipc/ai'
import { Channels } from '../src/shared/ipc-contract'

registerAiIpc()

const listModelsHandler = mocks.handlers.get(Channels.aiListModels) as Handler
const testConnectionHandler = mocks.handlers.get(Channels.aiTestConnection) as Handler

const FAKE_EVENT = { sender: {} } as never

/** The undici shape an unreachable custom gateway produces, host and all. */
function dnsFailure(): Error {
  return Object.assign(new Error(`getaddrinfo ENOTFOUND ${SECRET_HOST}`), {
    code: 'ENOTFOUND',
    stack: `Error: getaddrinfo ENOTFOUND ${SECRET_HOST}\n    at GetAddrInfoReqWrap.onlookup`
  })
}

/** The SDK shape: an APIError message assembled from the provider's own response body. */
function apiError(): Error {
  return Object.assign(
    new Error(
      `401 Incorrect API key provided: sk-live-abc***. Request to https://${SECRET_HOST}/v1/models failed.`
    ),
    { status: 401 }
  )
}

beforeEach(() => {
  mocks.buildClient.mockReset()
  mocks.listModels.mockReset()
  mocks.buildClient.mockReturnValue({})
})

describe('ai:list-models never forwards raw error text (WR-02)', () => {
  it('rejects with fixed copy when the endpoint cannot be resolved', async () => {
    mocks.listModels.mockRejectedValue(dnsFailure())

    const rejection = await listModelsHandler(FAKE_EVENT, undefined).then(
      () => null,
      (err: unknown) => err
    )

    expect(rejection).toBeInstanceOf(Error)
    const text = `${(rejection as Error).message} ${(rejection as Error).stack ?? ''}`
    expect(text).not.toContain(SECRET_HOST)
    expect(text).not.toContain('ENOTFOUND')
    expect(text).not.toContain('GetAddrInfoReqWrap')
    expect((rejection as Error).message).toMatch(/api key/i)
  })

  it('rejects with fixed copy when the provider returns an APIError carrying the URL', async () => {
    mocks.listModels.mockRejectedValue(apiError())

    const rejection = (await listModelsHandler(FAKE_EVENT, undefined).then(
      () => null,
      (err: unknown) => err
    )) as Error

    expect(rejection.message).not.toContain(SECRET_HOST)
    expect(rejection.message).not.toContain('sk-live-abc')
    expect(rejection.message).not.toContain('401')
  })

  it('maps a credential-shaped failure from buildClient to its own recoverable copy', async () => {
    mocks.buildClient.mockImplementation(() => {
      throw new Error('AI_CREDENTIALS_MISSING')
    })

    const rejection = (await listModelsHandler(FAKE_EVENT, undefined).then(
      () => null,
      (err: unknown) => err
    )) as Error

    expect(rejection.message).toMatch(/api key/i)
    expect(rejection.message).not.toBe('AI_CREDENTIALS_MISSING')
  })

  it('still resolves the classified model list on the happy path', async () => {
    mocks.listModels.mockResolvedValue([{ id: 'gpt-4o', vision: 'vision' }])
    await expect(listModelsHandler(FAKE_EVENT, undefined)).resolves.toEqual([
      { id: 'gpt-4o', vision: 'vision' }
    ])
  })

  it('rejects a smuggled payload before building a client', async () => {
    await expect(listModelsHandler(FAKE_EVENT, { baseUrl: 'https://evil.example' })).rejects.toThrow()
    expect(mocks.buildClient).not.toHaveBeenCalled()
  })
})

describe('ai:test-connection keeps its existing mapping', () => {
  it('returns { ok: false } with fixed copy rather than rejecting', async () => {
    mocks.listModels.mockRejectedValue(dnsFailure())
    const result = (await testConnectionHandler(FAKE_EVENT, undefined)) as {
      ok: boolean
      error?: string
    }
    expect(result.ok).toBe(false)
    expect(result.error).toBeTruthy()
    expect(result.error).not.toContain(SECRET_HOST)
  })
})
