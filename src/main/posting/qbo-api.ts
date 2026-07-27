// src/main/posting/qbo-api.ts
//
// The seam between the posting engine and QuickBooks.
//
// The posting engine talks to this interface and NOTHING else. Everything above it (the batch
// state machine, the audit ledger, undo, the summary) is exercised in unit tests against an
// in-memory fake that honours the same contract, so the parts that decide whether money gets
// entered twice are proven without a network, a token, or a sandbox company.
//
// THREE PIECES LIVE HERE:
//   1. QboApi          the interface, deliberately five methods wide. Anything the posting engine
//                      cannot express through these five methods is a design smell, not a reason
//                      to widen it.
//   2. createHttpQboApi the real implementation. Complete except for its CONFIG: it takes a base
//                      URL, a realm id, and an async getAccessToken() rather than reading the
//                      token store itself, so it has no dependency on QBO-CONNECT's module graph
//                      and can be unit tested with an injected fetch.
//   3. the provider    resolveQboApi() / setQboApiProvider(). Until the integration wave wires a
//                      provider, resolveQboApi() throws POSTING_NOT_CONNECTED, which maps to
//                      "connect on the Settings screen" rather than to a crash.
//
// >>> INTEGRATION WAVE, THIS IS YOUR ONE HOOK <<<
// Call setQboApiProvider() once at startup with a function that reads the live QuickBooks
// connection (realm id + access token, refreshing as needed) and returns
// createHttpQboApi({ baseUrl, realmId, getAccessToken }). No other file needs to change.
//
// SECRETS. No token is stored, cached, or logged here. getAccessToken() is called per request so
// a refresh between two entries of one batch is picked up without the client holding a stale
// value, and the token never lands in a field somebody might serialize.

import { z } from 'zod'
import {
  createEntityPath,
  deleteEntityPath,
  readEntityPath,
  type QboBillPayload,
  type QboEntityName,
  type QboPurchasePayload
} from './entity-builders'
import { POSTING_NOT_CONNECTED, POSTING_REJECTED, POSTING_UNAVAILABLE } from './errors'

/** What a create returns: the new entity's id and its opening SyncToken. */
export interface QboCreateResult {
  id: string
  syncToken: string
  /**
   * True when QuickBooks answered from its idempotency cache (the same requestid was seen before)
   * instead of creating a new entity.
   *
   * The engine treats a replay exactly like a create, which is the point: a replay is what turns a
   * crashed batch into a resumed one. It is surfaced because it is the fact worth asserting in a
   * test, and because a replay on a FIRST attempt would mean a request id was reused across two
   * different entries, which is a bug.
   */
  replayed: boolean
}

/** What a read returns. null means QuickBooks has no such entity (deleted, or never existed). */
export interface QboReadResult {
  id: string
  syncToken: string
}

/**
 * The whole QuickBooks surface the posting engine is allowed to touch.
 *
 * createBill / createPurchase take the requestid SEPARATELY from the payload because it is not
 * part of the entity: it rides on the query string, and keeping it out of the body stops it from
 * ever being confused for a field QuickBooks stores.
 */
export interface QboApi {
  /** The company these calls act on. Recorded on every audit row. Not a credential. */
  readonly realmId: string
  createBill(payload: QboBillPayload, requestId: string): Promise<QboCreateResult>
  createPurchase(payload: QboPurchasePayload, requestId: string): Promise<QboCreateResult>
  readEntity(entity: QboEntityName, id: string): Promise<QboReadResult | null>
  deleteEntity(entity: QboEntityName, id: string, syncToken: string): Promise<void>
  query(statement: string): Promise<unknown[]>
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

/** Returns the client for the currently connected company, or throws when there is none. */
export type QboApiProvider = () => Promise<QboApi> | QboApi

let provider: QboApiProvider | null = null

/**
 * Register the live client factory. Called ONCE at startup by the integration wave.
 *
 * Passing null clears it, which is what a disconnect should do and what a test does in afterEach
 * so one spec cannot leak a client into the next.
 */
export function setQboApiProvider(next: QboApiProvider | null): void {
  provider = next
}

/**
 * Resolve the client for this call.
 *
 * Throws the mapped-at-the-boundary POSTING_NOT_CONNECTED code when nothing is registered, so the
 * pre-integration state reads to the user as "connect to QuickBooks first" instead of as a fault.
 */
export async function resolveQboApi(): Promise<QboApi> {
  if (!provider) throw new Error(POSTING_NOT_CONNECTED)
  return await provider()
}

// ---------------------------------------------------------------------------
// The real HTTP client
// ---------------------------------------------------------------------------

/**
 * Everything the HTTP client needs, injected.
 *
 * baseUrl is the environment seam Phase 8 flips: 'https://sandbox-quickbooks.api.intuit.com' now,
 * 'https://quickbooks.api.intuit.com' at production cutover, with no change to any posting logic.
 */
export interface HttpQboConfig {
  baseUrl: string
  realmId: string
  /** Called per request. Refresh handling belongs to the caller, not to this client. */
  getAccessToken: () => Promise<string>
  /** Injectable for tests. Defaults to the global fetch. */
  fetchImpl?: typeof fetch
}

/**
 * QuickBooks wraps a created entity under its type name, and the two fields that matter are Id and
 * SyncToken. Everything else in the response is ignored on purpose: parsing more would couple this
 * client to fields it does not use and break it when a minor version adds one.
 */
const EntityBodySchema = z.object({
  Id: z.string().min(1),
  SyncToken: z.string().min(1)
})

const CreateResponseSchema = z.union([
  z.object({ Bill: EntityBodySchema }),
  z.object({ Purchase: EntityBodySchema })
])

const QueryResponseSchema = z.object({
  QueryResponse: z.record(z.string(), z.unknown()).optional()
})

/** Pull the entity body out of whichever key QuickBooks used. */
function entityFrom(body: unknown, entity: QboEntityName): z.infer<typeof EntityBodySchema> {
  const parsed = CreateResponseSchema.safeParse(body)
  if (!parsed.success) throw new Error(POSTING_REJECTED)
  const value = entity === 'Bill' ? (parsed.data as { Bill?: unknown }).Bill : (parsed.data as { Purchase?: unknown }).Purchase
  const inner = EntityBodySchema.safeParse(value)
  if (!inner.success) throw new Error(POSTING_REJECTED)
  return inner.data
}

/**
 * The real client. Complete: only its config comes from elsewhere.
 *
 * Error discipline: a non-2xx response becomes POSTING_REJECTED and a transport failure becomes
 * POSTING_UNAVAILABLE. The response BODY is never read into the thrown error, because an Intuit
 * fault message is built from the request and carries the URL and the realm id. Nothing logs.
 */
export function createHttpQboApi(config: HttpQboConfig): QboApi {
  const doFetch = config.fetchImpl ?? fetch

  async function request(path: string, init: { method: string; body?: unknown }): Promise<unknown> {
    const token = await config.getAccessToken()
    let response: Response
    try {
      response = await doFetch(`${config.baseUrl}${path}`, {
        method: init.method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          'Content-Type': 'application/json'
        },
        body: init.body === undefined ? undefined : JSON.stringify(init.body)
      })
    } catch {
      // DNS, TLS, offline, timeout. The thrown value carries the host, so it is dropped entirely.
      throw new Error(POSTING_UNAVAILABLE)
    }

    if (response.status === 401 || response.status === 403) throw new Error(POSTING_NOT_CONNECTED)
    // 5xx and 429 are "try again later"; 4xx is "this entry is wrong".
    if (response.status >= 500 || response.status === 429) throw new Error(POSTING_UNAVAILABLE)
    if (!response.ok) throw new Error(POSTING_REJECTED)

    try {
      return await response.json()
    } catch {
      throw new Error(POSTING_REJECTED)
    }
  }

  async function create(
    entity: QboEntityName,
    payload: QboBillPayload | QboPurchasePayload,
    requestId: string
  ): Promise<QboCreateResult> {
    const path = createEntityPath(config.realmId, entity, requestId)
    const body = await request(path, { method: 'POST', body: payload })
    const created = entityFrom(body, entity)
    // Over HTTP a replay is indistinguishable from a create: Intuit returns the original response
    // with the same 200. That is exactly the behaviour the engine wants, and it is why the engine
    // never branches on `replayed` for correctness, only reports it.
    return { id: created.Id, syncToken: created.SyncToken, replayed: false }
  }

  return {
    realmId: config.realmId,

    createBill(payload, requestId) {
      return create('Bill', payload, requestId)
    },

    createPurchase(payload, requestId) {
      return create('Purchase', payload, requestId)
    },

    async readEntity(entity, id) {
      const path = readEntityPath(config.realmId, entity, id)
      try {
        const body = await request(path, { method: 'GET' })
        const found = entityFrom(body, entity)
        return { id: found.Id, syncToken: found.SyncToken }
      } catch (err) {
        // A deleted entity answers 400 with an "object not found" fault, which lands here as
        // POSTING_REJECTED. For a READ that is not an error, it is the answer: it is gone.
        if (err instanceof Error && err.message === POSTING_REJECTED) return null
        throw err
      }
    },

    async deleteEntity(entity, id, syncToken) {
      const path = deleteEntityPath(config.realmId, entity)
      await request(path, { method: 'POST', body: { Id: id, SyncToken: syncToken } })
    },

    async query(statement) {
      const params = new URLSearchParams({ query: statement, minorversion: '75' })
      const path = `/v3/company/${encodeURIComponent(config.realmId)}/query?${params.toString()}`
      const body = await request(path, { method: 'GET' })
      const parsed = QueryResponseSchema.safeParse(body)
      if (!parsed.success || !parsed.data.QueryResponse) return []
      // QuickBooks keys the array by entity name and omits it entirely when nothing matched.
      const first = Object.values(parsed.data.QueryResponse).find((value) => Array.isArray(value))
      return Array.isArray(first) ? first : []
    }
  }
}
