// test/oauth-callback-page.test.ts
//
// docs/oauth-callback.html: the page Intuit redirects to on PRODUCTION keys, which forwards the
// sign in back to the app's loopback listener on this computer.
//
// WHY A PAGE GETS ITS OWN SPEC. It is the one piece of this app that runs somewhere the app cannot
// see, on a host anyone can fetch, holding a one time authorization code in its query string. Two
// properties have to be true and neither is provable by looking at a screenshot:
//
//   1. IT REACHES NOTHING. No script file, no stylesheet, no font, no image, no analytics, no
//      fetch. Everything is inline. A single external reference would put a third party in the
//      middle of somebody's QuickBooks authorization, and it would be invisible in the rendered
//      page. So the assertion is on the source, and it is deliberately blunt.
//   2. IT FORWARDS VERBATIM. The query string is copied, not parsed, re-encoded, or filtered. A
//      helpful normalization here would silently corrupt a code or drop the state nonce, and the
//      failure would surface as "that sign in could not be verified" with nothing to point at.
//
// The second half of this file EXECUTES the page's script against a stub window rather than
// pattern-matching it, because "the file contains location.replace" is not the same claim as "the
// address it navigates to is the loopback plus the untouched query string".

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { QBO_FORWARDER_REDIRECT_URI, QBO_REDIRECT_URI } from '../src/main/qbo/env'

const PAGE_PATH = resolve(__dirname, '../docs/oauth-callback.html')
const html = readFileSync(PAGE_PATH, 'utf8')

/** The one inline script block. There must be exactly one, and it must have no src. */
function pageScript(): string {
  const blocks = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
  expect(blocks).toHaveLength(1)
  expect(blocks[0][1].trim()).toBe('')
  return blocks[0][2]
}

describe('the forwarder page reaches nothing', () => {
  it('has no external references of any kind', () => {
    // One assertion per shape a reference can take, so a failure names the shape that appeared.
    expect(html).not.toMatch(/<script[^>]+src=/i)
    expect(html).not.toMatch(/<link\b/i)
    expect(html).not.toMatch(/<img\b/i)
    expect(html).not.toMatch(/<iframe\b/i)
    expect(html).not.toMatch(/@import/i)
    expect(html).not.toMatch(/url\(/i)
    expect(html).not.toMatch(/\bfetch\s*\(/)
    expect(html).not.toMatch(/XMLHttpRequest|WebSocket|navigator\.sendBeacon|EventSource/)
    expect(html).not.toMatch(/<form\b/i)
  })

  it('names no host but this computer, anywhere in the file', () => {
    // Every URL-looking string in the whole file, comments included, so a tracker or a CDN cannot
    // hide among them. localhost is the only hostname allowed to appear at all.
    const urls = [...html.matchAll(/https?:\/\/[^\s"'<>)]+/g)].map((m) => m[0])
    expect(urls.length).toBeGreaterThan(0)
    expect([...new Set(urls.map((url) => new URL(url).hostname))]).toEqual(['localhost'])
  })

  it('forwards to the exact loopback address the app binds', () => {
    expect(pageScript()).toContain(QBO_REDIRECT_URI)
  })

  it('does not name its own https address, which would be a redirect loop', () => {
    expect(html).not.toContain(QBO_FORWARDER_REDIRECT_URI)
  })

  it('carries no em dashes or en dashes, like every other string a person reads here', () => {
    expect(html).not.toMatch(/[–—]/)
  })
})

describe('the forwarder page script', () => {
  /**
   * Run the page's script against a stub window and document.
   *
   * The script refers to bare `window` and `document`, so passing them as parameters to a Function
   * built from the source is enough to sandbox it: no DOM, no jsdom, and the code under test is the
   * exact text that ships.
   */
  function runScript(search: string): { replaced: string[]; timeouts: number[]; text: string } {
    const replaced: string[] = []
    const timeouts: number[] = []
    const elements = new Map<string, { textContent: string; style: { display: string } }>()
    for (const id of ['working', 'fallback', 'target']) {
      elements.set(id, { textContent: '', style: { display: '' } })
    }

    const documentStub = {
      getElementById(id: string) {
        const found = elements.get(id)
        if (!found) throw new Error(`the page asked for an element that is not in it: ${id}`)
        return found
      }
    }
    const windowStub = {
      location: {
        search,
        replace(url: string): void {
          replaced.push(url)
        }
      },
      setTimeout(_fn: () => void, ms: number): number {
        timeouts.push(ms)
        return 0
      }
    }

    new Function('window', 'document', pageScript())(windowStub, documentStub)
    return { replaced, timeouts, text: elements.get('target')?.textContent ?? '' }
  }

  it('navigates to the loopback with the query string appended, unchanged', () => {
    const search = '?code=AB11xyz&state=deadbeef&realmId=9341457604445280'
    const { replaced } = runScript(search)
    expect(replaced).toEqual([`${QBO_REDIRECT_URI}${search}`])
  })

  it('copies the query string byte for byte instead of parsing and rebuilding it', () => {
    // Percent encoding, a plus sign, a repeated key, an empty value: a helpful rebuild would change
    // every one of these, and an authorization code is case and byte sensitive.
    const search = '?code=a%2Bb%3Dc&state=A1+B2&realmId=1&realmId=2&extra='
    const { replaced } = runScript(search)
    expect(replaced[0]).toBe(`${QBO_REDIRECT_URI}${search}`)
  })

  it('forwards an error redirect too, rather than swallowing it', () => {
    // Intuit reports a declined consent by redirecting with error=access_denied. The app has copy
    // for that; a page that only forwarded successes would leave it waiting for the timeout.
    const search = '?error=access_denied&state=deadbeef'
    const { replaced } = runScript(search)
    expect(replaced[0]).toBe(`${QBO_REDIRECT_URI}${search}`)
  })

  it('still navigates when there is no query string at all', () => {
    const { replaced } = runScript('')
    expect(replaced).toEqual([QBO_REDIRECT_URI])
  })

  it('shows the exact address to copy, so the fallback is actionable', () => {
    const search = '?code=AB11xyz&state=deadbeef&realmId=9341457604445280'
    const { text } = runScript(search)
    expect(text).toBe(`${QBO_REDIRECT_URI}${search}`)
  })

  it('reveals the fallback after about two seconds, and navigates regardless', () => {
    const { timeouts, replaced } = runScript('?code=c')
    expect(timeouts).toEqual([2000])
    // The navigation is not inside the timer: a page that waited two seconds before forwarding
    // would put a two second stall in front of every successful sign in.
    expect(replaced).toHaveLength(1)
  })

  it('carries the fallback wording the user is meant to act on', () => {
    expect(html).toContain(
      'Return to NicoleBooks and try Connect again. If this keeps happening, copy this address'
    )
    expect(html).toContain('into your browser on the computer running NicoleBooks:')
  })
})
