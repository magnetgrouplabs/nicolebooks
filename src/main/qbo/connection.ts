// src/main/qbo/connection.ts
//
// Connection STATE: which company is connected, what it is called, when its reference data was last
// synced, and whether the authorization still works.
//
// THE SPLIT THIS MODULE ENFORCES. Credentials live in the OS keychain (qbo/tokens.ts). Everything
// here lives in app_settings, because none of it is secret and all of it is displayed:
//   qbo-realm-id        the QuickBooks company id, an identifier the UI shows
//   qbo-company-name    the company's display name
//   qbo-last-sync-at    ISO timestamp of the last successful reference sync
//   qbo-reauth-required '1' when a refresh came back invalid_grant
// A token in app_settings would violate D-12; a realm id in the keychain would make the connection
// card unable to render without decrypting a secret. The line is "is it a credential", not "is it
// about QuickBooks".
//
// WHY 'expired' IS A SEPARATE STATE FROM 'disconnected'. A rotating refresh token eventually stops
// working (a revoked authorization, 100 days idle, an admin change). Collapsing that into
// 'disconnected' would tell the user their setup is gone and invite them to start over, when the fix
// is one click on a button that opens the same consent screen. The reauth flag is what makes the
// card say "Reconnect needed" instead.
//
// The flag is CLEARED on every successful connect, so a repaired connection cannot keep nagging.
//
// Everything is injectable (Shared Pattern B), so the unit spec drives state transitions against a
// temp database with no Electron.

import type Database from 'better-sqlite3'
import type { QboStatus } from '../../shared/ipc-contract'
import { getDatabase } from '../db/connection'
import { readTokenSet, type SecretStoreLike, type TokenDeps } from './tokens'

/** app_settings key holding the connected QuickBooks company id. Non-secret (D-05). */
export const QBO_REALM_ID_SETTING = 'qbo-realm-id'

/** app_settings key holding the connected company's display name. */
export const QBO_COMPANY_NAME_SETTING = 'qbo-company-name'

/** app_settings key holding the ISO timestamp of the last successful reference sync. */
export const QBO_LAST_SYNC_SETTING = 'qbo-last-sync-at'

/** app_settings key set to '1' when the stored refresh token was rejected. */
export const QBO_REAUTH_SETTING = 'qbo-reauth-required'

/** Injectable dependencies for the state accessors. */
export interface ConnectionDeps {
  db?: Database.Database
  secretStore?: SecretStoreLike
}

const GET_SQL = 'SELECT value FROM app_settings WHERE key = ?'
const SET_SQL =
  'INSERT INTO app_settings (key, value) VALUES (@key, @value) ' +
  'ON CONFLICT(key) DO UPDATE SET value = excluded.value'
const DELETE_SQL = 'DELETE FROM app_settings WHERE key = ?'

function database(deps: ConnectionDeps): Database.Database {
  return deps.db ?? getDatabase()
}

/** Read one app_settings value. Bound parameter, never interpolated (T-01-06). */
export function readSetting(key: string, deps: ConnectionDeps = {}): string | null {
  const row = database(deps).prepare(GET_SQL).get(key) as { value: string } | undefined
  return row?.value ?? null
}

/** Write one app_settings value with the same UPSERT the settings channel uses. */
export function writeSetting(key: string, value: string, deps: ConnectionDeps = {}): void {
  database(deps).prepare(SET_SQL).run({ key, value })
}

function deleteSetting(key: string, deps: ConnectionDeps = {}): void {
  database(deps).prepare(DELETE_SQL).run(key)
}

/** The connected company id, or null when nothing is connected. */
export function getRealmId(deps: ConnectionDeps = {}): string | null {
  return readSetting(QBO_REALM_ID_SETTING, deps)
}

/** ISO timestamp of the last successful reference sync, or null when it has never run. */
export function getLastSyncAt(deps: ConnectionDeps = {}): string | null {
  return readSetting(QBO_LAST_SYNC_SETTING, deps)
}

/** Record a successful reference sync. */
export function setLastSyncAt(syncedAt: string, deps: ConnectionDeps = {}): void {
  writeSetting(QBO_LAST_SYNC_SETTING, syncedAt, deps)
}

/**
 * Record a completed authorization: which company, what it is called, and that reauthorization is
 * no longer needed. Called after the tokens are already stored, so a status read can never see a
 * connected company whose tokens have not landed.
 */
export function markConnected(
  input: { realmId: string; companyName: string | null },
  deps: ConnectionDeps = {}
): void {
  writeSetting(QBO_REALM_ID_SETTING, input.realmId, deps)
  if (input.companyName) {
    writeSetting(QBO_COMPANY_NAME_SETTING, input.companyName, deps)
  } else {
    deleteSetting(QBO_COMPANY_NAME_SETTING, deps)
  }
  deleteSetting(QBO_REAUTH_SETTING, deps)
}

/** Record that the stored refresh token was rejected, so the card offers Reconnect. */
export function markReauthRequired(deps: ConnectionDeps = {}): void {
  writeSetting(QBO_REAUTH_SETTING, '1', deps)
}

/** True when a refresh has come back invalid_grant and no reconnect has succeeded since. */
export function isReauthRequired(deps: ConnectionDeps = {}): boolean {
  return readSetting(QBO_REAUTH_SETTING, deps) === '1'
}

/** Forget the connected company entirely. Tokens are cleared separately, by qbo/tokens.ts. */
export function clearConnection(deps: ConnectionDeps = {}): void {
  deleteSetting(QBO_REALM_ID_SETTING, deps)
  deleteSetting(QBO_COMPANY_NAME_SETTING, deps)
  deleteSetting(QBO_LAST_SYNC_SETTING, deps)
  deleteSetting(QBO_REAUTH_SETTING, deps)
}

/**
 * Assemble the status the renderer renders.
 *
 * The state is derived from what is actually stored rather than from a flag someone remembered to
 * set. A stored refresh token plus a realm id is a connection; the reauth flag downgrades it to
 * 'expired'; anything else is 'disconnected'. A status that is computed cannot drift out of step
 * with the credentials the way a cached one can.
 */
export function getStatus(deps: ConnectionDeps & TokenDeps = {}): QboStatus {
  const realmId = getRealmId(deps)
  const tokens = readTokenSet(deps)

  if (!realmId || !tokens) {
    return { state: 'disconnected', companyName: null, realmId: null, lastSyncAt: null }
  }

  return {
    state: isReauthRequired(deps) ? 'expired' : 'connected',
    companyName: readSetting(QBO_COMPANY_NAME_SETTING, deps),
    realmId,
    lastSyncAt: getLastSyncAt(deps)
  }
}
