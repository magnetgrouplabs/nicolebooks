// src/main/upload/server.ts
//
// Lifecycle for the phone-upload server: start, stop, status, and the two things that guarantee it
// does not outlive its usefulness.
//
// WHY A LIFECYCLE MODULE AT ALL. This is the only part of NicoleBooks that opens a listening socket
// on a network interface. A listener that is easy to start and easy to forget is a listener that
// runs for weeks. Two independent shutdowns close that off: a 15 minute idle timer, and the app's
// own quit (wired up in src/main/ipc/upload.ts, which owns the electron dependency). Both call the
// same stop path, so there is exactly one teardown to reason about.
//
// EVERY RUN GETS A FRESH TOKEN. It is 24 random bytes rather than a uuid, and it is regenerated on
// each start, so a URL someone glanced at last week does not open a folder today. The URL is the
// whole credential, which is why it only ever exists while the modal that shows it is open.
//
// THE PORT IS EPHEMERAL (bind to 0). Pinning a port would make the feature discoverable by scanning
// a well-known number and would collide with whatever else the machine is running.
//
// Nothing here logs, in line with the other main-side modules: the URL is a bearer credential and a
// log line is the easiest place for one to be read out of.

import { randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { toDataURL } from 'qrcode'
import type { UploadStartResult, UploadStatusResult, UploadStopResult } from '../../shared/ipc-contract'
import { resolveInboxPath } from '../ingestion/inbox'
import { createUploadApp } from './app'
import { bestLanAddress } from './lan-address'

/** Opaque failure codes. src/main/ipc/upload.ts maps these to copy; they never reach the renderer. */
export const UPLOAD_START_FAILED = 'UPLOAD_START_FAILED'
export const UPLOAD_STOP_FAILED = 'UPLOAD_STOP_FAILED'

/** Auto-stop after this long with no request from the phone. */
export const IDLE_TIMEOUT_MS = 15 * 60 * 1000

/** Everything one running instance owns, so teardown is a single object to release. */
interface RunningServer {
  server: Server
  url: string
  qrDataUrl: string
  stagingDir: string
  receivedCount: number
  idleTimer: NodeJS.Timeout | null
  idleMs: number
}

let current: RunningServer | null = null

/** Injectable so a spec can bind loopback with a short idle window instead of the real LAN. */
export interface StartUploadOptions {
  inboxPath?: string
  onReceived?: (filenames: string[]) => void
  /** Interface to bind. Defaults to 0.0.0.0 because the point is to be reachable from the phone. */
  host?: string
  /** Address printed in the URL. Defaults to the ranked LAN pick. */
  advertiseAddress?: string
  idleMs?: number
}

function clearIdle(instance: RunningServer): void {
  if (instance.idleTimer) clearTimeout(instance.idleTimer)
  instance.idleTimer = null
}

/**
 * (Re)arm the idle shutdown. unref() matters: a ref'd timer of this length would be one more thing
 * holding the event loop open during a quit that is trying to be quick.
 */
function armIdle(instance: RunningServer): void {
  clearIdle(instance)
  instance.idleTimer = setTimeout(() => {
    void stopUploadServer()
  }, instance.idleMs)
  instance.idleTimer.unref?.()
}

/** Promisified listen, so a bind failure (port taken, interface gone) rejects rather than emits. */
function listen(server: Server, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error): void => {
      server.removeListener('listening', onListening)
      reject(err)
    }
    const onListening = (): void => {
      server.removeListener('error', onError)
      const address = server.address()
      if (address === null || typeof address === 'string') {
        reject(new Error(UPLOAD_START_FAILED))
        return
      }
      resolve(address.port)
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(0, host)
  })
}

/**
 * Start the server and return the pairing URL plus its QR code.
 *
 * Idempotent: a second call while one is running returns the SAME url and QR rather than binding a
 * second port. The modal can be opened, closed, and reopened without leaking listeners, and the
 * user never sees the pairing URL change shape underneath a phone that is mid-upload.
 */
export async function startUploadServer(options: StartUploadOptions = {}): Promise<UploadStartResult> {
  if (current) return { url: current.url, qrDataUrl: current.qrDataUrl }

  const idleMs = options.idleMs ?? IDLE_TIMEOUT_MS
  let stagingDir: string | null = null
  let server: Server | null = null

  try {
    // Resolved main-side. Neither the renderer nor the phone ever names a path (T-02-02).
    const inboxPath = options.inboxPath ?? resolveInboxPath().path
    stagingDir = await mkdtemp(join(tmpdir(), 'nicolebooks-upload-'))

    // base64url keeps the token safe to drop straight into a path segment with no escaping.
    const token = randomBytes(24).toString('base64url')

    const app = createUploadApp({
      token,
      inboxPath,
      stagingDir,
      onReceived: (filenames) => {
        if (current) current.receivedCount += filenames.length
        options.onReceived?.(filenames)
      },
      onActivity: () => {
        if (current) armIdle(current)
      }
    })

    server = createServer(app)
    const port = await listen(server, options.host ?? '0.0.0.0')
    const url = `http://${options.advertiseAddress ?? bestLanAddress()}:${port}/u/${token}/`

    // Crimson on white, sized for a phone camera at arm's length. Medium correction tolerates a
    // little glare on a laptop screen without inflating the module count.
    const qrDataUrl = await toDataURL(url, {
      errorCorrectionLevel: 'M',
      margin: 2,
      width: 320,
      color: { dark: '#910023ff', light: '#ffffffff' }
    })

    current = { server, url, qrDataUrl, stagingDir, receivedCount: 0, idleTimer: null, idleMs }
    armIdle(current)
    return { url, qrDataUrl }
  } catch {
    // Partial start: release whatever was acquired before the failure, so a retry starts clean.
    if (server) server.close()
    if (stagingDir) await rm(stagingDir, { recursive: true, force: true }).catch(() => {})
    throw new Error(UPLOAD_START_FAILED)
  }
}

/**
 * Stop the server and remove its staging directory. Safe to call when nothing is running (returns
 * stopped: false), which is what makes it usable from the quit hook, the idle timer, and the Done
 * button without any of the three needing to know about the others.
 *
 * closeAllConnections() is not optional here: server.close() alone waits for keep-alive sockets to
 * go idle, and a phone that has the page open holds one. Without it, "Done" would leave the port
 * bound for up to another two minutes.
 */
export async function stopUploadServer(): Promise<UploadStopResult> {
  const instance = current
  if (!instance) return { stopped: false }
  current = null
  clearIdle(instance)

  try {
    instance.server.closeAllConnections()
    await new Promise<void>((resolve) => instance.server.close(() => resolve()))
    await rm(instance.stagingDir, { recursive: true, force: true }).catch(() => {})
    return { stopped: true }
  } catch {
    throw new Error(UPLOAD_STOP_FAILED)
  }
}

/** Current state for the Bills screen. url is null while nothing is running. */
export function getUploadStatus(): UploadStatusResult {
  if (!current) return { running: false, url: null, receivedCount: 0 }
  return { running: true, url: current.url, receivedCount: current.receivedCount }
}
