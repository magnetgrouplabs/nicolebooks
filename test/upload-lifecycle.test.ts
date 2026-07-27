// test/upload-lifecycle.test.ts
//
// start / stop / status for the phone-upload server.
//
// This is the only part of NicoleBooks that opens a listening socket, so the lifecycle assertions
// are really safety assertions: a second start must not leak a second listener, stop must actually
// free the port (server.close() alone does not, because a phone holding the page open holds a
// keep-alive socket), and the staging directory must not survive teardown.
//
// The host is overridden to loopback. Production binds 0.0.0.0 by design, but a test suite that
// did the same would pop a Windows Firewall prompt on the machine running it.

import { existsSync } from 'node:fs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))

import {
  IDLE_TIMEOUT_MS,
  getUploadStatus,
  startUploadServer,
  stopUploadServer
} from '../src/main/upload/server'

let inbox: string

const LOCAL = { host: '127.0.0.1', advertiseAddress: '127.0.0.1' } as const

beforeEach(() => {
  inbox = mkdtempSync(join(tmpdir(), 'nb-inbox-'))
})

afterEach(async () => {
  await stopUploadServer().catch(() => {})
  rmSync(inbox, { recursive: true, force: true })
})

describe('status before anything starts', () => {
  it('reports not running, with no URL to leak', async () => {
    expect(getUploadStatus()).toEqual({ running: false, url: null, receivedCount: 0 })
  })

  it('stopping when nothing is running is a no-op, not an error', async () => {
    // The idle timer, the Done button, and the quit hook all call this, and none of them knows
    // about the others.
    await expect(stopUploadServer()).resolves.toEqual({ stopped: false })
  })
})

describe('start', () => {
  it('returns a reachable URL and a self-contained QR image', async () => {
    const started = await startUploadServer({ ...LOCAL, inboxPath: inbox })
    expect(started.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/u\/[A-Za-z0-9_-]+\/$/)
    // A data: URI, so the renderer fetches nothing to draw it.
    expect(started.qrDataUrl.startsWith('data:image/png;base64,')).toBe(true)
    expect(started.qrDataUrl.length).toBeGreaterThan(500)
  })

  it('serves the upload page at the URL it handed back', async () => {
    const started = await startUploadServer({ ...LOCAL, inboxPath: inbox })
    const res = await fetch(started.url)
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('Take a photo')
  })

  it('mints a fresh token on every run, so an old URL never reopens the folder', async () => {
    const first = await startUploadServer({ ...LOCAL, inboxPath: inbox })
    await stopUploadServer()
    const second = await startUploadServer({ ...LOCAL, inboxPath: inbox })
    expect(second.url).not.toBe(first.url)

    // ...and the old URL is dead, not merely different.
    await expect(fetch(first.url)).rejects.toThrow()
  })

  it('is idempotent: a second start returns the same URL rather than binding a second port', async () => {
    // The modal can be opened, closed and reopened without leaking listeners, and the URL never
    // changes shape underneath a phone that is mid-upload.
    const first = await startUploadServer({ ...LOCAL, inboxPath: inbox })
    const second = await startUploadServer({ ...LOCAL, inboxPath: inbox })
    expect(second).toEqual(first)
  })

  it('reports running with the live URL', async () => {
    const started = await startUploadServer({ ...LOCAL, inboxPath: inbox })
    expect(getUploadStatus()).toEqual({ running: true, url: started.url, receivedCount: 0 })
  })
})

describe('received count and broadcast', () => {
  it('counts every file and forwards the names exactly once', async () => {
    const seen: string[][] = []
    const started = await startUploadServer({
      ...LOCAL,
      inboxPath: inbox,
      onReceived: (filenames) => seen.push(filenames)
    })

    const form = new FormData()
    form.append('files', new File([new Uint8Array(8)], 'a.pdf', { type: 'application/pdf' }))
    form.append('files', new File([new Uint8Array(8)], 'b.jpg', { type: 'image/jpeg' }))
    const res = await fetch(`${started.url}upload`, { method: 'POST', body: form })

    expect(res.status).toBe(200)
    expect(seen).toHaveLength(1)
    expect(seen[0].sort()).toEqual(['a.pdf', 'b.jpg'])
    expect(getUploadStatus().receivedCount).toBe(2)
  })
})

describe('stop', () => {
  it('frees the port, so the URL stops answering', async () => {
    const started = await startUploadServer({ ...LOCAL, inboxPath: inbox })
    // Hold a keep-alive socket open, which is what a phone with the page loaded does. Without
    // closeAllConnections() the close below would hang until that socket idled out.
    await fetch(started.url)
    await expect(stopUploadServer()).resolves.toEqual({ stopped: true })
    expect(getUploadStatus()).toEqual({ running: false, url: null, receivedCount: 0 })
    await expect(fetch(started.url)).rejects.toThrow()
  })

  it('removes the staging directory it created', async () => {
    await startUploadServer({ ...LOCAL, inboxPath: inbox })
    const before = stagingDirs()
    expect(before.length).toBeGreaterThan(0)
    await stopUploadServer()
    for (const dir of before) expect(existsSync(dir)).toBe(false)
  })

  it('is safe to call twice', async () => {
    await startUploadServer({ ...LOCAL, inboxPath: inbox })
    await expect(stopUploadServer()).resolves.toEqual({ stopped: true })
    await expect(stopUploadServer()).resolves.toEqual({ stopped: false })
  })
})

describe('idle shutdown', () => {
  it('stops itself after the idle window with no requests', async () => {
    await startUploadServer({ ...LOCAL, inboxPath: inbox, idleMs: 40 })
    expect(getUploadStatus().running).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 160))
    expect(getUploadStatus().running).toBe(false)
  })

  it('a request from the phone pushes the deadline back', async () => {
    const started = await startUploadServer({ ...LOCAL, inboxPath: inbox, idleMs: 200 })
    for (let i = 0; i < 3; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 90))
      await fetch(started.url)
    }
    // Well past 200ms of wall clock, but never 200ms without traffic.
    expect(getUploadStatus().running).toBe(true)
  })

  it('ships a 15 minute window', () => {
    expect(IDLE_TIMEOUT_MS).toBe(15 * 60 * 1000)
  })
})

/** The staging directories this process created under the OS temp folder. */
function stagingDirs(): string[] {
  const { readdirSync } = require('node:fs') as typeof import('node:fs')
  return readdirSync(tmpdir())
    .filter((name) => name.startsWith('nicolebooks-upload-'))
    .map((name) => join(tmpdir(), name))
}
