// test/ipc-error.test.ts
//
// The bug the live drill found, pinned so it cannot come back.
//
// Every main-side handler maps its failures to plain recoverable copy before rejecting, so the user
// never meets raw error text. Electron then throws that work away: `ipcRenderer.invoke` rejects with
// a NEW error whose message is "Error invoking remote method '<channel>': Error: <the sentence>".
// Six places in the renderer forwarded that message verbatim (which is the right instinct, and what
// the send flow, the undo flow, and the Settings QuickBooks card all do), so every one of them was
// showing an internal channel name and the word Error twice in front of the sentence.
//
// No unit test could have caught it before this one, because the wrapper is added by the IPC
// transport rather than by any code either side owns. It took a real invoke against a real handler.

import { describe, expect, it } from 'vitest'
import { ipcErrorMessage } from '../src/renderer/src/lib/ipc-error'

/** The exact string Electron produced in the drill, for the duplicate-vendor case. */
const REAL_WRAPPED =
  "Error invoking remote method 'qbo:create-vendor': Error: A vendor with this name already exists in QuickBooks. Pick it from the list instead."

const SENTENCE = 'A vendor with this name already exists in QuickBooks. Pick it from the list instead.'

describe('ipcErrorMessage', () => {
  it('recovers the sentence main actually mapped', () => {
    expect(ipcErrorMessage(new Error(REAL_WRAPPED))).toBe(SENTENCE)
  })

  it('never leaves an internal channel name in front of the user', () => {
    expect(ipcErrorMessage(new Error(REAL_WRAPPED))).not.toContain('qbo:create-vendor')
    expect(ipcErrorMessage(new Error(REAL_WRAPPED))).not.toContain('remote method')
  })

  it('strips the serialized error name whatever it is called', () => {
    expect(
      ipcErrorMessage(new Error("Error invoking remote method 'posting:send': TypeError: nope"))
    ).toBe('nope')
  })

  it('leaves an already plain sentence alone', () => {
    expect(ipcErrorMessage(new Error(SENTENCE))).toBe(SENTENCE)
  })

  // The Zod payload gate rejects BEFORE the handler's try block, so a schema failure crosses
  // unmapped and in Zod 4 that message is the whole issue array as JSON. Unwrapping must expose it
  // intact, so review/send.ts's isReadableSentence can still recognize it and refuse to show it.
  it('exposes an unmapped Zod rejection so the caller can still refuse to display it', () => {
    const zod = '[{"code":"invalid_type","expected":"object"}]'
    expect(ipcErrorMessage(new Error(`Error invoking remote method 'posting:send': Error: ${zod}`))).toBe(
      zod
    )
  })

  it('returns an empty string for anything that is not an error, so callers pick their own copy', () => {
    expect(ipcErrorMessage(undefined)).toBe('')
    expect(ipcErrorMessage('a string')).toBe('')
    expect(ipcErrorMessage(new Error('   '))).toBe('')
  })
})
