// test/bills-scan-button.test.ts
//
// WR-07 regression pin: "Scan now" is unavailable while a parse batch is running.
//
// runScan fires `void runParse(loaded)` WITHOUT awaiting it, and its finally immediately sets
// scanning = false. The button's only guard was `disabled={scanning}`, so a second click while
// parsing started a second, concurrent parse:parse-batch. Three consequences, in increasing
// order of cost:
//   1. the second runScan's setParseResults({}) wiped the first batch's rows, and the first
//      batch's setParseResults then merged stale results back in when it resolved;
//   2. the first batch's finally cleared `parsing` and `parseProgress` while the second was still
//      running, so the "parsing N of M" indicator vanished mid-run;
//   3. the second batch started before the first reached putCached for the files still in flight,
//      so BOTH batches missed the cache for the same documents and both paid the model — the
//      exact double-charge PARSE-05 exists to prevent.
//
// The in-flight ref inside runParse is the second line of defence and is not reachable without a
// DOM harness; the button's disabled rule is the control the user actually meets, and it is what
// this file pins.

import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ScanButton } from '../src/renderer/src/screens/BillsScreen'

function renderButton(scanning: boolean, parsing: boolean): string {
  return renderToStaticMarkup(createElement(ScanButton, { scanning, parsing, onScan: () => {} }))
}

/**
 * The real `disabled` ATTRIBUTE, not the word. The branded Button carries Tailwind variants like
 * `disabled:opacity-50` in its class list, so a plain substring check would pass either way and
 * pin nothing.
 */
function isDisabled(html: string): boolean {
  return /<button[^>]*\sdisabled=""/.test(html)
}

describe('Scan now while a parse batch is running (WR-07)', () => {
  it('is enabled when nothing is running', () => {
    const html = renderButton(false, false)
    expect(html).toContain('Scan now')
    expect(isDisabled(html)).toBe(false)
  })

  it('is disabled while scanning', () => {
    expect(isDisabled(renderButton(true, false))).toBe(true)
  })

  it('is disabled while PARSING, which is the window the second batch used to start in', () => {
    const html = renderButton(false, true)
    expect(isDisabled(html)).toBe(true)
    // ...and says why, so the control does not simply look broken.
    expect(html).toContain('Reading bills')
  })
})
