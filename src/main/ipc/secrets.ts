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

import { ipcMain } from 'electron'
import { Channels } from '../../shared/ipc-contract'
import { SecretKeySchema, SecretSetSchema } from '../../shared/schemas'
import { secretStore } from '../secrets/secret-store'
import { assertTrustedSender } from './trusted-sender'

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
