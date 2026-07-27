// src/main/ai/models.ts
//
// The model-list service: fetch the endpoint's live /models, classify each entry's vision
// capability (decisions D-01/D-02, order pinned by D-25), and persist the user's selection.
//
// classifyVision implements the D-25 rungs in order:
//   1. the endpoint's OWN metadata — architecture.input_modalities contains 'image' (OpenRouter)
//   2. else the curated vision-family regex on the id (vision-families.ts) — OpenAI reports no
//      capability metadata at all, so this is the only signal available there
//   3. else 'unknown' — the UI leaves it unbadged and requires the D-01 "use anyway" confirm
// Rung 2 still runs when metadata exists but omits 'image', so a provider that under-reports
// modalities cannot silently strip the badge off gpt-4o.
//
// ModelInfoSchema is deliberately LOCAL to this file, not in src/shared/schemas.ts: it validates
// an external HTTP response, not a renderer IPC payload. It is lenient (every rich field optional
// and nullable, unknown keys preserved) so OpenRouter's extras survive and OpenAI's minimal
// { id, object, created, owned_by } shape degrades to the curated fallback instead of failing.
//
// SECRET BOUNDARY (threat T-03-01): nothing here reads, returns, or logs the API key or base URL.
// The client arrives already built (client.ts owns the credentials) and only ModelInfo — id,
// label, and capability metadata — crosses back toward the renderer.
//
// The client and the db handle are injectable per 03-PATTERNS Shared Pattern B, so the unit spec
// drives OpenAI-minimal and OpenRouter-rich shapes against a temp DB with no Electron, no network.

import type Database from 'better-sqlite3'
import { z } from 'zod'
import type { ModelInfo } from '../../shared/ipc-contract'
import { getDatabase } from '../db/connection'
import { buildClient } from './client'
import { isKnownVisionFamily } from './vision-families'

/** app_settings key holding the selected model id. Non-secret, so SQLite is correct here (D-05). */
export const SELECTED_MODEL_KEY = 'ai-model'

/**
 * Lenient validator for ONE entry of an endpoint's /models response. Loose (unknown keys kept)
 * and nullish on every rich field, because the same code path has to accept OpenAI's four-key
 * object and OpenRouter's deeply nested one. Only `id` is genuinely required — without it the
 * entry cannot be selected or persisted, so an entry missing it is skipped rather than fatal.
 */
export const ModelInfoSchema = z.looseObject({
  id: z.string().min(1).max(256),
  name: z.string().max(512).nullish(),
  architecture: z
    .looseObject({
      input_modalities: z.array(z.string()).nullish(),
      output_modalities: z.array(z.string()).nullish()
    })
    .nullish(),
  supported_parameters: z.array(z.string()).nullish(),
  context_length: z.number().nullish()
})

/** The minimum shape classifyVision needs; both the raw entry and the parsed value satisfy it. */
export interface ClassifiableModel {
  id: string
  architecture?: { input_modalities?: string[] | null } | null
}

/** Structural slice of the client this module uses, so the fake double stands in with no mocking. */
export interface ModelsClientLike {
  models: {
    list: (...args: never[]) => Promise<unknown>
  }
}

/** Injectable dependencies for listModels (Shared Pattern B). */
export interface ListModelsDeps {
  client?: ModelsClientLike
}

/** Injectable dependencies for the selected-model accessors (Shared Pattern B). */
export interface SelectedModelDeps {
  db?: Database.Database
}

/**
 * Classify one model's vision capability per the D-25 order. Pure — no network, no state.
 */
export function classifyVision(model: ClassifiableModel): ModelInfo['vision'] {
  const modalities = model.architecture?.input_modalities
  if (Array.isArray(modalities) && modalities.some((m) => String(m).toLowerCase() === 'image')) {
    return 'vision'
  }
  if (isKnownVisionFamily(model.id)) {
    return 'vision-family'
  }
  return 'unknown'
}

/**
 * Normalize whatever models.list() resolved with into a flat array. The real SDK returns a Page
 * that is BOTH `.data`-bearing and async-iterable; a bare OpenAI-compatible gateway may return
 * only one of the two, so both access styles are supported and anything else yields [].
 */
async function toEntries(page: unknown): Promise<unknown[]> {
  if (!page || typeof page !== 'object') return []
  const data = (page as { data?: unknown }).data
  if (Array.isArray(data)) return data
  const iterator = (page as Partial<AsyncIterable<unknown>>)[Symbol.asyncIterator]
  if (typeof iterator === 'function') {
    const collected: unknown[] = []
    for await (const entry of page as AsyncIterable<unknown>) collected.push(entry)
    return collected
  }
  return []
}

/**
 * Fetch and classify the endpoint's model list. Called exactly once per Connect/Test press, which
 * is what makes D-04 work: one action both validates the stored credentials (a bad key or wrong
 * URL rejects here) and populates the picker.
 *
 * A rejection propagates so the caller can surface a plain recoverable error; individual entries
 * that fail the lenient schema are skipped rather than failing the whole list, so one malformed
 * row from a third-party gateway cannot blank out the picker.
 */
export async function listModels(deps: ListModelsDeps = {}): Promise<ModelInfo[]> {
  const client = deps.client ?? buildClient()
  const entries = await toEntries(await client.models.list())

  const models: ModelInfo[] = []
  for (const entry of entries) {
    const parsed = ModelInfoSchema.safeParse(entry)
    if (!parsed.success) continue
    const model = parsed.data
    models.push({
      id: model.id,
      label: model.name ?? undefined,
      vision: classifyVision(model),
      inputModalities: model.architecture?.input_modalities ?? undefined,
      supportedParameters: model.supported_parameters ?? undefined,
      contextLength: model.context_length ?? undefined
    })
  }
  return models
}

/**
 * Persist the selected model id (AI-04). Uses the same prepared-statement UPSERT as
 * src/main/ipc/settings.ts, bound never interpolated, so the value is reachable by the renderer
 * over the ordinary non-secret settings:get channel and is changeable at any time.
 */
export function setSelectedModel(modelId: string, deps: SelectedModelDeps = {}): boolean {
  const db = deps.db ?? getDatabase()
  db.prepare(
    'INSERT INTO app_settings (key, value) VALUES (@key, @value) ' +
      'ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run({ key: SELECTED_MODEL_KEY, value: modelId })
  return true
}

/** Read the selected model id, or null when the user has not picked one yet. */
export function getSelectedModel(deps: SelectedModelDeps = {}): string | null {
  const db = deps.db ?? getDatabase()
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(SELECTED_MODEL_KEY) as
    | { value: string }
    | undefined
  return row?.value ?? null
}
