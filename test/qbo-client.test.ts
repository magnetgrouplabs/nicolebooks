// test/qbo-client.test.ts
//
// Coverage for the signed Accounting API client: the pinned minorversion, the single 401 retry, and
// the /query pagination walk.
//
// WHY THE PAGINATION TEST EXISTS. Intuit's /query returns at most 1000 rows and truncates with a
// 200 status, no flag, and no cursor. A client that issues one request looks perfectly healthy on a
// company with 1200 vendors and silently hides 200 of them from the review grid, which surfaces
// later as "the vendor isn't in the dropdown" with nothing in any log. The only signal is that the
// page came back full, so the walk is asserted with a full page followed by a short one.
//
// WHY EXACTLY ONE RETRY. A second 401 after a freshly minted token means the grant is the problem,
// not the token. Retrying again would spin against Intuit with a credential that cannot work.

import { describe, expect, it, vi } from 'vitest'
import { createFakeSecretStore, jsonResponse, textResponse } from './helpers/fake-secret-store'
import { QUERY_PAGE_SIZE, fetchCompanyName, qboGet, qboQueryAll } from '../src/main/qbo/client'
import { QBO_REQUEST_FAILED } from '../src/main/qbo/errors'
import {
  QBO_ACCESS_TOKEN_SECRET,
  QBO_CLIENT_ID_SECRET,
  QBO_CLIENT_SECRET_SECRET,
  QBO_REFRESH_TOKEN_SECRET,
  QBO_TOKEN_EXPIRY_SECRET
} from '../src/main/qbo/secret-keys'

const NOW = Date.parse('2026-07-27T12:00:00.000Z')
const REALM = '9341457604445280'

function connectedStore() {
  return createFakeSecretStore({
    [QBO_CLIENT_ID_SECRET]: 'client-id-value',
    [QBO_CLIENT_SECRET_SECRET]: 'client-secret-value',
    [QBO_ACCESS_TOKEN_SECRET]: 'access-fresh',
    [QBO_REFRESH_TOKEN_SECRET]: 'refresh-old',
    [QBO_TOKEN_EXPIRY_SECRET]: String(NOW + 60 * 60 * 1000)
  })
}

/** One vendor entity, repeated to build pages. */
function vendor(id: number): Record<string, unknown> {
  return { Id: String(id), DisplayName: `Vendor ${id}`, Active: true }
}

describe('qboGet signs and pins every request', () => {
  it('sends the bearer token and the pinned minorversion', async () => {
    const store = connectedStore()
    const seen: string[] = []
    const headers: Array<Record<string, string>> = []
    const fetchImpl = vi.fn(async (url: unknown, init?: RequestInit) => {
      seen.push(String(url))
      headers.push((init?.headers ?? {}) as Record<string, string>)
      return jsonResponse({ ok: true })
    }) as unknown as typeof globalThis.fetch

    await qboGet(REALM, 'companyinfo/1', {}, { secretStore: store, fetch: fetchImpl, now: () => NOW })

    expect(seen[0]).toContain('sandbox-quickbooks.api.intuit.com')
    expect(seen[0]).toContain(`/v3/company/${REALM}/companyinfo/1`)
    expect(seen[0]).toContain('minorversion=75')
    expect(headers[0]['Authorization']).toBe('Bearer access-fresh')
  })

  it('percent encodes a query statement instead of concatenating it into the URL', async () => {
    const store = connectedStore()
    let seen = ''
    const fetchImpl = vi.fn(async (url: unknown) => {
      seen = String(url)
      return jsonResponse({ QueryResponse: {} })
    }) as unknown as typeof globalThis.fetch

    await qboGet(
      REALM,
      'query',
      { query: "SELECT * FROM Vendor WHERE Active = true" },
      { secretStore: store, fetch: fetchImpl, now: () => NOW }
    )

    // URLSearchParams encodes the spaces, so no literal space survives into the URL. That is the
    // point: the statement occupies exactly one parameter slot and cannot break out of it.
    expect(seen).toContain('query=SELECT+*+FROM+Vendor+WHERE+Active+%3D+true')
    expect(seen).not.toContain('SELECT * FROM')
  })
})

describe('the 401 retry is a backstop, and happens exactly once', () => {
  it('refreshes and retries once when the first request is unauthorized', async () => {
    const store = connectedStore()
    const calls: string[] = []
    const fetchImpl = vi.fn(async (url: unknown, init?: RequestInit) => {
      const target = String(url)
      if (target.includes('tokens/bearer')) {
        calls.push('refresh')
        return jsonResponse({ access_token: 'access-new', refresh_token: 'refresh-new', expires_in: 3600 })
      }
      const auth = String((init?.headers as Record<string, string>)?.['Authorization'] ?? '')
      calls.push(`get:${auth}`)
      return auth.endsWith('access-new')
        ? jsonResponse({ CompanyInfo: { CompanyName: 'Sandbox Company US 0b8b' } })
        : textResponse('unauthorized', 401)
    }) as unknown as typeof globalThis.fetch

    const body = await qboGet(REALM, 'companyinfo/1', {}, {
      secretStore: store,
      fetch: fetchImpl,
      now: () => NOW
    })

    expect(calls).toEqual(['get:Bearer access-fresh', 'refresh', 'get:Bearer access-new'])
    expect(body).toEqual({ CompanyInfo: { CompanyName: 'Sandbox Company US 0b8b' } })
    // The rotated refresh token landed before the retry used the new access token.
    expect(store.get(QBO_REFRESH_TOKEN_SECRET)).toBe('refresh-new')
  })

  it('gives up after a second 401 rather than spinning', async () => {
    const store = connectedStore()
    let getCount = 0
    const fetchImpl = vi.fn(async (url: unknown) => {
      if (String(url).includes('tokens/bearer')) {
        return jsonResponse({ access_token: 'a2', refresh_token: 'r2', expires_in: 3600 })
      }
      getCount += 1
      return textResponse('unauthorized', 401)
    }) as unknown as typeof globalThis.fetch

    await expect(
      qboGet(REALM, 'companyinfo/1', {}, { secretStore: store, fetch: fetchImpl, now: () => NOW })
    ).rejects.toThrow(QBO_REQUEST_FAILED)
    expect(getCount).toBe(2)
  })

  it('never forwards an Intuit fault body, which carries the request URL and the realm id', async () => {
    const store = connectedStore()
    const fault = `Fault: AuthenticationFailed at https://sandbox-quickbooks.api.intuit.com/v3/company/${REALM}/query`
    const fetchImpl = vi.fn(async () => textResponse(fault, 403)) as unknown as typeof globalThis.fetch

    const rejection = await qboGet(REALM, 'query', {}, {
      secretStore: store,
      fetch: fetchImpl,
      now: () => NOW
    }).catch((err: unknown) => err)

    const text = `${(rejection as Error).message} ${(rejection as Error).stack ?? ''}`
    expect(text).not.toContain(REALM)
    expect(text).not.toContain('sandbox-quickbooks.api.intuit.com')
    expect(text).not.toContain('AuthenticationFailed')
  })

  it('maps a thrown transport error to the request-failed code', async () => {
    const store = connectedStore()
    const fetchImpl = vi.fn(async () => {
      throw new Error('socket hang up')
    }) as unknown as typeof globalThis.fetch

    await expect(
      qboGet(REALM, 'query', {}, { secretStore: store, fetch: fetchImpl, now: () => NOW })
    ).rejects.toThrow(QBO_REQUEST_FAILED)
  })

  it('maps an unparseable success body to the request-failed code', async () => {
    const store = connectedStore()
    const fetchImpl = vi.fn(async () =>
      new Response('<html>gateway</html>', { status: 200 })
    ) as unknown as typeof globalThis.fetch

    await expect(
      qboGet(REALM, 'query', {}, { secretStore: store, fetch: fetchImpl, now: () => NOW })
    ).rejects.toThrow(QBO_REQUEST_FAILED)
  })
})

describe('qboQueryAll walks every page', () => {
  it('keeps requesting while pages come back full and stops on the first short one', async () => {
    const store = connectedStore()
    const firstPage = Array.from({ length: QUERY_PAGE_SIZE }, (_, i) => vendor(i + 1))
    const secondPage = [vendor(1001), vendor(1002), vendor(1003)]
    const requested: string[] = []

    const fetchImpl = vi.fn(async (url: unknown) => {
      const target = String(url)
      requested.push(target)
      const start = /STARTPOSITION\+(\d+)/.exec(target)?.[1]
      return jsonResponse({ QueryResponse: { Vendor: start === '1' ? firstPage : secondPage } })
    }) as unknown as typeof globalThis.fetch

    const rows = await qboQueryAll(REALM, 'SELECT * FROM Vendor', 'Vendor', {
      secretStore: store,
      fetch: fetchImpl,
      now: () => NOW
    })

    expect(rows).toHaveLength(QUERY_PAGE_SIZE + 3)
    expect(requested).toHaveLength(2)
    // Spaces arrive as + inside the encoded query parameter.
    expect(requested[0]).toContain(`MAXRESULTS+${QUERY_PAGE_SIZE}`)
    expect(requested[0]).toContain('STARTPOSITION+1')
    expect(requested[1]).toContain(`STARTPOSITION+${QUERY_PAGE_SIZE + 1}`)
  })

  it('stops after a single request when the first page is short', async () => {
    const store = connectedStore()
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ QueryResponse: { Vendor: [vendor(1), vendor(2)] } })
    ) as unknown as typeof globalThis.fetch

    const rows = await qboQueryAll(REALM, 'SELECT * FROM Vendor', 'Vendor', {
      secretStore: store,
      fetch: fetchImpl,
      now: () => NOW
    })

    expect(rows).toHaveLength(2)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('treats an empty QueryResponse as a legitimate empty answer, not a failure', async () => {
    // A company with no items at all answers with an empty envelope. Throwing there would make a
    // perfectly normal company impossible to sync.
    const store = connectedStore()
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ QueryResponse: {}, time: '2026-07-27T12:00:00.000Z' })
    ) as unknown as typeof globalThis.fetch

    await expect(
      qboQueryAll(REALM, 'SELECT * FROM Item', 'Item', {
        secretStore: store,
        fetch: fetchImpl,
        now: () => NOW
      })
    ).resolves.toEqual([])
  })
})

describe('fetchCompanyName', () => {
  it('returns the display name', async () => {
    const store = connectedStore()
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ CompanyInfo: { CompanyName: 'Sandbox Company US 0b8b', LegalName: 'Legal' } })
    ) as unknown as typeof globalThis.fetch

    await expect(
      fetchCompanyName(REALM, { secretStore: store, fetch: fetchImpl, now: () => NOW })
    ).resolves.toBe('Sandbox Company US 0b8b')
  })

  it('falls back to the legal name, then to null, rather than failing a connection', async () => {
    const store = connectedStore()
    const legalOnly = vi.fn(async () =>
      jsonResponse({ CompanyInfo: { LegalName: 'Legal Only LLC' } })
    ) as unknown as typeof globalThis.fetch
    await expect(
      fetchCompanyName(REALM, { secretStore: store, fetch: legalOnly, now: () => NOW })
    ).resolves.toBe('Legal Only LLC')

    const nameless = vi.fn(async () => jsonResponse({ CompanyInfo: {} })) as unknown as typeof globalThis.fetch
    await expect(
      fetchCompanyName(REALM, { secretStore: connectedStore(), fetch: nameless, now: () => NOW })
    ).resolves.toBeNull()
  })
})
