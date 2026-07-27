// src/main/qbo/service.ts
//
// The five QuickBooks operations the IPC layer exposes, assembled from the modules around it:
// oauth (consent + code exchange), tokens (keychain + rotation), connection (app_settings state),
// reference (the realm-scoped cache), and client (signed requests).
//
// This file exists so src/main/ipc/qbo.ts stays what every other handler module in this codebase is:
// a sender gate, a Zod gate, a call, and an error map. Everything below is pure orchestration with
// injectable dependencies, so the unit spec drives whole flows against a temp database, a fake
// secret store, a fake fetch, and a fake clock, with no Electron anywhere.
//
// ORDERING RULES THAT ARE NOT ARBITRARY:
//   connect    tokens are written before the realm id is recorded, so a status read can never show
//              a connected company whose credentials were not stored.
//   disconnect the cache is dropped for the realm that is leaving, so one company's vendor list can
//              never be shown while another company is connected.
//   sync       lastSyncAt is written only after the cache write succeeded, so "Last synced" never
//              claims data the grid does not have.

import type {
  QboReference,
  QboStatus,
  QboSyncResult
} from '../../shared/ipc-contract'
import { fetchCompanyName } from './client'
import {
  clearConnection,
  getLastSyncAt,
  getRealmId,
  getStatus,
  markConnected,
  markReauthRequired,
  setLastSyncAt,
  type ConnectionDeps
} from './connection'
import { QBO_NOT_CONNECTED } from './errors'
import { connectToQuickBooks, type OAuthDeps } from './oauth'
import {
  clearReference,
  readReference,
  syncReference as syncReferenceRows,
  type SyncReferenceDeps
} from './reference'
import { clearTokenSet } from './tokens'

/** Every injectable dependency the QuickBooks operations take. */
export interface QboServiceDeps extends OAuthDeps, SyncReferenceDeps, ConnectionDeps {}

/** The current connection status, computed from what is actually stored. */
export function readStatus(deps: QboServiceDeps = {}): QboStatus {
  return getStatus(deps)
}

/**
 * Run the guided sign in and record the resulting connection.
 *
 * Connecting to a DIFFERENT company drops the previous company's cached reference data. Leaving it
 * behind would let the review grid offer vendors and accounts that do not exist in the company now
 * open, which is a posting failure waiting to happen rather than a stale-data annoyance.
 *
 * The company name is best effort. A CompanyInfo read that fails must not undo a sign in the user
 * just completed, so the connection is recorded either way and the card falls back to the realm id.
 */
export async function connect(deps: QboServiceDeps = {}): Promise<QboStatus> {
  const previousRealmId = getRealmId(deps)
  const { realmId } = await connectToQuickBooks(deps)

  if (previousRealmId && previousRealmId !== realmId) {
    clearReference(previousRealmId, deps.db)
  }

  let companyName: string | null = null
  try {
    companyName = await fetchCompanyName(realmId, deps)
  } catch {
    companyName = null
  }

  markConnected({ realmId, companyName }, deps)
  return getStatus(deps)
}

/**
 * Forget the connection: tokens out of the keychain, cached reference data out of SQLite, state out
 * of app_settings. The Intuit client id and client secret are deliberately kept, because they
 * identify the app rather than the connection (see tokens.ts).
 */
export function disconnect(deps: QboServiceDeps = {}): QboStatus {
  const realmId = getRealmId(deps)
  clearTokenSet(deps)
  if (realmId) clearReference(realmId, deps.db)
  clearConnection(deps)
  return getStatus(deps)
}

/** Pull the company's reference lists into the cache and record when it happened. */
export async function syncReference(deps: QboServiceDeps = {}): Promise<QboSyncResult> {
  const realmId = getRealmId(deps)
  if (!realmId) throw new Error(QBO_NOT_CONNECTED)

  const result = await syncReferenceRows(realmId, deps)
  setLastSyncAt(result.syncedAt, deps)
  return result
}

/** Read the cache. Never touches the network, so this works offline and never blocks the grid. */
export function getReference(deps: QboServiceDeps = {}): QboReference {
  return readReference(getRealmId(deps), getLastSyncAt(deps), deps.db)
}

/**
 * Record that the authorization is dead, so the connection card switches to Reconnect.
 *
 * The tokens are deliberately NOT cleared: keeping the (now useless) refresh token is what lets
 * getStatus report 'expired' rather than 'disconnected', which is the whole difference between
 * "press Reconnect" and "set this up again".
 */
export function markConnectionExpired(deps: QboServiceDeps = {}): void {
  markReauthRequired(deps)
}
