// src/main/ipc/ai.ts
//
// ai channel group: test-connection / list-models / set-model (decisions D-04, D-05, D-16).
//
// Every handler runs assertTrustedSender(event) as its FIRST statement (03-PATTERNS Shared
// Pattern A, mirroring settings.ts / ingestion.ts), then Zod-parses the payload with a shared
// schema, then does the privileged work. Both list channels are payload-free by design: the
// credentials are resolved server-side, so there is nothing legitimate for the renderer to send
// and the strict-empty schema rejects anything smuggled in.
//
// SECRET BOUNDARY (D-05, threat T-03-01): no handler here accepts or returns the API key or the
// base URL. buildClient() reads both from the OS keychain inside the main process; only ModelInfo
// objects and a boolean/status travel back. Errors are mapped to fixed, human-readable copy — the
// raw error is never forwarded, so an SDK message carrying the endpoint URL (or a stack) cannot
// ride out to the renderer. Nothing in this file logs.

import { ipcMain } from 'electron'
import { Channels } from '../../shared/ipc-contract'
import { AiListModelsSchema, AiSetModelSchema, AiTestConnectionSchema } from '../../shared/schemas'
import { buildClient } from '../ai/client'
import { listModels, setSelectedModel } from '../ai/models'
import { assertTrustedSender } from './trusted-sender'

/**
 * Opaque failure codes from ai/client.ts mapped to plain, recoverable user copy (CR-01/WR-04
 * shape). Anything not in this table falls back to the generic message: an unrecognized error
 * came from the SDK or the network and its text is NOT safe to forward, because SDK errors
 * routinely embed the request URL.
 */
const CONNECTION_ERROR_COPY: Readonly<Record<string, string>> = {
  AI_CREDENTIALS_MISSING: 'Enter your API key and choose a base URL, then try again.',
  AI_BASE_URL_INVALID: 'That base URL is not a valid web address. Check it and try again.',
  AI_BASE_URL_INSECURE: 'The base URL must start with https:// so your API key is never sent unencrypted.'
}

const GENERIC_CONNECTION_ERROR =
  'Could not reach that endpoint with those credentials. Check your API key and base URL, then try again.'

/** Map any thrown value to a fixed recoverable message. Never returns raw error text or a stack. */
function recoverableReason(err: unknown): string {
  const code = err instanceof Error ? err.message : ''
  return CONNECTION_ERROR_COPY[code] ?? GENERIC_CONNECTION_ERROR
}

/** Register the ai channel handlers. Call after app 'ready' (safeStorage + getDatabase need it). */
export function registerAiIpc(): void {
  // D-04: ONE press of Connect and test = ONE /models call that both validates the stored
  // credentials and populates the picker. A failure returns { ok: false } with recoverable copy
  // rather than rejecting, so the Settings status can render "AI connection: error" directly —
  // the same graceful-degradation discipline as secrets.ts's null-on-unavailable.
  ipcMain.handle(Channels.aiTestConnection, async (event, raw) => {
    assertTrustedSender(event)
    // The preload invokes this with no argument, so raw is undefined; normalizing to {} keeps the
    // strict-empty gate intact (any actual payload still throws) without rejecting the real call.
    AiTestConnectionSchema.parse(raw ?? {})
    try {
      const models = await listModels({ client: buildClient() })
      return { ok: true as const, models }
    } catch (err) {
      return { ok: false as const, error: recoverableReason(err) }
    }
  })

  // Same list+classify path, re-fetched. Contract type is ModelInfo[], so a failure rejects and
  // the renderer's catch surfaces it; the rejection carries only the opaque code, never the URL.
  ipcMain.handle(Channels.aiListModels, async (event, raw) => {
    assertTrustedSender(event)
    AiListModelsSchema.parse(raw ?? {})
    return listModels({ client: buildClient() })
  })

  // The selected model id is the ONE piece of AI config that is non-secret, so it is the only one
  // that crosses this boundary and the only one written to app_settings (D-05).
  ipcMain.handle(Channels.aiSetModel, (event, raw) => {
    assertTrustedSender(event)
    const { modelId } = AiSetModelSchema.parse(raw)
    return setSelectedModel(modelId)
  })
}
