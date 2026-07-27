// src/main/qbo/tokens.ts
//
// The QuickBooks OAuth 2.0 token lifecycle: read, write, and refresh, all against the OS keychain.
//
// THE ONE RULE THIS MODULE EXISTS TO ENFORCE. Intuit rotates the refresh token: a refresh call
// returns a NEW refresh_token and invalidates the one that was sent. If the app uses the new access
// token and then fails to persist the new refresh token (a crash, an exception on the happy path, a
// write ordered after the network call that follows), the stored refresh token is already dead and
// the connection is unrecoverable at the next refresh, up to 60 minutes later, with no error in
// between to explain it. So refreshTokens() persists the rotated set BEFORE it returns, and
// writeTokenSet() writes the refresh token FIRST. A crash between the two writes leaves a valid
// refresh token with a stale access token, which self-heals on the next call; the opposite order
// would leave a valid access token with a dead refresh token, which does not.
//
// PROACTIVE REFRESH. Access tokens live about 60 minutes. Waiting for a 401 means every long
// operation has a chance of stalling mid-batch, so a token inside REFRESH_SKEW_MS of expiry is
// refreshed before the request rather than after it fails. The 401 retry in client.ts stays as the
// backstop for a token Intuit invalidated early.
//
// SECRET BOUNDARY (D-05, threat T-03-01). Tokens are read and written ONLY here and in the OAuth
// exchange. No value from this module is returned to the renderer, put in an error message, or
// logged: the errors thrown are the opaque codes in ./errors, which src/main/ipc/qbo.ts maps to
// fixed copy. Nothing here writes to SQLite, so no token or client credential can land in app.db.
//
// Everything is injectable (03-PATTERNS Shared Pattern B), so the unit spec drives the whole
// lifecycle with a fake store, a fake fetch, and a fake clock, and never touches Electron or the
// network.

import { z } from 'zod'
import { secretStore } from '../secrets/secret-store'
import {
  QBO_CLIENT_CREDENTIALS_MISSING,
  QBO_NOT_CONNECTED,
  QBO_REAUTH_REQUIRED,
  QBO_REDIRECT_URI_MISMATCH,
  QBO_SECRET_STORE_UNAVAILABLE,
  QBO_TOKEN_EXCHANGE_FAILED,
  QBO_TOKEN_REFRESH_FAILED
} from './errors'
import { qboEnvironment, type QboEnvironment } from './env'
import {
  QBO_ACCESS_TOKEN_SECRET,
  QBO_CLIENT_ID_SECRET,
  QBO_CLIENT_SECRET_SECRET,
  QBO_REFRESH_TOKEN_SECRET,
  QBO_TOKEN_EXPIRY_SECRET
} from './secret-keys'

/**
 * Refresh this long before the access token actually expires. Ten minutes is comfortably longer
 * than any single operation this app performs, so a request that passes the check cannot have its
 * token expire underneath it.
 */
export const REFRESH_SKEW_MS = 10 * 60 * 1000

/** The slice of secretStore these modules use. Injectable so specs need no safeStorage. */
export interface SecretStoreLike {
  get(key: string): string | null
  set(key: string, value: string): void
  delete(key: string): void
  available?(): boolean
}

/** The complete stored token set. expiresAt is epoch milliseconds. */
export interface TokenSet {
  accessToken: string
  refreshToken: string
  expiresAt: number
}

/** The Intuit app credentials, the HTTP Basic half of every token call. */
export interface ClientCredentials {
  clientId: string
  clientSecret: string
}

/** Injectable dependencies shared by every token operation (Shared Pattern B). */
export interface TokenDeps {
  secretStore?: SecretStoreLike
  fetch?: typeof globalThis.fetch
  now?: () => number
  environment?: QboEnvironment
}

/**
 * Intuit's token response. Lenient on everything the app does not consume, strict on the three
 * fields it does. `refresh_token` is optional purely defensively: the documented behaviour is that
 * it is always returned, and when it is absent the caller keeps the token it already had rather
 * than writing `undefined` over a working credential.
 */
export const TokenResponseSchema = z.looseObject({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).nullish(),
  expires_in: z.number().nullish()
})

/** Fallback access-token lifetime when Intuit omits expires_in. Their documented value is 3600s. */
const DEFAULT_EXPIRES_IN_SECONDS = 3600

function store(deps: TokenDeps): SecretStoreLike {
  return deps.secretStore ?? secretStore
}

function clock(deps: TokenDeps): number {
  return (deps.now ?? Date.now)()
}

function httpFetch(deps: TokenDeps): typeof globalThis.fetch {
  return deps.fetch ?? globalThis.fetch
}

/**
 * Assert the keychain backend is usable before a write is attempted. secretStore.set throws
 * SECRET_STORE_UNAVAILABLE on its own, but checking first means a connect attempt fails before it
 * opens a browser and asks the user to sign in to something that cannot be saved.
 */
export function assertSecretStoreAvailable(deps: TokenDeps = {}): void {
  const target = store(deps)
  if (typeof target.available === 'function' && !target.available()) {
    throw new Error(QBO_SECRET_STORE_UNAVAILABLE)
  }
}

/** Read the Intuit app credentials, or null when either half is missing. */
export function readClientCredentials(deps: TokenDeps = {}): ClientCredentials | null {
  const target = store(deps)
  const clientId = target.get(QBO_CLIENT_ID_SECRET)
  const clientSecret = target.get(QBO_CLIENT_SECRET_SECRET)
  if (!clientId || !clientSecret) return null
  return { clientId, clientSecret }
}

/** Read the app credentials or throw the opaque missing-credentials code. */
export function requireClientCredentials(deps: TokenDeps = {}): ClientCredentials {
  const credentials = readClientCredentials(deps)
  if (!credentials) throw new Error(QBO_CLIENT_CREDENTIALS_MISSING)
  return credentials
}

/** Write the Intuit app credentials. Used by the dev seeder; the UI writes them over `secrets:set`. */
export function writeClientCredentials(
  credentials: ClientCredentials,
  deps: TokenDeps = {}
): void {
  const target = store(deps)
  target.set(QBO_CLIENT_ID_SECRET, credentials.clientId)
  target.set(QBO_CLIENT_SECRET_SECRET, credentials.clientSecret)
}

/**
 * Read the stored token set, or null when the app is not connected.
 *
 * A missing or unparseable expiry reads as 0 rather than as "no tokens": an expiry we cannot trust
 * must force a refresh, not discard a perfectly good refresh token.
 */
export function readTokenSet(deps: TokenDeps = {}): TokenSet | null {
  const target = store(deps)
  const accessToken = target.get(QBO_ACCESS_TOKEN_SECRET)
  const refreshToken = target.get(QBO_REFRESH_TOKEN_SECRET)
  if (!refreshToken) return null
  const rawExpiry = target.get(QBO_TOKEN_EXPIRY_SECRET)
  const expiresAt = Number(rawExpiry)
  return {
    accessToken: accessToken ?? '',
    refreshToken,
    expiresAt: Number.isFinite(expiresAt) ? expiresAt : 0
  }
}

/**
 * Persist a token set, REFRESH TOKEN FIRST.
 *
 * The order is the whole point (see the module header). Interrupted after the first write, the app
 * holds a live refresh token and a stale access token, and the next call repairs itself. Interrupted
 * in the other order, it would hold a working access token and a dead refresh token: everything
 * keeps working for up to an hour and then the connection dies with nothing to point at.
 */
export function writeTokenSet(tokens: TokenSet, deps: TokenDeps = {}): void {
  const target = store(deps)
  target.set(QBO_REFRESH_TOKEN_SECRET, tokens.refreshToken)
  target.set(QBO_ACCESS_TOKEN_SECRET, tokens.accessToken)
  target.set(QBO_TOKEN_EXPIRY_SECRET, String(tokens.expiresAt))
}

/**
 * Remove the token set. The client id and client secret are deliberately KEPT: they identify the
 * Intuit app, not the connection, so a disconnect followed by a reconnect must not make the user
 * paste them again.
 */
export function clearTokenSet(deps: TokenDeps = {}): void {
  const target = store(deps)
  target.delete(QBO_ACCESS_TOKEN_SECRET)
  target.delete(QBO_REFRESH_TOKEN_SECRET)
  target.delete(QBO_TOKEN_EXPIRY_SECRET)
}

/** True when the access token is missing, expired, or inside the proactive-refresh window. */
export function needsRefresh(tokens: TokenSet, nowMs: number): boolean {
  if (!tokens.accessToken) return true
  return tokens.expiresAt - nowMs <= REFRESH_SKEW_MS
}

/** The HTTP Basic header Intuit's token endpoint requires. */
function basicAuth(credentials: ClientCredentials): string {
  const raw = `${credentials.clientId}:${credentials.clientSecret}`
  return `Basic ${Buffer.from(raw, 'utf8').toString('base64')}`
}

/** Read a response body without ever letting a parse failure mask the original HTTP failure. */
async function safeBodyText(response: Response): Promise<string> {
  try {
    return await response.text()
  } catch {
    return ''
  }
}

/**
 * Did Intuit reject the grant itself?
 *
 * invalid_grant is the code that means "this refresh token is dead", and it is the ONLY failure
 * that should flip the connection to 'expired'. Treating a 5xx or a dropped connection the same way
 * would tell the user to sign in again over a problem that clears itself on retry. The status check
 * is a fallback for a gateway that returns 400/401 with a body this app cannot parse.
 */
function isInvalidGrant(status: number, body: string): boolean {
  if (body.includes('invalid_grant')) return true
  return status === 400 || status === 401
}

/**
 * Did Intuit reject the exchange over the redirect address rather than over the credentials?
 *
 * Intuit's wording has varied ('invalid_redirect_uri', 'redirect_uri mismatch', a description
 * naming the parameter), so the test is the parameter NAME in any spelling the body uses. The body
 * is read only to choose between two opaque codes and is never forwarded: an Intuit fault message
 * carries the request URL and the client id.
 */
function isRedirectUriRejection(body: string): boolean {
  return /redirect[_ -]?uri/i.test(body)
}

/**
 * Turn a token endpoint response into a TokenSet. Shared by the refresh and the authorization-code
 * exchange, because the response shape is identical.
 */
function toTokenSet(
  payload: z.infer<typeof TokenResponseSchema>,
  fallbackRefreshToken: string | null,
  nowMs: number
): TokenSet {
  const refreshToken = payload.refresh_token ?? fallbackRefreshToken
  if (!refreshToken) throw new Error(QBO_TOKEN_EXCHANGE_FAILED)
  const lifetimeSeconds = payload.expires_in ?? DEFAULT_EXPIRES_IN_SECONDS
  return {
    accessToken: payload.access_token,
    refreshToken,
    expiresAt: nowMs + lifetimeSeconds * 1000
  }
}

/**
 * Exchange an authorization code for the first token set. Does NOT persist: the caller stores the
 * realm id and the tokens together so a half-connected state cannot be observed.
 */
export async function exchangeAuthorizationCode(
  input: { code: string; redirectUri: string; credentials: ClientCredentials },
  deps: TokenDeps = {}
): Promise<TokenSet> {
  const response = await httpFetch(deps)(qboEnvironment(deps.environment).tokenUrl, {
    method: 'POST',
    headers: {
      Authorization: basicAuth(input.credentials),
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json'
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: input.code,
      redirect_uri: input.redirectUri
    }).toString()
  })

  if (!response.ok) {
    const body = await safeBodyText(response)
    // The redirect address gets its own code because it is the first-run production mistake, and
    // because the generic copy would send somebody to re-check two credentials that are fine.
    throw new Error(
      isRedirectUriRejection(body) ? QBO_REDIRECT_URI_MISMATCH : QBO_TOKEN_EXCHANGE_FAILED
    )
  }

  const parsed = TokenResponseSchema.safeParse(await response.json().catch(() => null))
  if (!parsed.success) throw new Error(QBO_TOKEN_EXCHANGE_FAILED)
  return toTokenSet(parsed.data, null, clock(deps))
}

/**
 * Refresh the access token and persist the ROTATED set before returning it.
 *
 * The stored refresh token is re-read here rather than accepted from a caller, so a value cached
 * earlier in a long-running operation can never be replayed after a rotation has already happened.
 *
 * Throws QBO_REAUTH_REQUIRED on invalid_grant (the caller flips the connection to 'expired' and
 * surfaces Reconnect) and QBO_TOKEN_REFRESH_FAILED on anything else, so a transient outage never
 * looks like a dead authorization.
 */
export async function refreshTokenSet(deps: TokenDeps = {}): Promise<TokenSet> {
  const credentials = requireClientCredentials(deps)
  // Re-read immediately before the call: this is the same discipline the dev token file follows.
  const current = readTokenSet(deps)
  if (!current) throw new Error(QBO_NOT_CONNECTED)

  let response: Response
  try {
    response = await httpFetch(deps)(qboEnvironment(deps.environment).tokenUrl, {
      method: 'POST',
      headers: {
        Authorization: basicAuth(credentials),
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json'
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: current.refreshToken
      }).toString()
    })
  } catch {
    // A network failure is NOT a dead grant. Surfacing it as one would tell the user to reconnect
    // over an offline laptop lid.
    throw new Error(QBO_TOKEN_REFRESH_FAILED)
  }

  if (!response.ok) {
    const body = await safeBodyText(response)
    throw new Error(isInvalidGrant(response.status, body) ? QBO_REAUTH_REQUIRED : QBO_TOKEN_REFRESH_FAILED)
  }

  const parsed = TokenResponseSchema.safeParse(await response.json().catch(() => null))
  if (!parsed.success) throw new Error(QBO_TOKEN_REFRESH_FAILED)

  const next = toTokenSet(parsed.data, current.refreshToken, clock(deps))
  // PERSIST BEFORE RETURNING. The caller is about to use the access token; if that call throws,
  // the rotated refresh token is already safe on disk.
  writeTokenSet(next, deps)
  return next
}

/**
 * The access token to sign the next request with, refreshing proactively when it is close to
 * expiry. Throws QBO_NOT_CONNECTED when nothing is stored.
 */
export async function getAccessToken(deps: TokenDeps = {}): Promise<string> {
  const current = readTokenSet(deps)
  if (!current) throw new Error(QBO_NOT_CONNECTED)
  if (!needsRefresh(current, clock(deps))) return current.accessToken
  const refreshed = await refreshTokenSet(deps)
  return refreshed.accessToken
}
