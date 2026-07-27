// src/main/qbo/errors.ts
//
// The opaque failure codes the QuickBooks modules throw.
//
// These are CODES, never copy. src/main/ipc/qbo.ts owns the one table that turns a code into a
// sentence a person reads, exactly like ai/client.ts throws AI_CREDENTIALS_MISSING and
// ipc/ai.ts maps it. Splitting the two means a new failure mode cannot reach the renderer as raw
// text by accident: an unmapped code falls through to the generic message.
//
// WHY THAT MATTERS MORE HERE THAN ANYWHERE ELSE. A QuickBooks API error message is assembled from
// Intuit's response body and routinely carries the request URL, which contains the realm id. A
// token-endpoint error carries the client id. A loopback bind failure carries a port. None of that
// is safe to forward, so nothing outside this module's vocabulary ever reaches a user.
//
// This module deliberately imports nothing, so a unit spec can assert on codes without pulling
// electron, the database, or the network into its module graph.

/** No Intuit client id or client secret has been saved yet. */
export const QBO_CLIENT_CREDENTIALS_MISSING = 'QBO_CLIENT_CREDENTIALS_MISSING'

/** The OS keychain refused to store or return the connection. */
export const QBO_SECRET_STORE_UNAVAILABLE = 'QBO_SECRET_STORE_UNAVAILABLE'

/** No tokens are stored: the user has never connected, or has disconnected. */
export const QBO_NOT_CONNECTED = 'QBO_NOT_CONNECTED'

/**
 * The refresh token was rejected (invalid_grant). The connection cannot be repaired without the
 * user signing in again, which is precisely the 'expired' state the Reconnect button exists for.
 */
export const QBO_REAUTH_REQUIRED = 'QBO_REAUTH_REQUIRED'

/** The refresh call failed for a reason that is NOT invalid_grant (network, 5xx, malformed body). */
export const QBO_TOKEN_REFRESH_FAILED = 'QBO_TOKEN_REFRESH_FAILED'

/** The authorization-code exchange failed. Usually a wrong client id or client secret. */
export const QBO_TOKEN_EXCHANGE_FAILED = 'QBO_TOKEN_EXCHANGE_FAILED'

/**
 * Intuit rejected the exchange because the redirect address this app sent is not one of the
 * addresses registered on the app whose keys signed the request.
 *
 * Split out from the generic exchange failure because it is the single most likely first-run
 * mistake on production keys and it has an exact, actionable fix: production and development keys
 * carry SEPARATE redirect lists in the Intuit portal, and the production list needs both of this
 * app's addresses. "Check the client id and client secret" (the generic exchange copy) would send
 * somebody to re-paste two values that were never the problem.
 */
export const QBO_REDIRECT_URI_MISMATCH = 'QBO_REDIRECT_URI_MISMATCH'

/** Another process already holds the loopback port, so the redirect could not be caught. */
export const QBO_CALLBACK_PORT_BUSY = 'QBO_CALLBACK_PORT_BUSY'

/** The user closed the browser (or Intuit reported access_denied) before granting consent. */
export const QBO_AUTH_CANCELED = 'QBO_AUTH_CANCELED'

/** Nobody completed the sign in inside the allowed window, so the loopback server gave up. */
export const QBO_AUTH_TIMEOUT = 'QBO_AUTH_TIMEOUT'

/**
 * The redirect did not carry back the state nonce this app generated. Either a stale tab from an
 * earlier attempt, or a cross-site request forgery attempt against the loopback listener.
 */
export const QBO_AUTH_STATE_MISMATCH = 'QBO_AUTH_STATE_MISMATCH'

/** A connect attempt is already waiting on the browser. Two loopback servers cannot share a port. */
export const QBO_AUTH_IN_PROGRESS = 'QBO_AUTH_IN_PROGRESS'

/** An Accounting API request failed after the single authorized retry. */
export const QBO_REQUEST_FAILED = 'QBO_REQUEST_FAILED'

/** A reference sync could not complete, so the cache was left as it was. */
export const QBO_SYNC_FAILED = 'QBO_SYNC_FAILED'
