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

/**
 * Encrypted secret-store key for the access token's expiry, stored as epoch milliseconds in a
 * decimal string.
 *
 * An expiry timestamp is not itself confidential, but it is kept beside the two tokens rather than
 * in app_settings for one reason: it is the value the proactive refresh reads to decide whether the
 * access token is still usable. Keeping the three parts of the token set in ONE store means they
 * are written and cleared together, so there is no window where SQLite claims the token is fresh
 * while the keychain no longer holds it.
 */
export const QBO_TOKEN_EXPIRY_SECRET = 'qbo-token-expires-at'

/** Encrypted secret-store key for the Intuit app client id. */
export const QBO_CLIENT_ID_SECRET = 'qbo-client-id'

/** Encrypted secret-store key for the Intuit app client secret. */
export const QBO_CLIENT_SECRET_SECRET = 'qbo-client-secret'

/**
 * Every QuickBooks secret-store key, in one list, so src/main/ipc/secrets.ts can deny renderer
 * read-back on all of them at once.
 *
 * The client id is on this list even though Intuit does not treat it as secret on its own. It is
 * half of the HTTP Basic credential that refreshes a token, the Settings form writes it exactly
 * like the client secret, and a deny-list entry costs nothing. Denying by default is the whole
 * point of this module.
 *
 * NOT included, on purpose: the realm (company) id, the company name, and the last-sync timestamp.
 * They are identifiers and state the UI displays, not credentials, so they belong in app_settings
 * rather than the keychain.
 *
 * QBO-CONNECT: add any further credential key to this array. Do NOT edit secrets.ts.
 */
export const QBO_SECRET_KEYS: readonly string[] = [
  QBO_ACCESS_TOKEN_SECRET,
  QBO_REFRESH_TOKEN_SECRET,
  QBO_TOKEN_EXPIRY_SECRET,
  QBO_CLIENT_ID_SECRET,
  QBO_CLIENT_SECRET_SECRET
]
