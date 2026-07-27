// src/main/integration/e2e-hooks.ts
//
// A READ-ONLY verification surface for the live sandbox drill, and nothing else.
//
// WHY IT HAS TO EXIST. The live drill's whole point is to check what actually landed in the
// QuickBooks company after the app posted a batch, and to check it against the fixture manifest
// rather than against the app's own opinion of what it did. Asking the app "did it work" and
// believing the answer is not verification.
//
// WHY IT IS IN THE APP RATHER THAN IN THE SPEC. The obvious alternative is for the spec to call
// Intuit directly with the token from the shared credentials file. That is worse in two ways: the
// refresh token ROLLS, so a spec that refreshes silently invalidates the file everyone else seeds
// from, and a second Electron process cannot be used instead because the single-instance lock makes
// it quit before it reaches any dev command. Going through the app's own authenticated client
// reuses the one place that already handles rotation correctly, and it doubles as proof that the
// posting bridge is wired: if resolveQboApi were still unregistered, every query here would fail.
//
// WHY IT IS SAFE. Two independent gates, both of which must be open:
//   1. app.isPackaged must be false. A shipped installer never has this surface.
//   2. NICOLEBOOKS_E2E must be exactly '1'. A normal dev run does not set it.
// The exposed functions are READS ONLY (query and read-by-id). Nothing here creates, updates, or
// deletes, and nothing here returns a token: the access token is used inside the client to sign a
// request and never crosses back out.
//
// It is reachable only from the MAIN process (Playwright's app.evaluate), never from the renderer.
// No IPC channel, no preload method, no contextBridge entry. A compromised renderer cannot see it.

import { app } from 'electron'
import type { QboEntityName } from '../posting/entity-builders'
import { resolveQboApi } from '../posting/qbo-api'

/** The global the drill reaches through app.evaluate. Absent unless both gates below are open. */
export const E2E_GLOBAL_KEY = '__nicolebooksE2E'

/** Read-only operations the drill is allowed to perform against the connected company. */
export interface E2EHooks {
  /** Run one SQL-like Accounting API query and return the raw rows. */
  qboQuery(statement: string): Promise<unknown[]>
  /** Read one entity by id. null when QuickBooks no longer has it, which is what undo produces. */
  qboRead(entity: QboEntityName, id: string): Promise<{ id: string; syncToken: string } | null>
}

/** True when both gates are open. Exported so a unit spec can pin the gate rather than the effect. */
export function e2eHooksEnabled(
  packaged: boolean,
  env: Record<string, string | undefined>
): boolean {
  return !packaged && env['NICOLEBOOKS_E2E'] === '1'
}

/** Build the hooks. Pure: every call resolves the live client at the moment it is made. */
export function createE2EHooks(): E2EHooks {
  return {
    qboQuery: async (statement) => (await resolveQboApi()).query(statement),
    qboRead: async (entity, id) => (await resolveQboApi()).readEntity(entity, id)
  }
}

/** Install the hooks on globalThis, or do nothing at all. Called once, after registerIpc(). */
export function installE2EHooks(): void {
  if (!e2eHooksEnabled(app.isPackaged, process.env)) return
  ;(globalThis as Record<string, unknown>)[E2E_GLOBAL_KEY] = createE2EHooks()
}
