---
phase: 03-ai-client-and-parse-pipeline
reviewed: 2026-07-27T15:58:53Z
depth: standard
files_reviewed: 23
files_reviewed_list:
  - src/main/ai/client.ts
  - src/main/ai/models.ts
  - src/main/ai/vision-families.ts
  - src/main/db/migrate.ts
  - src/main/db/migrations/0003_parsed_results.ts
  - src/main/ipc/ai.ts
  - src/main/ipc/ingestion.ts
  - src/main/ipc/parse.ts
  - src/main/ipc/register.ts
  - src/main/parse/cache.ts
  - src/main/parse/confidence.ts
  - src/main/parse/extract-fields.ts
  - src/main/parse/extract-pdf.ts
  - src/main/parse/pipeline.ts
  - src/main/parse/prep-image.ts
  - src/main/parse/prompt.ts
  - src/main/parse/route.ts
  - src/main/parse/validate.ts
  - src/preload/index.ts
  - src/shared/ipc-contract.ts
  - src/shared/schemas.ts
  - src/renderer/src/screens/BillsScreen.tsx
  - src/renderer/src/screens/SettingsScreen.tsx
findings:
  critical: 4
  warning: 10
  info: 6
  total: 20
status: issues_found
---

# Phase 3: Code Review Report

**Reviewed:** 2026-07-27T15:58:53Z
**Depth:** standard
**Files Reviewed:** 23
**Status:** issues_found

## Summary

The phase is well-structured and several of its headline invariants genuinely hold. Verified as
correct, by reading the code rather than the comments:

- **SQL is fully parameterized.** `cache.ts`, `models.ts`, `migrate.ts` and `0003_parsed_results.ts`
  contain no string-interpolated values. The only interpolation in the whole DB layer is
  `PRAGMA user_version = ${m.version}` with a code-controlled integer. Migration 0003 is
  `CREATE TABLE IF NOT EXISTS ... STRICT`, appended forward-only, and destroys nothing on a 2 -> 3
  upgrade.
- **sharp never receives PDF bytes.** `route.ts:130` and `pipeline.ts:365` both branch on
  `isPdf(filename)` first, and the PDF branch never reaches `prepImage`. `encodeJpeg` uses
  @napi-rs/canvas rather than sharp, keeping the PDF path sharp-free end to end.
- **`baseUrlHost()` is a real guard.** `new URL(raw).host` strips scheme, userinfo, path, query and
  fragment, so a gateway URL carrying a key in userinfo or a query string cannot reach
  `parsed_results`.
- **`raw_response` is stored but never logged and never returned to the renderer.** There is not a
  single `console.*` call anywhere in `src/`.
- **`@napi-rs/canvas` JPEG quality really is a 0-100 scale** (verified empirically), so
  `toBuffer('image/jpeg', 80)` in `extract-pdf.ts:323` is correct, not a 0-1/0-100 mix-up.
- **Renderer branding is clean.** Zero hex literals in either screen; every class resolves to a
  semantic token defined in `globals.css`.
- **`pdfjs 6` teardown is correct in two of three places** — `loadPdfSignals` and
  `renderPdfPageImage` both use `doc.loadingTask.destroy()` inside a never-throwing `finally`.

Against that, four defects break stated invariants and must be fixed before this ships. Two are
money-correctness (`toCents` silently flips the sign of common credit formats and then grades the
result `high`; the parse cache is keyed on a renderer-supplied hash that is never checked against
the bytes actually read). One is availability (the PDF render scale clamp has a *floor* of 1, so a
large-MediaBox page allocates an unbounded raster in the main process — measured at 875 MB RSS for
a single 14400x14400 page, before unpdf's PNG data-URL round trip and `encodeJpeg`'s second
canvas). One is credential exposure (`window.api.secrets.get('ai-api-key')` hands the API key
straight back to the renderer, which is the exact opposite of what three separate Phase 3 file
headers claim).

The deferred items in `deferred-items.md` were checked. Item 3 (HEIC pre-decode pixel budget) is
genuinely closed in `pipeline.ts:420-445` and none of the remaining items are worse than recorded.

`npm run typecheck` is clean and all 286 unit tests pass; none of the findings below are caught by
the existing suite.

## Critical Issues

### CR-01: `toCents` silently flips the sign of common credit/refund formats, then grades the result `high` confidence

**File:** `src/main/parse/validate.ts:92`

**Issue:** Negative detection is `trimmed.startsWith('-') || /^\(.*\)$/.test(trimmed)`. Because the
currency symbol / ISO code is stripped *after* the sign test, any minus that is not the literal
first character is lost. Verified against the shipped code:

```
"$-45.00"      -> 4500     (should be -4500)
"USD -45.00"   -> 4500     (should be -4500)
"45.00-"       -> 4500     (should be -4500)   trailing-minus, standard on POS and ERP exports
"$1,234.10 CR" -> 123410   (should be -123410)
"(45.00)"      -> -4500    correct
"-45.00"       -> -4500    correct
```

This is not merely a wrong number, it is a wrong number the pipeline then certifies. On the native
PDF route the sign-flipped value grounds successfully: `containsToken` looks for `"45.00"` inside
the source text `"$-45.00"`; the preceding character is `-`, which fails the `/[0-9.,]/` boundary
test, so the match is accepted and `confidence.ts:126` returns `'high'`. The arithmetic cross-check
does not save it either — a credit memo whose subtotal, tax and total are all flipped consistently
still satisfies `subtotal + tax = total`.

**Failure scenario:** A vendor issues a $450.00 credit memo printed as `$-450.00`. NicoleBooks
stores `+45000` cents, flags nothing, badges the total `high` confidence, caches it, and Phase 7
posts a $450 *charge* where a $450 credit belonged — an $900 swing on the books that the review
screen actively told Nicole to trust.

**Fix:**

```ts
export function toCents(raw: string | null): number | null {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (trimmed === '') return null

  // Strip currency symbols/codes FIRST, then look for a sign anywhere, plus the
  // accounting conventions: wrapping parentheses, a trailing minus, and a CR suffix.
  const parenthesised = /^\(.*\)$/.test(trimmed)
  const trailingMinus = /-\s*$/.test(trimmed)
  const creditSuffix = /\bCR\b\s*$/i.test(trimmed)
  const leadingMinus = /-\s*(?=[^0-9]*[0-9])/.test(trimmed) // '-45.00', '$-45.00', 'USD -45.00'
  const negative = parenthesised || trailingMinus || creditSuffix || leadingMinus
  // ... rest unchanged
}
```

Add regression cases for `'$-45.00'`, `'USD -45.00'`, `'45.00-'`, `'(45.00)'` and `'$45.00 CR'` to
`test/parse-validate.test.ts`, and one case asserting that a sign-flipped value never scores
`'high'`.

---

### CR-02: `renderPdfPageImage` clamps the render scale to a *minimum* of 1, so a large-MediaBox page allocates an unbounded raster in the main process

**File:** `src/main/parse/extract-pdf.ts:48-51, 155-160`

**Issue:** The scale is computed as `clamp(RENDER_LONG_EDGE / longEdge, RENDER_MIN_SCALE = 1,
RENDER_MAX_SCALE = 4)`. For any page whose long edge exceeds 2000pt the desired scale is *below* 1
and is raised back to 1 by the floor. The `RENDER_MAX_SCALE` comment claims "never above 4x, so a
hostile page cannot force a gigantic raster" — but the raster size is `pageSize * scale`, and the
guard bounds only the multiplier, not the product. The floor of 1 is what defeats the intent: it
guarantees that an oversized page is rendered at full size no matter how large it is.

PDF permits a MediaBox up to 14400 x 14400 units. Measured on this machine with the installed
@napi-rs/canvas 1.0.2:

```
createCanvas(14400, 14400) + fill  ->  875.7 MB RSS
```

That is only the first allocation. unpdf's `renderPageAsImage` then calls
`canvas.toDataURL()` (a base64 PNG string of the whole raster), `fetch(dataUrl)` and
`.arrayBuffer()`, and `encodeJpeg` (`extract-pdf.ts:318-324`) allocates a *second* full canvas of
the same dimensions plus a decoded `loadImage` bitmap. Peak is multiple gigabytes for one page.

**Failure scenario:** Nicole drops one 200x200-inch PDF (crafted, or a large-format engineering
drawing from a supplier) into the inbox. Auto-parse fires. The main process either OOM-aborts —
which is *not* catchable by `parseOne`'s try/catch, so D-15 per-file isolation is defeated and the
entire batch dies with the app — or survives with a multi-GB spike and a multi-megabyte image on
the wire, blowing the token budget the 2000px target exists to bound (T-03-02). Every already-parsed
row in that batch that had not yet reached `putCached` is lost.

**Fix:** Bound the output pixel count, not the multiplier, and allow downscaling:

```ts
/** Never render more than this many output pixels, whatever the page geometry claims. */
export const RENDER_MAX_PIXELS = 4_000_000 // ~2000x2000

const longEdge = Math.max(viewport.width, viewport.height)
let scale = longEdge > 0 ? RENDER_LONG_EDGE / longEdge : 1
scale = Math.min(scale, RENDER_MAX_SCALE)          // cap up-scaling
const pixels = viewport.width * viewport.height * scale * scale
if (pixels > RENDER_MAX_PIXELS) {
  scale = scale * Math.sqrt(RENDER_MAX_PIXELS / pixels)
}
if (!Number.isFinite(scale) || scale <= 0) scale = 1
```

Add a spec that a synthetic 14400x14400 MediaBox renders to a bitmap at or under
`RENDER_MAX_PIXELS`.

---

### CR-03: The parse cache is written under a renderer-supplied hash that is never checked against the bytes actually read

**File:** `src/main/parse/pipeline.ts:236, 243, 261, 309-322`

**Issue:** `parseOne` takes `hash` verbatim from the `ParseBatchFile` the renderer sent
(`pipeline.ts:236`), uses it as the cache lookup key (`getCached(ctx.db, hash)`, line 243), reads
bytes from a *separately supplied* `filename` (line 261), and then writes the parse of those bytes
back under that same unverified hash (`fileHash: hash`, line 310). Nothing in the pipeline hashes
what it read. `ParseBatchSchema` only checks that the string is 64 characters long — it cannot bind
a hash to a file.

Two ways this produces a wrong answer:

1. **TOCTOU, the realistic one.** `runScan` hashes at T1 and returns; `parseBatch` reads bytes at
   T2. The batch is sequential (`pipeline.ts:207`) with two model calls per image-only document, so
   T2 - T1 for the last file in a 12-bill batch is minutes. This app deliberately targets
   cloud-synced folders — Phase 2 ships a whole materialization + settling gate because files *do*
   change under it. If `bill.pdf` is re-synced or re-saved in that window, the pipeline parses the
   NEW document and stores it under the OLD hash H1.
2. **Trust boundary.** `trusted-sender.ts` and the preload both declare the renderer untrusted, yet
   main accepts a `(filename, hash)` pair from it without verifying the pairing. A renderer bug or
   compromise can poison any cache row at will.

The damage is durable because the cache is authoritative: on any later scan of the original bytes,
`getCached` returns the *other document's* vendor, dates and `total_cents` with `status: 'cached'`,
no model call, and no flag. `parse:reparse` does not have this problem — `findInboxFileByHash`
re-scans and matches by hash (`parse.ts:101-106`) — which makes the gap in `parseBatch` an
inconsistency, not a design choice.

**Failure scenario:** OneDrive finishes syncing an updated `invoice-0912.pdf` (now $8,400) two
minutes after the scan hashed the $340 draft. The cache row for the $340 file's hash now says
$8,400. Weeks later the $340 file resurfaces in the inbox, hashes to H1, hits the cache, and is
presented as a ready-to-post $8,400 bill with no AI call and no warning.

**Fix:** Re-hash in the pipeline and treat a mismatch as a per-file failure, reusing Phase 2's
hasher:

```ts
import { sha256Buffer } from '../ingestion/hash' // or hash the buffer inline with node:crypto

const bytes = await ctx.readFile(filename)
const actual = createHash('sha256').update(bytes).digest('hex')
if (actual !== hash) {
  return failedResult(filename, hash, STALE_BYTES_COPY) // "This file changed since the scan. Click Scan now, then try again."
}
```

Place the check immediately after the read (before `routeFile`) so no model call is paid for stale
bytes, and add a spec that a byte reader returning content whose hash differs from the declared one
produces a `parse-failed` row and writes nothing to `parsed_results`.

---

### CR-04: The renderer can read the AI API key back out through `secrets:get`, contradicting the phase's stated T-03-01 mitigation

**File:** `src/preload/index.ts:26`, `src/main/ipc/secrets.ts:29-34`, `src/main/ai/client.ts:8-10`

**Issue:** Three Phase 3 file headers assert that the credential cannot be read back by the
renderer:

- `client.ts:9-10` — "There is no getter here that hands a credential back, so a compromised
  renderer has nothing to call."
- `preload/index.ts:42-44` — "no method takes or returns the API key or the base URL ... so a
  compromised renderer cannot read them back out (D-05, threat T-03-01)."
- `ipc-contract.ts:128-132` — "NOTHING below carries the AI API key or the base URL."

All three are true only of the `ai:*` channels. Phase 3 chose (D-05) to store both credentials
under the *generic* `secrets` channel, and that channel exposes an unrestricted getter:
`window.api.secrets.get(key)` -> `secretStore.get(key)` for any key, with no allow-list or
deny-list. `window.api.secrets.get('ai-api-key')` returns the decrypted key to renderer JavaScript,
and `window.api.secrets.get('ai-base-url')` returns the endpoint. `e2e/secret-roundtrip.spec.ts:44-45`
already demonstrates the exact round trip from renderer code.

The safeStorage encryption-at-rest control is intact; what is missing is the read-back control the
comments claim. The renderer is explicitly modelled as untrusted throughout this codebase
(`trusted-sender.ts`, the preload header), so a documented control that does not exist is worse
than an acknowledged gap — no future reviewer will look again.

**Failure scenario:** Any renderer-side script execution (a compromised dependency in the renderer
bundle, a future feature that renders remote content, a devtools-reachable path in a dev build)
exfiltrates the user's paid API key in one line: `await window.api.secrets.get('ai-api-key')`. The
key is a live billing credential.

**Fix:** Make the secret channel enforce what the comments promise. A deny-list is the smallest
change:

```ts
// src/main/ipc/secrets.ts
/** Secrets that are WRITE-ONLY from the renderer: written once, read only main-side (D-05). */
const RENDERER_UNREADABLE = new Set(['ai-api-key', 'ai-base-url'])

ipcMain.handle(Channels.secretsGet, (event, raw) => {
  assertTrustedSender(event)
  const key = SecretKeySchema.parse(raw)
  if (RENDERER_UNREADABLE.has(key)) return null // never hand a live credential back
  if (!secretStore.available()) return null
  return secretStore.get(key)
})
```

Then extend `test/no-secret-leak.test.ts` with a handler-level case asserting `secrets:get`
returns `null` for both AI keys while `secretStore.get` still returns them main-side, and fix the
three file headers so they describe the enforced behaviour.

## Warnings

### WR-01: `extractPdfText` leaks a pdfjs document (and its worker) for every native-route PDF

**File:** `src/main/parse/extract-pdf.ts:79-83`

**Issue:** The module header (lines 175-181) states the rule correctly — "pdfjs 6 dropped
`PDFDocumentProxy.destroy()`; the task that produced the proxy owns teardown ... skipping this leaks
a worker per bill" — and `loadPdfSignals` and `renderPdfPageImage` both honour it. `extractPdfText`
does not. It passes raw bytes to unpdf's `extractText`, and unpdf then creates a document
internally (`node_modules/unpdf/dist/index.mjs:369`: `const pdf = isPDFDocumentProxy(data) ? data :
await getDocumentProxy(data)`) and never destroys it. Since no proxy is returned, the caller has
nothing to tear down.

Every native-route bill therefore leaks one loading task, transport, worker and its retained copy
of the PDF bytes for the life of the main process — which for a desktop app is days.

**Fix:**

```ts
export async function extractPdfText(bytes: Buffer): Promise<PdfText> {
  await ensurePdfjs()
  const doc = await getDocumentProxy(pdfjsBytes(bytes))
  try {
    const { totalPages, text } = await extractText(doc, { mergePages: false })
    return { totalPages, text }
  } finally {
    await closeDocument(doc)
  }
}
```

---

### WR-02: `ai:list-models` forwards raw SDK/system error text — which can carry the configured endpoint host — to the renderer

**File:** `src/main/ipc/ai.ts:66-70`

**Issue:** The module header says "Errors are mapped to fixed, human-readable copy — the raw error
is never forwarded, so an SDK message carrying the endpoint URL (or a stack) cannot ride out to the
renderer", and the inline comment at lines 65-66 adds "the rejection carries only the opaque code,
never the URL." Neither is true for this handler: `return listModels({ client: buildClient() })` has
no try/catch, so any rejection propagates. `ipcMain.handle` serialises the thrown message into the
renderer's rejection. An undici DNS failure surfaces as `getaddrinfo ENOTFOUND gw.example.com`, and
`APIError` messages are built from the provider's response body. `ipc-contract.ts:131` states that
carrying "the credential or the endpoint URL" across this boundary is a contract violation, and the
base URL is stored in the keychain precisely because it is treated as secret.

`ai:test-connection` (lines 51-62) does this correctly — `buildClient()` is inside the try and
`recoverableReason` maps everything to fixed copy.

**Fix:** Apply the same mapping, and change the contract's return type to allow the failure shape:

```ts
ipcMain.handle(Channels.aiListModels, async (event, raw) => {
  assertTrustedSender(event)
  AiListModelsSchema.parse(raw ?? {})
  try {
    return await listModels({ client: buildClient() })
  } catch (err) {
    throw new Error(recoverableReason(err)) // fixed copy only
  }
})
```

---

### WR-03: The D-21 page cap bounds images but leaves the reference text completely unbounded

**File:** `src/main/parse/pipeline.ts:371-376`

**Issue:** `prepareDocument` caps rendered pages at 10 (`selectPageIndexes`) but builds
`referenceText` from `(extracted?.text ?? []).join('\n\n')` — every page of the PDF, with no cap on
page count or character count. There is no size limit anywhere upstream either: Phase 2's scan
records `sizeBytes` but never rejects on it, and `ParseBatchSchema` bounds only the array length.

The reference text is then sent as a `text` content part on the primary call *and* again on the
repair re-ask (`extract-fields.ts:272-277`). The threat register's cost control (T-03-02) is
therefore only half implemented.

**Failure scenario:** A 400-page vendor statement lands in the inbox. Ten page images go on the
wire as designed, alongside roughly 400 pages of extracted text — hundreds of thousands of tokens
in a single paid request, possibly twice, and a likely context-length 400 that then triggers the
whole `canFallBack` ladder (see WR-04).

**Fix:** Cap the text the same way the images are capped, and be explicit about it:

```ts
/** Characters of embedded text carried on the wire. ~50k chars is well past any real bill. */
export const MAX_REFERENCE_TEXT_CHARS = 50_000

const joined = (extracted?.text ?? []).join('\n\n').trim()
const clipped = joined.length > MAX_REFERENCE_TEXT_CHARS
referenceText = joined === '' ? null : joined.slice(0, MAX_REFERENCE_TEXT_CHARS)
// clipped participates in the same `truncated` flag the page cap already sets
```

---

### WR-04: `canFallBack` is a deny-list, so statuses that are not rung problems still burn the whole ladder

**File:** `src/main/parse/extract-fields.ts:497-514`

**Issue:** The documented behaviour is "descend only on 400/404/422". The implementation is the
inverse — descend on *anything* below 500 that is not in
`NON_FALLBACK_STATUS = {401, 403, 408, 409, 429}`. That admits 402 (Insufficient Credits, the
standard OpenRouter response for an exhausted balance), 413 (Payload Too Large — reachable via
WR-03), 415, 423, 424, 429-adjacent gateway codes, 451, and every future 4xx a provider invents.

For each of those the module makes three full requests per file instead of one, plus a repair
re-ask if any rung's reply happens to parse. Nothing about the rung was the problem, so all three
fail identically.

**Fix:** Invert to an allow-list matching the documented intent:

```ts
/** The ONLY statuses that mean "this endpoint does not support this parameter". */
const FALLBACK_STATUS = new Set([400, 404, 422])

function canFallBack(error: unknown): boolean {
  const status = (error as { status?: unknown } | null)?.status
  if (typeof status === 'number') return FALLBACK_STATUS.has(status)
  // unchanged: a TypeError from a client with no such method still descends
  ...
}
```

---

### WR-05: `temperature: 0` is sent unconditionally, so a reasoning model this app badges "Vision" fails every single file

**File:** `src/main/parse/extract-fields.ts:376-392`, `src/main/ai/vision-families.ts:27`

**Issue:** `buildRequest` puts `temperature: 0` on every rung of every call. OpenAI's o-series and
newer reasoning models reject an explicit `temperature` with a 400
(`Unsupported value: 'temperature' does not support 0`). `vision-families.ts:27` matches
`/(^|\/)o[134](-|$)/i`, so `o1`, `o3-mini` and `o4-mini` are badged as confirmed vision-capable and
presented to Nicole as safe picks. Selecting one makes every file fail: the 400 is fallback-eligible
under WR-04, so the ladder burns all three rungs and returns `call-failed` -> "The AI service could
not be reached for this file. Click Retry to try again." That copy sends a non-technical user into
an infinite retry loop against a configuration problem she has no way to diagnose.

**Fix:** Drop `temperature` on a retry when the error names it, or omit it for models known not to
accept it:

```ts
const TEMPERATURE_REJECTED = /temperature/i

// in the rung loop, before deciding to descend:
if (!first.ok && TEMPERATURE_REJECTED.test(describeError(first.error))) {
  const retry = await callRung(client, rung, { ...input, omitTemperature: true })
  ...
}
```

At minimum, add the `temperature` retry so the model picker's "Vision" badge does not lead the user
into a dead end.

---

### WR-06: A rejected key or a rate limit produces one full failing call sequence per file, with no batch-level circuit breaker

**File:** `src/main/parse/pipeline.ts:207-217`

**Issue:** The ladder correctly refuses to descend on 401/403/429 (`extract-fields.ts:512`), but
that only bounds a *single file*. The batch loop has no knowledge of why the previous file failed,
so a bad key produces one auth-rejected request per file, and a rate limit produces one request per
file each of which the SDK has already retried up to `maxRetries: 3` with backoff
(`client.ts:77`). `ParseBatchSchema` permits 500 files.

**Failure scenario:** Nicole's key expires. She drops 40 bills, hits Scan now, and the app fires
40 sequential auth-rejected requests at the provider before showing her 40 identical
"could not be reached" rows. Under a rate limit the same batch becomes up to 160 requests with
exponential backoff between each, so the UI hangs on "Reading bills..." for several minutes.
Repeated auth failures are exactly what providers use to flag or lock an account.

**Fix:** Track a terminal-configuration failure at batch scope and short-circuit the remainder:

```ts
let terminal: string | null = null
for (const file of list) {
  const result = terminal
    ? failedResult(file.filename, file.hash, terminal)
    : await parseOne(file, ctx)
  if (isTerminalConfigFailure(result)) terminal = result.error!  // auth rejected / rate limited
  ...
}
```

`extractFields` already distinguishes the reasons; surface the offending status on
`ExtractFailure` so the pipeline can classify it.

---

### WR-07: "Scan now" is not disabled while a parse batch is running, so batches overlap and uncached files can be paid for twice

**File:** `src/renderer/src/screens/BillsScreen.tsx:254, 365`

**Issue:** `runScan` fires `void runParse(loaded)` without awaiting it (line 254), then its `finally`
immediately sets `scanning = false`. The button's only guard is `disabled={scanning}` (line 365).
A second click while parsing therefore starts a second, concurrent `parse:parse-batch`.

Three consequences:
1. `setParseResults({})` in the second `runScan` wipes the first batch's rows, and the first batch's
   `setParseResults` then merges stale results back in when it eventually resolves.
2. The first batch's `finally` sets `parsing = false` and `parseProgress = null` while the second is
   still running, so the "parsing N of M" indicator disappears mid-run.
3. Cost: the second batch starts before the first has reached `putCached` for the files still in
   flight, so both batches miss the cache for the same documents and both pay the model — the exact
   double-charge PARSE-05 exists to prevent.

**Fix:** `disabled={scanning || parsing}` on the button, and guard `runParse` against re-entry
(a ref holding the in-flight promise, or an early return when `parsing` is true).

---

### WR-08: Changing the base URL and pressing "Connect and test" sends the previously stored key to the new endpoint

**File:** `src/renderer/src/screens/SettingsScreen.tsx:140-176`

**Issue:** `connectAndTest` always writes `ai-base-url` (line 152) but writes `ai-api-key` only
`if (apiKey.trim())` (line 153). The key field is intentionally never repopulated, and its
placeholder reads "Saved. Type a new key to replace it." So switching the Provider dropdown from
OpenAI to OpenRouter — or to "Other (enter a URL)" with an arbitrary https host — and pressing the
button transmits the *existing* provider's key to the *new* endpoint on the very next request. The
`assertHttpsBaseUrl` guard (`client.ts:46-57`) prevents plaintext transport but does nothing about
sending the credential to the wrong party, which is threat T-03-05's actual concern.

**Failure scenario:** Nicole is told to "try OpenRouter", picks it from the dropdown, and clicks
Connect and test without pasting a new key. Her OpenAI key is transmitted to openrouter.ai in an
`Authorization: Bearer` header, where it is logged as a failed auth attempt on a third party's
infrastructure.

**Fix:** Treat a base-URL change as invalidating the stored key:

```ts
const [savedForUrl, setSavedForUrl] = useState<string | null>(null)
const baseUrl = resolveBaseUrl()
const keyMatchesUrl = savedForUrl === baseUrl

// in connectAndTest:
if (!apiKey.trim() && !keyMatchesUrl) {
  setAiStatus('error')
  setAiError('Enter the API key for this provider before connecting.')
  return
}
```

Track the saved-for host in `app_settings` (non-secret) so the pairing survives a restart.

---

### WR-09: The inbox containment guard is lexical only — it never resolves symlinks

**File:** `src/main/parse/pipeline.ts:467-488`

**Issue:** `safeInboxPath` rejects separators, NUL, `.`, `..` and a Windows drive prefix, then
verifies `resolve(join(root, filename))` still starts with `root`. `path.resolve` is purely
lexical: it does not touch the filesystem and does not follow links. A symlink or Windows junction
named `receipt.jpg` inside the inbox and pointing outside it passes every check, and `readFile`
follows it.

Phase 2's scan skips symlinks (`scan.ts:78`), so a link never becomes a `loaded` `ScanFile`. But
`parse:parse-batch` accepts filenames straight from the renderer — the very trust boundary this
guard exists to enforce — so the scan's filter is not the pipeline's protection. The 03-07 summary
lists this guard as mitigating T-02-02 "path injection"; the mitigation is incomplete.

**Fix:** Resolve the real path before reading and re-check containment:

```ts
import { realpath } from 'node:fs/promises'

const full = resolve(join(root, filename))
const real = await realpath(full)            // throws ENOENT for a missing file, already handled
const realRoot = await realpath(root)
if (real !== realRoot && !real.startsWith(realRoot.endsWith(sep) ? realRoot : realRoot + sep)) {
  throw new Error(UNSAFE_FILENAME)
}
```

---

### WR-10: The Bills screen renders parsed money without any of its validation flags, so an unreadable total shows as a clean "Parsed ... $0.00"

**File:** `src/renderer/src/screens/BillsScreen.tsx:94-99, 156, 172-176`

**Issue:** `validate.ts:186-189` is explicit that an unreadable total is recorded as `0` "but only
ever alongside its flag, which is what makes the fallback visible instead of silent (D-12)".
`ParseFileResult` carries `validationFlags` and `confidence` across the boundary. `BillsScreen`
uses neither. `parsedSummary` renders `vendor + formatCents(totalCents)` and `ScanRow` renders it
next to a default-variant "Parsed" badge — no flag, no low-confidence marker, no distinction
between a grounded total and a fabricated one.

So the exact case `validate.ts` is proudest of catching — a total reading "N/A" that must not
become a confident $0.00 — is caught in the data layer and then presented to the user as a normal,
successfully parsed $0.00 bill. D-12's "flag-and-keep" is only half delivered: the keep is visible,
the flag is not.

D-18 puts the rich flagging UI in Phase 6, which is a fair scope line — but this screen chose to
display a *value*, and displaying a value without its flag is worse than displaying neither.

**Fix:** Either drop the money from the row until Phase 6, or surface the flag alongside it:

```tsx
const flagged = (parse?.validationFlags?.length ?? 0) > 0
...
{summary && (
  <span className={flagged ? 'font-sans text-sm text-destructive' : 'font-sans text-sm text-muted-foreground'}>
    {summary}{flagged ? '  (needs review)' : ''}
  </span>
)}
```

## Info

### IN-01: `getCached` / `putCached` put a defaulted parameter before a required one, so the documented default is unreachable

**File:** `src/main/parse/cache.ts:175-178, 223`

**Issue:** `getCached(db: Database.Database = getDatabase(), fileHash: string)` — the doc comment
says "The db handle is injectable (default: the main-process singleton)", but a default before a
required parameter can never be omitted. Every call site must pass `db` explicitly (and does).
**Fix:** Swap the order (`getCached(fileHash: string, db = getDatabase())`) or drop the misleading
default and the comment.

### IN-02: `computeConfidence`'s `modelSelfReport` is never supplied, so precedence rung 4 is dead

**File:** `src/main/parse/confidence.ts:88-92, 128`

**Issue:** The documented ladder has "4. The advisory model self-report -> as reported", and D-11
says the self-report exists "mainly for the category guess". `BillSchema` has no confidence field,
the prompt never asks for one, and `pipeline.ts:307` calls `computeConfidence` with three
arguments. `selfReport[key] ?? 'low'` therefore always yields `'low'`, and `suggestedCategory`
(which `isGrounded` deliberately never grounds) is permanently `'low'`. The degradation is in the
safe direction, but the parameter, the `ModelSelfReport` type and rung 4 of the header comment are
all dead. **Fix:** Either wire it up or delete the parameter and the ladder rung so the header
describes what runs.

### IN-03: `ai:list-models` is registered, bridged and typed but never called by the app

**File:** `src/main/ipc/ai.ts:66-70`, `src/preload/index.ts:47`, `SettingsScreen.tsx`

**Issue:** `SettingsScreen` only ever calls `testConnection`. `listModels` has no caller, so it is
an unexercised privileged channel carrying the defect in WR-02. **Fix:** Either use it (a "Refresh
models" control that does not rewrite the credentials would be genuinely useful) or drop it from the
contract until something needs it.

### IN-04: `extractFields.startRung` is never used, so every file re-walks the ladder from the top

**File:** `src/main/parse/extract-fields.ts:182-188`, `src/main/parse/pipeline.ts:270-275`

**Issue:** D-25 says the starting rung is "chosen from the model's known capabilities", and
`startRung` exists for exactly that. The pipeline never passes it, and nothing memoises which rung
worked. Against an endpoint with no `json_schema` support, every file in every batch pays the same
two rejected calls before reaching the rung that works. **Fix:** Cache the last successful rung per
`(model, baseUrlHost)` in `app_settings` and pass it as `startRung`.

### IN-05: `ExtractFailure.detail`, `.rung` and `.rawResponse` are computed but discarded

**File:** `src/main/parse/extract-fields.ts:161-169`, `src/main/parse/pipeline.ts:276-278`

**Issue:** `extract-fields.ts` carefully bounds and sanitises `detail` (`MAX_DETAIL_CHARS`,
`describeZodError`), but `parseOne` maps only `primary.reason` to copy and drops the rest. The
audit value the sanitising exists to enable is never realised. **Fix:** Persist the failure detail
alongside the audit trail (a `parse_failures` row, or `raw_response` on a failed attempt) rather
than computing and throwing it away — but keep it off the IPC boundary.

### IN-06: The Settings screen hides the selected model until Connect and test is pressed, and offers no way to clear a stored key

**File:** `src/renderer/src/screens/SettingsScreen.tsx:70, 336, 342-345`

**Issue:** `selectedModel` is loaded on mount but rendered only inside `{models.length > 0 && ...}`,
and `models` is empty until a `/models` call succeeds. On a fresh launch, a non-technical user
cannot see which model NicoleBooks is about to spend her money on. Separately, `keySaved` is
session-only (so the placeholder reverts to "Paste your API key" on every remount even though a key
is stored), and `secrets.delete` is bridged but never wired to a control, so there is no way to
remove a key from the UI. `VisionBadge` also renders the identical word "Vision" for
metadata-confirmed and heuristically-guessed models, collapsing the distinction D-02 draws.
**Fix:** Render "Currently using {selectedModel}" outside the `models.length > 0` guard, seed
`keySaved` from a non-secret `ai-key-configured` app setting, add a "Remove stored key" button, and
differentiate the two badge cases (e.g. "Vision" vs "Vision (likely)").

---

_Reviewed: 2026-07-27T15:58:53Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
