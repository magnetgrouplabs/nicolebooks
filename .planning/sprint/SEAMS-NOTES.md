# SEAMS notes for downstream agents

Written by the SEAMS agent (Wave 1) for QBO-CONNECT, INGEST-UX, POSTING-ENGINE, RECON, and
REVIEW-UI. Everything below is observed from this repo, not assumed.

Suite at handoff: **528 unit tests across 28 files, green** (419/27 before SEAMS).
`npm run typecheck`, `npm run build`, and `npx playwright test e2e/ipc-boundary.spec.ts` are all
green too.

---

## 1. What already exists, so you do not build it

| Your group | Your module (yours alone)                  | Channels registered as stubs                                                       |
| ---------- | ------------------------------------------ | ---------------------------------------------------------------------------------- |
| QBO-CONNECT| `src/main/ipc/qbo.ts`                      | `qbo:status`, `qbo:connect`, `qbo:disconnect`, `qbo:sync-reference`, `qbo:get-reference` |
| RECON      | `src/main/ipc/recon.ts`                    | `recon:match`                                                                        |
| POSTING    | `src/main/ipc/posting.ts`                  | `posting:send`, `posting:batches`, `posting:batch-detail`, `posting:undo-last`, `posting:summary` |
| INGEST-UX  | `src/main/ipc/upload.ts`                   | `ingestion:pick-files`, `upload:start`, `upload:stop`, `upload:status`                |

Broadcast channels (main to renderer sends, never `ipcMain.handle` targets):
`qbo:status-changed`, `posting:progress`, `upload:received`.

Each stub is already fully gated: `assertTrustedSender(event)` first, then the Zod parse, then a
`notImplemented()` that rejects with `This feature is still being built.` **Replace the
`notImplemented()` call and nothing else.** The gates, the error table, and the broadcast helper in
your module are yours to extend, not to remove.

`ingestion:pick-files` deliberately lives in `upload.ts`, not `ingestion.ts`. `ingestion.ts` is a
shipped Phase 2 module; keeping the picker in the file INGEST-UX owns means no shared-file edit.

### Files you must NOT edit (shared, already correct)

- `src/shared/ipc-contract.ts` and `src/shared/schemas.ts`: you may **refine your own group's
  response shapes and tighten your own group's schema bounds**. You may never rename a channel,
  never loosen a schema to `z.any()`, and never drop `.strict()` from a payload-free schema.
- `src/preload/index.ts`: the bridge is complete. Adding a method here means editing a file three
  other agents also import, plus two specs that pin the surface. If you genuinely need a new
  method, ask Fable first.
- `src/main/ipc/register.ts`: all four groups are already wired.
- `src/main/ipc/secrets.ts`: see section 6, you do not need to touch it.
- `src/main/ipc/{ai,ingestion,parse,settings,theme}.ts` and everything under
  `src/main/{ai,ingestion,parse,secrets}/`.

---

## 2. The payload-gate rule that has already bitten this repo once

**Payload-free channels must parse `raw ?? {}`, never a bare `raw`.**

The preload invokes payload-free channels with no argument at all
(`start: () => ipcRenderer.invoke(Channels.uploadStart)`), so `raw` arrives as `undefined`, and
`z.object({}).strict().parse(undefined)` throws `expected object, received undefined`. That is not
theoretical: `ingestion:scan` shipped permanently-rejecting for an entire phase because of it, and
the phase went green because no test ever actually invoked the channel. See
`test/ingestion-ipc-scan.test.ts` for the post-mortem.

Channels that carry a real payload use a bare `Schema.parse(raw)`. In the posting group both kinds
sit side by side, so read before you copy:

```ts
// payload-free
PostingBatchesSchema.parse(raw ?? {})
// real payload
PostingSendSchema.parse(raw)
```

`test/seams-ipc.test.ts` pins both halves for every new channel: the payload-free ones must resolve
for a zero-arity call **and** reject smuggled input. A reject-only test passes for a permanently
broken handler, which is exactly how the original defect survived.

### The preload wraps your payloads

Single-argument methods are wrapped into an object before they cross:

| Preload call                      | What your handler receives     |
| --------------------------------- | ------------------------------ |
| `recon.match(fileHashes)`          | `{ fileHashes: string[] }`     |
| `posting.send(rows)`               | `{ rows: PostingRow[] }`       |
| `posting.batchDetail(batchId)`     | `{ batchId: string }`          |
| `posting.summary(batchId)`         | `{ batchId: string }`          |

Your schema validates the wrapper, not the inner value. This matches `ai:set-model` and
`parse:reparse`.

---

## 3. How to add a migration (exact mechanics)

Numbers are **assigned, not claimed**: `0004` = QBO reference cache (QBO-CONNECT), `0005` =
posting batches + audit ledger (POSTING-ENGINE). Anything past `0005` needs a number from Fable.

Why it is assigned rather than "take the next free one": the runner in `src/main/db/migrate.ts`
applies every migration whose `version` is greater than `PRAGMA user_version`, in ascending order,
inside one transaction. Two agents in parallel worktrees who both read the array and both take `4`
produce two files with `version: 4`. The runner applies the first, bumps `user_version` to 4, and
then **silently skips the second**, because 4 is no longer greater than 4. The missing table is
invisible until a query hits it at runtime.

Steps:

1. Create `src/main/db/migrations/NNNN_name.ts` exporting `{ version: N, up(db) { db.exec(...) } }`.
   Copy `0003_parsed_results.ts`; it is the most complete example.
2. Import it in `src/main/db/migrate.ts` and append it to the `migrations` array, ascending.
3. That is all. `getDatabase()` in `src/main/db/connection.ts` runs `migrate()` on first call and
   the whole thing is idempotent, so a re-run with nothing pending is a no-op.

House rules the existing tables follow, and a reviewer will check:

- `STRICT` tables only.
- Money is `INTEGER` cents, never `REAL`. This is a financial tool and a float loses cents.
- Booleans are `INTEGER` 0/1. STRICT has no `BOOLEAN` type and better-sqlite3 refuses to bind a JS
  boolean, so the 0/1 to boolean coercion belongs in your data-access module (see
  `src/main/parse/cache.ts` for the pattern).
- **No secret material in SQLite, ever.** Storing a host is acceptable (`parsed_results
  .base_url_host` does), storing a credential is not.
- Never renumber or edit a shipped migration.

There is also `src/main/db/migrations/README.md` with the assigned-number table.

`test/migrate.test.ts` shows how to test a migration against a temp SQLite file without Electron
(use `openDatabase(tempPath)`, not `getDatabase()`).

---

## 4. How broadcasts are emitted

Two patterns exist, and the choice is about **who should see the event**.

**App-wide** (`src/main/ipc/theme.ts`). Used for `qbo:status-changed` and `upload:received`, both
already written for you as exported helpers:

```ts
// src/main/ipc/qbo.ts     -> broadcastQboStatus(status)
// src/main/ipc/upload.ts  -> broadcastUploadReceived({ filenames })
for (const win of BrowserWindow.getAllWindows()) {
  if (win.isDestroyed()) continue
  win.webContents.send(Channels.qboStatusChanged, status)
}
```

Connection state is global to the app, and a phone upload arrives from the network rather than from
an invoke, so there is no originating window to narrow to.

**Sender-narrowed** (`src/main/ipc/parse.ts`). Used for `posting:progress`, already written for you
as the exported `progressBroadcaster(event)` in `src/main/ipc/posting.ts`:

```ts
const win = BrowserWindow.fromWebContents(event.sender)
return (progress) => {
  if (!win || win.isDestroyed()) return
  win.webContents.send(Channels.postingProgress, progress)
}
```

A window watching a batch it did not start would see a counter it cannot explain. The
destroyed-window check matters because a batch outlives a window close.

Broadcasts are main-initiated, so there is **no sender to validate** on that path. Keep the payload
free of anything sensitive: it is the one direction with no gate.

Renderer side, all three subscriptions return a disposer, so a React effect cleanup removes exactly
its own listener:

```ts
useEffect(() => window.api.qbo.onStatusChanged(setStatus), [])
```

---

## 5. Where the error-mapping pattern lives

Canonical example: `src/main/ipc/ai.ts` (`CONNECTION_ERROR_COPY` plus `recoverableReason`). The
regression pin is `test/ai-ipc.test.ts`, and it is worth reading before you write your first catch
block: `ai:list-models` originally had no try/catch, so an undici DNS failure sent
`getaddrinfo ENOTFOUND <private host>` straight into the renderer's rejection.

Each of your four modules already has its own table, its own generic fallback, and its own
`recoverableReason`, so four agents extend four tables with no shared-file edit:

```ts
const QBO_ERROR_COPY: Readonly<Record<string, string>> = {
  [NOT_IMPLEMENTED]: 'This feature is still being built.'
  // add your codes here
}
```

Rules:

- Throw **opaque codes** internally (`AI_CREDENTIALS_MISSING` is the existing shape). Map to copy at
  the IPC boundary. Never forward raw error text or a stack.
- A QuickBooks API error message is assembled from the provider's response body and routinely
  carries the request URL and the realm id. A bind or filesystem error carries a port or a path.
  Assume every unmapped error is unsafe to forward; that is what the generic fallback is for.
- **No em dashes or en dashes in user-facing copy.** `test/seams-ipc.test.ts` asserts this on the
  NOT_IMPLEMENTED string; extend the check if you add copy.
- Choose deliberately between rejecting and returning a status object. `ai:test-connection` returns
  `{ ok: false, error }` because Settings renders the failure inline; `ai:list-models` rejects
  because its contract type has no room for a status. Both map their copy.
- Nothing in these modules logs. Keep it that way.

---

## 6. Secrets: already handled, do not edit `secrets.ts`

`src/main/ipc/secrets.ts` is a generic any-key/any-value store, so a credential is kept out of
renderer JavaScript only by its `RENDERER_UNREADABLE` deny-list. The AI key and base URL shipped
readable for a whole phase because that list was added after the fact
(`test/secrets-ipc-readback.test.ts` is the post-mortem):
`await window.api.secrets.get('ai-api-key')` returned the decrypted key.

SEAMS closed the same hole for QuickBooks ahead of time. `src/main/qbo/secret-keys.ts` names the
three keys and is imported into the deny-list already:

```ts
QBO_ACCESS_TOKEN_SECRET  = 'qbo-access-token'
QBO_REFRESH_TOKEN_SECRET = 'qbo-refresh-token'
QBO_CLIENT_SECRET_SECRET = 'qbo-client-secret'
```

**QBO-CONNECT: add any further credential key to `QBO_SECRET_KEYS` in that file. Do not edit
`secrets.ts`.** The module imports nothing on purpose, so pulling it into `secrets.ts` does not drag
the QuickBooks client into the module graph or into a unit test's electron mock.

Write and read tokens through `secretStore` (`src/main/secrets/secret-store.ts`), which encrypts via
`safeStorage` into `userData/secrets.enc`. It must be used after `app.whenReady()`. The realm
(company) id is **not** a credential: it belongs in `app_settings` and the UI displays it.

Reminder from the sprint plan: the refresh token **rolls**. Re-read
`.credentials/qbo-tokens.json` before refreshing and write the new value back immediately, or the
next refresh fails.

---

## 7. Testing conventions

- `vitest.config.ts` picks up `test/**/*.test.ts` only, `environment: 'node'`. Aliases `@` and
  `@shared` are available and mirror the Vite config, so a spec can render a renderer component with
  `react-dom/server` without a DOM.
- Handler specs mock `electron` to capture `ipcMain.handle` registrations instead of touching a real
  IPC bus, and stub `trusted-sender` to a no-op so the spec targets the payload gate. Copy
  `test/seams-ipc.test.ts` or `test/ingestion-ipc-scan.test.ts`.
- **If your module imports `BrowserWindow`, your electron mock must provide it**, otherwise the
  module fails at import. The mock in `test/seams-ipc.test.ts` already includes
  `{ getAllWindows: () => [], fromWebContents: () => null }`.
- `npm run typecheck` runs `tsc --build` over `src/` only. **`test/` is not typechecked**; vitest
  transpiles it. A type error in a spec will not show up until the spec runs.
- Two specs pin the boundary exhaustively and **will go red if you add a channel or a bridge
  method**, which is the point:
  - `test/ipc-contract.test.ts` pins every channel name with `toEqual` (exhaustive object match).
  - `e2e/ipc-boundary.spec.ts` pins the exact sorted method list of every `window.api` group.
- Whole suite green before you finish. `npm run test:unit` takes about 3 seconds.

---

## 8. Surprises worth knowing

1. **`.npmrc` sets `legacy-peer-deps=true`** (electron-vite 5 has not widened its peer range to
   vite 8). Installs work; do not "fix" the peer warning by changing a pinned version.
2. **All versions are pinned exactly**, no carets. Install with `npm install --save-exact`.
3. **`postinstall` runs `electron-rebuild -f -w better-sqlite3`.** As handed off, better-sqlite3
   loads under both plain node (vitest) and Electron (playwright), and both suites pass. If you ever
   see a `NODE_MODULE_VERSION` mismatch, that is the cause; `npm run rebuild` targets Electron.
4. **express 5 and multer 2 were installed, not express 4 / multer 1.** Express 5 changed error
   handling for async middleware and tightened the path-matching syntax; multer 2 changed its
   default limits behaviour. Check the v5/v2 docs, not a 2023 tutorial.
5. **Zod is v4.** `z.number().int()` works; the existing schemas use `z.object({}).strict()`,
   `z.enum([...])`, `.nullable()`, and `.length(64)`. Cross-field rules go in `.superRefine`, and
   they belong in **your** module rather than in `schemas.ts` if only your handler needs them. The
   bill-vs-expense rule (an `expense` row must name a `paidFromAccountId`, a `bill` row must not) is
   deliberately left for POSTING-ENGINE for exactly that reason.
6. **The file hash is the join key everywhere**: 64-char lowercase SHA-256 hex, produced in Phase 2,
   primary key of `parsed_results`, and the key of `recon:match` results and `posting:send` rows.
   Schemas pin it to `.length(64)` so a wrong-length value can never reach a cache or ledger lookup.
7. **Money is integer cents from the parser to QuickBooks.** `PostingRowSchema` enforces
   `int().positive()`. Do not introduce a float anywhere in the chain.
8. **`refNumber` is capped at 21 chars** because that is the QuickBooks DocNumber limit. Catching it
   in the schema turns a confusing mid-batch API rejection into an up-front validation error.
9. **`posting:undo-last` is payload-free on purpose.** Accepting a batch id would turn a one-step
   undo into "void any batch you can name". Resolve "the last batch" server-side.
10. **`recon:match` takes hashes only.** The parsed vendor and category text already lives in the
    main-side `parsed_results` cache; accepting it from the renderer would let a compromised renderer
    steer a match against text the parser never produced.
11. **`assertTrustedSender` throws the bare string `UNTRUSTED_SENDER`** and accepts only `file:`
    URLs or the exact `ELECTRON_RENDERER_URL` origin. It must be the first statement in every
    handler, before the Zod parse.
12. **The renderer touches no fs, db, or network.** Every path, port, and host is resolved
    main-side. That is why `ingestion:pick-files` and the whole upload group are payload-free: the
    dialog opens main-side and the server binds main-side.
13. **`registerIpc()` is called once**, after `app.whenReady()` and after the window is created
    (`src/main/index.ts:77`), because `safeStorage` and `getDatabase()` both need a ready app.
14. **`@tanstack/react-table` 8.21.3 is installed for REVIEW-UI**, along with the `@base-ui/react`
    primitives the existing components use. Look at `src/renderer/src/components/ui/` before adding
    a new dependency.
15. **Do not edit the logo or icon assets** (`src/renderer/src/assets/`, `build/icon.*`), and do not
    read or modify `.credentials/` unless your task explicitly grants it.
