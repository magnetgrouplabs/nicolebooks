// test/qbo-connection.test.ts
//
// QBO-01 and QBO-03 coverage for the connection state machine and the service orchestration:
// disconnected to connected to expired and back, and the ordering rules that keep a half-connected
// state from ever being observable.
//
// WHY 'expired' HAS ITS OWN TEST. A rotating refresh token eventually stops working. Collapsing
// that into 'disconnected' would tell somebody their setup is gone and invite them to start over,
// when the repair is one click on the same consent screen. The tests below pin that a dead
// authorization keeps its realm id and company name, so the card can say "Reconnect needed" and
// still name the company.
//
// Runs against a real temp database and a fake secret store: no Electron, no network.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { migrate } from '../src/main/db/migrate'
import { createFakeSecretStore, jsonResponse } from './helpers/fake-secret-store'
import {
  QBO_COMPANY_NAME_SETTING,
  QBO_LAST_SYNC_SETTING,
  QBO_REALM_ID_SETTING,
  QBO_REAUTH_SETTING,
  clearConnection,
  getStatus,
  isReauthRequired,
  markConnected,
  markReauthRequired,
  readSetting,
  setLastSyncAt
} from '../src/main/qbo/connection'
import { QBO_NOT_CONNECTED } from '../src/main/qbo/errors'
import { disconnect, getReference, readStatus, syncReference } from '../src/main/qbo/service'
import { readReference } from '../src/main/qbo/reference'
import {
  QBO_ACCESS_TOKEN_SECRET,
  QBO_CLIENT_ID_SECRET,
  QBO_CLIENT_SECRET_SECRET,
  QBO_REFRESH_TOKEN_SECRET,
  QBO_TOKEN_EXPIRY_SECRET
} from '../src/main/qbo/secret-keys'

const NOW = Date.parse('2026-07-27T12:00:00.000Z')
const REALM = '9341457604445280'

let dir: string
let db: Database.Database

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nb-qbo-conn-'))
  db = new Database(join(dir, 'app.db'))
  migrate(db)
})

afterEach(() => {
  try {
    db.close()
  } catch {
    /* already closed */
  }
  rmSync(dir, { recursive: true, force: true })
})

function connectedStore() {
  return createFakeSecretStore({
    [QBO_CLIENT_ID_SECRET]: 'id',
    [QBO_CLIENT_SECRET_SECRET]: 'secret',
    [QBO_ACCESS_TOKEN_SECRET]: 'access',
    [QBO_REFRESH_TOKEN_SECRET]: 'refresh',
    [QBO_TOKEN_EXPIRY_SECRET]: String(NOW + 60 * 60 * 1000)
  })
}

describe('status is computed from what is stored, not cached', () => {
  it('is disconnected with a fresh install', () => {
    expect(getStatus({ db, secretStore: createFakeSecretStore() })).toEqual({
      state: 'disconnected',
      companyName: null,
      realmId: null,
      lastSyncAt: null
    })
  })

  it('is disconnected when a realm id survives without tokens', () => {
    // Stale app_settings must never make the card claim a connection the keychain cannot back.
    markConnected({ realmId: REALM, companyName: 'Sandbox Company US 0b8b' }, { db })
    expect(getStatus({ db, secretStore: createFakeSecretStore() }).state).toBe('disconnected')
  })

  it('is disconnected when tokens survive without a realm id', () => {
    // The mirror image: a token set with nothing to spend it on is not a connection.
    expect(getStatus({ db, secretStore: connectedStore() }).state).toBe('disconnected')
  })

  it('is connected once both halves are present, and reports the company', () => {
    markConnected({ realmId: REALM, companyName: 'Sandbox Company US 0b8b' }, { db })
    setLastSyncAt('2026-07-27T12:00:00.000Z', { db })

    expect(getStatus({ db, secretStore: connectedStore() })).toEqual({
      state: 'connected',
      companyName: 'Sandbox Company US 0b8b',
      realmId: REALM,
      lastSyncAt: '2026-07-27T12:00:00.000Z'
    })
  })

  it('degrades to a nameless connection rather than failing when CompanyInfo gave nothing', () => {
    markConnected({ realmId: REALM, companyName: null }, { db })
    const status = getStatus({ db, secretStore: connectedStore() })
    expect(status.state).toBe('connected')
    expect(status.companyName).toBeNull()
    expect(status.realmId).toBe(REALM)
  })
})

describe('the expired state', () => {
  it('reports expired, and keeps the company name so the card can still name it', () => {
    markConnected({ realmId: REALM, companyName: 'Sandbox Company US 0b8b' }, { db })
    markReauthRequired({ db })

    const status = getStatus({ db, secretStore: connectedStore() })
    expect(status.state).toBe('expired')
    expect(status.companyName).toBe('Sandbox Company US 0b8b')
    expect(status.realmId).toBe(REALM)
  })

  it('is cleared by a successful reconnect, so a repaired connection stops nagging', () => {
    markConnected({ realmId: REALM, companyName: 'Old Name' }, { db })
    markReauthRequired({ db })
    expect(isReauthRequired({ db })).toBe(true)

    markConnected({ realmId: REALM, companyName: 'Sandbox Company US 0b8b' }, { db })
    expect(isReauthRequired({ db })).toBe(false)
    expect(getStatus({ db, secretStore: connectedStore() }).state).toBe('connected')
  })

  it('drops a stale company name when a reconnect returns none', () => {
    markConnected({ realmId: REALM, companyName: 'Old Name' }, { db })
    markConnected({ realmId: REALM, companyName: null }, { db })
    expect(readSetting(QBO_COMPANY_NAME_SETTING, { db })).toBeNull()
  })
})

describe('disconnect', () => {
  it('clears tokens, connection state, and the cache for that company', async () => {
    const store = connectedStore()
    markConnected({ realmId: REALM, companyName: 'Sandbox Company US 0b8b' }, { db })
    setLastSyncAt('2026-07-27T12:00:00.000Z', { db })

    const fetchImpl = vi.fn(async (url: unknown) => {
      const target = decodeURIComponent(String(url)).replace(/\+/g, ' ')
      if (target.includes('FROM Vendor')) {
        return jsonResponse({ QueryResponse: { Vendor: [{ Id: '58', DisplayName: 'Apex', Active: true }] } })
      }
      return jsonResponse({ QueryResponse: {} })
    }) as unknown as typeof globalThis.fetch

    await syncReference({ db, secretStore: store, fetch: fetchImpl, now: () => NOW })
    expect(readReference(REALM, null, db).vendors).toHaveLength(1)

    const status = disconnect({ db, secretStore: store })

    expect(status).toEqual({
      state: 'disconnected',
      companyName: null,
      realmId: null,
      lastSyncAt: null
    })
    expect(store.get(QBO_REFRESH_TOKEN_SECRET)).toBeNull()
    expect(store.get(QBO_ACCESS_TOKEN_SECRET)).toBeNull()
    // One company's reference data must never outlive its connection.
    expect(readReference(REALM, null, db).vendors).toEqual([])
    for (const key of [QBO_REALM_ID_SETTING, QBO_COMPANY_NAME_SETTING, QBO_LAST_SYNC_SETTING, QBO_REAUTH_SETTING]) {
      expect(readSetting(key, { db })).toBeNull()
    }
  })

  it('keeps the Intuit app credentials, so a reconnect needs no retyping', () => {
    const store = connectedStore()
    markConnected({ realmId: REALM, companyName: null }, { db })
    disconnect({ db, secretStore: store })

    expect(store.get(QBO_CLIENT_ID_SECRET)).toBe('id')
    expect(store.get(QBO_CLIENT_SECRET_SECRET)).toBe('secret')
  })

  it('is safe to call when nothing is connected', () => {
    expect(() => disconnect({ db, secretStore: createFakeSecretStore() })).not.toThrow()
  })
})

describe('service-level guards', () => {
  it('refuses to sync when nothing is connected, before any network call', async () => {
    const fetchImpl = vi.fn() as unknown as typeof globalThis.fetch
    await expect(
      syncReference({ db, secretStore: connectedStore(), fetch: fetchImpl, now: () => NOW })
    ).rejects.toThrow(QBO_NOT_CONNECTED)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('records lastSyncAt only after the cache write succeeded', async () => {
    markConnected({ realmId: REALM, companyName: null }, { db })
    const failing = vi.fn(async () => {
      throw new Error('socket hang up')
    }) as unknown as typeof globalThis.fetch

    await expect(
      syncReference({ db, secretStore: connectedStore(), fetch: failing, now: () => NOW })
    ).rejects.toThrow()
    // "Last synced" must never claim data the grid does not have.
    expect(readSetting(QBO_LAST_SYNC_SETTING, { db })).toBeNull()
  })

  it('reads the cache with the recorded sync time attached', async () => {
    markConnected({ realmId: REALM, companyName: null }, { db })
    const fetchImpl = vi.fn(async (url: unknown) => {
      const target = decodeURIComponent(String(url)).replace(/\+/g, ' ')
      if (target.includes('FROM Vendor')) {
        return jsonResponse({ QueryResponse: { Vendor: [{ Id: '58', DisplayName: 'Apex', Active: true }] } })
      }
      return jsonResponse({ QueryResponse: {} })
    }) as unknown as typeof globalThis.fetch

    const result = await syncReference({ db, secretStore: connectedStore(), fetch: fetchImpl, now: () => NOW })
    const reference = getReference({ db, secretStore: connectedStore() })

    expect(reference.vendors).toHaveLength(1)
    expect(reference.syncedAt).toBe(result.syncedAt)
    expect(readStatus({ db, secretStore: connectedStore() }).lastSyncAt).toBe(result.syncedAt)
  })

  it('returns empty lists rather than throwing when nothing is connected', () => {
    expect(getReference({ db, secretStore: createFakeSecretStore() })).toEqual({
      vendors: [],
      expenseAccounts: [],
      paymentAccounts: [],
      items: [],
      syncedAt: null
    })
  })
})

describe('no credential ever reaches app_settings', () => {
  it('stores only the realm id, the company name, the sync time, and the reauth flag', () => {
    const store = connectedStore()
    markConnected({ realmId: REALM, companyName: 'Sandbox Company US 0b8b' }, { db })
    setLastSyncAt('2026-07-27T12:00:00.000Z', { db })
    markReauthRequired({ db })

    const rows = db.prepare("SELECT key, value FROM app_settings WHERE key LIKE 'qbo%'").all() as Array<{
      key: string
      value: string
    }>
    expect(rows.map((r) => r.key).sort()).toEqual([
      QBO_COMPANY_NAME_SETTING,
      QBO_LAST_SYNC_SETTING,
      QBO_REALM_ID_SETTING,
      QBO_REAUTH_SETTING
    ].sort())

    // D-12: a token in SQLite would be the leak this whole split exists to prevent.
    const serialized = JSON.stringify(rows)
    expect(serialized).not.toContain(store.get(QBO_REFRESH_TOKEN_SECRET) ?? 'refresh')
    expect(serialized).not.toContain(store.get(QBO_ACCESS_TOKEN_SECRET) ?? 'access')
    expect(serialized).not.toContain('secret')
  })

  it('clearConnection removes every qbo app_settings row', () => {
    markConnected({ realmId: REALM, companyName: 'Sandbox' }, { db })
    setLastSyncAt('2026-07-27T12:00:00.000Z', { db })
    markReauthRequired({ db })
    clearConnection({ db })

    const rows = db.prepare("SELECT key FROM app_settings WHERE key LIKE 'qbo%'").all()
    expect(rows).toEqual([])
  })
})
