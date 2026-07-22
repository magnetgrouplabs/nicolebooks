// src/main/secrets/secret-store.ts
//
// safeStorage-backed secret store (RESEARCH Pattern 3, decisions D-10/D-12, threats
// T-01-04 and T-01-05).
//
// Secrets are encrypted by the OS keychain (macOS Keychain / Windows DPAPI, via Electron
// safeStorage) and the base64 ciphertext is written to a single owner-only file at
// app.getPath('userData')/secrets.enc. NO secret material, not even OS-encrypted
// ciphertext, is ever written to the SQLite database (D-12): this module imports neither
// the SQLite driver nor the db connection module, and the local database is never touched
// here. Secret values are never logged (T-01-05); the no-secret-leak test asserts a canary
// never appears in secrets.enc as plaintext, in the SQLite file, or in captured logs.
//
// safeStorage must be used after the app 'ready' event; when the backend is unavailable
// (isEncryptionAvailable() is false) set() throws SECRET_STORE_UNAVAILABLE rather than
// silently writing a plaintext fallback. Every later secret (Phase 3 AI key, Phase 4
// QuickBooks tokens) flows through this exact service.

import { app, safeStorage } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Absolute path to the ciphertext file under the per-user app-data directory. */
const FILE = (): string => join(app.getPath('userData'), 'secrets.enc')

/** On-disk shape: { [key]: base64(ciphertext) }. Only ever holds encrypted blobs. */
function readAll(): Record<string, string> {
  const file = FILE()
  if (!existsSync(file)) return {}
  return JSON.parse(readFileSync(file, 'utf8')) as Record<string, string>
}

function writeAll(map: Record<string, string>): void {
  // mode 0o600: owner read/write only, so no other local user can read the ciphertext file
  // (threat T-01-04). On Windows the POSIX mode mapping is coarse, but DPAPI already scopes
  // the ciphertext to the current user, so confidentiality does not depend on this mode there.
  writeFileSync(FILE(), JSON.stringify(map), { mode: 0o600 })
}

export const secretStore = {
  /** True when the OS keychain backend is ready. Call after the app 'ready' event. */
  available(): boolean {
    return safeStorage.isEncryptionAvailable()
  },

  /** Encrypt value and persist its base64 ciphertext. Throws when encryption is unavailable. */
  set(key: string, value: string): void {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('SECRET_STORE_UNAVAILABLE')
    }
    const map = readAll()
    map[key] = safeStorage.encryptString(value).toString('base64')
    writeAll(map)
  },

  /** Decrypt and return the value for key, or null when the key is absent. */
  get(key: string): string | null {
    const raw = readAll()[key]
    if (!raw) return null
    return safeStorage.decryptString(Buffer.from(raw, 'base64'))
  },

  /** Remove key from the store. A subsequent get returns null. */
  delete(key: string): void {
    const map = readAll()
    delete map[key]
    writeAll(map)
  }
}
