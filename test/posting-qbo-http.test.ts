// test/posting-qbo-http.test.ts
//
// createHttpQboApi, driven by an injected fetch.
//
// The real client is complete apart from its CONFIG (base URL, realm id, access-token getter),
// which the integration wave supplies from the live connection. Everything else, including the
// idempotency key on the URL and the error classification, is testable now and is tested now.
//
// The error assertions are the security half: a QuickBooks fault body is assembled from the
// request and carries the URL and the realm id, so this client never reads a response body into a
// thrown error. What it throws is an opaque code, which the boundary maps to a sentence.

import { describe, expect, it, vi } from 'vitest'
import { createHttpQboApi, resolveQboApi, setQboApiProvider } from '../src/main/posting/qbo-api'
import type { QboBillPayload } from '../src/main/posting/entity-builders'

const BILL: QboBillPayload = {
  VendorRef: { value: '42' },
  TxnDate: '2026-07-27',
  Line: [
    {
      Amount: '123.45',
      DetailType: 'AccountBasedExpenseLineDetail',
      AccountBasedExpenseLineDetail: { AccountRef: { value: '7' } }
    }
  ]
}

interface Call {
  url: string
  init: RequestInit
}

function client(
  respond: (call: Call) => Response | Promise<Response>,
  calls: Call[] = []
): ReturnType<typeof createHttpQboApi> {
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const call: Call = { url: String(url), init: init ?? {} }
    calls.push(call)
    return await respond(call)
  }) as unknown as typeof fetch
  return createHttpQboApi({
    baseUrl: 'https://sandbox-quickbooks.api.intuit.com',
    realmId: '9341457604445280',
    getAccessToken: async () => 'test-access-token',
    fetchImpl
  })
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })
}

describe('createBill', () => {
  it('POSTs to the bill endpoint with the requestid and minorversion on the query string', async () => {
    const calls: Call[] = []
    const api = client(() => json({ Bill: { Id: '55', SyncToken: '0' } }), calls)

    const result = await api.createBill(BILL, 'req-abc')

    expect(result).toEqual({ id: '55', syncToken: '0', replayed: false })
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe(
      'https://sandbox-quickbooks.api.intuit.com/v3/company/9341457604445280/bill?minorversion=75&requestid=req-abc'
    )
    expect(calls[0].init.method).toBe('POST')
    expect(JSON.parse(calls[0].init.body as string)).toEqual(BILL)
  })

  it('sends the bearer token and asks for JSON', async () => {
    const calls: Call[] = []
    const api = client(() => json({ Bill: { Id: '1', SyncToken: '0' } }), calls)
    await api.createBill(BILL, 'r')
    const headers = calls[0].init.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer test-access-token')
    expect(headers.Accept).toBe('application/json')
  })

  it('reads the token per request, so a mid-batch refresh is picked up', async () => {
    const calls: Call[] = []
    let token = 'first'
    const api = createHttpQboApi({
      baseUrl: 'https://x',
      realmId: '1',
      getAccessToken: async () => token,
      fetchImpl: (async (url: string, init: RequestInit) => {
        calls.push({ url: String(url), init })
        return json({ Bill: { Id: '1', SyncToken: '0' } })
      }) as unknown as typeof fetch
    })

    await api.createBill(BILL, 'r1')
    token = 'refreshed'
    await api.createBill(BILL, 'r2')

    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer first')
    expect((calls[1].init.headers as Record<string, string>).Authorization).toBe('Bearer refreshed')
  })

  it('posts a Purchase to the purchase endpoint', async () => {
    const calls: Call[] = []
    const api = client(() => json({ Purchase: { Id: '9', SyncToken: '0' } }), calls)
    const result = await api.createPurchase(
      {
        PaymentType: 'Check',
        AccountRef: { value: '35' },
        EntityRef: { value: '42', type: 'Vendor' },
        TxnDate: '2026-07-27',
        Line: BILL.Line
      },
      'r'
    )
    expect(result.id).toBe('9')
    expect(calls[0].url).toContain('/purchase?')
  })
})

describe('error classification never forwards provider text', () => {
  it('maps 401 and 403 to "not connected"', async () => {
    const api = client(() => json({ Fault: { Error: [{ Detail: 'token expired' }] } }, 401))
    await expect(api.createBill(BILL, 'r')).rejects.toThrow('POSTING_NOT_CONNECTED')
  })

  it('maps 5xx and 429 to "try again"', async () => {
    await expect(client(() => json({}, 500)).createBill(BILL, 'r')).rejects.toThrow(
      'POSTING_UNAVAILABLE'
    )
    await expect(client(() => json({}, 429)).createBill(BILL, 'r')).rejects.toThrow(
      'POSTING_UNAVAILABLE'
    )
  })

  it('maps a 4xx validation fault to "this entry is wrong", without its body', async () => {
    const api = client(() =>
      json(
        {
          Fault: {
            Error: [
              {
                Message: 'Invalid Reference Id',
                Detail:
                  'Accounts element id 7 not found at https://sandbox-quickbooks.api.intuit.com/v3/company/9341457604445280/bill'
              }
            ]
          }
        },
        400
      )
    )
    const err = await api.createBill(BILL, 'r').catch((e: Error) => e)
    expect((err as Error).message).toBe('POSTING_REJECTED')
    expect((err as Error).message).not.toContain('intuit.com')
    expect((err as Error).message).not.toContain('9341457604445280')
  })

  it('maps a transport failure to "try again" and drops the host it carried', async () => {
    const api = client(() => {
      throw new Error('getaddrinfo ENOTFOUND sandbox-quickbooks.api.intuit.com')
    })
    const err = await api.createBill(BILL, 'r').catch((e: Error) => e)
    expect((err as Error).message).toBe('POSTING_UNAVAILABLE')
    expect((err as Error).message).not.toContain('intuit.com')
  })

  it('rejects a 200 whose body is not the entity shape', async () => {
    await expect(client(() => json({ Bill: {} })).createBill(BILL, 'r')).rejects.toThrow(
      'POSTING_REJECTED'
    )
    await expect(
      client(() => new Response('not json', { status: 200 })).createBill(BILL, 'r')
    ).rejects.toThrow('POSTING_REJECTED')
  })
})

describe('readEntity', () => {
  it('returns the live id and SyncToken', async () => {
    const calls: Call[] = []
    const api = client(() => json({ Bill: { Id: '55', SyncToken: '3' } }), calls)
    expect(await api.readEntity('Bill', '55')).toEqual({ id: '55', syncToken: '3' })
    expect(calls[0].url).toBe(
      'https://sandbox-quickbooks.api.intuit.com/v3/company/9341457604445280/bill/55?minorversion=75'
    )
    expect(calls[0].init.method).toBe('GET')
  })

  it('returns null for a deleted entity, because absence is the answer and not an error', async () => {
    const api = client(() => json({ Fault: { Error: [{ code: '610' }] } }, 400))
    expect(await api.readEntity('Bill', '55')).toBeNull()
  })

  it('still throws for a genuine transport failure, so undo does not read "already gone"', async () => {
    // The distinction matters: treating an offline network as "the entity is gone" would clear the
    // dedupe ledger for a bill that is very much still in QuickBooks.
    const api = client(() => {
      throw new Error('socket hang up')
    })
    await expect(api.readEntity('Bill', '55')).rejects.toThrow('POSTING_UNAVAILABLE')
  })
})

describe('deleteEntity', () => {
  it('POSTs the id and SyncToken to the delete operation', async () => {
    const calls: Call[] = []
    const api = client(() => json({ Bill: { Id: '55', SyncToken: '1' } }), calls)
    await api.deleteEntity('Bill', '55', '0')
    expect(calls[0].url).toBe(
      'https://sandbox-quickbooks.api.intuit.com/v3/company/9341457604445280/bill?minorversion=75&operation=delete'
    )
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ Id: '55', SyncToken: '0' })
  })

  it('throws when QuickBooks refuses the delete', async () => {
    const api = client(() => json({ Fault: {} }, 400))
    await expect(api.deleteEntity('Bill', '55', '0')).rejects.toThrow('POSTING_REJECTED')
  })
})

describe('query', () => {
  it('returns the entity array from QueryResponse', async () => {
    const calls: Call[] = []
    const api = client(() => json({ QueryResponse: { Vendor: [{ Id: '1' }, { Id: '2' }] } }), calls)
    expect(await api.query('select * from Vendor')).toEqual([{ Id: '1' }, { Id: '2' }])
    expect(calls[0].url).toContain('query=select+*+from+Vendor')
  })

  it('returns [] when nothing matched, which QuickBooks signals by omitting the key', async () => {
    expect(await client(() => json({ QueryResponse: {} })).query('select 1')).toEqual([])
    expect(await client(() => json({})).query('select 1')).toEqual([])
  })
})

describe('the provider hook', () => {
  it('rejects with "not connected" until the integration wave registers a client', async () => {
    setQboApiProvider(null)
    await expect(resolveQboApi()).rejects.toThrow('POSTING_NOT_CONNECTED')
  })

  it('returns whatever the registered provider resolves', async () => {
    const built = client(() => json({}))
    setQboApiProvider(() => built)
    expect(await resolveQboApi()).toBe(built)
    setQboApiProvider(null)
  })

  it('supports an async provider, so a token refresh can happen before the client is built', async () => {
    const built = client(() => json({}))
    const provider = vi.fn(async () => built)
    setQboApiProvider(provider)
    expect(await resolveQboApi()).toBe(built)
    expect(provider).toHaveBeenCalledTimes(1)
    setQboApiProvider(null)
  })
})
