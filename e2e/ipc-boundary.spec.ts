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
//   2. window.api exposes ONLY the named groups (settings, secrets, theme, ingestion, ai, parse)
//      and, within each, only named methods — never ipcRenderer or a generic invoke.
//   3. An over-long key rejects at the main handler (Zod bound: key max 128), so the invoke rejects.
//   4. The Phase 3 parse channels are genuinely INVOCABLE from the renderer, not merely present on
//      the bridge. Asserting a method exists is what let ingestion:scan ship permanently-rejecting
//      for a whole phase (quick task 260727-fb9), so parse:parse-batch is actually called here and
//      its Zod bound is actually tripped.

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

    // 2. window.api exposes exactly the named channel groups, nothing more.
    const apiShape = await window.evaluate(() => ({
      top: Object.keys(window.api).sort(),
      settings: Object.keys(window.api.settings).sort(),
      secrets: Object.keys(window.api.secrets).sort(),
      theme: Object.keys(window.api.theme).sort(),
      ingestion: Object.keys(window.api.ingestion).sort(),
      ai: Object.keys(window.api.ai).sort(),
      parse: Object.keys(window.api.parse).sort(),
      qbo: Object.keys(window.api.qbo).sort(),
      recon: Object.keys(window.api.recon).sort(),
      posting: Object.keys(window.api.posting).sort(),
      upload: Object.keys(window.api.upload).sort()
    }))
    expect(apiShape.top).toEqual([
      'ai',
      'ingestion',
      'parse',
      'posting',
      'qbo',
      'recon',
      'secrets',
      'settings',
      'theme',
      'upload'
    ])
    expect(apiShape.settings).toEqual(['get', 'set'])
    expect(apiShape.secrets).toEqual(['delete', 'get', 'set'])
    expect(apiShape.theme).toEqual(['get', 'onChange'])
    expect(apiShape.ingestion).toEqual(['chooseInbox', 'pickFiles', 'resolveInbox', 'scan'])
    // Phase 3 (plan 03-01): the ai + parse groups are named methods only — no generic invoke.
    expect(apiShape.ai).toEqual(['listModels', 'setModel', 'testConnection'])
    expect(apiShape.parse).toEqual(['onProgress', 'parseBatch', 'reparse'])
    // Finish sprint (SEAMS): the four new groups are likewise named methods only. Handler bodies
    // land later; the bridge surface is pinned here so a downstream agent cannot widen it into a
    // generic invoke, and so a group that quietly loses a method fails at merge.
    // setEnvironment is PROD-MODE's one added method: sandbox or live company. It is named, like
    // every other method here, and it takes a two-value enum rather than a URL.
    expect(apiShape.qbo).toEqual([
      'connect',
      'disconnect',
      'getReference',
      'onStatusChanged',
      'setEnvironment',
      'status',
      'syncReference'
    ])
    expect(apiShape.recon).toEqual(['match'])
    // checkDuplicates is REVIEW-UI's one added method: a read-only prior-entry lookup for the
    // review grid. It is named, like every other method here, so the group is still not a
    // generic invoke.
    expect(apiShape.posting).toEqual([
      'batchDetail',
      'batches',
      'checkDuplicates',
      'onProgress',
      'send',
      'summary',
      'undoLast'
    ])
    expect(apiShape.upload).toEqual(['onReceived', 'start', 'status', 'stop'])

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

    // 4. The parse channels actually work end to end across the boundary (plan 03-07). An empty
    //    batch is the cheapest honest invocation: the handler is registered, the payload schema
    //    accepts the real call, and the pipeline returns its zero summary without touching the
    //    inbox or the model.
    const parseBatchResult = await window.evaluate(async () => {
      try {
        return { ok: true as const, value: await window.api.parse.parseBatch([]) }
      } catch (error) {
        return { ok: false as const, message: String(error) }
      }
    })
    expect(parseBatchResult.ok).toBe(true)
    expect(parseBatchResult.ok && parseBatchResult.value).toEqual({
      files: [],
      summary: { total: 0, parsed: 0, failed: 0, cached: 0 }
    })

    // ...and the Zod bounds on those channels really gate: a hash that is not 64 hex chars can
    // never become a parsed_results key, and a bad reparse hash never reaches the filesystem.
    const parseRejections = await window.evaluate(async () => {
      const rejects = async (run: () => Promise<unknown>): Promise<boolean> => {
        try {
          await run()
          return false
        } catch {
          return true
        }
      }
      return {
        shortHash: await rejects(() =>
          window.api.parse.parseBatch([
            { filename: 'bill.pdf', hash: 'too-short', batchEntryDate: '2026-07-27' }
          ])
        ),
        badReparse: await rejects(() => window.api.parse.reparse('not-a-sha256'))
      }
    })
    expect(parseRejections.shortHash).toBe(true)
    expect(parseRejections.badReparse).toBe(true)

    // The progress subscription hands back a disposer, exactly like theme.onChange.
    const disposerType = await window.evaluate(() => typeof window.api.parse.onProgress(() => {}))
    expect(disposerType).toBe('function')
  } finally {
    await app.close()
  }

  rmSync(userDataDir, { recursive: true, force: true })
})
