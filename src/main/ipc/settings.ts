// src/main/ipc/settings.ts
//
// settings:get / settings:set IPC handlers (SC3 app_settings round trip).
//
// Every handler runs assertTrustedSender(event) first (T-01-03), then Zod-parses the
// payload with the shared schema (T-01-03 input validation), then reads or writes
// app_settings through prepared statements. There is no string interpolation of key or
// value into SQL: get binds a parameter, set uses named parameters with an ON CONFLICT
// UPSERT (T-01-06). No secret material flows through this channel (D-12); secrets have
// their own encrypted channel.

import { ipcMain } from 'electron'
import { Channels } from '../../shared/ipc-contract'
import { SettingsKeySchema, SettingsSetSchema } from '../../shared/schemas'
import { getDatabase } from '../db/connection'
import { assertTrustedSender } from './trusted-sender'

/** Register the settings channel handlers. Call after app 'ready' (getDatabase needs it). */
export function registerSettingsIpc(): void {
  const db = getDatabase()
  // Prepared once for the app lifetime; getDatabase returns a singleton handle.
  const getStmt = db.prepare('SELECT value FROM app_settings WHERE key = ?')
  const setStmt = db.prepare(
    'INSERT INTO app_settings (key, value) VALUES (@key, @value) ' +
      'ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  )

  ipcMain.handle(Channels.settingsGet, (event, raw) => {
    assertTrustedSender(event)
    const key = SettingsKeySchema.parse(raw)
    const row = getStmt.get(key) as { value: string } | undefined
    return row?.value ?? null
  })

  ipcMain.handle(Channels.settingsSet, (event, raw) => {
    assertTrustedSender(event)
    const payload = SettingsSetSchema.parse(raw)
    setStmt.run(payload)
    return true
  })
}
