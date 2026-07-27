// src/main/qbo/env.ts
//
// THE ENVIRONMENT SEAM. Every QuickBooks host, path, and version constant in the app is declared
// here and nowhere else, so the Phase 8 production cutover is a one-line change to
// ACTIVE_ENVIRONMENT rather than a hunt through the codebase for hardcoded sandbox URLs.
//
// Only the DATA host differs between sandbox and production. The OAuth endpoints (authorize,
// token, revoke) are shared: Intuit issues one set of tokens whose environment is decided by which
// keys signed the request, not by which URL asked for them. Splitting them anyway (rather than
// hoisting them out of the table) keeps the seam honest, because a future Intuit change to one
// environment's auth host would then be a data change here instead of a code change everywhere.
//
// MINOR VERSION. Every request pins minorversion explicitly. Without it Intuit serves whatever the
// current default is, so a server-side default bump can silently change a response shape under a
// shipped installer. 75 is the version this app's Zod response gates were written against.
//
// LOOPBACK REDIRECT. http://localhost:8734/oauth/callback is registered character for character in
// the Intuit developer portal, so the port and path are constants, never configurable: a mismatch
// is rejected by Intuit before the user ever sees a consent screen.

/** Which Intuit environment the app talks to. Sandbox is the only one wired today. */
export type QboEnvironment = 'sandbox' | 'production'

/** Every host the QuickBooks integration reaches, resolved from one environment name. */
export interface QboEnvironmentConfig {
  name: QboEnvironment
  /** Accounting API root. The realm id is appended per request. */
  apiBaseUrl: string
  /** Where the user is sent to grant consent. */
  authorizeUrl: string
  /** Authorization-code exchange and refresh-token rotation. */
  tokenUrl: string
  /** Token revocation, used by disconnect. */
  revokeUrl: string
}

/** The Accounting API minor version every request pins. See the header for why this is explicit. */
export const QBO_MINOR_VERSION = '75'

/** The only OAuth scope this app requests. */
export const QBO_SCOPE = 'com.intuit.quickbooks.accounting'

/** Loopback port registered in the Intuit developer portal. Not configurable, by design. */
export const QBO_LOOPBACK_PORT = 8734

/** Loopback path registered in the Intuit developer portal. Not configurable, by design. */
export const QBO_LOOPBACK_PATH = '/oauth/callback'

/**
 * The exact redirect URI registered with Intuit. Built from the two constants above so the server
 * this app binds and the URI it sends to Intuit can never drift apart.
 */
export const QBO_REDIRECT_URI = `http://localhost:${QBO_LOOPBACK_PORT}${QBO_LOOPBACK_PATH}`

const ENVIRONMENTS: Readonly<Record<QboEnvironment, QboEnvironmentConfig>> = {
  sandbox: {
    name: 'sandbox',
    apiBaseUrl: 'https://sandbox-quickbooks.api.intuit.com/v3/company',
    authorizeUrl: 'https://appcenter.intuit.com/connect/oauth2',
    tokenUrl: 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer',
    revokeUrl: 'https://developer.api.intuit.com/v2/oauth2/tokens/revoke'
  },
  production: {
    name: 'production',
    apiBaseUrl: 'https://quickbooks.api.intuit.com/v3/company',
    authorizeUrl: 'https://appcenter.intuit.com/connect/oauth2',
    tokenUrl: 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer',
    revokeUrl: 'https://developer.api.intuit.com/v2/oauth2/tokens/revoke'
  }
}

/**
 * The environment the app runs against. Phase 8 flips this one value (behind whatever gate the
 * cutover plan chooses) and the whole integration follows.
 */
export const ACTIVE_ENVIRONMENT: QboEnvironment = 'sandbox'

/** Resolve an environment config. Defaults to the active environment. */
export function qboEnvironment(name: QboEnvironment = ACTIVE_ENVIRONMENT): QboEnvironmentConfig {
  return ENVIRONMENTS[name]
}

/**
 * Build a fully qualified Accounting API URL for one company, with minorversion always applied.
 *
 * `path` is a code-controlled endpoint segment ('query', 'companyinfo/123'), never renderer input.
 * Query parameters are appended through URLSearchParams so a SQL-like query statement is percent
 * encoded rather than string-concatenated into the URL.
 */
export function companyApiUrl(
  realmId: string,
  path: string,
  params: Record<string, string> = {},
  environment: QboEnvironment = ACTIVE_ENVIRONMENT
): string {
  const url = new URL(`${qboEnvironment(environment).apiBaseUrl}/${realmId}/${path}`)
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value)
  }
  url.searchParams.set('minorversion', QBO_MINOR_VERSION)
  return url.toString()
}
