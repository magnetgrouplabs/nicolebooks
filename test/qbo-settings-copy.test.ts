// test/qbo-settings-copy.test.ts
//
// The Settings connection card's user-facing wording, exercised through the pure helpers the screen
// exports so nothing needs a DOM.
//
// TWO RULES ARE PINNED HERE. First, 'expired' must read as "Reconnect needed" rather than "Not
// connected": the repair is one click on the same consent screen, and telling somebody their setup
// is gone would invite them to start over. Second, no em dash and no en dash anywhere, which is a
// standing house rule for every string a person will read.

import { describe, expect, it } from 'vitest'
import {
  formatSyncTime,
  qboStatusLabel,
  qboSyncSummary
} from '../src/renderer/src/screens/SettingsScreen'
import type { QboStatus } from '../src/shared/ipc-contract'

const CONNECTED: QboStatus = {
  state: 'connected',
  companyName: 'Sandbox Company US 0b8b',
  realmId: '9341457604445280',
  lastSyncAt: '2026-07-27T20:17:07.067Z'
}

describe('qboStatusLabel', () => {
  it('names the connected company', () => {
    expect(qboStatusLabel(CONNECTED)).toBe('Connected to Sandbox Company US 0b8b')
  })

  it('still reads as connected when CompanyInfo returned no name', () => {
    expect(qboStatusLabel({ ...CONNECTED, companyName: null })).toBe('Connected to QuickBooks')
  })

  it('says Reconnect needed for an expired authorization, not Not connected', () => {
    expect(qboStatusLabel({ ...CONNECTED, state: 'expired' })).toBe('Reconnect needed')
  })

  it('says Not connected for a fresh install', () => {
    expect(
      qboStatusLabel({ state: 'disconnected', companyName: null, realmId: null, lastSyncAt: null })
    ).toBe('Not connected')
  })

  it('shows a loading line rather than a false Not connected before the status arrives', () => {
    // Rendering "Not connected" for the first frame would flash a wrong answer at somebody who is
    // in fact connected.
    expect(qboStatusLabel(null)).toMatch(/checking/i)
  })
})

describe('qboSyncSummary', () => {
  it('reports every list in plain words', () => {
    const copy = qboSyncSummary({
      vendors: 32,
      expenseAccounts: 44,
      paymentAccounts: 4,
      items: 18,
      syncedAt: '2026-07-27T20:17:07.067Z'
    })
    expect(copy).toContain('32 vendors')
    expect(copy).toContain('44 expense categories')
    expect(copy).toContain('4 payment accounts')
    expect(copy).toContain('18 items')
  })
})

describe('formatSyncTime', () => {
  it('says so when nothing has been synced yet', () => {
    expect(formatSyncTime(null)).toBe('Not synced yet')
  })

  it('renders a real timestamp', () => {
    expect(formatSyncTime('2026-07-27T20:17:07.067Z')).toMatch(/^Last synced /)
  })

  it('degrades to the raw value rather than showing "Invalid Date"', () => {
    expect(formatSyncTime('not a date')).toBe('Last synced not a date')
  })
})

describe('no em dashes or en dashes in any of the card copy', () => {
  const samples = [
    qboStatusLabel(CONNECTED),
    qboStatusLabel({ ...CONNECTED, state: 'expired' }),
    qboStatusLabel({ state: 'disconnected', companyName: null, realmId: null, lastSyncAt: null }),
    qboStatusLabel(null),
    qboSyncSummary({ vendors: 1, expenseAccounts: 2, paymentAccounts: 3, items: 4, syncedAt: 'x' }),
    formatSyncTime(null),
    formatSyncTime('2026-07-27T20:17:07.067Z')
  ]

  it.each(samples)('%s is free of em dashes and en dashes', (copy) => {
    expect(copy).not.toMatch(/[–—]/)
  })
})
