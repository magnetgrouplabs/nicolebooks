// test/ai-models.test.ts
//
// Wave-0 (RED) unit spec for the Phase 3 AI service layer (plan 03-02, requirements
// AI-01..AI-04). Until src/main/ai/vision-families.ts, src/main/ai/models.ts and
// src/main/ai/client.ts exist this file fails to import — the correct Wave-0 state.
//
// Coverage:
//   1. classifyVision (D-02/D-25 order): endpoint metadata first
//      (architecture.input_modalities contains 'image' -> 'vision'), then the curated
//      vision-family regex on the id -> 'vision-family', else 'unknown' (which the UI leaves
//      unbadged and routes through the D-01 "use anyway" confirm gate).
//   2. listModels: drives the shared fake OpenAI double with a MIXED list (OpenRouter-rich and
//      OpenAI-minimal entries side by side), asserts every entry comes back classified, and
//      asserts models.list() is invoked EXACTLY ONCE — D-04's "one Connect/Test press = one
//      /models call that both validates the credentials and populates the picker".
//   3. Selected-model persistence (AI-04): the non-secret model id round-trips through the
//      app_settings prepared-statement path that settings:get reads, against a real migrated
//      temp DB (the migrate.test.ts / ingestion-scan.test.ts temp-DB lifecycle).
//   4. buildClient guards (D-05 / threats T-03-01, T-03-05): a missing credential and a
//      non-https or malformed base URL are rejected BEFORE a client is built, so the key is
//      never sent to a plaintext or malformed target; the happy path pins the D-25 client
//      config (maxRetries 3, timeout 120000) and never returns the credential to a caller.
//
// No Electron and no network: the client is injected per 03-PATTERNS Shared Pattern B, and
// buildClient takes an injectable secret reader so safeStorage is never touched.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { migrate } from '../src/main/db/migrate'
import { makeFakeClient, type ModelListEntry } from './helpers/fake-openai-client'
import { isKnownVisionFamily } from '../src/main/ai/vision-families'
import {
  SELECTED_MODEL_KEY,
  classifyVision,
  getSelectedModel,
  listModels,
  setSelectedModel
} from '../src/main/ai/models'
import { AI_API_KEY_SECRET, AI_BASE_URL_SECRET, buildClient } from '../src/main/ai/client'

// --- fixtures -------------------------------------------------------------------------

/** OpenRouter-rich: capability metadata is present, so classification never needs the regex. */
const openrouterVision: ModelListEntry = {
  id: 'openai/gpt-4o-2024-11-20',
  name: 'OpenAI: GPT-4o',
  architecture: { input_modalities: ['text', 'image', 'file'], output_modalities: ['text'] },
  supported_parameters: ['response_format', 'structured_outputs', 'temperature'],
  context_length: 128000
}

/** OpenRouter-rich but text-only: metadata says no image input. */
const openrouterTextOnly: ModelListEntry = {
  id: 'mistralai/mistral-7b-instruct',
  name: 'Mistral 7B Instruct',
  architecture: { input_modalities: ['text'], output_modalities: ['text'] },
  supported_parameters: ['temperature'],
  context_length: 32768
}

/** OpenAI-minimal: no capability metadata at all — the curated fallback is the only signal. */
const minimalGpt4o: ModelListEntry = {
  id: 'gpt-4o',
  object: 'model',
  created: 1715367049,
  owned_by: 'system'
}

const minimalUnknown: ModelListEntry = {
  id: 'text-davinci-003',
  object: 'model',
  created: 1669599635,
  owned_by: 'openai-internal'
}

/** A secret reader stand-in so buildClient never reaches Electron safeStorage. */
function fakeSecrets(values: Record<string, string | null>): { get(key: string): string | null } {
  return { get: (key: string): string | null => values[key] ?? null }
}

// --- 1. classifyVision (D-02 / D-25) --------------------------------------------------

describe('classifyVision', () => {
  it("returns 'vision' when the endpoint's own metadata reports image input", () => {
    expect(classifyVision(openrouterVision)).toBe('vision')
  })

  it("returns 'vision-family' for an OpenAI-minimal entry whose id matches a curated family", () => {
    expect(classifyVision(minimalGpt4o)).toBe('vision-family')
    expect(classifyVision({ id: 'claude-3-5-sonnet-20241022' })).toBe('vision-family')
    expect(classifyVision({ id: 'gemini-1.5-pro' })).toBe('vision-family')
    expect(classifyVision({ id: 'qwen2.5-vl-72b-instruct' })).toBe('vision-family')
  })

  it("returns 'unknown' for an unrecognizable id with no metadata", () => {
    expect(classifyVision(minimalUnknown)).toBe('unknown')
    expect(classifyVision({ id: 'some-random-llm' })).toBe('unknown')
  })

  it("returns 'unknown' when metadata is present but reports no image modality", () => {
    expect(classifyVision(openrouterTextOnly)).toBe('unknown')
  })

  it('checks metadata BEFORE the curated regex (D-25 order)', () => {
    // An id the curated list has never heard of, but the endpoint says it takes images.
    expect(classifyVision({ id: 'acme/private-model-v9', architecture: { input_modalities: ['text', 'image'] } })).toBe(
      'vision'
    )
    // A curated-family id whose metadata omits image still falls through to the regex rung,
    // so a badge is never lost just because one provider under-reports modalities.
    expect(classifyVision({ id: 'gpt-4o-mini', architecture: { input_modalities: ['text'] } })).toBe('vision-family')
  })
})

describe('isKnownVisionFamily', () => {
  it('matches the curated families, bare and provider-qualified', () => {
    for (const id of [
      'gpt-4o',
      'openai/gpt-4o-mini',
      'gpt-4.1-mini',
      'o1-preview',
      'openai/o3-mini',
      'claude-3-5-sonnet-20241022',
      'anthropic/claude-opus-4',
      'gemini-1.5-flash',
      'google/gemini-2.0-flash-exp',
      'meta-llama/llama-3.2-90b-vision-instruct',
      'qwen/qwen2-vl-72b-instruct',
      'mistralai/pixtral-12b'
    ]) {
      expect(isKnownVisionFamily(id), id).toBe(true)
    }
  })

  it('does not match text-only or unrecognizable ids', () => {
    for (const id of [
      'text-davinci-003',
      'some-random-llm',
      'mistralai/mistral-7b-instruct',
      'gpt-3.5-turbo',
      'deepseek/deepseek-chat'
    ]) {
      expect(isKnownVisionFamily(id), id).toBe(false)
    }
  })
})

// --- 2. listModels (AI-02 / D-04) -----------------------------------------------------

describe('listModels', () => {
  it('classifies every entry of a mixed list and calls models.list() exactly once', async () => {
    const client = makeFakeClient({
      models: [openrouterVision, minimalGpt4o, minimalUnknown, openrouterTextOnly]
    })

    const models = await listModels({ client })

    expect(models.map((m) => m.id)).toEqual([
      'openai/gpt-4o-2024-11-20',
      'gpt-4o',
      'text-davinci-003',
      'mistralai/mistral-7b-instruct'
    ])
    expect(models.map((m) => m.vision)).toEqual(['vision', 'vision-family', 'unknown', 'unknown'])

    // D-04: one action, one /models call. A second call here would mean the Connect/Test press
    // double-charges the endpoint and the "validate + populate in one step" contract is broken.
    expect(client.callCount('models.list')).toBe(1)
    expect(client.chatCalls()).toHaveLength(0)
  })

  it('carries the rich OpenRouter metadata through and degrades on the OpenAI-minimal shape', async () => {
    const client = makeFakeClient({ models: [openrouterVision, minimalGpt4o] })

    const [rich, minimal] = await listModels({ client })

    expect(rich.label).toBe('OpenAI: GPT-4o')
    expect(rich.inputModalities).toEqual(['text', 'image', 'file'])
    expect(rich.supportedParameters).toContain('structured_outputs')
    expect(rich.contextLength).toBe(128000)

    // OpenAI returns none of that; the entry must still come back, just without the extras.
    expect(minimal.id).toBe('gpt-4o')
    expect(minimal.inputModalities).toBeUndefined()
    expect(minimal.supportedParameters).toBeUndefined()
    expect(minimal.contextLength).toBeUndefined()
  })

  it('returns an empty list when the endpoint reports no models', async () => {
    const client = makeFakeClient({ models: [] })
    await expect(listModels({ client })).resolves.toEqual([])
    expect(client.callCount('models.list')).toBe(1)
  })

  it('propagates an endpoint failure so the caller can surface a recoverable error', async () => {
    const client = makeFakeClient({ modelsError: new Error('401 Incorrect API key provided') })
    await expect(listModels({ client })).rejects.toThrow()
  })
})

// --- 3. selected-model persistence (AI-04 / D-05) -------------------------------------

describe('selected model persistence', () => {
  let dir: string
  let db: Database.Database

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nb-ai-models-'))
    db = new Database(join(dir, 'app.db'))
    migrate(db)
  })

  afterEach(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('writes the model id under the app_settings key settings:get reads', () => {
    expect(getSelectedModel({ db })).toBeNull()

    setSelectedModel('openai/gpt-4o-2024-11-20', { db })

    // Read back through the EXACT statement src/main/ipc/settings.ts uses for settings:get,
    // proving the id is reachable by the renderer over the non-secret settings channel.
    const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(SELECTED_MODEL_KEY) as
      | { value: string }
      | undefined
    expect(row?.value).toBe('openai/gpt-4o-2024-11-20')
    expect(getSelectedModel({ db })).toBe('openai/gpt-4o-2024-11-20')
  })

  it('is changeable at any time (UPSERT, not insert-once)', () => {
    setSelectedModel('gpt-4o', { db })
    setSelectedModel('anthropic/claude-3-5-sonnet', { db })

    expect(getSelectedModel({ db })).toBe('anthropic/claude-3-5-sonnet')
    const count = db
      .prepare('SELECT COUNT(*) AS n FROM app_settings WHERE key = ?')
      .get(SELECTED_MODEL_KEY) as { n: number }
    expect(count.n).toBe(1)
  })

  it('stores the model id under a non-secret key, never a credential key', () => {
    setSelectedModel('gpt-4o', { db })
    const keys = (db.prepare('SELECT key FROM app_settings').all() as Array<{ key: string }>).map(
      (r) => r.key
    )
    expect(keys).toContain(SELECTED_MODEL_KEY)
    expect(keys).not.toContain('ai-api-key')
    expect(keys).not.toContain('ai-base-url')
  })
})

// --- 4. buildClient guards (D-05 / D-25 / T-03-01 / T-03-05) --------------------------

describe('buildClient', () => {
  const goodUrl = 'https://api.openai.com/v1'

  it('builds a client with the D-25 configuration when both credentials are present', () => {
    const client = buildClient({
      secretStore: fakeSecrets({ [AI_API_KEY_SECRET]: 'sk-test-key', [AI_BASE_URL_SECRET]: goodUrl })
    })
    expect(client.baseURL).toBe(goodUrl)
    expect(client.maxRetries).toBe(3)
    expect(client.timeout).toBe(120000)
  })

  it('rejects a missing API key before any client is built', () => {
    expect(() =>
      buildClient({ secretStore: fakeSecrets({ [AI_BASE_URL_SECRET]: goodUrl }) })
    ).toThrow(/AI_CREDENTIALS_MISSING/)
  })

  it('rejects a missing base URL before any client is built', () => {
    expect(() =>
      buildClient({ secretStore: fakeSecrets({ [AI_API_KEY_SECRET]: 'sk-test-key' }) })
    ).toThrow(/AI_CREDENTIALS_MISSING/)
  })

  it('rejects a non-https base URL so the key is never sent in the clear (T-03-05)', () => {
    for (const bad of ['http://api.openai.com/v1', 'ftp://example.com/v1', 'file:///etc/passwd']) {
      expect(
        () =>
          buildClient({
            secretStore: fakeSecrets({ [AI_API_KEY_SECRET]: 'sk-test-key', [AI_BASE_URL_SECRET]: bad })
          }),
        bad
      ).toThrow(/AI_BASE_URL/)
    }
  })

  it('rejects a malformed base URL', () => {
    expect(() =>
      buildClient({
        secretStore: fakeSecrets({
          [AI_API_KEY_SECRET]: 'sk-test-key',
          [AI_BASE_URL_SECRET]: 'not a url at all'
        })
      })
    ).toThrow(/AI_BASE_URL/)
  })

  it('never puts the API key into the thrown error message', () => {
    const key = 'sk-super-secret-do-not-echo'
    let thrown: unknown = null
    try {
      buildClient({
        secretStore: fakeSecrets({ [AI_API_KEY_SECRET]: key, [AI_BASE_URL_SECRET]: 'http://insecure' })
      })
    } catch (err) {
      thrown = err
    }
    // The guard must have fired (otherwise this assertion would pass vacuously).
    expect(thrown).toBeInstanceOf(Error)
    expect(String(thrown)).not.toContain(key)
    expect((thrown as Error).stack ?? '').not.toContain(key)
  })
})
