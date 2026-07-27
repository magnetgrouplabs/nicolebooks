// src/main/ai/client.ts
//
// Builds the OpenAI-compatible SDK client from the credentials the user stored in the OS
// keychain (decision D-05, D-25).
//
// SECRET BOUNDARY (threat T-03-01): this module is the ONLY place the API key and the base URL
// are read, and it runs exclusively in the main process. Neither value is returned to a caller,
// put in an error message, or logged — the errors below are opaque codes that src/main/ipc/ai.ts
// maps to plain, recoverable user copy. There is no getter here that hands a credential back, so
// a compromised renderer has nothing to call.
//
// SSRF / key-exfiltration guard (threat T-03-05, 03-RESEARCH Security V14): the base URL is
// user-chosen, so it is validated as a well-formed https: URL with new URL() BEFORE the client
// is constructed. A plaintext http:// (or file:, ftp:, or malformed) target would carry the key
// to an attacker-readable channel, so it is rejected outright rather than "fixed up".
//
// The secret reader is injectable per 03-PATTERNS Shared Pattern B, so the unit spec exercises
// every guard without Electron safeStorage.

import OpenAI from 'openai'
import { secretStore } from '../secrets/secret-store'

/** Keychain key holding the OpenAI-compatible API key. Written by the Settings AI-config form. */
export const AI_API_KEY_SECRET = 'ai-api-key'

/** Keychain key holding the endpoint base URL. Stored beside the key, never in SQLite (D-05). */
export const AI_BASE_URL_SECRET = 'ai-base-url'

/** The slice of secretStore this module needs (see src/main/secrets/secret-store.ts). */
export interface SecretReader {
  get(key: string): string | null
}

/** Injectable dependencies (Shared Pattern B). Production omits deps and uses the real store. */
export interface BuildClientDeps {
  secretStore?: SecretReader
}

/**
 * Parse and validate a user-supplied base URL. Throws an opaque code — never the URL itself, so
 * the value cannot ride out through an error surface.
 *
 * AI_BASE_URL_INVALID  the string is not a URL at all
 * AI_BASE_URL_INSECURE the URL parses but is not https:
 */
export function assertHttpsBaseUrl(raw: string): URL {
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw new Error('AI_BASE_URL_INVALID')
  }
  if (parsed.protocol !== 'https:') {
    throw new Error('AI_BASE_URL_INSECURE')
  }
  return parsed
}

/**
 * Build the OpenAI-compatible client from the stored credentials, with the D-25 configuration:
 * maxRetries 3 (the SDK's transient-error retry sits INSIDE the per-file isolation of D-15) and a
 * 120s per-call timeout (the SDK default of 10 minutes is far too long for a UI showing progress).
 *
 * Throws AI_CREDENTIALS_MISSING when either credential is absent, or one of the base-URL codes
 * above. All three are recoverable-by-configuration, which is exactly how the Settings screen
 * presents them.
 */
export function buildClient(deps: BuildClientDeps = {}): OpenAI {
  const store = deps.secretStore ?? secretStore
  const apiKey = store.get(AI_API_KEY_SECRET)
  const baseUrl = store.get(AI_BASE_URL_SECRET)
  if (!apiKey || !baseUrl) {
    throw new Error('AI_CREDENTIALS_MISSING')
  }
  // Validate BEFORE constructing: the key must never be handed to a non-https target.
  assertHttpsBaseUrl(baseUrl)
  return new OpenAI({ apiKey, baseURL: baseUrl, maxRetries: 3, timeout: 120000 })
}
