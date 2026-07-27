// src/main/ai/vision-families.ts
//
// The curated vision-capable model families (decision D-02, rung 2 of the D-25 classification
// order). This is the FALLBACK signal: it only runs when the endpoint reports no capability
// metadata of its own. OpenAI's /v1/models returns the minimal { id, object, created, owned_by }
// shape with no modality information at all, so without this list every OpenAI model would land
// unbadged and Nicole would hit the D-01 "use anyway" confirm gate on gpt-4o.
//
// Deliberately a small, pure, zero-dependency module (the src/main/ingestion/hash.ts convention):
// no Electron, no network, no state, directly unit-testable. Being wrong in either direction is
// recoverable by design — a missed family only means an extra confirm click (D-01 never hides a
// model), and the flag is advisory, never a hard filter.
//
// Families are from 03-RESEARCH Directive 6: gpt-4o, gpt-4.1, gpt-4 turbo/vision, the o-series,
// Claude 3/4 (opus/sonnet/haiku), Gemini 1.5/2/3 and the flash/pro lines, Llama vision, Qwen-VL,
// and Pixtral, plus an explicit "-vision-" name segment.

/**
 * Curated matchers, evaluated against the full model id. Ids arrive either bare ("gpt-4o", the
 * OpenAI shape) or provider-qualified ("openai/gpt-4o-mini", the OpenRouter shape), so every
 * pattern is anchored loosely enough to survive the prefix.
 */
const VISION_FAMILIES: readonly RegExp[] = [
  /gpt-4o/i, // gpt-4o, gpt-4o-mini, chatgpt-4o-latest
  /gpt-4\.1/i, // gpt-4.1, gpt-4.1-mini, gpt-4.1-nano
  /gpt-4[-_]?(turbo|vision)/i, // gpt-4-turbo, gpt-4-vision-preview
  /(^|\/)o[134](-|$)/i, // o1, o1-preview, o3-mini, o4-mini (bare or provider-qualified)
  /claude-3/i, // claude-3-opus, claude-3-5-sonnet, claude-3-7-sonnet
  /claude-4/i,
  /claude-(opus|sonnet|haiku)/i, // claude-opus-4, claude-sonnet-4
  /gemini-(1\.5|2|2\.5|3)/i, // gemini-1.5-pro, gemini-2.0-flash-exp
  /gemini[\w.-]*-(flash|pro)\b/i, // gemini-flash-latest, gemini-pro-vision
  /llama[\w.-]*vision/i, // llama-3.2-11b-vision, llama-3.2-90b-vision-instruct
  /qwen[\w.]*-?vl/i, // qwen-vl, qwen2-vl, qwen2.5-vl
  /pixtral/i, // pixtral-12b, pixtral-large
  /[-_/]vision([-_.]|$)/i // any id naming "vision" as its own segment
]

/**
 * True when the model id matches a known vision-capable family. Pure: same input, same answer,
 * no side effects. Called only after the endpoint's own metadata came back inconclusive (D-25).
 */
export function isKnownVisionFamily(id: string): boolean {
  if (!id) return false
  return VISION_FAMILIES.some((pattern) => pattern.test(id))
}
