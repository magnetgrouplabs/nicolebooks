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
// THE ONE INFERRED FIELD (added after the live drill). Every field above is a transcription, and
// suggested_category is not: no bill PRINTS the category its recipient files it under, so under a
// transcription-only prompt the honest answer was null on all nine drill fixtures and every review
// row needed its category picked by hand. So this field, and only this field, is now asked for as
// an INFERENCE from the vendor and the line items. Three things keep that safe:
//
//   1. It is scoped by name. The exception sentence and CATEGORY_INSTRUCTION both name
//      suggested_category, so the never-invent rule still governs the vendor, the amounts, the
//      dates and the invoice number, which are the fields that become audit record in QuickBooks.
//   2. It cannot certify itself. confidence.ts refuses to ground suggestedCategory no matter what
//      the document text contains (see isGrounded), so an inferred phrase can never earn 'high'
//      from a coincidental substring hit; it lands at the model's advisory self-report or 'low'.
//   3. It is never posted as written. The phrase is a QUERY: recon ranks it against the company's
//      real expense accounts and a person confirms the account. A phrase that matches nothing
//      leaves the cell empty, which is exactly the state the drill already produced.
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
 * The D-23 system message, from 03-RESEARCH Directive 4 (lines 349-355).
 * Do not paraphrase without re-running the extraction spec: every sentence here maps to a
 * specific failure mode the phase is accountable for.
 *
 * The closing pair of sentences is the one addition to the researcher's wording: it carves
 * suggested_category out of the never-infer rule BY NAME, so the rule keeps its full force over
 * every field that becomes a permanent record in somebody's books.
 */
export const BILL_SYSTEM_PROMPT = `You extract billing fields from a single vendor bill (invoice or receipt).
You return ONLY data that is actually present. If a field is not visibly present,
return null for it. Never invent, infer, or guess a value to fill a field.
The IMAGE is the ground truth. Any transcribed text provided is a NOISY reference
that may contain OCR errors; when the text and the image disagree, trust the image.
Report every monetary amount exactly as printed (digits and decimal separator as shown).
Report dates exactly as printed; do not reformat or infer a year that is not shown.
There is exactly ONE exception to all of the above, the suggested_category field, which bills do
not print and which you are asked to INFER from the vendor and the line items.
That exception applies to suggested_category alone; every other field stays a transcription.`

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
 * The suggested_category inference instruction, the one place a field is asked for as a judgement.
 *
 * THE PHRASE IS A QUERY, NOT A LABEL. It is never shown as the answer and never posted: recon
 * ranks it against the connected company's real expense accounts with a blend of token overlap and
 * character similarity, and only a person confirms the account. That is what fixes the wording, and
 * the first live revalidation measured exactly how much it matters. Asked for a merchandise-flavoured
 * phrase, gpt-4o-mini answered well and matched badly: "plumbing supplies" reached its best account
 * at 0.61, "auto parts" at 0.59 and "electrical supplies" at 0.57, all of them just under the 0.62
 * suggest floor, so four correct readings produced three empty cells. The same documents described
 * in standard chart-of-accounts wording ("job materials", "automobile", "fuel") score 1.0. The
 * qualifier is what costs the match: it adds a token the account name does not have, and the token
 * half of the blend leads.
 *
 * So every clause below is doing work:
 *
 *   "one to three plain words"  Brevity is a MATCHING property, not a style preference. Each extra
 *       word the account name does not share dilutes the token half of the score.
 *   "the way a QuickBooks chart of accounts writes an expense account"  Names the target register
 *       directly. This app talks to exactly one accounting system, so the vocabulary that matches
 *       is not a guess.
 *   "the standard category, not the goods", with its three contrasts  The single highest-value
 *       clause, and the one the revalidation is built on. It converts the model's natural answer
 *       into the account's own wording.
 *   the eight example wordings  QuickBooks' own default expense accounts, present in essentially
 *       every company file rather than copied from one chart. They steer the REGISTER without
 *       teaching the model to guess at an account list it cannot see, and a phrase that matches
 *       nothing still leaves the cell empty rather than filling it wrongly.
 *   "do not copy a line item, a product code, or the vendor name"  The three failure modes that
 *       produce a phrase which looks filled in and matches nothing.
 *   "null only when ... no basis at all"  Keeps the field genuinely nullable (D-09). A blank or
 *       unreadable receipt must still be allowed to answer nothing.
 */
export const CATEGORY_INSTRUCTION =
  'suggested_category is the one field you INFER rather than read. Look at the vendor and the ' +
  'line items and name the expense category a bookkeeper would file this bill under, written the ' +
  'way a QuickBooks chart of accounts writes an expense account: one to three plain words, with ' +
  'no trade or product qualifier. Name the standard category, not the goods, so "job materials" ' +
  'rather than "plumbing supplies", "automobile" rather than "auto parts", "office expenses" ' +
  'rather than "printer toner". Other standard wordings are "fuel", "supplies", "utilities", ' +
  '"repairs and maintenance", "travel", "insurance", "advertising" and "equipment rental". Do not ' +
  'copy a line item, a product code, or the vendor name into it, and do not write an account ' +
  'number. Return null for suggested_category only when the document gives you no basis at all. ' +
  'Every other field stays a transcription: return null whenever it is not printed on the bill.'

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
 *   3. the suggested_category inference instruction,
 *   4. any extra instructions (schema description, repair re-ask),
 *   5. one image part per page.
 *
 * The category instruction rides in this builder rather than at a call site so it is present on
 * every rung of the D-25 ladder and on the repair re-ask: a fallback that silently dropped it
 * would answer with the old transcription-only behaviour on exactly the endpoints least able to
 * follow a schema.
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
    { type: 'text', text: EXTRACT_INSTRUCTION },
    { type: 'text', text: CATEGORY_INSTRUCTION }
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
