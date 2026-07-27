// test/no-secret-leak.test.ts
//
// SC2 no-leak coverage (threats T-01-04 and T-01-05). A distinctive canary secret is stored
// through the secret store, then this suite asserts the canary PLAINTEXT never appears in
// three places it must never reach:
//   1. secrets.enc holds only base64 ciphertext (the canary plaintext is absent)
//   2. app.db (a real migrated SQLite file) does not contain the canary
//   3. captured stdout/stderr/console output during set and get does not contain the canary
//
// The DB is created with the same better-sqlite3 + migrate path as production so the app.db
// byte-scan is a genuine artifact, not an empty file. electron is mocked exactly as in the
// secret-store suite (temp userData dir + reversible safeStorage stub).
//
// Plan 03-02 extension (AI-01, decision D-05, threat T-03-01): the same three-surface scan is
// applied to BOTH Phase 3 AI credentials — the API key AND the base URL — because the base URL
// is stored in the keychain alongside the key and identifies the endpoint the key is sent to.
// The AI path is then exercised end to end (buildClient reads both main-side, listModels
// classifies a model list) to prove neither canary escapes into the IPC-bound result or a log.

import { afterAll, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { migrate } from '../src/main/db/migrate'
import { makeFakeClient } from './helpers/fake-openai-client'

const CANARY = 'CANARY-NEVER-LEAK-4f3a9b2e17'

// Distinct AI-credential canaries. The base URL must still be a well-formed https URL so
// buildClient accepts it; the canary lives in the host so a leak is unambiguous.
const AI_KEY_CANARY = 'sk-CANARY-AI-KEY-8b17d4c6e0'
const AI_BASE_URL_HOST_CANARY = 'canary-base-url-9d41c7e2.example'
const AI_BASE_URL_CANARY = `https://${AI_BASE_URL_HOST_CANARY}/v1`

const state = vi.hoisted(() => {
  const os = require('node:os') as typeof import('node:os')
  const fs = require('node:fs') as typeof import('node:fs')
  const path = require('node:path') as typeof import('node:path')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-noleak-'))
  return { dir }
})

vi.mock('electron', () => ({
  app: { getPath: (_name: string) => state.dir },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string): Buffer =>
      Buffer.from('stub-v10:' + Buffer.from(s, 'utf8').toString('base64'), 'utf8'),
    decryptString: (b: Buffer): string => {
      const text = b.toString('utf8')
      return Buffer.from(text.slice('stub-v10:'.length), 'base64').toString('utf8')
    }
  }
}))

import { secretStore } from '../src/main/secrets/secret-store'
import { AI_API_KEY_SECRET, AI_BASE_URL_SECRET, buildClient } from '../src/main/ai/client'
import { listModels, setSelectedModel } from '../src/main/ai/models'

afterAll(() => {
  vi.restoreAllMocks()
})

/** Capture every console/stdout/stderr write for the duration of fn, then restore. */
async function captureOutput(fn: () => void | Promise<void>): Promise<string> {
  const captured: string[] = []
  const record = (...args: unknown[]): boolean => {
    captured.push(args.map(String).join(' '))
    return true
  }
  const spies = [
    vi.spyOn(console, 'log').mockImplementation(record),
    vi.spyOn(console, 'info').mockImplementation(record),
    vi.spyOn(console, 'warn').mockImplementation(record),
    vi.spyOn(console, 'error').mockImplementation(record),
    vi.spyOn(console, 'debug').mockImplementation(record),
    vi.spyOn(process.stdout, 'write').mockImplementation(record as never),
    vi.spyOn(process.stderr, 'write').mockImplementation(record as never)
  ]
  try {
    await fn()
  } finally {
    spies.forEach((s) => s.mockRestore())
  }
  return captured.join('\n')
}

describe('no secret leakage', () => {
  it('writes only base64 ciphertext to secrets.enc, never the plaintext canary', () => {
    secretStore.set('ai-api-key', CANARY)
    const bytes = readFileSync(join(state.dir, 'secrets.enc'))
    expect(bytes.includes(CANARY)).toBe(false)

    // The stored value must be present, and it must be encoded (not the plaintext).
    const parsed = JSON.parse(bytes.toString('utf8')) as Record<string, string>
    expect(typeof parsed['ai-api-key']).toBe('string')
    expect(parsed['ai-api-key']).not.toBe(CANARY)
    // Round trip still works, proving the ciphertext is valid.
    expect(secretStore.get('ai-api-key')).toBe(CANARY)
  })

  it('never writes the canary into the SQLite database', () => {
    const dbPath = join(state.dir, 'app.db')
    const db = new Database(dbPath)
    db.pragma('journal_mode = WAL')
    migrate(db)
    // A benign, non-secret setting is written; the secret must never land in app.db.
    db.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?)').run('last-folder', '/bills')
    secretStore.set('ai-api-key', CANARY)
    db.close()

    const dbBytes = readFileSync(dbPath)
    expect(dbBytes.includes(CANARY)).toBe(false)
  })

  it('never logs the canary plaintext to stdout, stderr, or console', () => {
    const captured: string[] = []
    const record = (...args: unknown[]): boolean => {
      captured.push(args.map(String).join(' '))
      return true
    }
    const spies = [
      vi.spyOn(console, 'log').mockImplementation(record),
      vi.spyOn(console, 'info').mockImplementation(record),
      vi.spyOn(console, 'warn').mockImplementation(record),
      vi.spyOn(console, 'error').mockImplementation(record),
      vi.spyOn(console, 'debug').mockImplementation(record),
      vi.spyOn(process.stdout, 'write').mockImplementation(record as never),
      vi.spyOn(process.stderr, 'write').mockImplementation(record as never)
    ]

    try {
      secretStore.set('ai-api-key', CANARY)
      secretStore.get('ai-api-key')
      secretStore.delete('ai-api-key')
    } finally {
      spies.forEach((s) => s.mockRestore())
    }

    expect(captured.join('\n')).not.toContain(CANARY)
  })
})

// ---------------------------------------------------------------------------
// Plan 03-02: the same three surfaces, for BOTH AI credentials (AI-01, D-05, T-03-01)
// ---------------------------------------------------------------------------

describe('AI credentials never leak', () => {
  it('keeps the API key and the base URL out of secrets.enc plaintext', () => {
    secretStore.set(AI_API_KEY_SECRET, AI_KEY_CANARY)
    secretStore.set(AI_BASE_URL_SECRET, AI_BASE_URL_CANARY)

    const bytes = readFileSync(join(state.dir, 'secrets.enc'))
    expect(bytes.includes(AI_KEY_CANARY)).toBe(false)
    expect(bytes.includes(AI_BASE_URL_HOST_CANARY)).toBe(false)

    // Both are genuinely stored (encoded), so the absence above is not a vacuous pass.
    const parsed = JSON.parse(bytes.toString('utf8')) as Record<string, string>
    expect(parsed[AI_API_KEY_SECRET]).not.toBe(AI_KEY_CANARY)
    expect(parsed[AI_BASE_URL_SECRET]).not.toBe(AI_BASE_URL_CANARY)
    expect(secretStore.get(AI_API_KEY_SECRET)).toBe(AI_KEY_CANARY)
    expect(secretStore.get(AI_BASE_URL_SECRET)).toBe(AI_BASE_URL_CANARY)
  })

  it('keeps both AI credentials out of app.db, even while the model id is written there', () => {
    const dbPath = join(state.dir, 'ai-app.db')
    const db = new Database(dbPath)
    db.pragma('journal_mode = WAL')
    migrate(db)

    secretStore.set(AI_API_KEY_SECRET, AI_KEY_CANARY)
    secretStore.set(AI_BASE_URL_SECRET, AI_BASE_URL_CANARY)
    // The ONE piece of AI config that is allowed in SQLite: the non-secret selected model id.
    setSelectedModel('openai/gpt-4o-2024-11-20', { db })
    db.close()

    const dbBytes = readFileSync(dbPath)
    expect(dbBytes.includes('openai/gpt-4o-2024-11-20')).toBe(true) // the legitimate write landed
    expect(dbBytes.includes(AI_KEY_CANARY)).toBe(false)
    expect(dbBytes.includes(AI_BASE_URL_HOST_CANARY)).toBe(false)
  })

  it('never logs either credential while building the client and listing models', async () => {
    secretStore.set(AI_API_KEY_SECRET, AI_KEY_CANARY)
    secretStore.set(AI_BASE_URL_SECRET, AI_BASE_URL_CANARY)

    let models: unknown = null
    const captured = await captureOutput(async () => {
      // buildClient reads BOTH credentials main-side — the only place they are ever read.
      const client = buildClient()
      expect(client.baseURL).toBe(AI_BASE_URL_CANARY) // proves the read really happened
      models = await listModels({ client: makeFakeClient({ models: [{ id: 'gpt-4o' }] }) })
    })

    expect(captured).not.toContain(AI_KEY_CANARY)
    expect(captured).not.toContain(AI_BASE_URL_HOST_CANARY)

    // The renderer-bound result carries the model list and nothing else (T-03-01).
    const serialized = JSON.stringify(models)
    expect(serialized).toContain('gpt-4o')
    expect(serialized).not.toContain(AI_KEY_CANARY)
    expect(serialized).not.toContain(AI_BASE_URL_HOST_CANARY)
  })

  it('never logs either credential when the base URL is rejected as insecure', async () => {
    secretStore.set(AI_API_KEY_SECRET, AI_KEY_CANARY)
    secretStore.set(AI_BASE_URL_SECRET, `http://${AI_BASE_URL_HOST_CANARY}/v1`)

    let thrown: unknown = null
    const captured = await captureOutput(() => {
      try {
        buildClient()
      } catch (err) {
        thrown = err
      }
    })

    expect(thrown).toBeInstanceOf(Error)
    expect(String(thrown)).not.toContain(AI_KEY_CANARY)
    expect(String(thrown)).not.toContain(AI_BASE_URL_HOST_CANARY)
    expect(captured).not.toContain(AI_KEY_CANARY)
    expect(captured).not.toContain(AI_BASE_URL_HOST_CANARY)
  })
})
