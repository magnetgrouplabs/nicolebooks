// test/secret-store.test.ts
//
// SC2 unit coverage for the safeStorage secret store (decisions D-10/D-12, threat
// T-01-04). electron is mocked: app.getPath points at a per-file temp directory, and
// safeStorage is a reversible non-identity stub whose ciphertext never contains the
// plaintext literal. The store logic under test (round trip, unknown key, delete, and the
// unavailable-throws guard) is exercised without a real OS keychain or a running app.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { rmSync } from 'node:fs'
import { join } from 'node:path'

const state = vi.hoisted(() => {
  const os = require('node:os') as typeof import('node:os')
  const fs = require('node:fs') as typeof import('node:fs')
  const path = require('node:path') as typeof import('node:path')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-secret-'))
  return { dir, available: true }
})

vi.mock('electron', () => ({
  app: { getPath: (_name: string) => state.dir },
  safeStorage: {
    isEncryptionAvailable: () => state.available,
    // Reversible, non-identity stub. Output is 'stub-v10:' + base64(plaintext); base64
    // transforms the bytes so the plaintext literal never survives into the ciphertext.
    encryptString: (s: string): Buffer =>
      Buffer.from('stub-v10:' + Buffer.from(s, 'utf8').toString('base64'), 'utf8'),
    decryptString: (b: Buffer): string => {
      const text = b.toString('utf8')
      const marker = 'stub-v10:'
      if (!text.startsWith(marker)) throw new Error('bad ciphertext')
      return Buffer.from(text.slice(marker.length), 'base64').toString('utf8')
    }
  }
}))

import { secretStore } from '../src/main/secrets/secret-store'

beforeEach(() => {
  state.available = true
  rmSync(join(state.dir, 'secrets.enc'), { force: true })
})

describe('secretStore', () => {
  it('round-trips a value through set and get', () => {
    secretStore.set('ai-api-key', 'sk-test-123')
    expect(secretStore.get('ai-api-key')).toBe('sk-test-123')
  })

  it('returns null for an unknown key', () => {
    expect(secretStore.get('never-set')).toBeNull()
  })

  it('delete removes the entry so a later get returns null', () => {
    secretStore.set('qbo-refresh', 'refresh-token-abc')
    expect(secretStore.get('qbo-refresh')).toBe('refresh-token-abc')
    secretStore.delete('qbo-refresh')
    expect(secretStore.get('qbo-refresh')).toBeNull()
  })

  it('reports availability from safeStorage.isEncryptionAvailable', () => {
    expect(secretStore.available()).toBe(true)
    state.available = false
    expect(secretStore.available()).toBe(false)
  })

  it('throws SECRET_STORE_UNAVAILABLE when encryption is unavailable', () => {
    state.available = false
    expect(() => secretStore.set('ai-api-key', 'sk-test-123')).toThrow('SECRET_STORE_UNAVAILABLE')
  })
})
