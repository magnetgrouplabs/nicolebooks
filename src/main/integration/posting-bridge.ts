// src/main/integration/posting-bridge.ts
//
// The two seams POSTING-ENGINE left open, closed against the live QuickBooks connection.
//
// The posting engine was written with no knowledge of QBO-CONNECT's module graph, on purpose: it
// talks to a five-method QboApi interface and to a name resolver, and its whole batch state machine
// is proven against in-memory fakes. That is why the parts that decide whether money gets entered
// twice have unit tests with no network in them. The cost of that choice is exactly this file: one
// place where the two halves are introduced to each other.
//
// It lives in its own directory rather than inside posting/ or qbo/ because it is the ONLY module
// that legitimately imports both. Putting it in either one would make that package depend on the
// other, which is the coupling both agents avoided.
//
// WHAT IS RESOLVED PER CALL, AND WHY
//
//   realm id      read on EVERY resolve, not captured at install. Connecting a different company
//                 must change where the next batch goes; a captured realm id would keep posting to
//                 the company that happened to be open at startup.
//   access token  read per REQUEST by the HTTP client, refreshing proactively inside the ten minute
//                 skew. A batch that runs past the hour boundary therefore refreshes mid-batch
//                 instead of failing halfway through.
//   names         read per lookup from the 0004 cache, so a vendor created during the review is
//                 resolvable in the batch that follows without a full sync.
//
// ERROR TRANSLATION IS THE OTHER HALF OF THE JOB. The qbo modules throw their own vocabulary, and
// the posting error table has never heard of it, so an expired connection would reach the user as
// "something went wrong" instead of "connect on the Settings screen". The map below is small and
// deliberate: every qbo code that means "this is not going to work until you reconnect" becomes
// POSTING_NOT_CONNECTED, and everything transient becomes POSTING_UNAVAILABLE.
//
// NO TOKEN IS CAPTURED, CACHED, OR LOGGED HERE. getAccessToken is passed as a function, called by
// the client per request, and its value is never stored in a field.

import {
  createHttpQboApi,
  setQboApiProvider,
  type QboApi
} from '../posting/qbo-api'
import { POSTING_NOT_CONNECTED, POSTING_UNAVAILABLE } from '../posting/errors'
import { setPostingReference, type PostingReference } from '../posting/reference'
import {
  QBO_COMPANY_NAME_SETTING,
  getRealmId,
  markReauthRequired,
  readSetting,
  type ConnectionDeps
} from '../qbo/connection'
import { qboEnvironment, type QboEnvironment } from '../qbo/env'
import {
  QBO_CLIENT_CREDENTIALS_MISSING,
  QBO_NOT_CONNECTED,
  QBO_REAUTH_REQUIRED,
  QBO_SECRET_STORE_UNAVAILABLE,
  QBO_TOKEN_REFRESH_FAILED
} from '../qbo/errors'
import { lookupReferenceRecord } from '../qbo/reference'
import { getAccessToken, type TokenDeps } from '../qbo/tokens'

/** Injectable dependencies, so the wiring itself is unit testable with no Electron and no network. */
export interface PostingBridgeDeps extends ConnectionDeps, TokenDeps {
  environment?: QboEnvironment
}

/**
 * The API ORIGIN, which is what createHttpQboApi wants.
 *
 * The environment seam publishes `apiBaseUrl` with the '/v3/company' segment already on it, because
 * every other caller builds a company-scoped URL from it. The posting client builds its own full
 * paths (they carry the requestid and the operation), so it needs the bare host. Deriving the origin
 * here rather than adding a constant to env.ts keeps this file the only thing that has to change if
 * that seam is reshaped.
 */
export function qboApiOrigin(environment?: QboEnvironment): string {
  return new URL(qboEnvironment(environment).apiBaseUrl).origin
}

/**
 * Translate a QuickBooks-connection failure into the posting vocabulary.
 *
 * A dead grant additionally records that reauthorization is needed, so the Settings card offers
 * Reconnect the next time it reads status. It deliberately does NOT broadcast: broadcasting needs
 * BrowserWindow, and dragging Electron into the module that every posting unit test loads would
 * cost more than the immediate card refresh is worth.
 */
export function translateConnectionError(err: unknown, deps: PostingBridgeDeps = {}): Error {
  const code = err instanceof Error ? err.message : ''
  if (code === QBO_REAUTH_REQUIRED) {
    try {
      markReauthRequired(deps)
    } catch {
      // The connection is already broken; failing to write the flag must not replace the real error.
    }
    return new Error(POSTING_NOT_CONNECTED)
  }
  if (
    code === QBO_NOT_CONNECTED ||
    code === QBO_CLIENT_CREDENTIALS_MISSING ||
    code === QBO_SECRET_STORE_UNAVAILABLE
  ) {
    return new Error(POSTING_NOT_CONNECTED)
  }
  if (code === QBO_TOKEN_REFRESH_FAILED) return new Error(POSTING_UNAVAILABLE)
  return err instanceof Error ? err : new Error(String(err))
}

/**
 * Build the live client for the company that is connected RIGHT NOW.
 *
 * Throws POSTING_NOT_CONNECTED when nothing is connected, which is what resolveQboApi's contract
 * expects and what maps to "connect on the Settings screen".
 */
export function createLiveQboApi(deps: PostingBridgeDeps = {}): QboApi {
  const realmId = getRealmId(deps)
  if (!realmId) throw new Error(POSTING_NOT_CONNECTED)

  return createHttpQboApi({
    baseUrl: qboApiOrigin(deps.environment),
    realmId,
    getAccessToken: async () => {
      try {
        return await getAccessToken(deps)
      } catch (err) {
        throw translateConnectionError(err, deps)
      }
    }
  })
}

/**
 * The name and account-type resolver, backed by the 0004 reference cache.
 *
 * Every method returns null rather than throwing when the realm is unknown or the row is missing.
 * That is the contract: an unresolved name degrades a report line to a bare id, and it must never
 * fail a post. safeReference wraps this again inside the posting engine, so a throwing SQLite call
 * is also survivable.
 */
export function createLiveReference(deps: PostingBridgeDeps = {}): PostingReference {
  const lookup = (kind: 'vendor' | 'account', id: string): string | null => {
    const realmId = getRealmId(deps)
    if (!realmId) return null
    return lookupReferenceRecord(realmId, kind, id, deps.db)?.name ?? null
  }

  return {
    companyName: () => readSetting(QBO_COMPANY_NAME_SETTING, deps),
    vendorName: (vendorId) => lookup('vendor', vendorId),
    accountName: (accountId) => lookup('account', accountId),
    accountType: (accountId) => {
      const realmId = getRealmId(deps)
      if (!realmId) return null
      return lookupReferenceRecord(realmId, 'account', accountId, deps.db)?.accountType ?? null
    }
  }
}

/**
 * Close both seams. Called ONCE at startup, after the database is open and the app is ready.
 *
 * Installing is pure registration: no database read, no network call, no token access happens here.
 * Everything is resolved lazily on the first post, which is why this is safe to call before a
 * company has ever been connected.
 */
export function installPostingBridge(deps: PostingBridgeDeps = {}): void {
  setQboApiProvider(() => createLiveQboApi(deps))
  setPostingReference(createLiveReference(deps))
}
