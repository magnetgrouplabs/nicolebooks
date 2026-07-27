// src/main/parse/extract-fields.ts
//
// The vision extraction step (requirement PARSE-03, decisions D-21, D-23 and D-25). It assembles
// the text-before-image request from prompt.ts, walks the D-25 structured-output fallback ladder
// against the configured endpoint, and re-validates whatever comes back with the LOCAL BillSchema.
//
// Three invariants this module is accountable for:
//
//   1. THE LOCAL SCHEMA IS AUTHORITATIVE. Providers differ in how much of a json_schema they
//      actually enforce (OpenRouter: some route to models that merely translate the schema), and
//      the reply itself is untrusted content derived from an attacker-influenceable document
//      (threat T-03-04, prompt injection). So BillSchema.safeParse runs on EVERY rung, including
//      the strict one — the provider's guarantee is a best effort, the local parse is the gate
//      (RESEARCH Pattern 3).
//   2. FAILURE IS DATA, NEVER AN EXCEPTION. Every path returns { ok: false, reason } so the
//      pipeline can mark one file "needs attention / retry" and keep parsing the rest of the
//      batch (D-15). A throw here would abort a 12-bill batch over one unreadable receipt.
//   3. THE LADDER IS BOUNDED. One repair retry, then stop (D-25). The ladder descends only on
//      errors that mean "this endpoint does not support this parameter" — never on a rejected
//      credential or a dead connection, where three more calls just burn the key against the
//      same wall.
//
// SECRET BOUNDARY (threat T-03-01): the API key lives inside the injected client and is never
// read here. This module logs NOTHING — not the key, not the prompt, not the raw reply. The raw
// reply is RETURNED as data (the D-24 `raw_response` audit column needs it) and the failure
// `detail` is a bounded, value-free description, so a hostile document cannot use an error path
// as an exfiltration or log-flooding channel.
//
// Injectable client per 03-PATTERNS Shared Pattern B: tests drive the whole ladder with the
// shared fake double, no Electron, no network, no key. The real client is loaded LAZILY so
// importing this module never drags in Electron's safeStorage.

import { zodResponseFormat } from 'openai/helpers/zod'
import { BillSchema, type Bill } from '../../shared/schemas'
import {
  BILL_SYSTEM_PROMPT,
  PLAIN_JSON_INSTRUCTION,
  SCHEMA_IN_PROMPT_INSTRUCTION,
  buildRepairInstruction,
  buildUserContent
} from './prompt'

// ---------------------------------------------------------------------------
// Structural client type
// ---------------------------------------------------------------------------
//
// Deliberately a narrow hand-written slice rather than the concrete `OpenAI` class, so the fake
// double stands in with zero mocking and unit specs are immune to SDK version drift. It mirrors
// test/helpers/fake-openai-client.ts's OpenAIClientLike.

export interface ChatTextPart {
  type: 'text'
  text: string
}

export interface ChatImagePart {
  type: 'image_url'
  image_url: { url: string; detail?: string }
}

export type ChatContentPart = ChatTextPart | ChatImagePart

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string | ChatContentPart[]
}

export interface ChatRequest {
  model: string
  messages: ChatMessage[]
  temperature?: number
  response_format?: unknown
  [key: string]: unknown
}

export interface ChatResponse {
  choices: Array<{
    message: {
      content?: string | null
      /** Populated by the SDK's structured-output helper on the strict rung. */
      parsed?: unknown
    }
  }>
  [key: string]: unknown
}

/** The slice of the OpenAI-compatible SDK this module uses. */
export interface VisionClientLike {
  chat: {
    completions: {
      parse(args: ChatRequest): Promise<ChatResponse>
      create(args: ChatRequest): Promise<ChatResponse>
    }
  }
}

// ---------------------------------------------------------------------------
// D-21: one bounded multi-image call
// ---------------------------------------------------------------------------

/** Pages carried in a single call before truncation kicks in (D-21). */
export const MAX_PAGE_IMAGES = 10

/** Pages kept from the front when truncating: vendor, invoice number and date live here. */
export const HEAD_PAGE_IMAGES = 3

/** Pages kept from the back when truncating: the total almost always lives here. */
export const TAIL_PAGE_IMAGES = 2

/**
 * Apply the D-21 cap. Over the cap the selection is pages 1-3 plus the LAST 2 — a naive
 * "first N" truncation would drop the single most important number on a long invoice.
 *
 * Applied inside extractFields as well as being exported, so no caller can accidentally put an
 * unbounded page count (and an unbounded token bill) on the wire.
 */
export function selectPageImages(imageDataUrls: readonly string[]): {
  imageDataUrls: string[]
  truncated: boolean
} {
  const all = Array.isArray(imageDataUrls) ? imageDataUrls : []
  if (all.length <= MAX_PAGE_IMAGES) return { imageDataUrls: [...all], truncated: false }
  return {
    imageDataUrls: [...all.slice(0, HEAD_PAGE_IMAGES), ...all.slice(all.length - TAIL_PAGE_IMAGES)],
    truncated: true
  }
}

// ---------------------------------------------------------------------------
// The D-25 ladder
// ---------------------------------------------------------------------------

/** The three structured-output modes, strongest first (D-25). */
export type LadderRung = 'json_schema' | 'json_object' | 'plain'

/** The ladder in descent order. */
export const LADDER: readonly LadderRung[] = ['json_schema', 'json_object', 'plain'] as const

export type ExtractFailureReason =
  /** The endpoint could not be called at all (bad credential, dead connection, no rung worked). */
  | 'call-failed'
  /** A reply arrived twice and failed the local BillSchema both times. */
  | 'schema-invalid'
  /** No client could be built — credentials are missing or the base URL is not https. */
  | 'client-unavailable'

export interface ExtractSuccess {
  ok: true
  /** The raw BillSchema shape. Cents/date coercion is validate.ts's job, not this module's. */
  bill: Bill
  /** Which rung produced it, for the audit trail. */
  rung: LadderRung
  /** True when the first reply failed local validation and the single repair re-ask fixed it. */
  repaired: boolean
  /** True when the document exceeded the D-21 page cap. Phase 6 surfaces it. */
  truncated: boolean
  /** The reply verbatim, for the D-24 `raw_response` audit column. Data — never logged. */
  rawResponse: string | null
}

export interface ExtractFailure {
  ok: false
  reason: ExtractFailureReason
  /** A bounded, value-free description. Never the key, never the full reply. */
  detail: string
  rung: LadderRung | null
  truncated: boolean
  rawResponse: string | null
}

export type ExtractFieldsResult = ExtractSuccess | ExtractFailure

export interface ExtractFieldsDeps {
  /** The model id the user selected (AI-04), persisted in app_settings. */
  model: string
  /** One prepared JPEG data URL per page, in page order. */
  imageDataUrls: readonly string[]
  /** Embedded PDF text on the native route (D-06); null on the image-only route (D-07). */
  referenceText?: string | null
  /** Injected in tests (Shared Pattern B); defaults to the real client from 03-02. */
  client?: VisionClientLike
  /**
   * Where to start the ladder. D-25 picks the rung "from the model's known capabilities", so a
   * caller that already knows the endpoint has no structured-output support can skip straight to
   * 'plain' instead of paying two rejected calls per bill.
   */
  startRung?: LadderRung
}

/** Cap on any error text this module hands back. */
const MAX_DETAIL_CHARS = 400

/**
 * The nine BillSchema keys. Used to turn an OMITTED key into the explicit null the schema wants —
 * see normalizeCandidate.
 */
const BILL_KEYS = [
  'vendor',
  'invoice_number',
  'invoice_date',
  'due_date',
  'subtotal',
  'tax',
  'total',
  'currency',
  'suggested_category'
] as const

/**
 * Run the vision extraction for one document.
 *
 * Never throws. Returns `{ ok: true, bill }` with the raw BillSchema shape, or a structured
 * failure marker the pipeline turns into a "needs attention / retry" row (D-15).
 */
export async function extractFields(deps: ExtractFieldsDeps): Promise<ExtractFieldsResult> {
  const { imageDataUrls, truncated } = selectPageImages(deps.imageDataUrls ?? [])
  const referenceText = deps.referenceText ?? null
  const model = deps.model

  let client: VisionClientLike
  try {
    client = deps.client ?? (await loadDefaultClient())
  } catch (error) {
    // Missing credentials or a non-https base URL. Recoverable by configuration, so it is a
    // marker like any other failure rather than an exception through the batch loop.
    return {
      ok: false,
      reason: 'client-unavailable',
      detail: describeError(error),
      rung: null,
      truncated,
      rawResponse: null
    }
  }

  const rungs = ladderFrom(deps.startRung)
  let lastError = 'no rung was attempted'

  for (let i = 0; i < rungs.length; i += 1) {
    const rung = rungs[i]
    const first = await callRung(client, rung, { model, referenceText, imageDataUrls })

    if (!first.ok) {
      lastError = describeError(first.error)
      // Descend ONLY when the error means "this endpoint does not support this parameter".
      if (canFallBack(first.error) && i < rungs.length - 1) continue
      return {
        ok: false,
        reason: 'call-failed',
        detail: lastError,
        rung,
        truncated,
        rawResponse: null
      }
    }

    // The local gate. It runs here on every rung, including the strict one.
    const firstCheck = validateReply(first.response)
    if (firstCheck.ok) {
      return {
        ok: true,
        bill: firstCheck.bill,
        rung,
        repaired: false,
        truncated,
        rawResponse: firstCheck.rawResponse
      }
    }

    // Exactly ONE corrective re-ask on this rung (D-25). Not a loop: a model that fails the
    // same schema twice is not going to converge, and each attempt is a paid call.
    const repair = await callRung(client, rung, {
      model,
      referenceText,
      imageDataUrls,
      repairError: firstCheck.detail
    })
    if (!repair.ok) {
      return {
        ok: false,
        reason: 'call-failed',
        detail: describeError(repair.error),
        rung,
        truncated,
        rawResponse: firstCheck.rawResponse
      }
    }

    const secondCheck = validateReply(repair.response)
    if (secondCheck.ok) {
      return {
        ok: true,
        bill: secondCheck.bill,
        rung,
        repaired: true,
        truncated,
        rawResponse: secondCheck.rawResponse
      }
    }

    // Flag-and-keep (D-25/D-15): the file becomes a retryable failed row, nothing is thrown and
    // nothing is silently invented to fill the gap.
    return {
      ok: false,
      reason: 'schema-invalid',
      detail: secondCheck.detail,
      rung,
      truncated,
      rawResponse: secondCheck.rawResponse
    }
  }

  return {
    ok: false,
    reason: 'call-failed',
    detail: lastError,
    rung: null,
    truncated,
    rawResponse: null
  }
}

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

/** The rungs still to try, starting at the caller's pinned rung (default: the strongest). */
function ladderFrom(start?: LadderRung): LadderRung[] {
  const index = start ? LADDER.indexOf(start) : 0
  return [...LADDER.slice(index < 0 ? 0 : index)]
}

interface RungInput {
  model: string
  referenceText: string | null
  imageDataUrls: string[]
  repairError?: string
}

type RungOutcome = { ok: true; response: ChatResponse } | { ok: false; error: unknown }

/**
 * Build and issue one rung's request.
 *
 * A client whose `parse` method does not exist (a bare gateway wrapper) throws a TypeError in
 * here, which is caught and treated like any other unsupported-parameter error — the ladder
 * then descends to `create`.
 */
async function callRung(
  client: VisionClientLike,
  rung: LadderRung,
  input: RungInput
): Promise<RungOutcome> {
  try {
    const { args, method } = buildRequest(rung, input)
    const response =
      method === 'parse'
        ? await client.chat.completions.parse(args)
        : await client.chat.completions.create(args)
    return { ok: true, response }
  } catch (error) {
    return { ok: false, error }
  }
}

/** Assemble the request for one rung. Text-before-image is guaranteed by buildUserContent. */
function buildRequest(
  rung: LadderRung,
  input: RungInput
): { args: ChatRequest; method: 'parse' | 'create' } {
  const extraInstructions: string[] = []
  if (rung === 'json_object') extraInstructions.push(SCHEMA_IN_PROMPT_INSTRUCTION)
  if (rung === 'plain') extraInstructions.push(PLAIN_JSON_INSTRUCTION)
  if (input.repairError) extraInstructions.push(buildRepairInstruction(input.repairError))

  const base: ChatRequest = {
    model: input.model,
    // Extraction is transcription, not composition. Determinism also makes D-22's second-pass
    // agreement check meaningful — two sampled calls would disagree by construction.
    temperature: 0,
    messages: [
      { role: 'system', content: BILL_SYSTEM_PROMPT },
      {
        role: 'user',
        content: buildUserContent({
          referenceText: input.referenceText,
          imageDataUrls: input.imageDataUrls,
          extraInstructions
        })
      }
    ]
  }

  if (rung === 'json_schema') {
    return {
      method: 'parse',
      args: { ...base, response_format: zodResponseFormat(BillSchema, 'bill') }
    }
  }
  if (rung === 'json_object') {
    return { method: 'create', args: { ...base, response_format: { type: 'json_object' } } }
  }
  return { method: 'create', args: base }
}

type ReplyCheck =
  | { ok: true; bill: Bill; rawResponse: string | null }
  | { ok: false; detail: string; rawResponse: string | null }

/** The authoritative local gate: extract a candidate object, then BillSchema it. */
function validateReply(response: ChatResponse): ReplyCheck {
  const message = response?.choices?.[0]?.message
  const rawResponse = typeof message?.content === 'string' ? message.content : null

  // The strict rung hands back an already-deserialized object; every other rung hands back text.
  const candidate = isPlainObject(message?.parsed)
    ? message.parsed
    : parseJsonLoose(rawResponse)
  if (!isPlainObject(candidate)) {
    return { ok: false, detail: 'the reply did not contain a JSON object', rawResponse }
  }

  const result = BillSchema.safeParse(normalizeCandidate(candidate))
  if (!result.success) {
    return { ok: false, detail: describeZodError(result.error), rawResponse }
  }
  return { ok: true, bill: result.data, rawResponse }
}

/**
 * Turn an OMITTED key into the explicit null the schema requires.
 *
 * On the non-strict rungs a model routinely drops null-valued keys entirely; that omission IS
 * the prompt's own "return null if absent" contract, just expressed by absence. Filling it costs
 * nothing in safety — a filled null still has to satisfy BillSchema, so `vendor` and `total`
 * (non-nullable) still fail, which is exactly the required-field minimization guarantee — and it
 * saves a paid repair call plus a spuriously lost bill on every receipt with no tax line.
 *
 * Only `undefined` is filled. A wrong TYPE is never coerced; that is a genuine mismatch and must
 * reach the repair retry.
 */
function normalizeCandidate(candidate: Record<string, unknown>): Record<string, unknown> {
  const normalized: Record<string, unknown> = { ...candidate }
  for (const key of BILL_KEYS) {
    if (normalized[key] === undefined) normalized[key] = null
  }
  return normalized
}

/**
 * Parse a JSON object out of a plain-text reply.
 *
 * Tolerant on purpose, because rung 3 has no syntactic guarantee at all: a markdown code fence
 * and a sentence of preamble are the two things models add unprompted. Tolerance here costs
 * nothing — BillSchema still decides whether the extracted object is acceptable.
 */
function parseJsonLoose(text: string | null): unknown {
  if (typeof text !== 'string') return undefined
  const trimmed = text.trim()
  if (trimmed === '') return undefined

  const unfenced = trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim()

  const direct = tryJson(unfenced)
  if (direct !== undefined) return direct

  const start = unfenced.indexOf('{')
  const end = unfenced.lastIndexOf('}')
  if (start >= 0 && end > start) return tryJson(unfenced.slice(start, end + 1))
  return undefined
}

function tryJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Should the ladder descend on this error?
 *
 * Yes for a parameter/route rejection (typically 400/404/422, or a TypeError from a client that
 * has no such method) — that is precisely what the ladder exists for. NO for a rejected
 * credential, a rate limit, a server fault or a dead connection: the rung is not the problem, and
 * descending would triple the failed calls for every file in the batch. The SDK has already spent
 * its own maxRetries (3, D-25) on the transient cases before the error reaches here.
 */
function canFallBack(error: unknown): boolean {
  const status = (error as { status?: unknown } | null)?.status
  if (typeof status === 'number') {
    if (status >= 500) return false
    return !NON_FALLBACK_STATUS.has(status)
  }

  const rawName = (error as { name?: unknown } | null)?.name
  const name = typeof rawName === 'string' ? rawName : ''
  const message = error instanceof Error ? error.message : ''
  if (CONNECTION_ERROR.test(name) || CONNECTION_ERROR.test(message)) return false
  return true
}

/** Auth, permission, request-timeout, conflict and rate-limit: never a ladder problem. */
const NON_FALLBACK_STATUS = new Set([401, 403, 408, 409, 429])

const CONNECTION_ERROR = /connection|timed?[ _-]?out|ECONNREFUSED|ENOTFOUND|ECONNRESET|abort/i

/** A bounded, value-free description of a thrown error. */
function describeError(error: unknown): string {
  if (error instanceof Error) return truncate(error.message || error.name || 'error')
  if (typeof error === 'string') return truncate(error)
  return 'unknown error'
}

/** Field paths and type expectations only — no document values ride out through here. */
function describeZodError(error: { issues: Array<{ path: PropertyKey[]; message: string }> }): string {
  const issues = error.issues
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('; ')
  return truncate(issues || 'the reply did not match the bill schema')
}

function truncate(text: string): string {
  return text.length <= MAX_DETAIL_CHARS ? text : `${text.slice(0, MAX_DETAIL_CHARS)}...`
}

/**
 * The real client, loaded lazily so importing this module never pulls in Electron's safeStorage.
 * buildClient throws when credentials are missing or the base URL is not https (T-03-05); that
 * throw is caught by the caller and becomes a 'client-unavailable' marker.
 */
async function loadDefaultClient(): Promise<VisionClientLike> {
  const { buildClient } = await import('../ai/client')
  return buildClient() as unknown as VisionClientLike
}
