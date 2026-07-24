# Phase 3: AI Client and Parse Pipeline - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-07-24
**Phase:** 3-AI Client and Parse Pipeline
**Areas discussed:** Model picker + vision detection, PDF vs photo routing, Fields/confidence/validation, Parse trigger + caching

---

## Model picker + vision detection

### Vision-capability handling (AI-03)
| Option | Description | Selected |
|--------|-------------|----------|
| Flag + confirm on non-vision | Show all models, badge confirmed vision-capable ones, require explicit "use anyway" confirm on a non-vision/unbadged pick | ✓ |
| Filter — hide non-vision | Only vision-capable models appear at all | |
| Flag only (soft warning) | Badge vision models, warn on others, never block | |

### Vision detection mechanism
| Option | Description | Selected |
|--------|-------------|----------|
| Metadata first, curated fallback | Endpoint metadata when present (OpenRouter input_modalities); fall back to a maintained known-vision-family list when absent (OpenAI/custom); unconfirmed stays unbadged | ✓ |
| Endpoint metadata only | Only badge when the endpoint explicitly reports image input | |
| Model-name heuristic only | Match model IDs against vision-name patterns everywhere | |

### Endpoint / base URL entry
| Option | Description | Selected |
|--------|-------------|----------|
| Presets + custom | OpenAI/OpenRouter presets that auto-fill the base URL + a Custom free-text option | ✓ |
| OpenAI default, editable | Prefill OpenAI base URL in one editable field | |
| Free-form only | One empty base URL field | |

### Connection check / model-list fetch
| Option | Description | Selected |
|--------|-------------|----------|
| Test + load, with status | A Connect/Test action calls /models once — validates the key AND fills the picker, surfaced as an "AI connection: OK" status mirroring the Secret-store HealthIndicator | ✓ |
| Auto-load on entry | Silently fetch /models when key+URL present | |
| Manual refresh only | Explicit "Refresh models" button, nothing automatic | |

**Notes:** Storage of the key + base URL was pre-locked by Phase 1 (OS keychain via the `secrets` channel) and not re-asked.

---

## PDF vs photo routing

### Native/digital PDF branch — what the model sees
| Option | Description | Selected |
|--------|-------------|----------|
| A: Both text + image (belt-and-suspenders) | Native PDF → exact embedded text (unpdf) + rendered page image (pdfjs), text-before-image, image as ground truth; photos/scans image-only | ✓ |
| B: Text-first, image on doubt | Text-only when clean; attach image only when extraction looks weak | |
| C: Always image (vision-only) | Render every doc to an image, ignore the text layer | |

### Native-vs-scan detection gate
| Option | Description | Selected |
|--------|-------------|----------|
| Robust layered gate | Native-authoritative only when real text extracts AND not an invisible OCR overlay over a full-page image (text present, embedded fonts, low bitmap coverage, not render-mode-3); else image-only | ✓ |
| Simple text-presence check | Non-trivial text → pair both; else image-only | |
| Give research the guardrail, let it pick signals | Lock the intent, let planning pick precise signals | |

**Notes:** A research pass (gsd-advisor-researcher) preceded this decision at Anthony's request — he wanted to choose from industry-standard options, not have research decide for him. Belt-and-suspenders was Anthony's own instinct and matched the research recommendation for this app's accuracy-first / cost-irrelevant profile. Exact gate thresholds deferred to research.

---

## Fields, confidence + validation

### Per-field confidence source
| Option | Description | Selected |
|--------|-------------|----------|
| Hybrid, deterministic-weighted | Grounding + format/parse + arithmetic checks decide the flag; model self-report advisory (mainly category); LLM self-report never the gate | ✓ |
| Deterministic only | Confidence purely from validation/grounding; model never rates itself | |
| Model self-reported | Ask the model for 0-1 per field, use as the signal | |

### Validation-failure behavior
| Option | Description | Selected |
|--------|-------------|----------|
| Flag for review, keep values | Failed check = visible warning; values kept; small rounding tolerance; flag independent of model confidence | ✓ |
| Reject / block failed bills | Pull the bill until fixed | |
| Auto-correct silently | Back-derive to reconcile numbers | |

### Field schema / missing fields
| Option | Description | Selected |
|--------|-------------|----------|
| Structured JSON, optional fields nullable | Structured-outputs mode, nullable optionals + "return null if absent", Zod gate (money→cents, dates→ISO), skip subtotal+tax=total when null; mirror Azure invoice schema | ✓ |
| Structured JSON, all fields required | One fixed shape, every field required | |
| Loose JSON + Zod repair | Unconstrained output, validate/repair after | |

**Notes:** A second research pass (gsd-advisor-researcher) preceded these three. Key evidence: LLM self-reported confidence is poorly calibrated/overconfident (green-lights hallucinated totals); financial HITL standard is flag-not-reject with rounding tolerance; forcing required fields causes hallucinated fills. All three picks matched the research leans and the app's review-gate philosophy.

---

## Parse trigger + caching

### When parsing runs
| Option | Description | Selected |
|--------|-------------|----------|
| Auto-parse right after scan | Scan → immediately parse every loaded file → results land in review | ✓ |
| Explicit "Parse" button | Scan loads; user clicks Parse to run the model | |
| Auto, but confirm large batches | Auto-parse, but confirm if unusually large | |

### Cache behavior on model change
| Option | Description | Selected |
|--------|-------------|----------|
| Cache by hash; manual re-parse override | Keyed on the Phase 2 SHA-256 hash; store the model used; switching models does not auto-re-charge; per-doc/batch "Re-parse" forces a fresh call | ✓ |
| Cache by hash + model; auto re-parse on switch | Model in the key; switching re-parses everything | |
| Cache by hash only; no re-parse | Never re-call, no override | |

### Mid-batch failure handling
| Option | Description | Selected |
|--------|-------------|----------|
| Flag and continue (per-file isolation) | Failed doc = retry row; batch continues; progress shown; retry just the failures | ✓ |
| Stop on first failure | Halt the whole batch on any error | |
| Silent skip | Drop failed docs without surfacing them | |

**Notes:** These were product/architecture choices specific to the app rather than industry-standard questions, so no research pass was run. Cache key = the Phase 2 SHA-256 hash and "never re-bill on reload" were near-locked by PARSE-05 going in.

---

## Claude's Discretion

Deferred to research/planning (Anthony wants options surfaced, not unilaterally decided): exact native-vs-scan thresholds; multi-page PDF handling; whether photos get a second-pass agreement check; prompt/instruction wording; the exact `migration0003` cache schema; image downscale dimensions + JPEG quality; IPC channel names/shapes; model-call retry/backoff; `client.models.list()` shape differences across providers.

## Deferred Ideas

None new — the discussion stayed within Phase 3 scope. Adjacent capabilities intentionally out of scope (tracked as v2): multi-line itemized category splitting (V2-01), multi-invoice-per-PDF splitting (V2-02), vendor→category learning (V2-05). Phase 3 assumes one bill per file.
