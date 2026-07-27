// test/fake-openai-client.test.ts
//
// Guard for the shared fake OpenAI-compatible double that EVERY other Phase 3 spec injects
// (03-VALIDATION Wave 0). If the double silently stops recording calls or stops honoring
// throwForFilename, the downstream proofs it underwrites — PARSE-05 cache-hit-no-recall
// ("client NEVER called") and D-15 per-file isolation ("only the named file fails") — would
// pass vacuously. This spec keeps that from happening.

import { describe, it, expect } from 'vitest'
import { makeFakeClient, makeChatResponse } from './helpers/fake-openai-client'

describe('fake OpenAI client double', () => {
  it('records calls, supports both models.list access styles, throws per filename', async () => {
    const bare = makeFakeClient()
    expect(bare.neverCalled()).toBe(true)

    const c = makeFakeClient({
      models: [
        { id: 'gpt-4o', object: 'model', created: 1, owned_by: 'openai' },
        { id: 'x/y', architecture: { input_modalities: ['text', 'image'] }, supported_parameters: ['structured_outputs'] }
      ],
      parsedObject: { vendor: 'Acme', total: '10.00' },
      throwForFilename: 'bad.pdf'
    })

    const page = await c.models.list()
    expect(page.data.map((m) => m.id)).toEqual(['gpt-4o', 'x/y'])
    const iterated: string[] = []
    for await (const m of page) iterated.push(m.id)
    expect(iterated).toEqual(['gpt-4o', 'x/y'])

    const ok = await c.chat.completions.parse({
      model: 'gpt-4o',
      temperature: 0,
      messages: [
        { role: 'system', content: 'sys' },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'good.pdf transcription' },
            { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAA', detail: 'high' } }
          ]
        }
      ]
    })
    expect(ok.choices[0].message.parsed).toEqual({ vendor: 'Acme', total: '10.00' })

    await expect(
      c.chat.completions.create({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'bad.pdf transcription' }] }]
      })
    ).rejects.toThrow(/bad\.pdf/)

    expect(c.callCount()).toBe(3)
    expect(c.callCount('models.list')).toBe(1)
    expect(c.chatCalls()).toHaveLength(2)
    expect(c.neverCalled()).toBe(false)
    c.reset()
    expect(c.neverCalled()).toBe(true)

    // ordered array of canned responses (repair-retry scripting)
    const seq = makeFakeClient({ chatResponse: [makeChatResponse({ a: 1 }), makeChatResponse({ a: 2 })] })
    const r1 = await seq.chat.completions.parse({ model: 'm', messages: [] })
    const r2 = await seq.chat.completions.parse({ model: 'm', messages: [] })
    const r3 = await seq.chat.completions.parse({ model: 'm', messages: [] })
    expect(r1.choices[0].message.parsed).toEqual({ a: 1 })
    expect(r2.choices[0].message.parsed).toEqual({ a: 2 })
    expect(r3.choices[0].message.parsed).toEqual({ a: 2 })
  })
})
