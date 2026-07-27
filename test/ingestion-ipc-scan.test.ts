// test/ingestion-ipc-scan.test.ts
//
// Regression pin for the Phase 2 defect where ingestion:scan ALWAYS rejected: the handler ran
// ScanRequestSchema.parse(raw) against a strict-empty schema, but the preload invokes the channel
// with no argument, so raw was undefined and z.object({}).strict().parse(undefined) threw
// 'expected object, received undefined'. The Bills screen "Scan now" button could never succeed.
// Phase 2 shipped green because no spec ever INVOKED the channel — e2e/ipc-boundary.spec.ts only
// asserted `scan` was present on the bridge, which a permanently-rejecting handler passes.
//
// This is the ONLY layer where the reject half of the gate is reachable. src/preload/index.ts:40
// is zero-arity (`scan: () => ipcRenderer.invoke(Channels.ingestionScan)`) and silently discards
// any caller argument, so a renderer-level `window.api.ingestion.scan({...})` RESOLVES — the
// payload never crosses the bridge. Asserting the reject half from e2e would be a false failure
// that tempts someone to "fix" it by weakening the schema. The resolve half is proven end-to-end
// in e2e/ingestion-scan.spec.ts; the reject half lives here, against the main-process handler.
//
// The runScan-not-called assertion is what makes the strict gate un-removable: deleting the parse
// would make the smuggled call both resolve AND reach privileged fs work, turning two tests red
// (threat T-02-02, path injection).
//
// electron is mocked so ipcMain.handle registrations are captured instead of touching a real IPC
// bus; trusted-sender is a no-op so this targets the PAYLOAD gate rather than the sender gate
// (e2e/ipc-boundary.spec.ts already covers the latter); scan + inbox are mocked so no fs, sqlite,
// or PowerShell attribute read runs in the unit suite, and so runScan is a spy.

import { beforeEach, describe, expect, it, vi } from 'vitest'

type Handler = (event: unknown, raw?: unknown) => unknown

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, raw?: unknown) => unknown>(),
  runScan: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: Handler): void => {
      mocks.handlers.set(channel, fn)
    }
  },
  // ingestion.ts imports both at module load for the choose-inbox handler; never exercised here.
  dialog: { showOpenDialog: vi.fn() },
  BrowserWindow: { fromWebContents: () => null }
}))

vi.mock('../src/main/ipc/trusted-sender', () => ({
  assertTrustedSender: (): void => {}
}))

vi.mock('../src/main/ingestion/scan', () => ({ runScan: mocks.runScan }))

vi.mock('../src/main/ingestion/inbox', () => ({
  resolveInboxPath: () => ({ path: '/tmp/nb-inbox', created: false }),
  persistInboxPath: (): void => {}
}))

import { registerIngestionIpc } from '../src/main/ipc/ingestion'
import { Channels, type ScanResult } from '../src/shared/ipc-contract'

/** Distinctive value returned by the runScan spy, so a resolve is provably the handler's result. */
const SENTINEL: ScanResult = {
  batchEntryDate: '2026-07-27',
  inboxPath: '/tmp/nb-inbox',
  files: [{ filename: 'bill.pdf', status: 'loaded', hash: 'a'.repeat(64), sizeBytes: 12 }],
  summary: { total: 1, loaded: 1, duplicates: 0, notReady: 0, unsupported: 0 }
}

registerIngestionIpc()

const scanHandler = mocks.handlers.get(Channels.ingestionScan) as (
  event: unknown,
  raw?: unknown
) => Promise<ScanResult>

// The sender gate is mocked out, so the event only needs to be a value.
const FAKE_EVENT = { sender: {} } as never

beforeEach(() => {
  mocks.runScan.mockReset()
  mocks.runScan.mockResolvedValue(SENTINEL)
})

describe('ingestion:scan payload gate', () => {
  it('registers a handler on the ingestion:scan channel', () => {
    expect(typeof scanHandler).toBe('function')
  })

  it('resolves when invoked with undefined, which is what the zero-arity preload sends', async () => {
    await expect(scanHandler(FAKE_EVENT, undefined)).resolves.toEqual(SENTINEL)
    expect(mocks.runScan).toHaveBeenCalledTimes(1)
  })

  it('resolves when invoked with an explicit empty object', async () => {
    await expect(scanHandler(FAKE_EVENT, {})).resolves.toEqual(SENTINEL)
    expect(mocks.runScan).toHaveBeenCalledTimes(1)
  })

  it('rejects a smuggled non-empty payload', async () => {
    await expect(scanHandler(FAKE_EVENT, { inboxPath: 'C:\\Windows' })).rejects.toThrow()
  })

  it('does not reach runScan when a smuggled payload is rejected (T-02-02)', async () => {
    await expect(scanHandler(FAKE_EVENT, { inboxPath: 'C:\\Windows' })).rejects.toThrow()
    // The gate fires BEFORE any privileged fs/db work. If the parse were ever deleted, this
    // assertion and the one above both go red.
    expect(mocks.runScan).not.toHaveBeenCalled()
  })
})
