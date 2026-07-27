// test/secrets-ipc-readback.test.ts
//
// CR-04 regression pin: the renderer can WRITE the AI credentials through the generic secrets
// channel, but it can never READ them back.
//
// Why this file exists. Three Phase 3 headers assert the credential cannot be read back by the
// renderer (src/main/ai/client.ts, src/preload/index.ts, src/shared/ipc-contract.ts). All three
// were true only of the ai:* channels. Phase 3 (D-05) chose to store BOTH credentials under the
// generic `secrets` channel, whose getter had no allow-list or deny-list at all, so
// `await window.api.secrets.get('ai-api-key')` returned the decrypted key to renderer
// JavaScript. A documented control that does not exist is worse than an acknowledged gap,
// because no future reviewer looks again.
//
// The gate is only reachable at the main-process handler: the preload bridges secrets.get
// verbatim, so asserting this from e2e would prove nothing the handler does not already decide.
// electron is mocked to capture ipcMain.handle registrations (the test/ingestion-ipc-scan.test.ts
// pattern) and trusted-sender is a no-op, so this targets the READ-BACK gate specifically.

import { beforeEach, describe, expect, it, vi } from 'vitest'

type Handler = (event: unknown, raw?: unknown) => unknown

const state = vi.hoisted(() => {
  const os = require('node:os') as typeof import('node:os')
  const fs = require('node:fs') as typeof import('node:fs')
  const path = require('node:path') as typeof import('node:path')
  return { dir: fs.mkdtempSync(path.join(os.tmpdir(), 'nb-secret-readback-')) }
})

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, raw?: unknown) => unknown>()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: Handler): void => {
      mocks.handlers.set(channel, fn)
    }
  },
  app: { getPath: (_name: string) => state.dir },
  // A reversible stand-in for the OS keychain: encrypted at rest, decryptable main-side.
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string): Buffer =>
      Buffer.from('stub-v10:' + Buffer.from(s, 'utf8').toString('base64'), 'utf8'),
    decryptString: (b: Buffer): string =>
      Buffer.from(b.toString('utf8').slice('stub-v10:'.length), 'base64').toString('utf8')
  }
}))

vi.mock('../src/main/ipc/trusted-sender', () => ({
  assertTrustedSender: (): void => {}
}))

import { registerSecretsIpc } from '../src/main/ipc/secrets'
import { AI_API_KEY_SECRET, AI_BASE_URL_SECRET } from '../src/main/ai/client'
import { secretStore } from '../src/main/secrets/secret-store'
import { Channels } from '../src/shared/ipc-contract'

/** Distinctive values, so a leak through the handler is unambiguous rather than coincidental. */
const KEY_VALUE = 'sk-CR04-LIVE-BILLING-CREDENTIAL-7f21a9'
const BASE_URL_VALUE = 'https://cr04-endpoint-3b8e1d.example/v1'
const CANARY_VALUE = 'ok'

registerSecretsIpc()

const setHandler = mocks.handlers.get(Channels.secretsSet) as Handler
const getHandler = mocks.handlers.get(Channels.secretsGet) as Handler
const deleteHandler = mocks.handlers.get(Channels.secretsDelete) as Handler

const FAKE_EVENT = { sender: {} } as never

beforeEach(() => {
  secretStore.set(AI_API_KEY_SECRET, KEY_VALUE)
  secretStore.set(AI_BASE_URL_SECRET, BASE_URL_VALUE)
})

describe('secrets:get never hands an AI credential back to the renderer (CR-04)', () => {
  it('returns null for the API key even though it is stored', () => {
    // The one-line exfiltration this closes: await window.api.secrets.get('ai-api-key')
    expect(getHandler(FAKE_EVENT, AI_API_KEY_SECRET)).toBeNull()
  })

  it('returns null for the base URL, which identifies where the key is sent', () => {
    expect(getHandler(FAKE_EVENT, AI_BASE_URL_SECRET)).toBeNull()
  })

  it('still reads both credentials MAIN-side, so the deny-list is a boundary and not a delete', () => {
    // If this went null too, the fix would have broken the client instead of the leak.
    expect(secretStore.get(AI_API_KEY_SECRET)).toBe(KEY_VALUE)
    expect(secretStore.get(AI_BASE_URL_SECRET)).toBe(BASE_URL_VALUE)
  })

  it('keeps the generic round trip working for non-credential keys', () => {
    // The Settings HealthIndicator (SC2's permanent proof) and e2e/secret-roundtrip.spec.ts both
    // depend on set -> get returning the exact value for an ordinary key.
    setHandler(FAKE_EVENT, { key: 'canary', value: CANARY_VALUE })
    expect(getHandler(FAKE_EVENT, 'canary')).toBe(CANARY_VALUE)

    setHandler(FAKE_EVENT, { key: 'e2e_roundtrip_canary', value: 'E2E-CANARY-9c1f7ae0d3b64' })
    expect(getHandler(FAKE_EVENT, 'e2e_roundtrip_canary')).toBe('E2E-CANARY-9c1f7ae0d3b64')
  })

  it('still lets the renderer WRITE a credential (the settings form must work)', () => {
    setHandler(FAKE_EVENT, { key: AI_API_KEY_SECRET, value: 'sk-a-newer-key-4d02' })
    expect(secretStore.get(AI_API_KEY_SECRET)).toBe('sk-a-newer-key-4d02')
    expect(getHandler(FAKE_EVENT, AI_API_KEY_SECRET)).toBeNull() // written, still unreadable
  })

  it('still lets the renderer DELETE a credential (removing a stored key is not reading it)', () => {
    deleteHandler(FAKE_EVENT, AI_API_KEY_SECRET)
    expect(secretStore.get(AI_API_KEY_SECRET)).toBeNull()
  })

  it('rejects a malformed key before deciding anything about readability', () => {
    expect(() => getHandler(FAKE_EVENT, '')).toThrow()
    expect(() => getHandler(FAKE_EVENT, 42)).toThrow()
  })
})
