// test/helpers/fake-qbo-api.ts
//
// A high-fidelity in-memory QuickBooks, standing in for the real API across the posting suite.
// Same role as test/helpers/fake-openai-client.ts, and it exists for the same reason: the
// behaviour worth proving here is the app's, not the network's.
//
// FIDELITY IS THE POINT. A fake that just returns { id: '1' } would let every duplicate bug in
// this phase pass. This one models the three QuickBooks behaviours the engine actually leans on:
//
//   1. REQUESTID IDEMPOTENCY. A create carrying a requestid that has been seen before returns the
//      ORIGINAL response and creates nothing. That is the entire mechanism behind "a crash
//      mid-batch produces zero duplicates", so a fake that ignored requestid would make the
//      headline test vacuous.
//   2. SYNCTOKEN. Every entity gets one at creation, and mutateEntity() bumps it the way an edit
//      in the QuickBooks web UI would. That is what undo's refusal check reads.
//   3. FAILURE AT ARBITRARY POINTS. failCreate/failRead/failDelete are called with the attempt and
//      may return an Error, so a spec can break the third of five creates, or one delete, and
//      watch what the engine does with the rest.
//
// Counters worth asserting on:
//   createAttempts  every create call, INCLUDING replays and failures
//   entityCount()   how many entities actually exist. The zero-duplicate assertion.

import type {
  QboApi,
  QboCreateResult,
  QboReadResult
} from '../../src/main/posting/qbo-api'
import type {
  QboBillPayload,
  QboEntityName,
  QboPurchasePayload
} from '../../src/main/posting/entity-builders'

/** One entity as the fake stores it. */
export interface FakeEntity {
  entity: QboEntityName
  id: string
  syncToken: string
  payload: QboBillPayload | QboPurchasePayload
  requestId: string
  deleted: boolean
}

/** One create attempt, recorded whether it created, replayed, or failed. */
export interface FakeCreateAttempt {
  entity: QboEntityName
  requestId: string
  payload: QboBillPayload | QboPurchasePayload
  /** 1-based across ALL creates on this fake, so a spec can say "break the third one". */
  attempt: number
}

export interface FakeReadAttempt {
  entity: QboEntityName
  id: string
  attempt: number
}

export interface FakeDeleteAttempt {
  entity: QboEntityName
  id: string
  syncToken: string
  attempt: number
}

export interface FakeQboOptions {
  realmId?: string
  /** Return an Error to fail this create, or null to let it through. */
  failCreate?: (attempt: FakeCreateAttempt) => Error | null
  failRead?: (attempt: FakeReadAttempt) => Error | null
  failDelete?: (attempt: FakeDeleteAttempt) => Error | null
  /** Query results, keyed by the exact statement. Unmatched statements return []. */
  queryResults?: Record<string, unknown[]>
}

export class FakeQboApi implements QboApi {
  readonly realmId: string

  /** requestid -> the response first returned for it. The idempotency cache. */
  private readonly byRequestId = new Map<string, QboCreateResult>()
  /** `${entity}:${id}` -> the entity. */
  private readonly entities = new Map<string, FakeEntity>()

  readonly createAttempts: FakeCreateAttempt[] = []
  readonly readAttempts: FakeReadAttempt[] = []
  readonly deleteAttempts: FakeDeleteAttempt[] = []

  private nextId = 1
  private readonly options: FakeQboOptions

  constructor(options: FakeQboOptions = {}) {
    this.options = options
    this.realmId = options.realmId ?? '9341457604445280'
  }

  createBill(payload: QboBillPayload, requestId: string): Promise<QboCreateResult> {
    return this.create('Bill', payload, requestId)
  }

  createPurchase(payload: QboPurchasePayload, requestId: string): Promise<QboCreateResult> {
    return this.create('Purchase', payload, requestId)
  }

  private async create(
    entity: QboEntityName,
    payload: QboBillPayload | QboPurchasePayload,
    requestId: string
  ): Promise<QboCreateResult> {
    const attempt: FakeCreateAttempt = {
      entity,
      requestId,
      payload,
      attempt: this.createAttempts.length + 1
    }
    this.createAttempts.push(attempt)

    // The injected failure runs FIRST, before the idempotency check, so a spec can model a request
    // that never reached QuickBooks at all. That is the interesting failure: the engine has an
    // entry in 'sent' and no idea whether anything was created.
    const failure = this.options.failCreate?.(attempt)
    if (failure) throw failure

    const replay = this.byRequestId.get(requestId)
    if (replay) {
      // The behaviour the whole phase depends on: same key, original answer, nothing created.
      return { ...replay, replayed: true }
    }

    const id = String(this.nextId)
    this.nextId += 1
    this.entities.set(`${entity}:${id}`, {
      entity,
      id,
      syncToken: '0',
      payload,
      requestId,
      deleted: false
    })
    const result: QboCreateResult = { id, syncToken: '0', replayed: false }
    this.byRequestId.set(requestId, result)
    return result
  }

  async readEntity(entity: QboEntityName, id: string): Promise<QboReadResult | null> {
    const attempt: FakeReadAttempt = { entity, id, attempt: this.readAttempts.length + 1 }
    this.readAttempts.push(attempt)
    const failure = this.options.failRead?.(attempt)
    if (failure) throw failure

    const found = this.entities.get(`${entity}:${id}`)
    if (!found || found.deleted) return null
    return { id: found.id, syncToken: found.syncToken }
  }

  async deleteEntity(entity: QboEntityName, id: string, syncToken: string): Promise<void> {
    const attempt: FakeDeleteAttempt = {
      entity,
      id,
      syncToken,
      attempt: this.deleteAttempts.length + 1
    }
    this.deleteAttempts.push(attempt)
    const failure = this.options.failDelete?.(attempt)
    if (failure) throw failure

    const found = this.entities.get(`${entity}:${id}`)
    if (!found || found.deleted) throw new Error('FAKE_QBO_ENTITY_MISSING')
    // QuickBooks rejects a delete carrying a stale token. Undo re-reads first, so this is the
    // second of two guards; modelling it keeps the fake honest if that order ever changes.
    if (found.syncToken !== syncToken) throw new Error('FAKE_QBO_STALE_TOKEN')
    found.deleted = true
  }

  async query(statement: string): Promise<unknown[]> {
    return this.options.queryResults?.[statement] ?? []
  }

  // --- test-only controls ---------------------------------------------------

  /**
   * Edit an entity out of band, exactly as somebody working in the QuickBooks web UI would: the
   * SyncToken increments. This is what makes undo refuse.
   */
  mutateEntity(entity: QboEntityName, id: string): void {
    const found = this.entities.get(`${entity}:${id}`)
    if (!found) throw new Error(`fake: no ${entity} ${id}`)
    found.syncToken = String(Number(found.syncToken) + 1)
  }

  /** Delete an entity out of band, as somebody deleting it in QuickBooks would. */
  deleteOutOfBand(entity: QboEntityName, id: string): void {
    const found = this.entities.get(`${entity}:${id}`)
    if (!found) throw new Error(`fake: no ${entity} ${id}`)
    found.deleted = true
  }

  /** Every entity ever created, deleted ones included. */
  allEntities(): FakeEntity[] {
    return [...this.entities.values()]
  }

  /** Entities that currently exist. The zero-duplicate assertion reads this. */
  liveEntities(): FakeEntity[] {
    return this.allEntities().filter((e) => !e.deleted)
  }

  /** How many entities were CREATED (not attempts, not replays). */
  entityCount(): number {
    return this.entities.size
  }

  getEntity(entity: QboEntityName, id: string): FakeEntity | undefined {
    return this.entities.get(`${entity}:${id}`)
  }
}
