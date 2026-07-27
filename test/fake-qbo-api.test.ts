// test/fake-qbo-api.test.ts
//
// The fake QuickBooks, tested against its own contract.
//
// A fake carries the same risk as the code it stands in for: if it silently stops honouring
// requestid replay, every zero-duplicate assertion in test/posting-send.test.ts keeps passing while
// proving nothing. Same reason test/fake-openai-client.test.ts exists.

import { describe, expect, it } from 'vitest'
import type { QboBillPayload } from '../src/main/posting/entity-builders'
import { FakeQboApi } from './helpers/fake-qbo-api'

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

describe('requestid idempotency', () => {
  it('creates once and replays the ORIGINAL response for the same key', async () => {
    const api = new FakeQboApi()
    const first = await api.createBill(BILL, 'key-1')
    const second = await api.createBill({ ...BILL, TxnDate: '2099-01-01' }, 'key-1')

    expect(first).toEqual({ id: '1', syncToken: '0', replayed: false })
    // The replay returns the original id, even though the payload differs: that is exactly what
    // Intuit does, and the posting engine's "never lose money to a duplicate" trade depends on it.
    expect(second).toEqual({ id: '1', syncToken: '0', replayed: true })
    expect(api.entityCount()).toBe(1)
    expect(api.createAttempts).toHaveLength(2)
  })

  it('creates a second entity for a different key', async () => {
    const api = new FakeQboApi()
    await api.createBill(BILL, 'key-1')
    const second = await api.createBill(BILL, 'key-2')
    expect(second.id).toBe('2')
    expect(api.entityCount()).toBe(2)
  })

  it('shares the key space across Bill and Purchase, as one idempotency cache does', async () => {
    const api = new FakeQboApi()
    const bill = await api.createBill(BILL, 'key-1')
    const purchase = await api.createPurchase(
      {
        PaymentType: 'Check',
        AccountRef: { value: '35' },
        EntityRef: { value: '42', type: 'Vendor' },
        TxnDate: '2026-07-27',
        Line: BILL.Line
      },
      'key-1'
    )
    expect(purchase.id).toBe(bill.id)
    expect(purchase.replayed).toBe(true)
    expect(api.entityCount()).toBe(1)
  })
})

describe('injected failures', () => {
  it('fails the nominated attempt and lets the rest through', async () => {
    const api = new FakeQboApi({
      failCreate: (attempt) => (attempt.attempt === 2 ? new Error('BOOM') : null)
    })
    await expect(api.createBill(BILL, 'k1')).resolves.toMatchObject({ id: '1' })
    await expect(api.createBill(BILL, 'k2')).rejects.toThrow('BOOM')
    await expect(api.createBill(BILL, 'k3')).resolves.toMatchObject({ id: '2' })
  })

  it('fails BEFORE the idempotency check, modelling a request that never arrived', async () => {
    // The interesting failure: the engine has an entry in 'sent' and no idea whether anything was
    // created. Nothing must be cached for that key, or the retry would replay a phantom.
    let fail = true
    const api = new FakeQboApi({ failCreate: () => (fail ? new Error('BOOM') : null) })
    await expect(api.createBill(BILL, 'k1')).rejects.toThrow('BOOM')
    expect(api.entityCount()).toBe(0)

    fail = false
    const retried = await api.createBill(BILL, 'k1')
    expect(retried).toEqual({ id: '1', syncToken: '0', replayed: false })
  })

  it('can fail a read and a delete', async () => {
    const failing = new FakeQboApi({ failRead: () => new Error('READ') })
    await failing.createBill(BILL, 'k1')
    await expect(failing.readEntity('Bill', '1')).rejects.toThrow('READ')

    const failingDelete = new FakeQboApi({ failDelete: () => new Error('DELETE') })
    await failingDelete.createBill(BILL, 'k1')
    await expect(failingDelete.deleteEntity('Bill', '1', '0')).rejects.toThrow('DELETE')
  })
})

describe('SyncToken and out-of-band change', () => {
  it('opens every entity at SyncToken 0', async () => {
    const api = new FakeQboApi()
    await api.createBill(BILL, 'k1')
    expect(await api.readEntity('Bill', '1')).toEqual({ id: '1', syncToken: '0' })
  })

  it('bumps the token when the entity is edited out of band', async () => {
    const api = new FakeQboApi()
    await api.createBill(BILL, 'k1')
    api.mutateEntity('Bill', '1')
    expect(await api.readEntity('Bill', '1')).toEqual({ id: '1', syncToken: '1' })
  })

  it('refuses a delete carrying a stale token', async () => {
    const api = new FakeQboApi()
    await api.createBill(BILL, 'k1')
    api.mutateEntity('Bill', '1')
    await expect(api.deleteEntity('Bill', '1', '0')).rejects.toThrow('FAKE_QBO_STALE_TOKEN')
    expect(api.liveEntities()).toHaveLength(1)
  })
})

describe('reads and deletes', () => {
  it('returns null for an entity that never existed', async () => {
    const api = new FakeQboApi()
    expect(await api.readEntity('Bill', '404')).toBeNull()
  })

  it('returns null for a deleted entity, whether deleted through the API or out of band', async () => {
    const api = new FakeQboApi()
    await api.createBill(BILL, 'k1')
    await api.createBill(BILL, 'k2')
    await api.deleteEntity('Bill', '1', '0')
    api.deleteOutOfBand('Bill', '2')
    expect(await api.readEntity('Bill', '1')).toBeNull()
    expect(await api.readEntity('Bill', '2')).toBeNull()
    expect(api.liveEntities()).toHaveLength(0)
    // Still counted as created: the zero-duplicate assertion reads creations, not survivors.
    expect(api.entityCount()).toBe(2)
  })

  it('keys entities by type, so a Bill 1 and a Purchase 1 are different records', async () => {
    const api = new FakeQboApi()
    await api.createBill(BILL, 'k1')
    expect(await api.readEntity('Purchase', '1')).toBeNull()
  })
})

describe('query', () => {
  it('answers from the injected table and returns [] for anything else', async () => {
    const api = new FakeQboApi({ queryResults: { 'select * from Vendor': [{ Id: '1' }] } })
    expect(await api.query('select * from Vendor')).toEqual([{ Id: '1' }])
    expect(await api.query('select * from Account')).toEqual([])
  })
})

describe('realm', () => {
  it('defaults to the sandbox realm and accepts an override', () => {
    expect(new FakeQboApi().realmId).toBe('9341457604445280')
    expect(new FakeQboApi({ realmId: '123' }).realmId).toBe('123')
  })
})
