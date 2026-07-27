// src/main/ipc/secrets.ts
//
// secrets:set / secrets:get / secrets:delete IPC handlers.
//
// Every handler runs assertTrustedSender(event) first (T-01-03), then Zod-parses the
// payload, then delegates to secretStore (safeStorage-backed). This module never touches
// the SQLite handle and never writes any secret material to app.db (D-12): the ONLY store
// it references is secretStore, which encrypts to secrets.enc. Secret values are never
// logged (T-01-05). When the OS keychain backend is unavailable, the handlers return null
// gracefully rather than throwing a raw stack trace into the renderer (T-01-05,
// error-handling control).
//
// WRITE-ONLY SECRETS (Phase 3, D-05, threat T-03-01). This channel is generic by design: any
// key, any value. Phase 3 then chose to store the AI API key and base URL through it, which made
// `window.api.secrets.get('ai-api-key')` a one-line credential read from renderer JavaScript —
// the exact opposite of what three Phase 3 file headers claim. The deny-list below is what makes
// those claims true: a credential can be WRITTEN from the settings form and DELETED from it, but
// it is only ever READ main-side, by src/main/ai/client.ts's buildClient. The canary round trip
// the Settings HealthIndicator and e2e/secret-roundtrip.spec.ts depend on is untouched, because
// those use non-credential keys.

import { ipcMain } from 'electron'
import { Channels } from '../../shared/ipc-contract'
import { SecretKeySchema, SecretSetSchema } from '../../shared/schemas'
import { AI_API_KEY_SECRET, AI_BASE_URL_SECRET } from '../ai/client'
import { QBO_SECRET_KEYS } from '../qbo/secret-keys'
import { secretStore } from '../secrets/secret-store'
import { assertTrustedSender } from './trusted-sender'

/**
 * Secrets the renderer may write but must never read back.
 *
 * Both AI credentials qualify: the key is a live billing credential, and the base URL is stored
 * in the keychain precisely because it identifies the endpoint that key is sent to. Any renderer
 * script execution (a compromised dependency in the bundle, a future feature that renders remote
 * content, a devtools-reachable path in a dev build) would otherwise exfiltrate both in one line.
 *
 * Add every future credential here. It is deliberately a DENY-list rather than an allow-list so
 * the generic store keeps working for non-secret round trips like the health canary; the moment a
 * new credential lands, it goes in this set.
 *
 * The QuickBooks keys are pulled in as a LIST from src/main/qbo/secret-keys.ts rather than spelled
 * out here (finish sprint, SEAMS). Four agents work in parallel, and a credential is only as safe
 * as the odds that whoever adds it remembers to edit this file too. Sourcing the names from the
 * module QBO-CONNECT already owns means a new token key is denied by default.
 */
const RENDERER_UNREADABLE: ReadonlySet<string> = new Set([
  AI_API_KEY_SECRET,
  AI_BASE_URL_SECRET,
  ...QBO_SECRET_KEYS
])

/** Is this key readable by the renderer? Exported for the handler-level regression spec. */
export function isRendererReadable(key: string): boolean {
  return !RENDERER_UNREADABLE.has(key)
}

/** Register the secrets channel handlers. Call after app 'ready' (safeStorage needs it). */
export function registerSecretsIpc(): void {
  ipcMain.handle(Channels.secretsSet, (event, raw) => {
    assertTrustedSender(event)
    const { key, value } = SecretSetSchema.parse(raw)
    if (!secretStore.available()) return null
    secretStore.set(key, value)
    return null
  })

  ipcMain.handle(Channels.secretsGet, (event, raw) => {
    assertTrustedSender(event)
    const key = SecretKeySchema.parse(raw)
    // A live credential is never handed back across this boundary, whatever the store says.
    // Null (rather than a throw) keeps the shape identical to the keychain-unavailable case, so
    // a caller learns nothing about whether the secret exists.
    if (!isRendererReadable(key)) return null
    if (!secretStore.available()) return null
    return secretStore.get(key)
  })

  ipcMain.handle(Channels.secretsDelete, (event, raw) => {
    assertTrustedSender(event)
    const key = SecretKeySchema.parse(raw)
    if (!secretStore.available()) return null
    secretStore.delete(key)
    return null
  })
}
