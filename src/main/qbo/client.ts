// src/main/qbo/client.ts
//
// The authenticated Accounting API client: one signed request helper, one paginated query helper,
// and the CompanyInfo read the connection card displays.
//
// There is no official Intuit Node data SDK, so this calls the v3 REST endpoints directly with
// fetch and validates every response with Zod (the stack decision in CLAUDE.md). The surface this
// app touches is small: the SQL-like /query endpoint plus /companyinfo.
//
// TWO-LAYER TOKEN FRESHNESS. getAccessToken refreshes proactively inside the ten-minute skew, so a
// normal request never races the expiry. The 401 retry here is the backstop for the case that skew
// cannot cover: a token Intuit invalidated early (a password change, an admin revoking access, a
// clock that drifted). Exactly ONE retry, because a second 401 after a fresh token means the grant
// is the problem, not the token, and retrying again would just spin.
//
// PAGINATION IS NOT OPTIONAL. The /query endpoint returns at most 1000 rows and silently truncates:
// a company with 1200 vendors returns 1000 with no flag, no next-page cursor, and a 200 status. The
// only signal is that the page came back full, so qboQueryAll keeps walking STARTPOSITION until a
// short page arrives. A missing loop here would look perfectly healthy and quietly hide vendors
// from the review grid.
//
// SECRET BOUNDARY. This module reads the access token to sign a request and never returns it,
// stores it, or puts it in an error. Every failure is one of the opaque codes in ./errors, and the
// Intuit response body (which carries the request URL and the realm id) is read only to decide
// between codes, never forwarded. Nothing here logs.

import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { companyApiUrl, type QboEnvironment } from './env'
import { QBO_REQUEST_FAILED, QBO_VENDOR_DUPLICATE_NAME } from './errors'
import { getAccessToken, refreshTokenSet, type TokenDeps } from './tokens'

/** Injectable dependencies for a signed request (Shared Pattern B). */
export interface QboClientDeps extends TokenDeps {
  environment?: QboEnvironment
}

/** The most rows Intuit will return from one /query call. Their hard cap, not a preference. */
export const QUERY_PAGE_SIZE = 1000

/** Guard against an endless page walk if a gateway ever returns full pages forever. */
const MAX_QUERY_PAGES = 200

function authHeaders(accessToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    Accept: 'application/json'
  }
}

/**
 * Perform one signed GET against the Accounting API, refreshing proactively and retrying exactly
 * once on a 401. Returns the parsed JSON body as `unknown`; every caller runs it through a Zod
 * gate, because a response shape is external input.
 */
export async function qboGet(
  realmId: string,
  path: string,
  params: Record<string, string>,
  deps: QboClientDeps = {}
): Promise<unknown> {
  const doFetch = deps.fetch ?? globalThis.fetch
  const url = companyApiUrl(realmId, path, params, deps.environment)

  let accessToken = await getAccessToken(deps)
  let response = await requestOrFail(doFetch, url, accessToken)

  if (response.status === 401) {
    // The proactive window did not cover this one. Force a rotation, persist it (refreshTokenSet
    // writes before it returns), and try the request once more.
    accessToken = (await refreshTokenSet(deps)).accessToken
    response = await requestOrFail(doFetch, url, accessToken)
  }

  if (!response.ok) {
    // The body is deliberately dropped. An Intuit fault message embeds the request URL, and the
    // request URL contains the realm id.
    throw new Error(QBO_REQUEST_FAILED)
  }

  try {
    return await response.json()
  } catch {
    throw new Error(QBO_REQUEST_FAILED)
  }
}

async function requestOrFail(
  doFetch: typeof globalThis.fetch,
  url: string,
  accessToken: string
): Promise<Response> {
  try {
    return await doFetch(url, { method: 'GET', headers: authHeaders(accessToken) })
  } catch {
    throw new Error(QBO_REQUEST_FAILED)
  }
}

/**
 * Intuit's "Duplicate Name Exists Error" code, returned when a create would collide with an existing
 * DisplayName. It is the ONE fault this app reads out of a response body, because it is the only one
 * with a different answer for the user: not "try again", but "the vendor you want is already there,
 * pick it from the list". Everything else stays generic.
 */
const DUPLICATE_NAME_FAULT_CODE = '6240'

/**
 * Perform one signed POST against the Accounting API, with the same proactive refresh and single
 * 401 retry as qboGet.
 *
 * A `requestid` is always attached. Intuit treats it as an idempotency key on creates: replaying the
 * same id returns the ORIGINAL response instead of creating a second record, so a retry that crosses
 * a timeout cannot leave two vendors behind. It is minted per call rather than accepted from a
 * caller, because the retry inside this function is the only replay it needs to survive.
 *
 * ERROR DISCIPLINE. The response body is read ONLY to recognise the duplicate-name fault, and it is
 * never forwarded: an Intuit fault message embeds the request URL, which embeds the realm id.
 */
export async function qboPost(
  realmId: string,
  path: string,
  body: unknown,
  deps: QboClientDeps = {}
): Promise<unknown> {
  const doFetch = deps.fetch ?? globalThis.fetch
  const url = companyApiUrl(realmId, path, { requestid: randomUUID() }, deps.environment)
  const payload = JSON.stringify(body)

  let accessToken = await getAccessToken(deps)
  let response = await postOrFail(doFetch, url, accessToken, payload)

  if (response.status === 401) {
    accessToken = (await refreshTokenSet(deps)).accessToken
    response = await postOrFail(doFetch, url, accessToken, payload)
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    if (text.includes(DUPLICATE_NAME_FAULT_CODE)) throw new Error(QBO_VENDOR_DUPLICATE_NAME)
    throw new Error(QBO_REQUEST_FAILED)
  }

  try {
    return await response.json()
  } catch {
    throw new Error(QBO_REQUEST_FAILED)
  }
}

async function postOrFail(
  doFetch: typeof globalThis.fetch,
  url: string,
  accessToken: string,
  payload: string
): Promise<Response> {
  try {
    return await doFetch(url, {
      method: 'POST',
      headers: { ...authHeaders(accessToken), 'Content-Type': 'application/json' },
      body: payload
    })
  } catch {
    throw new Error(QBO_REQUEST_FAILED)
  }
}

/**
 * The envelope every /query response arrives in. Loose because the entity arrays are keyed by
 * entity name ('Vendor', 'Account', 'Item') and validated by the caller's own schema.
 */
const QueryEnvelopeSchema = z.looseObject({
  QueryResponse: z.looseObject({}).nullish()
})

/**
 * Run a SQL-like query and walk every page.
 *
 * `statement` is code-controlled (built from the constants in reference.ts), never renderer input:
 * the renderer cannot reach this function, and nothing user-typed is interpolated into it. The
 * statement is percent encoded by companyApiUrl's URLSearchParams rather than concatenated.
 */
export async function qboQueryAll(
  realmId: string,
  statement: string,
  entityKey: string,
  deps: QboClientDeps = {}
): Promise<unknown[]> {
  const rows: unknown[] = []
  let startPosition = 1

  for (let page = 0; page < MAX_QUERY_PAGES; page += 1) {
    const paged = `${statement} STARTPOSITION ${startPosition} MAXRESULTS ${QUERY_PAGE_SIZE}`
    const body = await qboGet(realmId, 'query', { query: paged }, deps)

    const envelope = QueryEnvelopeSchema.safeParse(body)
    if (!envelope.success) throw new Error(QBO_REQUEST_FAILED)

    const container = envelope.data.QueryResponse as Record<string, unknown> | null | undefined
    const batch = container?.[entityKey]
    // An empty QueryResponse (no entity key at all) is how Intuit reports "nothing matched". It is
    // a legitimate answer, not a failure, so the walk stops rather than throwing.
    if (!Array.isArray(batch) || batch.length === 0) break

    rows.push(...batch)
    // A short page is the only end-of-results signal Intuit gives.
    if (batch.length < QUERY_PAGE_SIZE) break
    startPosition += batch.length
  }

  return rows
}

/** The two CompanyInfo fields the connection card needs. Everything else is ignored. */
const CompanyInfoSchema = z.looseObject({
  CompanyInfo: z
    .looseObject({
      CompanyName: z.string().nullish(),
      LegalName: z.string().nullish()
    })
    .nullish()
})

/**
 * Read the connected company's display name. Returns null when Intuit answers without one, so a
 * nameless company degrades to "Connected" rather than failing the whole connect flow.
 */
export async function fetchCompanyName(
  realmId: string,
  deps: QboClientDeps = {}
): Promise<string | null> {
  const body = await qboGet(realmId, `companyinfo/${encodeURIComponent(realmId)}`, {}, deps)
  const parsed = CompanyInfoSchema.safeParse(body)
  if (!parsed.success) return null
  const info = parsed.data.CompanyInfo
  return info?.CompanyName ?? info?.LegalName ?? null
}
