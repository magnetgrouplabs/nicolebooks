// src/main/qbo/secret-keys.ts
//
// The secret-store key names the QuickBooks connection uses, and the deny-list entry that keeps
// them unreadable from the renderer.
//
// WHY THIS IS A SEPARATE, DEPENDENCY-FREE MODULE (finish sprint, SEAMS). src/main/ipc/secrets.ts
// builds RENDERER_UNREADABLE, the deny-list that stops `window.api.secrets.get('...')` handing a
// live credential back to renderer JavaScript. Every new credential MUST land in that set, and
// forgetting is a one-line exfiltration (that is exactly the CR-04 defect the AI credentials hit).
// Importing this list into secrets.ts up front means QBO-CONNECT never has to edit a shared file
// mid-sprint: add a key name HERE and the deny-list picks it up automatically.
//
// It deliberately imports nothing (no electron, no db), so secrets.ts can pull it in without
// dragging the whole QuickBooks client into the module graph or into a unit test's electron mock.
//
// The tokens themselves never touch SQLite and are never written by the renderer: the OAuth flow
// runs main-side and writes them through secretStore, which encrypts via safeStorage (D-05/D-12).

/** Encrypted secret-store key for the QuickBooks OAuth 2.0 access token (lives about 1 hour). */
export const QBO_ACCESS_TOKEN_SECRET = 'qbo-access-token'

/**
 * Encrypted secret-store key for the refresh token. This one ROLLS: Intuit reissues it
 * periodically, so whatever refreshes must persist the newest value immediately or the connection
 * dies at the next refresh.
 */
export const QBO_REFRESH_TOKEN_SECRET = 'qbo-refresh-token'

/** Encrypted secret-store key for the Intuit app client secret. */
export const QBO_CLIENT_SECRET_SECRET = 'qbo-client-secret'

/**
 * Every QuickBooks secret-store key, in one list, so src/main/ipc/secrets.ts can deny renderer
 * read-back on all of them at once.
 *
 * NOT included, on purpose: the realm (company) id. It is an identifier the UI displays, not a
 * credential, so it belongs in app_settings rather than the keychain.
 *
 * QBO-CONNECT: add any further credential key to this array. Do NOT edit secrets.ts.
 */
export const QBO_SECRET_KEYS: readonly string[] = [
  QBO_ACCESS_TOKEN_SECRET,
  QBO_REFRESH_TOKEN_SECRET,
  QBO_CLIENT_SECRET_SECRET
]
