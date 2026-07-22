import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect } from '@playwright/test'
import { MAIN_ENTRY, _electron as electron } from '../playwright.config'

// SC2 end-to-end: the real renderer -> window.api -> IPC -> main -> OS keychain round trip,
// observed from OUTSIDE the app. This proves two controls on the running build:
//   1. The Settings health indicator resolves to "Secret store: OK" only when a canary stored
//      through the keychain reads back byte-for-byte (the live round trip, threat T-01-04).
//   2. secrets.enc under userData holds base64 ciphertext, NEVER the plaintext canary, and the
//      plaintext canary is absent from app.db (the no-leak control, threats T-01-04 / T-01-05).
//
// A distinctive canary (not the app's short internal "ok") is driven through window.api.secrets
// so the plaintext byte-scan of secrets.enc and app.db is unambiguous. Each run uses a fresh
// temp userData via the Electron --user-data-dir switch, and the on-disk files are inspected
// after the app closes so there is no open-handle contention.

// Distinctive, high-entropy so a plaintext byte match in any file is meaningful (not coincidence).
const ROUNDTRIP_CANARY = 'E2E-ROUNDTRIP-CANARY-9c1f7ae0d3b64'
const CANARY_KEY = 'e2e_roundtrip_canary'

test('secret round trip lands ciphertext in secrets.enc and no plaintext in app.db', async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), 'nb-e2e-secret-'))
  const app = await electron.launch({ args: [MAIN_ENTRY, `--user-data-dir=${userDataDir}`] })

  let userData: string
  try {
    // The real userData the main process resolved (honors --user-data-dir); used to locate the files.
    userData = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'))

    const window = await app.firstWindow()
    await window.waitForLoadState('domcontentloaded')

    // Navigate to Settings so the permanent HealthIndicator mounts and performs its live round trip.
    await window.getByRole('button', { name: 'Settings' }).click()

    // The healthy state renders ONLY on an exact canary round trip through the keychain.
    await expect(window.getByText('Secret store: OK')).toBeVisible({ timeout: 15_000 })

    // Drive a distinctive canary through the same public bridge and confirm it reads back exactly.
    const readBack = await window.evaluate(
      async ({ key, value }) => {
        await window.api.secrets.set(key, value)
        return window.api.secrets.get(key)
      },
      { key: CANARY_KEY, value: ROUNDTRIP_CANARY }
    )
    expect(readBack).toBe(ROUNDTRIP_CANARY)
  } finally {
    // Close the app before reading the files so there is no open-handle contention on Windows.
    await app.close()
  }

  // secrets.enc must exist and hold base64 ciphertext for our key, never the plaintext canary.
  const secretsFile = join(userData, 'secrets.enc')
  expect(existsSync(secretsFile)).toBe(true)

  const secretsRaw = readFileSync(secretsFile, 'utf8')
  expect(secretsRaw.includes(ROUNDTRIP_CANARY)).toBe(false)

  const parsed = JSON.parse(secretsRaw) as Record<string, string>
  const stored = parsed[CANARY_KEY]
  expect(typeof stored).toBe('string')
  expect(stored).not.toBe(ROUNDTRIP_CANARY)
  // Stored value is base64 ciphertext (safeStorage.encryptString -> base64), not readable plaintext.
  expect(stored).toMatch(/^[A-Za-z0-9+/]+={0,2}$/)

  // The canary must never appear in the SQLite database (secrets never touch app.db, D-12).
  const dbFile = join(userData, 'app.db')
  expect(existsSync(dbFile)).toBe(true)
  const dbBytes = readFileSync(dbFile)
  expect(dbBytes.includes(ROUNDTRIP_CANARY)).toBe(false)

  rmSync(userDataDir, { recursive: true, force: true })
})
