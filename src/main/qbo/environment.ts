// src/main/qbo/environment.ts
//
// WHICH Intuit environment the app is pointed at, persisted in app_settings under 'qbo-environment'.
//
// This is the only module that turns the stored setting into the environment name the seam in
// ./env.ts resolves URLs from. Everything else takes the resolved value as an argument, which is
// what makes "never a constant" enforceable: a module that builds an API URL cannot silently fall
// back to sandbox, because it was handed the answer.
//
// WHY app_settings AND NOT THE KEYCHAIN. It is not a credential. It is a user choice the Settings
// screen displays, and it must be readable to render the card without decrypting anything (the same
// line connection.ts draws for the realm id).
//
// WHY THE DEFAULT IS SANDBOX AND WHY AN UNRECOGNIZED VALUE READS AS SANDBOX. Every failure mode of
// this setting has an asymmetric cost. Reading production as sandbox costs a failed request against
// a company that is not there. Reading sandbox as production would send a batch of bills into
// somebody's real books. So parseQboEnvironment coerces rather than throws, and it coerces down.
//
// SWITCHING IS A DISCONNECT. Tokens are issued by one set of Intuit keys against one environment,
// so a token set carried across a switch is guaranteed dead and would fail as a mysterious
// authorization error rather than as the deliberate act it was. setQboEnvironment therefore clears
// the tokens and the connection state whenever the value actually changes. It deliberately leaves
// the reference cache alone: qbo_reference rows are keyed by realm id, so the old company's vendors
// can never be served for a different company, and keeping them means switching back does not
// force a re-sync.

import { clearConnection, readSetting, writeSetting, type ConnectionDeps } from './connection'
import { parseQboEnvironment, qboEnvironment, type QboEnvironment } from './env'
import { clearTokenSet, type TokenDeps } from './tokens'

/** app_settings key holding the chosen Intuit environment. Non-secret, and displayed. */
export const QBO_ENVIRONMENT_SETTING = 'qbo-environment'

/** Injectable dependencies for reading and writing the environment. */
export interface EnvironmentDeps extends ConnectionDeps, TokenDeps {}

/**
 * The environment the app is currently pointed at. Never throws: an absent or unrecognized value
 * reads as sandbox.
 */
export function getQboEnvironment(deps: EnvironmentDeps = {}): QboEnvironment {
  return parseQboEnvironment(readSetting(QBO_ENVIRONMENT_SETTING, deps))
}

/**
 * The Accounting API host for the current environment: scheme and host, no path.
 *
 * This is the value the posting HTTP client takes as its `baseUrl` (src/main/posting/qbo-api.ts).
 * It is a function rather than a constant so a provider registered once at startup still follows a
 * later environment switch: resolve it INSIDE the provider, per call, not when the provider is
 * built.
 */
export function qboApiHost(deps: EnvironmentDeps = {}): string {
  return qboEnvironment(getQboEnvironment(deps)).apiHost
}

/**
 * Point the app at an environment.
 *
 * Returns true when the value actually changed (and the connection was therefore cleared), false
 * when it was already set, so a caller can tell a real switch from a no-op without re-reading.
 *
 * ORDER MATTERS. The credentials are cleared BEFORE the new environment is recorded. Interrupted
 * between the two, the app holds the old environment with no tokens, which reads as "not connected"
 * and is repaired by connecting again. The opposite order would leave the new environment holding
 * the previous environment's tokens, which is the one state that looks connected and is not.
 */
export function setQboEnvironment(
  environment: QboEnvironment,
  deps: EnvironmentDeps = {}
): boolean {
  if (getQboEnvironment(deps) === environment) return false
  clearTokenSet(deps)
  clearConnection(deps)
  writeSetting(QBO_ENVIRONMENT_SETTING, environment, deps)
  return true
}
