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
  environmentSwitchNotice,
  formatSyncTime,
  qboStatusLabel,
  qboSyncSummary,
  QBO_ENVIRONMENT_OPTIONS,
  QBO_LIVE_WARNING,
  QBO_SWITCH_CONFIRM
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

describe('the environment selector', () => {
  it('offers exactly two options, in plain words rather than portal jargon', () => {
    expect(QBO_ENVIRONMENT_OPTIONS.map((o) => o.id)).toEqual(['sandbox', 'production'])
    expect(QBO_ENVIRONMENT_OPTIONS.map((o) => o.label)).toEqual([
      'Sandbox (testing)',
      'Live QuickBooks'
    ])
  })

  it('warns, calmly and specifically, about what Live actually means', () => {
    // The consequence a person needs before they pick it, not after: entries land in real books.
    expect(QBO_LIVE_WARNING).toBe(
      'Live mode connects to a real QuickBooks company. Entries you send will appear in its books.'
    )
  })

  it('states the consequence of switching rather than asking whether they are sure', () => {
    // The disconnect is not a precaution that can be declined: tokens issued by one environment's
    // app keys are dead in the other.
    expect(QBO_SWITCH_CONFIRM).toBe('Switching disconnects the current QuickBooks company.')
  })

  it('says what to do next after a switch, for each direction', () => {
    expect(environmentSwitchNotice('production')).toMatch(/Live QuickBooks/)
    expect(environmentSwitchNotice('production')).toMatch(/Connect/)
    expect(environmentSwitchNotice('sandbox')).toMatch(/sandbox/i)
    expect(environmentSwitchNotice('sandbox')).toMatch(/Connect/)
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
    formatSyncTime('2026-07-27T20:17:07.067Z'),
    QBO_LIVE_WARNING,
    QBO_SWITCH_CONFIRM,
    environmentSwitchNotice('production'),
    environmentSwitchNotice('sandbox'),
    ...QBO_ENVIRONMENT_OPTIONS.map((option) => option.label)
  ]

  it.each(samples)('%s is free of em dashes and en dashes', (copy) => {
    expect(copy).not.toMatch(/[–—]/)
  })
})
