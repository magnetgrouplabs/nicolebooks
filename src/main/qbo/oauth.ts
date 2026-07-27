// src/main/qbo/oauth.ts
//
// The authorization-code flow for a desktop app: build the consent URL, open it in the user's real
// browser, and catch Intuit's redirect on a short-lived loopback HTTP server.
//
// WHY THE SYSTEM BROWSER AND NOT AN EMBEDDED WINDOW. An in-app BrowserWindow pointed at Intuit
// would be a window this app can read the DOM of, which is exactly the pattern that makes an
// embedded OAuth screen indistinguishable from a credential harvester. It also loses the user's
// existing QuickBooks session, their password manager, and their MFA device flow. shell.openExternal
// hands the whole sign in to a browser this app cannot see into.
//
// WHY A LOOPBACK SERVER. Intuit redirects to a URL, so something has to receive it.
// http://localhost:8734/oauth/callback is registered character for character in the developer portal
// (see env.ts), the server binds 127.0.0.1 so nothing on the LAN can reach it, and it lives only for
// the duration of one sign in.
//
// THE STATE NONCE IS LOAD BEARING. A loopback listener accepts a request from any local process and
// from any page the browser happens to load. Without the nonce, anything could drive this app into
// exchanging an attacker-supplied authorization code and silently connect it to the ATTACKER's
// QuickBooks company. The nonce is 32 random bytes, generated per attempt, compared with a
// length-safe equality check, and a mismatch aborts the whole flow.
//
// ONE ATTEMPT AT A TIME. Two concurrent connects would race for the same port and the second would
// die with a bind error the user cannot act on, so a second attempt is refused up front with its own
// code.
//
// SECRET BOUNDARY. The authorization code and the tokens exist only inside this flow and are handed
// straight to tokens.ts to be encrypted. Nothing here logs, and every failure is an opaque code from
// ./errors that src/main/ipc/qbo.ts maps to fixed copy: a bind error carries a port, an Intuit error
// carries the client id, and neither is safe to forward.

import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import {
  QBO_LOOPBACK_PATH,
  QBO_LOOPBACK_PORT,
  QBO_REDIRECT_URI,
  QBO_SCOPE,
  qboEnvironment,
  type QboEnvironment
} from './env'
import {
  QBO_AUTH_CANCELED,
  QBO_AUTH_IN_PROGRESS,
  QBO_AUTH_STATE_MISMATCH,
  QBO_AUTH_TIMEOUT,
  QBO_CALLBACK_PORT_BUSY
} from './errors'
import {
  assertSecretStoreAvailable,
  exchangeAuthorizationCode,
  requireClientCredentials,
  writeTokenSet,
  type TokenDeps,
  type TokenSet
} from './tokens'

/** How long the loopback server waits for the user to finish signing in. */
export const OAUTH_TIMEOUT_MS = 5 * 60 * 1000

/** What Intuit sends back on the redirect. */
export interface OAuthCallback {
  code: string
  realmId: string
}

/** Injectable dependencies for the whole connect flow (Shared Pattern B). */
export interface OAuthDeps extends TokenDeps {
  /** Opens the consent URL in the user's browser. Production passes shell.openExternal. */
  openExternal?: (url: string) => Promise<unknown>
  /** Overridable for the unit spec so it can drive a real server on an ephemeral port. */
  port?: number
  timeoutMs?: number
  environment?: QboEnvironment
  redirectUri?: string
  /**
   * Notified with the port that was actually bound, before the browser is opened. Production has no
   * use for it (the port is fixed and registered with Intuit); a spec asking for port 0 needs it to
   * know where to send the simulated redirect.
   */
  onListening?: (port: number) => void
}

/** Generate the per-attempt state nonce. 32 bytes of CSPRNG output, hex encoded. */
export function createStateNonce(): string {
  return randomBytes(32).toString('hex')
}

/**
 * Constant-time state comparison. Overkill for a value that never leaves the machine, but a plain
 * === on a security token is the kind of detail a reviewer should never have to think about twice.
 * Lengths are compared first because timingSafeEqual throws on a length mismatch.
 */
export function stateMatches(expected: string, received: string | null): boolean {
  if (!received || expected.length !== received.length) return false
  return timingSafeEqual(Buffer.from(expected, 'utf8'), Buffer.from(received, 'utf8'))
}

/**
 * Build the Intuit consent URL. Every parameter is set through URLSearchParams, so a value can
 * never break out of its slot.
 */
export function buildAuthorizeUrl(input: {
  clientId: string
  state: string
  redirectUri?: string
  environment?: QboEnvironment
}): string {
  const url = new URL(qboEnvironment(input.environment).authorizeUrl)
  url.searchParams.set('client_id', input.clientId)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('scope', QBO_SCOPE)
  url.searchParams.set('redirect_uri', input.redirectUri ?? QBO_REDIRECT_URI)
  url.searchParams.set('state', input.state)
  return url.toString()
}

/** The page the browser lands on. Plain, brandless, and free of em dashes and en dashes. */
function resultPage(heading: string, detail: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>NicoleBooks</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 0; display: grid; place-items: center;
         min-height: 100vh; background: #f6f6f7; color: #1c1c1e; }
  main { max-width: 28rem; padding: 2rem; text-align: center; }
  h1 { font-size: 1.25rem; margin: 0 0 0.5rem; }
  p { margin: 0; color: #55555c; line-height: 1.5; }
</style></head>
<body><main><h1>${heading}</h1><p>${detail}</p></main></body></html>`
}

function respond(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' })
  res.end(html)
}

/** Module-level guard: only one sign in may hold the loopback port at a time. */
let callbackInFlight = false

/**
 * Bind the loopback server, wait for Intuit's redirect, and resolve with the code and realm id.
 *
 * Resolves at most once and always closes the server, including on timeout, on a state mismatch,
 * and on a bind failure. A leaked listener would make the NEXT connect attempt fail with a port
 * conflict the user has no way to clear short of restarting the app.
 */
export async function waitForOAuthCallback(input: {
  expectedState: string
  port?: number
  path?: string
  timeoutMs?: number
  /**
   * Called once the socket is actually listening, with the port that was ACTUALLY bound. Passing
   * the real port rather than the requested one lets a spec ask for port 0 and still address the
   * server, and in production the two are identical because the port is fixed.
   */
  onListening?: (port: number) => void | Promise<void>
}): Promise<OAuthCallback> {
  if (callbackInFlight) throw new Error(QBO_AUTH_IN_PROGRESS)
  callbackInFlight = true

  const port = input.port ?? QBO_LOOPBACK_PORT
  const path = input.path ?? QBO_LOOPBACK_PATH
  const timeoutMs = input.timeoutMs ?? OAUTH_TIMEOUT_MS

  let server: Server | null = null
  let timer: NodeJS.Timeout | null = null

  try {
    return await new Promise<OAuthCallback>((resolve, reject) => {
      let settled = false

      const finish = (fn: () => void): void => {
        if (settled) return
        settled = true
        fn()
      }

      server = createServer((req: IncomingMessage, res: ServerResponse) => {
        // A bare `new URL(req.url)` throws on a path-only value, so a base is supplied. The host is
        // irrelevant; only the pathname and the query are read.
        let requested: URL
        try {
          requested = new URL(req.url ?? '/', `http://127.0.0.1:${port}`)
        } catch {
          respond(res, 400, resultPage('Sorry, something went wrong.', 'Return to NicoleBooks and try connecting again.'))
          return
        }

        if (requested.pathname !== path) {
          // Anything else hitting this port (a favicon probe, a stray local request) is not the
          // redirect and must not end the wait.
          respond(res, 404, resultPage('Not found.', 'This page is only used while connecting to QuickBooks.'))
          return
        }

        const params = requested.searchParams
        const error = params.get('error')
        const code = params.get('code')
        const realmId = params.get('realmId')

        if (!stateMatches(input.expectedState, params.get('state'))) {
          respond(res, 400, resultPage(
            'That sign in could not be verified.',
            'Return to NicoleBooks and start the connection again.'
          ))
          finish(() => reject(new Error(QBO_AUTH_STATE_MISMATCH)))
          return
        }

        if (error || !code || !realmId) {
          respond(res, 200, resultPage(
            'Connection canceled.',
            'Return to NicoleBooks if you would like to try again.'
          ))
          finish(() => reject(new Error(QBO_AUTH_CANCELED)))
          return
        }

        respond(res, 200, resultPage(
          'QuickBooks is connected.',
          'You can close this tab and return to NicoleBooks.'
        ))
        finish(() => resolve({ code, realmId }))
      })

      server.on('error', () => {
        // The realistic cause is EADDRINUSE: something else already holds the registered port, and
        // the port cannot be changed because Intuit validates the redirect URI exactly.
        finish(() => reject(new Error(QBO_CALLBACK_PORT_BUSY)))
      })

      timer = setTimeout(() => {
        finish(() => reject(new Error(QBO_AUTH_TIMEOUT)))
      }, timeoutMs)
      // Do not hold the process open purely to wait for a sign in nobody is completing.
      timer.unref?.()

      // 127.0.0.1 only: a loopback bind cannot be reached from the LAN. Browsers resolving
      // "localhost" to ::1 fall back to IPv4, which is why the registered URI can still say
      // localhost while the socket is pinned to the IPv4 loopback.
      server.listen(port, '127.0.0.1', () => {
        const address = server?.address()
        const boundPort = typeof address === 'object' && address ? address.port : port
        void Promise.resolve(input.onListening?.(boundPort)).catch(() => {
          // Failing to open the browser is not a reason to leave the listener hanging until the
          // timeout: nothing is ever going to arrive on it.
          finish(() => reject(new Error(QBO_AUTH_CANCELED)))
        })
      })
    })
  } finally {
    if (timer) clearTimeout(timer)
    if (server) {
      const active: Server = server
      // closeAllConnections releases the keep-alive socket the browser leaves behind; without it
      // close() waits for that socket and the port stays held.
      active.closeAllConnections?.()
      await new Promise<void>((done) => active.close(() => done()))
    }
    callbackInFlight = false
  }
}

/** What a completed connect hands back to the caller. */
export interface ConnectResult {
  realmId: string
  tokens: TokenSet
}

/**
 * Run the whole authorization: consent URL, browser, loopback redirect, code exchange, and the
 * token write.
 *
 * ORDER MATTERS at the end. The tokens are written to the keychain BEFORE the caller records the
 * realm id in app_settings, so there is no window in which the app believes it is connected to a
 * company whose credentials were never stored.
 */
export async function connectToQuickBooks(deps: OAuthDeps = {}): Promise<ConnectResult> {
  // Fail before opening a browser if the machine cannot store the result. Asking somebody to sign
  // in and then discarding the tokens is the worst possible order for this check.
  assertSecretStoreAvailable(deps)
  const credentials = requireClientCredentials(deps)

  const state = createStateNonce()
  const redirectUri = deps.redirectUri ?? QBO_REDIRECT_URI

  const callback = await waitForOAuthCallback({
    expectedState: state,
    port: deps.port,
    timeoutMs: deps.timeoutMs,
    onListening: async (boundPort) => {
      deps.onListening?.(boundPort)
      const authorizeUrl = buildAuthorizeUrl({
        clientId: credentials.clientId,
        state,
        redirectUri,
        environment: deps.environment
      })
      // Opened only once the socket is listening, so the redirect cannot arrive before there is
      // anything to catch it.
      await deps.openExternal?.(authorizeUrl)
    }
  })

  const tokens = await exchangeAuthorizationCode(
    { code: callback.code, redirectUri, credentials },
    deps
  )
  writeTokenSet(tokens, deps)

  return { realmId: callback.realmId, tokens }
}
