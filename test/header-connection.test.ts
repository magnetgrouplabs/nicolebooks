// test/header-connection.test.ts
//
// The always-visible connection slot in the top bar.
//
// THE BUG THIS FILE EXISTS BECAUSE OF. The slot shipped as a Phase 1 placeholder that read
// "Not connected" unconditionally, with a comment saying Phase 4 would replace it. Nothing did. The
// live drill screenshotted the app posting eight entries into a QuickBooks company with
// "Not connected" sitting in the top right corner of the same window.
//
// That is worse than having no indicator at all: the one piece of status a user can see from every
// screen was contradicting what the app was doing, on an app whose entire value proposition is that
// a non-technical person can trust what it tells them.
//
// Rendered with react-dom/server (no DOM), the same pattern as the other renderer specs.

import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Header, connectionLabel, connectionTone } from '../src/renderer/src/components/Header'
import type { QboStatus } from '../src/shared/ipc-contract'

function status(overrides: Partial<QboStatus> = {}): QboStatus {
  return {
    state: 'connected',
    companyName: 'Sandbox Company US 0b8b',
    realmId: '9341457604445280',
    lastSyncAt: '2026-07-27T22:00:00.000Z',
    ...overrides
  }
}

describe('connectionLabel', () => {
  // WHICH books, not merely THAT there are books. The fact a person needs before sending money
  // entries is which company they are about to touch.
  it('names the connected company', () => {
    expect(connectionLabel(status())).toBe('Sandbox Company US 0b8b')
  })

  it('falls back to a plain sentence when the company has no name', () => {
    expect(connectionLabel(status({ companyName: null }))).toBe('Connected to QuickBooks')
  })

  // The fix is one click on a button that reopens the same consent screen. Saying "Not connected"
  // would invite the user to set the whole thing up again.
  it('says Reconnect needed rather than Not connected for a dead authorization', () => {
    expect(connectionLabel(status({ state: 'expired' }))).toBe('Reconnect needed')
  })

  it('says Not connected when nothing is connected', () => {
    expect(connectionLabel(status({ state: 'disconnected', companyName: null }))).toBe(
      'Not connected'
    )
  })

  // "Not answered yet" is a third state. Claiming disconnected before the answer arrives is the
  // same class of lie the placeholder was.
  it('says it is still checking before the first answer arrives', () => {
    expect(connectionLabel(null)).toBe('Checking QuickBooks')
  })

  it('uses no em dash or en dash in any state', () => {
    for (const value of [
      connectionLabel(null),
      connectionLabel(status()),
      connectionLabel(status({ state: 'expired' })),
      connectionLabel(status({ state: 'disconnected' }))
    ]) {
      expect(value).not.toMatch(/[–—]/)
    }
  })
})

describe('connectionTone', () => {
  it('carries the state in the dot colour, from semantic tokens only', () => {
    expect(connectionTone(status())).toBe('text-success')
    expect(connectionTone(status({ state: 'expired' }))).toBe('text-destructive')
    expect(connectionTone(status({ state: 'disconnected' }))).toContain('header-foreground')
    expect(connectionTone(null)).toContain('header-foreground')
  })

  it('never hardcodes a hex colour', () => {
    for (const value of [
      connectionTone(null),
      connectionTone(status()),
      connectionTone(status({ state: 'expired' })),
      connectionTone(status({ state: 'disconnected' }))
    ]) {
      expect(value).not.toMatch(/#[0-9a-f]{3,8}/i)
    }
  })
})

describe('the header renders the injected status', () => {
  const render = (value: QboStatus | null): string =>
    renderToStaticMarkup(createElement(Header, { status: value }))

  it('shows the company name once connected', () => {
    expect(render(status())).toContain('Sandbox Company US 0b8b')
  })

  it('no longer hardcodes Not connected', () => {
    expect(render(status())).not.toContain('Not connected')
  })

  it('still shows Not connected when that is actually true', () => {
    expect(render(status({ state: 'disconnected', companyName: null }))).toContain('Not connected')
  })

  it('keeps the logo lockup, which is fixed artwork and never filtered', () => {
    const html = render(status())
    expect(html).toContain('alt="NicoleBooks"')
    expect(html).not.toContain('invert')
  })
})
