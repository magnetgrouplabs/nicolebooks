// test/settings-key-provider.test.ts
//
// WR-08 regression pin: a stored API key is never sent to a provider it was not saved for.
//
// connectAndTest always wrote ai-base-url but wrote ai-api-key only `if (apiKey.trim())`, and the
// key field is deliberately never repopulated (its placeholder reads "Saved. Type a new key to
// replace it."). So switching the Provider dropdown from OpenAI to OpenRouter — or to "Other
// (enter a URL)" with any https host — and pressing "Connect and test" transmitted the EXISTING
// provider's key to the NEW endpoint on the very next request, in an Authorization: Bearer
// header, where a third party logs it as a failed auth attempt. assertHttpsBaseUrl prevents
// plaintext transport but says nothing about sending the credential to the wrong party, which is
// what threat T-03-05 is actually about.
//
// The decision is a pure exported function so it is testable without a DOM. The screen calls it
// BEFORE writing anything, because writing the new base URL and then refusing would leave the
// stored key paired with an endpoint it does not belong to.

import { describe, expect, it } from 'vitest'
import {
  KEY_REQUIRED_FOR_PROVIDER,
  connectBlockedReason
} from '../src/renderer/src/screens/SettingsScreen'

const OPENAI = 'https://api.openai.com/v1'
const OPENROUTER = 'https://openrouter.ai/api/v1'

describe('a stored key is never sent to a different provider (WR-08)', () => {
  it('blocks connecting to a NEW provider with a key saved for the old one', () => {
    // Nicole is told to "try OpenRouter", picks it from the dropdown, and presses the button
    // without pasting a new key. Her OpenAI key must not reach openrouter.ai.
    expect(connectBlockedReason({ baseUrl: OPENROUTER, typedKey: '', keyProvider: OPENAI })).toBe(
      KEY_REQUIRED_FOR_PROVIDER
    )
  })

  it('blocks an arbitrary custom endpoint just the same', () => {
    expect(
      connectBlockedReason({
        baseUrl: 'https://someone-elses-gateway.example/v1',
        typedKey: '',
        keyProvider: OPENAI
      })
    ).toBe(KEY_REQUIRED_FOR_PROVIDER)
  })

  it('allows a re-test against the SAME provider without retyping the key', () => {
    expect(connectBlockedReason({ baseUrl: OPENAI, typedKey: '', keyProvider: OPENAI })).toBeNull()
  })

  it('allows a new provider as soon as a key is typed for it', () => {
    expect(
      connectBlockedReason({ baseUrl: OPENROUTER, typedKey: 'sk-or-new', keyProvider: OPENAI })
    ).toBeNull()
  })

  it('blocks the first-ever connect when no key has been typed or stored', () => {
    expect(connectBlockedReason({ baseUrl: OPENAI, typedKey: '', keyProvider: null })).toBe(
      KEY_REQUIRED_FOR_PROVIDER
    )
  })

  it('still blocks an empty base URL with its own message', () => {
    const reason = connectBlockedReason({ baseUrl: '   ', typedKey: 'sk-x', keyProvider: null })
    expect(reason).toMatch(/https:\/\//)
  })

  it('treats whitespace-only input as no key typed', () => {
    expect(connectBlockedReason({ baseUrl: OPENROUTER, typedKey: '   ', keyProvider: OPENAI })).toBe(
      KEY_REQUIRED_FOR_PROVIDER
    )
  })
})
