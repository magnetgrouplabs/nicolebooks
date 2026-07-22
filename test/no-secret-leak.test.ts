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

import { afterAll, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { migrate } from '../src/main/db/migrate'

const CANARY = 'CANARY-NEVER-LEAK-4f3a9b2e17'

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

afterAll(() => {
  vi.restoreAllMocks()
})

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
