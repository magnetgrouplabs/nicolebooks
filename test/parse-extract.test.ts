// test/parse-extract.test.ts
//
// Wave-0 (RED) unit spec for the vision extraction step (plan 03-05, requirement PARSE-03,
// decisions D-21, D-23 and D-25). Until src/main/parse/prompt.ts and
// src/main/parse/extract-fields.ts exist this file fails to import — the correct Wave-0 state.
//
// Everything here runs against the shared fake OpenAI double (test/helpers/fake-openai-client.ts):
// no Electron, no network, no API key. The double records every call, which is what makes the
// call-count assertions below ("exactly ONE repair retry", "the ladder did not descend") real
// proofs rather than shape checks.
//
// What must hold, and why each one is a money bug if it does not:
//
//   1. CONTENT ORDER (D-23). Every text part precedes every image part, and the image is
//      declared ground truth while the transcription is declared noisy. A vision model weights
//      the last-seen modality heavily; putting the noisy OCR text after the image is how a junk
//      transcription overrides a correctly-read total.
//   2. REQUIRED-FIELD MINIMIZATION (D-09/D-23). Only `vendor` and `total` carry a non-null
//      requirement. Forcing an optional field to be required is the top cause of hallucinated
//      fills — an invented invoice number on a cash receipt is a fabricated audit record.
//   3. THE FALLBACK LADDER (D-25). strict json_schema -> json_object + schema-in-prompt ->
//      plain-prompt JSON, and the LOCAL BillSchema re-validates on EVERY rung. Providers vary in
//      how much of a schema they actually enforce, so the only gate we control is the local one
//      (RESEARCH Pattern 3). A ladder that skipped local validation on the "guaranteed" rung
//      would trust the provider's word about a financial document.
//   4. ONE REPAIR RETRY, THEN FLAG-AND-KEEP (D-25/D-15). A Zod-invalid reply gets exactly one
//      corrective re-ask. Unbounded repair loops burn a paid API against a model that cannot
//      comply; zero repairs throws away a bill over a fixable formatting slip. Still invalid ->
//      a structured failure marker, never a throw, so the pipeline can mark one file failed and
//      keep parsing the rest of the batch.
//   5. A BOUNDED SINGLE CALL (D-21). Every page rides in one multi-image request, capped at 10;
//      over the cap it is pages 1-3 plus the last 2 with a `truncated` flag, because the total
//      lives on the last page.

import { describe, expect, it } from 'vitest'
import { BillSchema } from '../src/shared/schemas'
import {
  makeChatResponse,
  makeFakeClient,
  makeTextResponse,
  type ChatCompletionArgs,
  type ChatContentPart
} from './helpers/fake-openai-client'
import {
  BILL_SYSTEM_PROMPT,
  EXTRACT_INSTRUCTION,
  NO_TRANSCRIPTION_MARKER,
  PLAIN_JSON_INSTRUCTION,
  REFERENCE_TRANSCRIPTION_HEADER,
  SCHEMA_IN_PROMPT_INSTRUCTION,
  buildUserContent
} from '../src/main/parse/prompt'
import {
  HEAD_PAGE_IMAGES,
  MAX_PAGE_IMAGES,
  TAIL_PAGE_IMAGES,
  extractFields,
  selectPageImages
} from '../src/main/parse/extract-fields'

// --- fixtures -------------------------------------------------------------------------

const MODEL = 'fake-vision-model'

/** A page image the way prep-image.ts / extract-pdf.ts hand it over: a JPEG data URL. */
const page = (n: number): string => `data:image/jpeg;base64,PAGE-${n}`

/**
 * The minimal schema-valid bill: vendor + total present, every other field explicitly null.
 * This IS the required-field-minimization contract in object form.
 */
const MINIMAL_BILL = {
  vendor: 'Acme Supply Co',
  invoice_number: null,
  invoice_date: null,
  due_date: null,
  subtotal: null,
  tax: null,
  total: '$1,234.10',
  currency: null,
  suggested_category: null
}

/** An error shaped like a provider rejecting an unsupported structured-output parameter. */
const unsupported = (what: string): Error =>
  Object.assign(new Error(`Invalid parameter: response_format of type '${what}' is not supported`), {
    status: 400
  })

/** An error shaped like a rejected credential. The ladder must NOT retry its way through this. */
const unauthorized = (): Error =>
  Object.assign(new Error('Incorrect API key provided'), { status: 401 })

// --- readers over the recorded calls ---------------------------------------------------

function userParts(args: ChatCompletionArgs | undefined): ChatContentPart[] {
  const user = args?.messages.find((m) => m.role === 'user')
  if (!user || typeof user.content === 'string') {
    throw new Error('expected the user message content to be a content-part array')
  }
  return user.content
}

function userText(args: ChatCompletionArgs | undefined): string {
  return userParts(args)
    .filter((p): p is Extract<ChatContentPart, { type: 'text' }> => p.type === 'text')
    .map((p) => p.text)
    .join('\n')
}

function systemText(args: ChatCompletionArgs | undefined): string {
  const system = args?.messages.find((m) => m.role === 'system')
  return typeof system?.content === 'string' ? system.content : ''
}

// =======================================================================================
// 1. The D-23 prompt constant
// =======================================================================================

describe('BILL_SYSTEM_PROMPT — the D-23 guardrails, verbatim', () => {
  it('instructs the model to return null rather than invent a value', () => {
    expect(BILL_SYSTEM_PROMPT).toContain('return null')
    expect(BILL_SYSTEM_PROMPT).toMatch(/never invent/i)
  })

  it('declares the image ground truth and any transcription a noisy reference', () => {
    // This single sentence is what resolves the belt-and-suspenders (D-06) conflict
    // deterministically: when junk OCR text disagrees with the page, the page wins.
    expect(BILL_SYSTEM_PROMPT).toContain('ground truth')
    expect(BILL_SYSTEM_PROMPT).toMatch(/nois(y|e)/i)
  })

  it('forbids reformatting amounts and dates, so the model never does math', () => {
    // Money and dates come back as the RAW PRINTED STRING; the deterministic coercion to
    // integer cents / ISO lives locally in validate.ts (D-23, RESEARCH Pitfall 4).
    expect(BILL_SYSTEM_PROMPT).toMatch(/exactly as printed/i)
    expect(BILL_SYSTEM_PROMPT).toMatch(/do not reformat/i)
  })
})

// =======================================================================================
// 2. Content ordering (D-23)
// =======================================================================================

describe('buildUserContent — text before image (D-23)', () => {
  it('puts every text part before every image part', () => {
    const parts = buildUserContent({
      referenceText: 'INVOICE\nTOTAL 1,234.10',
      imageDataUrls: [page(1), page(2)]
    })
    const lastText = parts.map((p) => p.type).lastIndexOf('text')
    const firstImage = parts.map((p) => p.type).indexOf('image_url')
    expect(firstImage).toBeGreaterThan(-1)
    expect(lastText).toBeLessThan(firstImage)
  })

  it('leads with the reference transcription, then the extract instruction', () => {
    const parts = buildUserContent({
      referenceText: 'INVOICE\nTOTAL 1,234.10',
      imageDataUrls: [page(1)]
    })
    expect(parts[0]).toEqual({
      type: 'text',
      text: `${REFERENCE_TRANSCRIPTION_HEADER}\nINVOICE\nTOTAL 1,234.10`
    })
    expect(parts[1]).toEqual({ type: 'text', text: EXTRACT_INSTRUCTION })
  })

  it('writes an explicit "none" marker when there is no transcription (image-only route)', () => {
    // An image-only doc (photo, scanned PDF) has no text layer at all. The slot must still be
    // filled explicitly — a silently missing part reads to the model like a truncated prompt.
    for (const referenceText of ['', '   ', null, undefined]) {
      const parts = buildUserContent({ referenceText, imageDataUrls: [page(1)] })
      expect(parts[0]).toEqual({
        type: 'text',
        text: `${REFERENCE_TRANSCRIPTION_HEADER}\n${NO_TRANSCRIPTION_MARKER}`
      })
    }
  })

  it('emits one image part per page, in page order, at high detail', () => {
    const parts = buildUserContent({ referenceText: null, imageDataUrls: [page(1), page(2), page(3)] })
    const images = parts.filter(
      (p): p is Extract<ChatContentPart, { type: 'image_url' }> => p.type === 'image_url'
    )
    expect(images).toHaveLength(3)
    expect(images.map((i) => i.image_url.url)).toEqual([page(1), page(2), page(3)])
    // Dense invoices carry small print; this app is accuracy-first (RESEARCH Pitfall 6).
    expect(images.every((i) => i.image_url.detail === 'high')).toBe(true)
  })

  it('keeps extra instructions in the TEXT block, never after the images', () => {
    const parts = buildUserContent({
      referenceText: null,
      imageDataUrls: [page(1)],
      extraInstructions: ['EXTRA-A', 'EXTRA-B']
    })
    const lastText = parts.map((p) => p.type).lastIndexOf('text')
    const firstImage = parts.map((p) => p.type).indexOf('image_url')
    expect(lastText).toBeLessThan(firstImage)
    expect(parts.filter((p) => p.type === 'text').map((p) => p.text)).toContain('EXTRA-A')
    expect(parts.filter((p) => p.type === 'text').map((p) => p.text)).toContain('EXTRA-B')
  })
})

describe('extractFields — the request it puts on the wire', () => {
  it('sends the D-23 system prompt, temperature 0, and the selected model', async () => {
    const client = makeFakeClient({ parsedObject: MINIMAL_BILL })
    await extractFields({ model: MODEL, imageDataUrls: [page(1)], client })

    const args = client.chatCalls()[0]?.args
    expect(systemText(args)).toBe(BILL_SYSTEM_PROMPT)
    // Extraction is a transcription task, not a creative one: determinism beats diversity, and
    // D-22's second-pass agreement check is meaningless if the two calls are sampled.
    expect(args?.temperature).toBe(0)
    expect(args?.model).toBe(MODEL)
  })

  it('sends text before image on the wire, not just in the builder', async () => {
    const client = makeFakeClient({ parsedObject: MINIMAL_BILL })
    await extractFields({
      model: MODEL,
      referenceText: 'TOTAL 1,234.10',
      imageDataUrls: [page(1), page(2)],
      client
    })

    const kinds = userParts(client.chatCalls()[0]?.args).map((p) => p.type)
    expect(kinds.lastIndexOf('text')).toBeLessThan(kinds.indexOf('image_url'))
    expect(userText(client.chatCalls()[0]?.args)).toContain('TOTAL 1,234.10')
  })
})

// =======================================================================================
// 3. Required-field minimization (D-09/D-23)
// =======================================================================================

describe('BillSchema — only vendor and total are required (D-09/D-23)', () => {
  it('accepts vendor + total with every other field null', () => {
    expect(BillSchema.safeParse(MINIMAL_BILL).success).toBe(true)
  })

  it('rejects a response missing total', () => {
    const { total: _total, ...withoutTotal } = MINIMAL_BILL
    expect(BillSchema.safeParse(withoutTotal).success).toBe(false)
  })

  it('rejects a response missing vendor', () => {
    const { vendor: _vendor, ...withoutVendor } = MINIMAL_BILL
    expect(BillSchema.safeParse(withoutVendor).success).toBe(false)
  })

  it('accepts a null in every optional slot but never in vendor or total', () => {
    expect(BillSchema.safeParse({ ...MINIMAL_BILL, vendor: null }).success).toBe(false)
    expect(BillSchema.safeParse({ ...MINIMAL_BILL, total: null }).success).toBe(false)
    expect(BillSchema.safeParse({ ...MINIMAL_BILL, invoice_number: null }).success).toBe(true)
    expect(BillSchema.safeParse({ ...MINIMAL_BILL, suggested_category: null }).success).toBe(true)
  })
})

describe('extractFields — required-field minimization end to end', () => {
  it('returns the bill when only vendor and total came back populated', async () => {
    const client = makeFakeClient({ parsedObject: MINIMAL_BILL })
    const result = await extractFields({ model: MODEL, imageDataUrls: [page(1)], client })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.bill.vendor).toBe('Acme Supply Co')
    expect(result.bill.total).toBe('$1,234.10')
    expect(result.bill.invoice_number).toBeNull()
    expect(client.chatCalls()).toHaveLength(1)
  })

  it('treats an OMITTED optional key as an explicit null, without a repair round trip', async () => {
    // On the non-strict rungs a model routinely drops null keys entirely. That is the prompt's
    // own "return null if absent" contract expressed by omission — it must not cost a paid
    // repair call, and it must not lose an otherwise-good bill.
    const client = makeFakeClient({
      chatResponse: makeTextResponse(JSON.stringify({ vendor: 'Acme', total: '10.00' }))
    })
    const result = await extractFields({
      model: MODEL,
      imageDataUrls: [page(1)],
      startRung: 'plain',
      client
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.bill.currency).toBeNull()
    expect(result.bill.due_date).toBeNull()
    expect(client.chatCalls()).toHaveLength(1)
  })

  it('does NOT let that null-filling rescue a missing total', async () => {
    // The whole point of the minimization is that the two required fields stay required.
    const client = makeFakeClient({ parsedObject: { vendor: 'Acme' } })
    const result = await extractFields({ model: MODEL, imageDataUrls: [page(1)], client })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('schema-invalid')
  })
})

// =======================================================================================
// 4. The D-25 fallback ladder
// =======================================================================================

describe('extractFields — structured-output fallback ladder (D-25)', () => {
  it('rung 1: strict json_schema via chat.completions.parse', async () => {
    const client = makeFakeClient({ parsedObject: MINIMAL_BILL })
    const result = await extractFields({ model: MODEL, imageDataUrls: [page(1)], client })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.rung).toBe('json_schema')
    expect(client.calls[0]?.method).toBe('chat.completions.parse')

    const rf = client.chatCalls()[0]?.args?.response_format as
      | { type?: string; json_schema?: { name?: string; strict?: boolean; schema?: unknown } }
      | undefined
    expect(rf?.type).toBe('json_schema')
    expect(rf?.json_schema?.strict).toBe(true)
    expect(rf?.json_schema?.name).toBe('bill')
    expect(rf?.json_schema?.schema).toBeTruthy()
  })

  it('rung 2: falls to json_object + schema-in-prompt when json_schema is unsupported', async () => {
    const client = makeFakeClient({
      chatImpl: (args) => {
        const rf = args.response_format as { type?: string } | undefined
        if (rf?.type === 'json_schema') throw unsupported('json_schema')
        return makeTextResponse(JSON.stringify(MINIMAL_BILL))
      }
    })
    const result = await extractFields({ model: MODEL, imageDataUrls: [page(1)], client })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.rung).toBe('json_object')
    expect(client.chatCalls()).toHaveLength(2)

    const second = client.chatCalls()[1]
    expect(second?.method).toBe('chat.completions.create')
    expect(second?.args?.response_format).toEqual({ type: 'json_object' })
    // json_object mode constrains syntax only, so the SHAPE has to travel in the prompt.
    expect(userText(second?.args)).toContain(SCHEMA_IN_PROMPT_INSTRUCTION)
  })

  it('rung 3: falls to plain-prompt JSON when neither response_format is supported', async () => {
    const client = makeFakeClient({
      chatImpl: (args) => {
        const rf = args.response_format as { type?: string } | undefined
        if (rf?.type === 'json_schema') throw unsupported('json_schema')
        if (rf?.type === 'json_object') throw unsupported('json_object')
        return makeTextResponse(JSON.stringify(MINIMAL_BILL))
      }
    })
    const result = await extractFields({ model: MODEL, imageDataUrls: [page(1)], client })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.rung).toBe('plain')
    expect(client.chatCalls()).toHaveLength(3)

    const third = client.chatCalls()[2]
    expect(third?.args?.response_format).toBeUndefined()
    expect(userText(third?.args)).toContain(PLAIN_JSON_INSTRUCTION)
    // Text-before-image survives every rung; the ladder must not append instructions after
    // the images while it rebuilds the request.
    const kinds = userParts(third?.args).map((p) => p.type)
    expect(kinds.lastIndexOf('text')).toBeLessThan(kinds.indexOf('image_url'))
  })

  it('re-validates locally on the STRICT rung too (the provider is never the gate)', async () => {
    // A provider that advertises strict json_schema still returned a number where the schema
    // says string. RESEARCH Pattern 3: the local Zod parse is the only gate we control.
    const client = makeFakeClient({
      parsedObject: [{ ...MINIMAL_BILL, total: 1234.1 }, MINIMAL_BILL]
    })
    const result = await extractFields({ model: MODEL, imageDataUrls: [page(1)], client })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.rung).toBe('json_schema')
    expect(result.repaired).toBe(true)
    expect(result.bill.total).toBe('$1,234.10')
  })

  it('re-validates locally on the PLAIN rung too', async () => {
    let plainCalls = 0
    const client = makeFakeClient({
      chatImpl: (args) => {
        const rf = args.response_format as { type?: string } | undefined
        if (rf?.type === 'json_schema') throw unsupported('json_schema')
        if (rf?.type === 'json_object') throw unsupported('json_object')
        plainCalls += 1
        return makeTextResponse(
          JSON.stringify(plainCalls === 1 ? { ...MINIMAL_BILL, total: 1234.1 } : MINIMAL_BILL)
        )
      }
    })
    const result = await extractFields({ model: MODEL, imageDataUrls: [page(1)], client })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.rung).toBe('plain')
    expect(result.repaired).toBe(true)
    // parse(json_schema) + create(json_object) + create(plain) + create(plain repair)
    expect(client.chatCalls()).toHaveLength(4)
  })

  it('strips a markdown code fence from a plain-rung reply', async () => {
    const client = makeFakeClient({
      chatResponse: makeTextResponse('```json\n' + JSON.stringify(MINIMAL_BILL) + '\n```')
    })
    const result = await extractFields({
      model: MODEL,
      imageDataUrls: [page(1)],
      startRung: 'plain',
      client
    })

    expect(result.ok).toBe(true)
    expect(client.chatCalls()).toHaveLength(1)
  })

  it('starts at the rung the caller pins from the model capabilities', async () => {
    const client = makeFakeClient({
      chatResponse: makeTextResponse(JSON.stringify(MINIMAL_BILL))
    })
    const result = await extractFields({
      model: MODEL,
      imageDataUrls: [page(1)],
      startRung: 'plain',
      client
    })

    expect(result.ok).toBe(true)
    expect(client.chatCalls()).toHaveLength(1)
    expect(client.chatCalls()[0]?.method).toBe('chat.completions.create')
    expect(client.chatCalls()[0]?.args?.response_format).toBeUndefined()
  })

  it('does NOT descend the ladder on a rejected credential', async () => {
    // Walking the ladder on a 401 means three rejected calls per file and a batch of 12 bills
    // hammering the endpoint 36 times with a bad key. The rung is not the problem here.
    const client = makeFakeClient({ chatError: unauthorized() })
    const result = await extractFields({ model: MODEL, imageDataUrls: [page(1)], client })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('call-failed')
    expect(client.chatCalls()).toHaveLength(1)
  })

  it('does NOT descend the ladder on a connection failure', async () => {
    const connection = Object.assign(new Error('Connection error.'), { name: 'APIConnectionError' })
    const client = makeFakeClient({ chatError: connection })
    const result = await extractFields({ model: MODEL, imageDataUrls: [page(1)], client })

    expect(result.ok).toBe(false)
    expect(client.chatCalls()).toHaveLength(1)
  })

  // WR-04. The implementation was the inverse of the documented rule: descend on ANYTHING under
  // 500 that was not explicitly excluded. Each admitted status cost three full requests per file
  // plus a repair re-ask, all failing identically.
  it('descends ONLY on the documented parameter-rejection statuses', async () => {
    for (const status of [400, 404, 422]) {
      const client = makeFakeClient({
        chatError: Object.assign(new Error('unsupported parameter'), { status })
      })
      await extractFields({ model: MODEL, imageDataUrls: [page(1)], client })
      expect(client.chatCalls(), `status ${status} should walk the ladder`).toHaveLength(3)
    }
  })

  it('does NOT descend on a status that has nothing to do with the rung', async () => {
    // 402 is OpenRouter's exhausted-balance response; 413 is reachable through a long statement;
    // 451/423/424 and every future 4xx a provider invents are the same class of non-rung problem.
    for (const status of [402, 413, 415, 423, 424, 429, 451]) {
      const client = makeFakeClient({
        chatError: Object.assign(new Error('not a rung problem'), { status })
      })
      const result = await extractFields({ model: MODEL, imageDataUrls: [page(1)], client })
      expect(result.ok).toBe(false)
      expect(client.chatCalls(), `status ${status} should stop at one call`).toHaveLength(1)
    }
  })

  it('does NOT descend on a server fault', async () => {
    const client = makeFakeClient({
      chatError: Object.assign(new Error('upstream is down'), { status: 503 })
    })
    await extractFields({ model: MODEL, imageDataUrls: [page(1)], client })
    expect(client.chatCalls()).toHaveLength(1)
  })

  it('still descends for a client that has no such method at all (no status)', async () => {
    // The original reason the ladder exists: a bare gateway wrapper whose `parse` is undefined
    // throws a TypeError with no status, and must fall through to `create`.
    const client = makeFakeClient({ parsedObject: MINIMAL_BILL })
    delete (client.chat.completions as { parse?: unknown }).parse
    const result = await extractFields({ model: MODEL, imageDataUrls: [page(1)], client })
    expect(result.ok).toBe(true)
  })

  // WR-05. temperature: 0 went on every rung of every call. OpenAI's o-series rejects an explicit
  // temperature with a 400, and vision-families.ts badges o1/o3-mini/o4-mini as CONFIRMED
  // vision-capable, so choosing one made every file fail with "The AI service could not be
  // reached for this file. Click Retry" — an infinite retry loop against a configuration problem
  // a non-technical user cannot diagnose.
  it('retries the same rung without temperature when the model rejects the parameter', async () => {
    const client = makeFakeClient({
      chatImpl: (args) => {
        if (args.temperature !== undefined) {
          throw Object.assign(
            new Error("Unsupported value: 'temperature' does not support 0 with this model"),
            { status: 400 }
          )
        }
        return makeChatResponse(MINIMAL_BILL)
      }
    })

    const result = await extractFields({ model: 'o3-mini', imageDataUrls: [page(1)], client })

    expect(result.ok).toBe(true)
    expect(client.chatCalls()).toHaveLength(2)
    // The retry stays on the STRONGEST rung: the parameter was the problem, not the rung.
    expect(client.chatCalls()[1]?.method).toBe('chat.completions.parse')
    expect(client.chatCalls()[0]?.args?.temperature).toBe(0)
    expect(client.chatCalls()[1]?.args?.temperature).toBeUndefined()
  })

  it('keeps temperature dropped for the rest of the document, including the repair re-ask', async () => {
    let replies = 0
    const client = makeFakeClient({
      chatImpl: (args) => {
        if (args.temperature !== undefined) {
          throw Object.assign(new Error("'temperature' is not supported with this model"), {
            status: 400
          })
        }
        replies += 1
        // First accepted reply fails the local schema, forcing the one repair re-ask.
        return makeChatResponse(replies === 1 ? { ...MINIMAL_BILL, total: 1234.1 } : MINIMAL_BILL)
      }
    })

    const result = await extractFields({ model: 'o4-mini', imageDataUrls: [page(1)], client })

    expect(result.ok).toBe(true)
    // One rejected call, then every later call omits the parameter rather than re-learning it.
    expect(client.chatCalls()).toHaveLength(3)
    for (const call of client.chatCalls().slice(1)) {
      expect(call.args?.temperature).toBeUndefined()
    }
  })

  it('still sends temperature 0 to a model that accepts it (D-22 determinism)', async () => {
    const client = makeFakeClient({ parsedObject: MINIMAL_BILL })
    await extractFields({ model: MODEL, imageDataUrls: [page(1)], client })
    expect(client.chatCalls()).toHaveLength(1)
    expect(client.chatCalls()[0]?.args?.temperature).toBe(0)
  })

  it('does not treat a 5xx that merely mentions temperature as a parameter rejection', async () => {
    const client = makeFakeClient({
      chatError: Object.assign(new Error('upstream temperature sensor fault'), { status: 503 })
    })
    await extractFields({ model: MODEL, imageDataUrls: [page(1)], client })
    expect(client.chatCalls()).toHaveLength(1)
  })

  it('returns a failure marker when every rung is unsupported', async () => {
    const client = makeFakeClient({ chatError: unsupported('everything') })
    const result = await extractFields({ model: MODEL, imageDataUrls: [page(1)], client })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('call-failed')
    expect(client.chatCalls()).toHaveLength(3)
  })
})

// =======================================================================================
// 5. One repair retry, then flag-and-keep (D-25/D-15)
// =======================================================================================

describe('extractFields — exactly one repair retry (D-25)', () => {
  it('re-asks once with the validation error, then succeeds', async () => {
    const client = makeFakeClient({
      parsedObject: [{ ...MINIMAL_BILL, total: 1234.1 }, MINIMAL_BILL]
    })
    const result = await extractFields({ model: MODEL, imageDataUrls: [page(1)], client })

    expect(client.chatCalls()).toHaveLength(2)
    expect(userText(client.chatCalls()[0]?.args)).not.toMatch(/failed validation/i)
    expect(userText(client.chatCalls()[1]?.args)).toMatch(/failed validation/i)
    expect(userText(client.chatCalls()[1]?.args)).toMatch(/corrected JSON only/i)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.repaired).toBe(true)
  })

  it('keeps the repair re-ask in the text block, before the images', async () => {
    const client = makeFakeClient({
      parsedObject: [{ ...MINIMAL_BILL, total: 1234.1 }, MINIMAL_BILL]
    })
    await extractFields({ model: MODEL, imageDataUrls: [page(1), page(2)], client })

    const kinds = userParts(client.chatCalls()[1]?.args).map((p) => p.type)
    expect(kinds.lastIndexOf('text')).toBeLessThan(kinds.indexOf('image_url'))
    expect(kinds.filter((k) => k === 'image_url')).toHaveLength(2)
  })

  it('stops after ONE repair and returns a failure marker, never a throw', async () => {
    const client = makeFakeClient({ parsedObject: { ...MINIMAL_BILL, total: 1234.1 } })
    const result = await extractFields({ model: MODEL, imageDataUrls: [page(1)], client })

    // Two calls, not three, not a loop: the model has now failed the same schema twice.
    expect(client.chatCalls()).toHaveLength(2)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('schema-invalid')
    expect(result.detail).toBeTruthy()
  })

  it('treats a non-JSON reply as invalid and repairs once', async () => {
    const client = makeFakeClient({
      chatResponse: [
        makeTextResponse('I am sorry, I cannot read this receipt.'),
        makeTextResponse(JSON.stringify(MINIMAL_BILL))
      ]
    })
    const result = await extractFields({
      model: MODEL,
      imageDataUrls: [page(1)],
      startRung: 'plain',
      client
    })

    expect(client.chatCalls()).toHaveLength(2)
    expect(result.ok).toBe(true)
  })

  it('does not re-ask a rung whose repair call itself fails', async () => {
    const client = makeFakeClient({
      chatImpl: (_args, index) => {
        if (index === 0) return makeChatResponse({ ...MINIMAL_BILL, total: 1234.1 })
        throw unauthorized()
      }
    })
    const result = await extractFields({ model: MODEL, imageDataUrls: [page(1)], client })

    expect(client.chatCalls()).toHaveLength(2)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('call-failed')
  })
})

describe('extractFields — failure is data, never an exception (D-15, T-03-01)', () => {
  it('survives a client that rejects with a non-Error value', async () => {
    const client = makeFakeClient({
      chatImpl: () => {
        throw 'boom' as unknown as Error
      }
    })
    const result = await extractFields({ model: MODEL, imageDataUrls: [page(1)], client })
    expect(result.ok).toBe(false)
  })

  it('survives an empty completion with no content at all', async () => {
    const client = makeFakeClient({ chatResponse: { choices: [] } })
    const result = await extractFields({ model: MODEL, imageDataUrls: [page(1)], client })
    expect(result.ok).toBe(false)
  })

  it('bounds the failure detail so a huge provider dump cannot ride out of the module', async () => {
    const client = makeFakeClient({ chatError: new Error('x'.repeat(5000)) })
    const result = await extractFields({ model: MODEL, imageDataUrls: [page(1)], client })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.detail.length).toBeLessThanOrEqual(512)
  })
})

// =======================================================================================
// 6. One bounded multi-image call (D-21)
// =======================================================================================

describe('selectPageImages — the D-21 10-page cap', () => {
  it('sends every page when the document is at or under the cap', () => {
    const urls = Array.from({ length: MAX_PAGE_IMAGES }, (_, i) => page(i + 1))
    expect(selectPageImages(urls)).toEqual({ imageDataUrls: urls, truncated: false })
  })

  it('sends the first three and the last two when the document is over the cap', () => {
    // The total is almost always on the last page, so a naive "first N" truncation would drop
    // the single most important number on the document.
    const urls = Array.from({ length: 14 }, (_, i) => page(i + 1))
    const selected = selectPageImages(urls)
    expect(selected.truncated).toBe(true)
    expect(selected.imageDataUrls).toEqual([page(1), page(2), page(3), page(13), page(14)])
    expect(selected.imageDataUrls).toHaveLength(HEAD_PAGE_IMAGES + TAIL_PAGE_IMAGES)
  })

  it('handles an empty page list without throwing', () => {
    expect(selectPageImages([])).toEqual({ imageDataUrls: [], truncated: false })
  })
})

describe('extractFields — one call carries every page (D-21)', () => {
  it('attaches all pages to a SINGLE request', async () => {
    const client = makeFakeClient({ parsedObject: MINIMAL_BILL })
    await extractFields({
      model: MODEL,
      imageDataUrls: [page(1), page(2), page(3)],
      client
    })

    expect(client.chatCalls()).toHaveLength(1)
    expect(userParts(client.chatCalls()[0]?.args).filter((p) => p.type === 'image_url')).toHaveLength(3)
  })

  it('applies the cap and reports truncation to the caller', async () => {
    const client = makeFakeClient({ parsedObject: MINIMAL_BILL })
    const result = await extractFields({
      model: MODEL,
      imageDataUrls: Array.from({ length: 12 }, (_, i) => page(i + 1)),
      client
    })

    expect(result.truncated).toBe(true)
    expect(userParts(client.chatCalls()[0]?.args).filter((p) => p.type === 'image_url')).toHaveLength(
      HEAD_PAGE_IMAGES + TAIL_PAGE_IMAGES
    )
  })
})
