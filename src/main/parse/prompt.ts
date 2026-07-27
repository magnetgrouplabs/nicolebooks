// src/main/parse/prompt.ts
//
// The vision-extraction prompt (decision D-23), kept as ONE diffable, testable module so a
// wording change is a reviewable one-file diff rather than a string edit buried in call-site
// logic. Anthony locked the researcher's recommended prompt VERBATIM (03-RESEARCH Directive 4,
// lines 347-365); the wording is tunable but every guardrail below is load-bearing:
//
//   "return null ... never invent"   Optional fields are genuinely nullable (D-09). Forcing a
//                                    field to be required is the top cause of hallucinated
//                                    fills, and an invented invoice number on a cash receipt is
//                                    a fabricated audit record in a financial system.
//   "The IMAGE is the ground truth"  This is what makes belt-and-suspenders (D-06) safe. A
//                                    native PDF sends its embedded text AND its rendered page;
//                                    when a junk OCR transcription disagrees with the page, the
//                                    page wins, deterministically, by instruction.
//   "exactly as printed"             The model is never asked to do arithmetic or unit
//                                    conversion. Money comes back as the RAW PRINTED STRING and
//                                    the local, deterministic gate in validate.ts coerces it to
//                                    integer cents (RESEARCH Pitfall 4).
//
// ORDERING (D-23): every text part precedes every image part. A vision model weights the
// last-seen modality heavily, so text-after-image is how a noisy transcription overrides a
// correctly-read total. buildUserContent enforces the order structurally — extra instructions
// (the ladder's schema description, a repair re-ask) are appended to the TEXT block, never
// after the images.
//
// A pure, side-effect-free module in the src/main/ingestion/hash.ts convention: no Electron,
// no network, no SDK import. Its only dependency is the shared BillSchema, so the schema that
// travels in the prompt and the schema that validates the reply can never drift apart.

import { z } from 'zod'
import { BillSchema } from '../../shared/schemas'

/**
 * The D-23 system message, verbatim from 03-RESEARCH Directive 4 (lines 349-355).
 * Do not paraphrase without re-running the extraction spec: every sentence here maps to a
 * specific failure mode the phase is accountable for.
 */
export const BILL_SYSTEM_PROMPT = `You extract billing fields from a single vendor bill (invoice or receipt).
You return ONLY data that is actually present. If a field is not visibly present,
return null for it. Never invent, infer, or guess a value to fill a field.
The IMAGE is the ground truth. Any transcribed text provided is a NOISY reference
that may contain OCR errors; when the text and the image disagree, trust the image.
Report every monetary amount exactly as printed (digits and decimal separator as shown).
Report dates exactly as printed; do not reformat or infer a year that is not shown.`

/** Header on the reference-transcription part. Labels the text as untrusted before it is read. */
export const REFERENCE_TRANSCRIPTION_HEADER = 'REFERENCE TRANSCRIPTION (may be empty or noisy):'

/**
 * What fills the transcription slot for an image-only document (photo, scanned PDF). The slot is
 * always present: a silently missing content part reads to the model like a truncated prompt,
 * whereas an explicit "none" tells it there is simply nothing to cross-check against.
 */
export const NO_TRANSCRIPTION_MARKER = 'none'

/** The extract instruction, verbatim from 03-RESEARCH Directive 4 (line 361). */
export const EXTRACT_INSTRUCTION =
  'Extract the fields defined by the schema. Return null for anything absent.'

/**
 * Image fidelity. Invoices are dense and carry small print, and this app is accuracy-first with
 * negligible volume, so the extra tokens of 'high' are the right trade (RESEARCH Pitfall 6).
 */
export const IMAGE_DETAIL = 'high'

/**
 * The bill shape as JSON Schema, derived from the authoritative BillSchema rather than
 * hand-written, so rungs 2 and 3 of the D-25 ladder describe exactly the shape rung 1 enforces
 * and exactly the shape the local re-validation applies.
 */
export const BILL_JSON_SCHEMA = z.toJSONSchema(BillSchema)

const SCHEMA_TEXT = JSON.stringify(BILL_JSON_SCHEMA)

/**
 * Rung 2 of the D-25 ladder. `response_format: {type:'json_object'}` constrains SYNTAX only —
 * the provider guarantees valid JSON, not the right keys — so the shape has to travel in the
 * prompt itself.
 */
export const SCHEMA_IN_PROMPT_INSTRUCTION =
  'Return a single JSON object that matches this JSON Schema exactly. Every key must be ' +
  `present; use null for any field that is not visibly present on the bill.\n${SCHEMA_TEXT}`

/**
 * Rung 3 of the D-25 ladder: the endpoint supports no structured-output mode at all, so the
 * "no prose, no code fence" instruction is the only thing keeping the reply parseable.
 */
export const PLAIN_JSON_INSTRUCTION =
  'Respond with ONLY a JSON object - no prose, no explanation, no markdown code fence. It must ' +
  'match this JSON Schema exactly. Every key must be present; use null for any field that is ' +
  `not visibly present on the bill.\n${SCHEMA_TEXT}`

/**
 * The single corrective re-ask (D-25). It carries the local Zod error — field paths and type
 * expectations, never the document's values — so the model learns what to fix without the
 * module echoing an untrusted payload back into a new prompt wholesale.
 */
export function buildRepairInstruction(error: string): string {
  return `Your last output failed validation: ${error}; return corrected JSON only, with no other text.`
}

/** A text content part of a chat message. */
export interface PromptTextPart {
  type: 'text'
  text: string
}

/** An image content part. `detail` is always IMAGE_DETAIL; see the constant above. */
export interface PromptImagePart {
  type: 'image_url'
  image_url: { url: string; detail: string }
}

export type PromptContentPart = PromptTextPart | PromptImagePart

export interface UserContentOptions {
  /** Embedded PDF text on the native route (D-06); null/empty on the image-only route (D-07). */
  referenceText?: string | null
  /** One prepared JPEG data URL per page, in page order. */
  imageDataUrls: string[]
  /** Ladder/repair instructions. Appended to the TEXT block so ordering cannot be violated. */
  extraInstructions?: string[]
}

/**
 * Build the user message content array in the D-23 order:
 *   1. the reference transcription (or the explicit "none" marker),
 *   2. the extract instruction,
 *   3. any extra instructions (schema description, repair re-ask),
 *   4. one image part per page.
 *
 * The loop that appends images runs LAST and is the only place image parts are created, which
 * is what makes "text before image" a structural property of this function rather than a
 * convention call sites have to remember.
 */
export function buildUserContent(options: UserContentOptions): PromptContentPart[] {
  const reference = (options.referenceText ?? '').trim()
  const parts: PromptContentPart[] = [
    {
      type: 'text',
      text: `${REFERENCE_TRANSCRIPTION_HEADER}\n${reference === '' ? NO_TRANSCRIPTION_MARKER : reference}`
    },
    { type: 'text', text: EXTRACT_INSTRUCTION }
  ]

  for (const instruction of options.extraInstructions ?? []) {
    if (typeof instruction === 'string' && instruction.trim() !== '') {
      parts.push({ type: 'text', text: instruction })
    }
  }

  for (const url of options.imageDataUrls ?? []) {
    parts.push({ type: 'image_url', image_url: { url, detail: IMAGE_DETAIL } })
  }

  return parts
}
