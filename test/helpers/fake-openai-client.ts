// test/helpers/fake-openai-client.ts
//
// The shared fake OpenAI-compatible client double for every Phase 3 unit spec (03-VALIDATION
// "Shared fake OpenAIClientLike test double"). It drives the whole ai/ + parse/ stack with no
// Electron, no network, and no API key, via the Phase 2 ScanDeps-style injectable-dependency
// convention (03-PATTERNS Shared Pattern B: `deps.client ?? realClient`).
//
// IMPORTANT: this module imports NOTHING from the `openai` package. The structural type below
// (OpenAIClientLike) is hand-written on purpose so the double stays a pure test artifact and the
// production modules can accept a narrow structural type instead of the full SDK class. That
// keeps unit specs free of SDK version drift and makes the "client was NEVER called" assertion
// (PARSE-05 cache-hit-no-recall) trivially provable.
//
// What it records: every call lands on `.calls` as { method, args } in invocation order, so a
// spec can assert call count, ordering (text part before image part, D-23), the model id, the
// temperature, and the response_format the fallback ladder picked (D-25).

// ---------------------------------------------------------------------------
// Structural types (hand-written; no `openai` import)
// ---------------------------------------------------------------------------

/**
 * One entry from GET /models. Deliberately loose: OpenAI returns the minimal
 * { id, object, created, owned_by } shape with NO capability metadata, while OpenRouter returns
 * a rich object carrying architecture.input_modalities and supported_parameters (RESEARCH
 * Directive 6a). Both must survive this type so classifyVision() can be exercised on each
 * (D-02: metadata-first, curated-regex fallback, else unbadged).
 */
export interface ModelListEntry {
  id: string
  object?: string
  created?: number
  owned_by?: string
  name?: string
  architecture?: {
    input_modalities?: string[]
    output_modalities?: string[]
    [key: string]: unknown
  }
  supported_parameters?: string[]
  context_length?: number
  [key: string]: unknown
}

/**
 * What `client.models.list()` resolves to. The real SDK returns a Page that is BOTH async
 * iterable and exposes `.data`, so the double supports both access styles and a consumer written
 * either way keeps working.
 */
export interface ModelListPage {
  data: ModelListEntry[]
  [Symbol.asyncIterator](): AsyncIterator<ModelListEntry>
}

/** A single content part of a user message. Text-before-image ordering is asserted on these. */
export type ChatContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: string } }

/** One chat message. `content` is a bare string for the system message, an array for the user. */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string | ChatContentPart[]
}

/** The request object handed to chat.completions.parse/create. */
export interface ChatCompletionArgs {
  model: string
  messages: ChatMessage[]
  temperature?: number
  response_format?: unknown
  max_tokens?: number
  [key: string]: unknown
}

/** One choice of a chat completion. `parsed` is populated by the SDK's structured-output helper. */
export interface ChatCompletionChoice {
  index?: number
  finish_reason?: string
  message: {
    role: 'assistant'
    content: string | null
    parsed?: unknown
    refusal?: string | null
  }
}

/** The response object chat.completions.parse/create resolves to. */
export interface ChatCompletionResponse {
  id?: string
  model?: string
  choices: ChatCompletionChoice[]
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
  [key: string]: unknown
}

/**
 * The narrow structural slice of the OpenAI SDK that Phase 3 actually uses. Production code
 * should accept THIS type for its injectable `client` dep (ParseDeps.client / AiDeps.client), not
 * the concrete `OpenAI` class — that is what lets this double stand in with zero mocking.
 */
export interface OpenAIClientLike {
  models: {
    list(): Promise<ModelListPage>
  }
  chat: {
    completions: {
      parse(args: ChatCompletionArgs): Promise<ChatCompletionResponse>
      create(args: ChatCompletionArgs): Promise<ChatCompletionResponse>
    }
  }
}

// ---------------------------------------------------------------------------
// The double
// ---------------------------------------------------------------------------

/** One recorded invocation. `args` is undefined for models.list (it takes none). */
export interface RecordedCall {
  method: 'models.list' | 'chat.completions.parse' | 'chat.completions.create'
  args?: ChatCompletionArgs
}

export interface FakeClientOptions {
  /** Entries `models.list()` resolves with. Accepts the OpenAI-minimal or OpenRouter-rich shape. */
  models?: ModelListEntry[]
  /** When set, `models.list()` rejects with this instead of resolving (bad key / wrong base URL). */
  modelsError?: Error
  /**
   * Canned chat response(s). A single value is returned for every call; an array is consumed in
   * order and the final entry repeats, which is how a spec scripts a failing first attempt
   * followed by a successful repair retry (D-25).
   */
  chatResponse?: ChatCompletionResponse | ChatCompletionResponse[]
  /**
   * Convenience over `chatResponse`: a plain object (or per-call array) that is both JSON-
   * stringified into `message.content` AND set on `message.parsed`, matching what the SDK's
   * structured-output helper produces. Use for schema-valid canned bills.
   */
  parsedObject?: unknown | unknown[]
  /** When set, every chat call rejects with this (the D-15 "whole batch would fail" case). */
  chatError?: Error
  /**
   * Reject ONLY when a text content part mentions this filename — the D-15 per-file isolation
   * proof: one file blows up, every other file in the batch still parses.
   */
  throwForFilename?: string
  /** Error thrown by throwForFilename. Defaults to a generic recoverable Error. */
  throwForFilenameError?: Error
  /**
   * Full escape hatch, checked before every other chat rule. Return a response to resolve with,
   * or throw to reject. `callIndex` counts chat calls only (so a second-pass agreement check,
   * D-22, is index 1).
   */
  chatImpl?: (args: ChatCompletionArgs, callIndex: number) => ChatCompletionResponse
}

/** The double: an OpenAIClientLike plus the recording/assertion surface specs need. */
export interface FakeOpenAIClient extends OpenAIClientLike {
  /** Every call in invocation order. */
  calls: RecordedCall[]
  /** true when the client was never touched — the PARSE-05 cache-hit-no-recall assertion. */
  neverCalled(): boolean
  /** Count of all calls, or of one method. */
  callCount(method?: RecordedCall['method']): number
  /** Only the chat calls (parse + create), in order. */
  chatCalls(): RecordedCall[]
  /** Clear the recording without rebuilding the double. */
  reset(): void
}

/** Build a schema-valid-looking completion response from a plain object. */
export function makeChatResponse(parsed: unknown, model = 'fake-vision-model'): ChatCompletionResponse {
  return {
    id: 'chatcmpl-fake',
    model,
    choices: [
      {
        index: 0,
        finish_reason: 'stop',
        message: { role: 'assistant', content: JSON.stringify(parsed), parsed }
      }
    ]
  }
}

/** Build a completion response whose content is raw text (used for the non-strict ladder rungs). */
export function makeTextResponse(text: string, model = 'fake-vision-model'): ChatCompletionResponse {
  return {
    id: 'chatcmpl-fake',
    model,
    choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: text } }]
  }
}

/** Flatten every text content part of a request into one string (used by throwForFilename). */
function requestText(args: ChatCompletionArgs): string {
  const parts: string[] = []
  for (const message of args.messages ?? []) {
    if (typeof message.content === 'string') {
      parts.push(message.content)
      continue
    }
    for (const part of message.content ?? []) {
      if (part.type === 'text') parts.push(part.text)
    }
  }
  return parts.join('\n')
}

/** Pick the response for chat call N from a single value or an ordered array (last repeats). */
function pickFor<T>(source: T | T[], callIndex: number): T {
  if (!Array.isArray(source)) return source
  if (source.length === 0) throw new Error('fake-openai-client: empty response array')
  return source[Math.min(callIndex, source.length - 1)] as T
}

/**
 * Create the fake client. With no options it resolves an empty model list and returns an empty
 * canned completion, so a spec that only needs to prove "the client was never called" can
 * construct it bare: `const client = makeFakeClient()` then `expect(client.neverCalled()).toBe(true)`.
 */
export function makeFakeClient(opts: FakeClientOptions = {}): FakeOpenAIClient {
  const calls: RecordedCall[] = []
  let chatCallIndex = 0

  const nextChatResponse = (args: ChatCompletionArgs): ChatCompletionResponse => {
    const index = chatCallIndex++

    // 1. Full escape hatch wins (it may itself throw).
    if (opts.chatImpl) return opts.chatImpl(args, index)

    // 2. Per-file isolation: throw only for the named file (D-15).
    if (opts.throwForFilename && requestText(args).includes(opts.throwForFilename)) {
      throw (
        opts.throwForFilenameError ??
        new Error(`fake-openai-client: simulated failure for ${opts.throwForFilename}`)
      )
    }

    // 3. Blanket failure.
    if (opts.chatError) throw opts.chatError

    // 4. Canned responses.
    if (opts.chatResponse !== undefined) return pickFor(opts.chatResponse, index)
    if (opts.parsedObject !== undefined) return makeChatResponse(pickFor(opts.parsedObject, index))

    return makeChatResponse(null)
  }

  const client: FakeOpenAIClient = {
    models: {
      list: async (): Promise<ModelListPage> => {
        calls.push({ method: 'models.list' })
        if (opts.modelsError) throw opts.modelsError
        const data = opts.models ?? []
        // The real SDK Page is BOTH async-iterable and `.data`-bearing; support both so a
        // consumer written either way works against the double.
        return {
          data,
          async *[Symbol.asyncIterator](): AsyncIterator<ModelListEntry> {
            for (const entry of data) yield entry
          }
        } as ModelListPage
      }
    },
    chat: {
      completions: {
        parse: async (args: ChatCompletionArgs): Promise<ChatCompletionResponse> => {
          calls.push({ method: 'chat.completions.parse', args })
          return nextChatResponse(args)
        },
        create: async (args: ChatCompletionArgs): Promise<ChatCompletionResponse> => {
          calls.push({ method: 'chat.completions.create', args })
          return nextChatResponse(args)
        }
      }
    },
    calls,
    neverCalled: () => calls.length === 0,
    callCount: (method) => (method ? calls.filter((c) => c.method === method).length : calls.length),
    chatCalls: () => calls.filter((c) => c.method !== 'models.list'),
    reset: () => {
      calls.length = 0
      chatCallIndex = 0
    }
  }

  return client
}
