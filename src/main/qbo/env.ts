// src/main/qbo/env.ts
//
// THE ENVIRONMENT SEAM. Every QuickBooks host, path, redirect, and version constant in the app is
// declared here and nowhere else, so which Intuit environment the app talks to is one resolved
// value rather than a hunt through the codebase for hardcoded sandbox URLs.
//
// WHAT THIS MODULE IS NOT. It does not decide which environment is CURRENT. That is a user setting
// stored in app_settings, and it is read by ./environment.ts, which owns the database access. This
// module stays pure and dependency free (aside from one type) so a unit spec can assert on URL
// selection without pulling SQLite or Electron into its module graph, and so no import cycle can
// form between the seam and the state that selects through it.
//
// WHAT DIFFERS BETWEEN THE TWO ENVIRONMENTS. The DATA host and the REDIRECT URI. The OAuth
// endpoints (authorize, token, revoke) are shared: Intuit issues one set of tokens whose
// environment is decided by which keys signed the request, not by which URL asked for them.
// Splitting them anyway (rather than hoisting them out of the table) keeps the seam honest, because
// a future Intuit change to one environment's auth host would then be a data change here instead of
// a code change everywhere.
//
// WHY THE REDIRECT URI DIFFERS, AND WHY THAT IS NOT A CHOICE. Intuit accepts a plain
// http://localhost redirect on DEVELOPMENT keys only. Production keys require https, so the
// loopback URI this app binds cannot be registered against them. Production therefore sends Intuit
// to a static page on GitHub Pages (docs/oauth-callback.html) whose only job is to forward the
// query string, unchanged, to the same loopback server. The app still receives the callback on
// 127.0.0.1; only the address Intuit is told to visit changes.
//
// MINOR VERSION. Every request pins minorversion explicitly. Without it Intuit serves whatever the
// current default is, so a server-side default bump can silently change a response shape under a
// shipped installer. 75 is the version this app's Zod response gates were written against.

import type { QboEnvironment } from '../../shared/ipc-contract'

// Re-exported so every existing importer of './env' keeps its single import site for the type. The
// declaration itself lives in the shared contract because the renderer's environment selector needs
// the same two names, and a duplicated union is a union that eventually disagrees with itself.
export type { QboEnvironment }

/** Every host the QuickBooks integration reaches, resolved from one environment name. */
export interface QboEnvironmentConfig {
  name: QboEnvironment
  /** Scheme and host only, no path. This is what the posting HTTP client takes as its baseUrl. */
  apiHost: string
  /** Accounting API root. The realm id is appended per request. */
  apiBaseUrl: string
  /** Where the user is sent to grant consent. */
  authorizeUrl: string
  /** Authorization-code exchange and refresh-token rotation. */
  tokenUrl: string
  /** Token revocation, used by disconnect. */
  revokeUrl: string
  /** The redirect URI registered with Intuit for THIS environment's keys. */
  redirectUri: string
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
 * The loopback redirect URI. Built from the two constants above so the server this app binds and
 * the URI it sends to Intuit can never drift apart.
 *
 * This is the redirect for SANDBOX keys, and it is also the address the production forwarder page
 * hands the callback on to, so it stays the one true target either way.
 */
export const QBO_REDIRECT_URI = `http://localhost:${QBO_LOOPBACK_PORT}${QBO_LOOPBACK_PATH}`

/**
 * The production redirect URI: a static page that forwards straight back to the loopback above.
 *
 * It is https, which is what production keys require, and it holds no secret and runs no logic
 * beyond a location.replace. The page source is docs/oauth-callback.html in this repository.
 */
export const QBO_FORWARDER_REDIRECT_URI =
  'https://magnetgrouplabs.github.io/nicolebooks/oauth-callback.html'

const SANDBOX_API_HOST = 'https://sandbox-quickbooks.api.intuit.com'
const PRODUCTION_API_HOST = 'https://quickbooks.api.intuit.com'

const ENVIRONMENTS: Readonly<Record<QboEnvironment, QboEnvironmentConfig>> = {
  sandbox: {
    name: 'sandbox',
    apiHost: SANDBOX_API_HOST,
    apiBaseUrl: `${SANDBOX_API_HOST}/v3/company`,
    authorizeUrl: 'https://appcenter.intuit.com/connect/oauth2',
    tokenUrl: 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer',
    revokeUrl: 'https://developer.api.intuit.com/v2/oauth2/tokens/revoke',
    redirectUri: QBO_REDIRECT_URI
  },
  production: {
    name: 'production',
    apiHost: PRODUCTION_API_HOST,
    apiBaseUrl: `${PRODUCTION_API_HOST}/v3/company`,
    authorizeUrl: 'https://appcenter.intuit.com/connect/oauth2',
    tokenUrl: 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer',
    revokeUrl: 'https://developer.api.intuit.com/v2/oauth2/tokens/revoke',
    redirectUri: QBO_FORWARDER_REDIRECT_URI
  }
}

/** Both environment names, in the order the Settings selector offers them. */
export const QBO_ENVIRONMENTS: readonly QboEnvironment[] = ['sandbox', 'production']

/**
 * What the app falls back to when no environment has been resolved: sandbox, always.
 *
 * The direction of this default is the safety property. A wrong fallback to sandbox costs a failed
 * request against a company that is not there; a wrong fallback to production would post real
 * entries into somebody's real books.
 */
export const DEFAULT_QBO_ENVIRONMENT: QboEnvironment = 'sandbox'

/** True when a value is one of the two environment names. */
export function isQboEnvironment(value: unknown): value is QboEnvironment {
  return value === 'sandbox' || value === 'production'
}

/**
 * Coerce any stored or supplied value to an environment.
 *
 * Anything unrecognized (a null from a missing setting, a typo written by hand into app_settings,
 * a value from an older build) reads as sandbox rather than throwing, because the alternative to a
 * safe default here is an app that cannot start.
 */
export function parseQboEnvironment(value: unknown): QboEnvironment {
  return isQboEnvironment(value) ? value : DEFAULT_QBO_ENVIRONMENT
}

/** Resolve an environment config. */
export function qboEnvironment(name: QboEnvironment = DEFAULT_QBO_ENVIRONMENT): QboEnvironmentConfig {
  return ENVIRONMENTS[name]
}

/** The redirect URI to register and to send Intuit for one environment. */
export function redirectUriFor(environment: QboEnvironment = DEFAULT_QBO_ENVIRONMENT): string {
  return qboEnvironment(environment).redirectUri
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
  environment: QboEnvironment = DEFAULT_QBO_ENVIRONMENT
): string {
  const url = new URL(`${qboEnvironment(environment).apiBaseUrl}/${realmId}/${path}`)
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value)
  }
  url.searchParams.set('minorversion', QBO_MINOR_VERSION)
  return url.toString()
}
