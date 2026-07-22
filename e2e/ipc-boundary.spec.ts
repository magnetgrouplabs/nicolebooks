import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect } from '@playwright/test'
import { MAIN_ENTRY, _electron as electron } from '../playwright.config'

// SC4 renderer isolation, proven on the running app from the renderer's own context. The renderer
// is untrusted: with contextIsolation + sandbox + nodeIntegration:false it must have NO reach to
// Node, fs, the database, the keychain, or the network except through the narrow window.api bridge,
// and every privileged handler must reject a malformed payload before acting (threats T-01-02 /
// T-01-03). This spec asserts:
//   1. window.require / window.process / window.module and a bare ipcRenderer are all undefined.
//   2. window.api exposes ONLY the three named groups (settings, secrets, theme) and nothing else.
//   3. An over-long key rejects at the main handler (Zod bound: key max 128), so the invoke rejects.

test('the renderer is isolated: no Node reach, only window.api, malformed payloads reject', async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), 'nb-e2e-ipc-'))
  const app = await electron.launch({ args: [MAIN_ENTRY, `--user-data-dir=${userDataDir}`] })

  try {
    const window = await app.firstWindow()
    await window.waitForLoadState('domcontentloaded')
    // window.api is exposed by the sandbox-safe preload before the document scripts run.
    await window.waitForFunction(() => typeof window.api !== 'undefined')

    // 1. No Node / Electron internals leak into the renderer main world.
    const leaks = await window.evaluate(() => ({
      hasRequire: typeof (window as unknown as { require?: unknown }).require !== 'undefined',
      hasProcess: typeof (window as unknown as { process?: unknown }).process !== 'undefined',
      hasModule: typeof (window as unknown as { module?: unknown }).module !== 'undefined',
      hasIpcRenderer: typeof (window as unknown as { ipcRenderer?: unknown }).ipcRenderer !== 'undefined'
    }))
    expect(leaks.hasRequire).toBe(false)
    expect(leaks.hasProcess).toBe(false)
    expect(leaks.hasModule).toBe(false)
    expect(leaks.hasIpcRenderer).toBe(false)

    // 2. window.api exposes exactly the three named channel groups, nothing more.
    const apiShape = await window.evaluate(() => ({
      top: Object.keys(window.api).sort(),
      settings: Object.keys(window.api.settings).sort(),
      secrets: Object.keys(window.api.secrets).sort(),
      theme: Object.keys(window.api.theme).sort()
    }))
    expect(apiShape.top).toEqual(['secrets', 'settings', 'theme'])
    expect(apiShape.settings).toEqual(['get', 'set'])
    expect(apiShape.secrets).toEqual(['delete', 'get', 'set'])
    expect(apiShape.theme).toEqual(['get', 'onChange'])

    // 3. A malformed payload (key far over the 128-char bound) is rejected by the main handler,
    //    so the invoke rejects in the renderer rather than performing any privileged action.
    const rejected = await window.evaluate(async () => {
      try {
        await window.api.secrets.set('k'.repeat(200), 'value')
        return false
      } catch {
        return true
      }
    })
    expect(rejected).toBe(true)
  } finally {
    await app.close()
  }

  rmSync(userDataDir, { recursive: true, force: true })
})
