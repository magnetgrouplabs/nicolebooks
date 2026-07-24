# Phase 2: Ingestion and Dedupe - Research

**Researched:** 2026-07-24
**Domain:** Cross-platform (Windows + macOS) filesystem ingestion, cloud-sync placeholder detection, SHA-256 file dedupe, Electron main-process IPC
**Confidence:** HIGH on the code seams and dedupe/IPC design; MEDIUM-HIGH on cross-platform placeholder detection (the one area that needs a Wave-0 empirical probe on real machines).

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- **D-01:** Single flat inbox folder, no date-named subfolders. Configured once in Settings. On first run the app offers a default it creates under the OS documents dir (e.g. `Documents/NicoleBooks/Inbox`) which she can repoint anywhere. The chosen path persists in the Phase 1 `app_settings` table (key `inbox_path`), reusing the existing `settings:get/set` IPC channel; no new settings plumbing.
- **D-02:** The inbox folder is named `Inbox` under a `NicoleBooks` parent (clean pairing with a future `Posted`/`Archive` folder).
- **D-03:** Scan is manual, triggered by a "Scan now" button on the Bills screen. One-shot snapshot at click time. No background watcher (that is V2-03).
- **D-04:** Phase 2 is strictly read-only on the inbox. Files are never moved, renamed, or deleted here.
- **D-05:** The entry date for a scanned batch is the processing date (the day the scan runs), assigned by the app. Phase 2 does NOT parse any date from folder/file names and does NOT prompt for a date.
- **D-06:** The entry date is editable per row later, in the Phase 6 review table.
- **D-07:** Dedupe is exact-file only: SHA-256 over file bytes. Content near-duplicates are Phase 6 (REVIEW-08), not this phase.
- **D-08:** "Already processed" means already sent/posted to QuickBooks. Phase 2 builds the persistent dedupe-hash ledger table (new `migration0002`), computes each scanned file's hash, and checks it against the ledger. The write that marks a hash as sent/posted happens at post time in Phase 7. Consequence: re-scanning an inbox that still holds un-sent (pending) bills reloads them.
- **D-09:** A caught duplicate appears in the loaded results list, visibly flagged (e.g. "Already entered on <date>"), excluded from the batch by default, with a one-click "include anyway" override. Nothing silently dropped, nothing silently re-processed.
- **D-10:** Within-scan duplicates (two byte-identical copies in one scan) are collapsed/flagged within that batch regardless of ledger state.
- **D-11:** File materialization (SC4): the scan waits a brief bounded window for files actively settling, then hashes/loads them. Files still not fully local (online-only cloud placeholders) are flagged "not downloaded yet, re-scan shortly" and skipped. The app does NOT force-download placeholders. A file is never hashed half-complete and never silently dropped.
- **D-12:** Supported formats: text/scanned PDF, JPEG, PNG, HEIC (ingestion accepts all PDFs; image-only vs text-PDF routing is Phase 3). Unsupported user files (.docx, .zip, stray .txt, screenshots) are not loaded but surfaced in a "N files skipped (unsupported type)" summary listing their names.
- **D-13:** OS/system junk (`.DS_Store`, `Thumbs.db`, AppleDouble `._*`, hidden dotfiles) is silently ignored and does NOT appear in the unsupported-skipped summary.
- **D-14:** Phase 2 renders a minimal loaded-results surface on the Bills screen: a list of scanned files each with a status (loaded / duplicate-excluded / not-ready-skipped / unsupported-skipped) plus a one-line scan summary and the batch entry date. The rich editable review table stays in Phase 6.
- **D-15:** All filesystem access, hashing, stability checks, and DB writes run in the Electron main process. The renderer calls a new typed IPC channel group added to `src/shared/ipc-contract.ts`, handled following the `settings.ts` pattern (assertTrustedSender -> Zod-parse -> prepared statements). Native folder picker uses Electron `dialog.showOpenDialog` in main.
- **D-16:** The dedupe ledger is added via a new forward-only migration appended to `migrate.ts` (`migration0002`), mirroring the `0001_init.ts` STRICT-table pattern. Node's built-in `crypto.createHash('sha256')` is the hasher; no new dependency.

### Claude's Discretion
- Exact IPC channel names and payload/return shapes for the scan/dedupe group (follow Phase 1 contract conventions).
- Exact dedupe-ledger schema (SHA-256 column plus provenance: first-seen timestamp, original filename, and a sent/posted marker or a reference the Phase 7 "mark sent" write targets). Phase 7 owns that write; Phase 2 defines the table and the read/check.
- The bounded-wait strategy and cross-platform detection mechanism for file stability. Durations included. This is research territory.
- HEIC at ingestion vs Phase 3: default is Phase 2 recognizes the `.heic`/`.heif` type only and records it; decode is Phase 3.
- Minimal Bills-screen results UI (reuse Phase 1 shadcn components: EmptyState, Badge, Button).
- Empty-inbox / all-duplicates / all-skipped empty states and messaging.

### Deferred Ideas (OUT OF SCOPE)
- App-created dated-subfolder archive after posting (Phase 7). Pairs with the `Inbox` naming (D-02).
- Requirements/roadmap revision (DONE 2026-07-23, commit f184d0a). No open action.
- Background auto-watcher (tracked as V2-03). The scan stays manual.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| ING-01 | Drop bill files into a single flat inbox; app loads them on a manual scan and stamps the batch with the processing date | `ingestion:scan` handler enumerates the flat inbox and returns a `ScanResult` whose `batchEntryDate` is the local calendar day of the scan (see IPC Channel Group + Entry Date). |
| ING-02 | Configure the inbox once in Settings (app creates a sensible default), then trigger a manual "Scan now" | `ingestion:resolveInbox` (computes/creates `Documents/NicoleBooks/Inbox`, persists to `app_settings.inbox_path`) + `ingestion:chooseInbox` (native `dialog.showOpenDialog`) + reuse of the existing `settings:get/set` channel (D-01). |
| ING-03 | Skip files that are unsupported or not fully materialized (placeholders, partial writes); surface skipped files in a summary rather than dropping them | Extension classifier (unsupported -> summary) + placeholder detection (Section 1) + bounded stability poll (Section 1.3). Status enum surfaces every skipped file. |
| ING-04 | Compute a SHA-256 file hash for each document; skip-and-flag any exact file already posted to QuickBooks (excluded by default, with override) | Streaming `crypto.createHash('sha256')` over `fs.createReadStream` + dedupe-ledger read/check (Section 3) + `duplicate-excluded` status with include-anyway override (D-09). |
| ING-05 | Accept text PDFs, JPEG, PNG, and iPhone HEIC | Extension-based classifier accepting `.pdf .jpg .jpeg .png .heic .heif`; HEIC recognized by type only (decode is Phase 3, PARSE-02). |
</phase_requirements>

## Summary

Phase 2 is 90% a disciplined application of patterns Phase 1 already established: a new typed IPC channel group (mirroring `settings.ts`), a new STRICT-table forward-only migration (`migration0002`, mirroring `0001_init.ts`), Node's built-in `crypto` for SHA-256, and a minimal results surface built from the existing `EmptyState`/`Badge`/`Button` components. None of that needs a new dependency, and CONTEXT already locks those seams. The research confirms them and pins the exact shapes.

The genuinely hard, non-obvious problem is **cross-platform detection of cloud-sync placeholders without triggering a download**, and it drives the single most important architectural insight of this phase: **the scanner must classify file type by extension and check materialization by metadata BEFORE it ever reads a file's bytes, because reading bytes is exactly what forces a placeholder to download (Windows recall) or materialize (macOS File Provider).** This inverts the intuitive "sniff the magic bytes first" approach. On macOS a dataless file is reliably detectable in pure Node via `fs.stat` (`size > 0 && blocks === 0`, plus the legacy `.<name>.icloud` sentinel); on Windows the reliable signal is the file's `FILE_ATTRIBUTE_OFFLINE` / `FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS` attributes, which Node's `fs.Stats` does not expose, so the recommended pure-dependency-free path is a single batched `execFile('attrib', ...)` or PowerShell read per scan (never `exec` with a shell string, to avoid command injection on a crafted folder path).

Partial-write protection is a separate, simpler concern: a bounded size+mtime settling poll before hashing. Placeholders are stable (they do not change), so the poll alone cannot catch them; the two guards are independent and both required.

**Primary recommendation:** Build `src/main/ingestion/` (scan orchestrator + `filetype.ts` + `materialization.ts` + `hash.ts` + `ledger.ts`) behind a new `ingestion` IPC channel group. Enumerate the flat inbox once (no recursion), then per file run this ordered pipeline: junk filter -> extension classify -> materialization check (metadata only) -> stability poll -> stream-hash -> within-scan collapse -> ledger check. Add `migration0002` creating one STRICT dedupe-hash table. Ship a Wave-0 empirical probe that creates a real OneDrive online-only file on Windows and a real iCloud evicted file on macOS and logs `fs.stat().blocks` + attributes, to lock the detection thresholds on the actual target machines.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Native "choose inbox" folder picker | Main (Electron `dialog`) | — | `dialog.showOpenDialog` exists only in main; the sandboxed renderer cannot open native dialogs. |
| Inbox path persistence / default creation | Main (better-sqlite3 `app_settings` + `fs.mkdir`) | — | DB and fs access are confined to main by the Phase 1 trust boundary (D-15). |
| Directory enumeration | Main (Node `fs.readdir`) | — | fs is main-only. |
| File-type classification (extension) | Main (Node, string ops) | — | Runs where fs runs; no byte read (must not materialize placeholders). |
| Placeholder / materialization detection | Main (`fs.stat` + OS attribute read) | — | OS-level metadata; main-only. |
| Partial-write stability poll | Main (`fs.stat` sampling) | — | fs, main. |
| SHA-256 hashing | Main (Node `crypto` + `fs.createReadStream`) | — | Reads file bytes; main-only. |
| Dedupe-ledger read/check | Main (better-sqlite3 prepared statement) | — | DB, main. |
| Scan orchestration | Main (`ingestion:scan` IPC handler) | — | Coordinates fs/crypto/db behind the trust boundary. |
| Scan trigger + results rendering | Renderer (React on Bills screen) | Main (IPC handler) | UI in renderer; all privileged work in main. |

Every capability except the button and the results list lives in main. This is the strongest possible reinforcement of D-15 and the Phase 1 SC4 boundary.

## Standard Stack

No new runtime dependencies. Everything Phase 2 needs is already installed or built into Node/Electron.

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| Node `crypto` (built-in) | Node 22 bundled with Electron 43 | `createHash('sha256')` streaming file hash | Native, memory-bounded via streams; zero dependency (D-16). [CITED: nodejs.org/api/crypto] |
| Node `fs` / `node:fs/promises` (built-in) | " | `readdir`, `stat`, `createReadStream`, `mkdir` | The whole enumerate/stat/hash pipeline; main-only. [CITED: nodejs.org/api/fs] |
| `better-sqlite3` | 13.0.1 (installed) | Dedupe-hash ledger table + prepared-statement check | Already the app DB; rebuilt against Electron 43 ABI in Phase 1. [VERIFIED: package.json] |
| `zod` | 4.4.3 (installed) | IPC payload validation at the boundary | The established T-01-03 input-validation control. [VERIFIED: package.json] |
| Electron `dialog` (built-in) | Electron 43.2.0 | Native folder picker (`showOpenDialog`) | Only cross-platform native directory chooser; main-only. [CITED: electronjs.org/docs/latest/api/dialog] |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `child_process.execFile` (built-in) | Node 22 | Batched Windows attribute read (`attrib` or PowerShell) for placeholder detection | Windows only, one spawn per scan, ONLY with an args array (never a shell string). |
| Electron `app.getPath('documents')` | Electron 43 | Locate the default inbox parent cross-platform | Computing `Documents/NicoleBooks/Inbox` on first run (D-01). [CITED: electronjs.org/docs/latest/api/app] |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Extension-based type check | `file-type` npm (magic-byte sniffing) | Rejected: (a) new dependency (CONTEXT forbids); (b) it READS the file header, which would force-download a Windows placeholder and materialize a macOS dataless file, directly violating D-11. Extension check needs no bytes. |
| `execFile('attrib')` on Windows | `winattr` / `fswin` npm (native attribute read) | Cleaner API and returns the raw attribute DWORD, but a new native dependency to rebuild against the Electron ABI. Not worth it for one shell-out per scan at this volume. |
| Bounded stability poll | `chokidar` / `fs.watch` awaitWriteFinish | Rejected: a watcher is the deferred V2-03 background feature; the scan is an explicit one-shot snapshot (D-03). A poll is simpler and matches the manual model. |
| Hand-rolled migration | `drizzle` / `knex` migrations | Rejected: Phase 1 already ships a forward-only `user_version` runner (`migrate.ts`); appending `migration0002` is a one-line change. |

**Installation:** None. `npm install` adds nothing for this phase.

**Version verification:** Confirmed against `package.json` (installed): `better-sqlite3@13.0.1`, `zod@4.4.3`, `electron@43.2.0`, `typescript@7.0.2`, `vitest@4.1.10`, `@playwright/test@1.61.1`. Node `crypto`/`fs`/`child_process` and Electron `dialog`/`app` are built-in. [VERIFIED: package.json]

## Package Legitimacy Audit

**No external packages are installed in this phase.** CONTEXT D-16 and the additional-context brief both state "no new dependency should be needed for dedupe/scan," and this research confirms it: SHA-256 (Node `crypto`), enumeration/stat/streams (Node `fs`), the ledger (existing `better-sqlite3`), validation (existing `zod`), the folder picker (Electron `dialog`), and Windows attribute reads (Node `child_process` shelling to the OS-bundled `attrib.exe`/`powershell.exe`) are all built-in or already present.

| Package | Registry | Age | Downloads | Source Repo | slopcheck | Disposition |
|---------|----------|-----|-----------|-------------|-----------|-------------|
| (none) | — | — | — | — | N/A | No installs this phase |

**Packages removed due to slopcheck [SLOP] verdict:** none (no packages evaluated for install).
**Packages flagged as suspicious [SUS]:** none.

If a future planning decision reverses the "no new dependency" stance (e.g. adopting `file-type` or `winattr`), that package MUST go through the Package Legitimacy Gate and be gated behind a `checkpoint:human-verify` task before install.

## Architecture Patterns

### System Architecture Diagram

```
  [ Bills screen: "Scan now" button ]  (renderer, React)
                 |
                 |  window.api.ingestion.scan()      (typed, via preload)
                 v
        ipcMain.handle('ingestion:scan')            (main)
                 |
                 |  assertTrustedSender(event)        (T-01-03 gate)
                 |  ScanRequestSchema.parse(raw)      (Zod boundary)
                 v
        readdir(inboxPath, {withFileTypes:true})     (flat, NO recursion)
                 |
                 v   ---- per directory entry ----
   +----------------------------------------------------------+
   | 1. JUNK filter (.DS_Store, Thumbs.db, ._*, dotfiles)     |  -> drop silently (D-13)
   |    (translate .<name>.icloud -> <name> is a placeholder) |
   | 2. EXTENSION classify (.pdf .jpg .jpeg .png .heic .heif) |  -> else 'unsupported-skipped' (D-12)
   | 3. MATERIALIZATION check  (fs.stat metadata ONLY)        |  -> 'not-ready-skipped' (D-11)
   |      mac: size>0 && blocks===0 | .icloud sentinel        |     (NEVER reads bytes here)
   |      win: OFFLINE / RECALL_ON_DATA_ACCESS attribute      |
   | 4. STABILITY poll (size+mtime settle, bounded)           |  -> 'not-ready-skipped' if still growing
   | 5. STREAM-HASH  createReadStream -> sha256               |  (now safe: local + settled)
   +----------------------------------------------------------+
                 |
                 v   ---- across the whole batch ----
   | 6. WITHIN-SCAN collapse by hash (D-10)                   |  -> 'duplicate-in-batch'
   | 7. LEDGER check: hash in posted_file_hashes? (D-08/09)   |  -> 'duplicate-excluded' (posted date)
                 |                                                 else -> 'loaded'
                 v
        ScanResult { batchEntryDate, inboxPath, files[], summary }
                 |
                 v
   [ Bills screen results list + one-line summary + batch date ]  (renderer)
```

The load-bearing ordering rule: **byte reads (step 5) happen only after type (step 2), materialization (step 3), and stability (step 4) all pass.** Steps 2 and 3 are metadata-only precisely so an online-only placeholder can be classified and skipped without being downloaded.

### Recommended Project Structure
```
src/main/
├── ingestion/
│   ├── scan.ts            # orchestrator: enumerate -> classify -> materialize-check -> poll -> hash -> dedupe
│   ├── filetype.ts        # extension classifier + junk filter (pure, unit-testable)
│   ├── materialization.ts # placeholder detection (mac blocks/.icloud, win attrib) + stability poll
│   ├── hash.ts            # streaming sha256 of a file path (pure, unit-testable)
│   └── ledger.ts          # prepared-statement dedupe read/check against posted_file_hashes
├── ipc/
│   └── ingestion.ts       # registerIngestionIpc(): assertTrustedSender -> Zod -> ingestion/*
└── db/migrations/
    └── 0002_dedupe.ts     # migration0002: CREATE TABLE posted_file_hashes ... STRICT
```
Mirrors the Phase 1 layout: thin IPC file (`ipc/ingestion.ts`) delegating to a logic module (`ingestion/`), exactly as `ipc/settings.ts` is thin over `db/`.

### Pattern 1: The "metadata-first, bytes-last" scan pipeline
**What:** Classify and screen every file using only directory-entry names and `fs.stat` metadata; open the file's data stream only at the hashing step, and only for files that already passed the materialization and stability gates.
**When to use:** Any time a folder may contain cloud-sync placeholders (OneDrive/iCloud/Dropbox/Google Drive). That is always true for a user's Documents folder.
**Example:**
```typescript
// src/main/ingestion/materialization.ts
// Source: pattern derived from macOS dataless-file semantics (eclecticlight.co) and
// Windows Files On-Demand attribute semantics (learn.microsoft.com). [CITED]
import { stat } from 'node:fs/promises'

/** True when the file's bytes are NOT on local disk (online-only placeholder). Reads
 *  metadata only, so it never triggers a download / materialization. */
export async function isNotMaterialized(
  fullPath: string,
  siblingNames: Set<string>,   // names in the same directory, from the readdir we already did
  fileName: string,
  platform = process.platform
): Promise<boolean> {
  const st = await stat(fullPath)          // stat does NOT fault-in data on mac or win
  if (platform === 'darwin') {
    // macOS APFS dataless file: full logical size, zero allocated extents.
    if (Number(st.size) > 0 && Number(st.blocks) === 0) return true
    // Legacy pre-Sonoma iCloud stub: a sibling ".<name>.icloud" placeholder exists.
    if (siblingNames.has(`.${fileName}.icloud`)) return true
    return false
  }
  // win32 handled by a batched attribute read (see readWindowsOfflineFlags) because
  // Node's fs.Stats exposes no Windows file attributes and its `blocks` value is not a
  // reliable allocation signal on Windows. See Section 1.
  return false
}
```

### Pattern 2: Bounded size+mtime settling poll (partial-write guard)
**What:** Sample `(size, mtimeMs)` twice with a short gap; treat the file as still being written if either changed; retry up to a small budget.
**When to use:** Before hashing any file, to avoid hashing a half-copied file.
**Example:**
```typescript
// src/main/ingestion/materialization.ts
import { stat } from 'node:fs/promises'
import { setTimeout as sleep } from 'node:timers/promises'

/** Resolves true once (size,mtime) are stable across two consecutive samples, or false
 *  if the file is still changing after the budget (treat as not-ready). */
export async function isSettled(fullPath: string,
  { intervalMs = 750, maxSamples = 6 } = {}): Promise<boolean> {
  let prev = await stat(fullPath)
  for (let i = 0; i < maxSamples; i++) {
    await sleep(intervalMs)
    const next = await stat(fullPath)
    if (next.size === prev.size && next.mtimeMs === prev.mtimeMs) return true
    prev = next
  }
  return false   // still growing after ~4.5s -> 'not-ready-skipped', re-scan shortly
}
```

### Pattern 3: Streaming SHA-256 (memory-bounded, large-scan-safe)
**What:** Pipe a read stream through a hash and await the pipeline; never `readFileSync` a scanned PDF or phone photo into memory.
**Example:**
```typescript
// src/main/ingestion/hash.ts
// Source: nodejs.org/api/crypto streaming interface. [CITED]
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'

export async function sha256File(fullPath: string): Promise<string> {
  const hash = createHash('sha256')
  await pipeline(createReadStream(fullPath), hash)   // backpressure-safe
  return hash.digest('hex')                          // 64-char lowercase hex
}
```

### Pattern 4: New IPC channel group (mirrors `settings.ts` exactly)
```typescript
// src/main/ipc/ingestion.ts
import { ipcMain, dialog, app, BrowserWindow } from 'electron'
import { Channels } from '../../shared/ipc-contract'
import { ScanRequestSchema } from '../../shared/schemas'
import { assertTrustedSender } from './trusted-sender'
import { runScan } from '../ingestion/scan'
import { resolveInboxPath, persistInboxPath } from '../ingestion/inbox'

export function registerIngestionIpc(): void {
  ipcMain.handle(Channels.ingestionResolveInbox, (event) => {
    assertTrustedSender(event)
    return resolveInboxPath()            // reads app_settings, creates default if unset
  })

  ipcMain.handle(Channels.ingestionChooseInbox, async (event) => {
    assertTrustedSender(event)
    const win = BrowserWindow.fromWebContents(event.sender) ?? undefined
    const res = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] })
    if (res.canceled || res.filePaths.length === 0) return { canceled: true as const }
    persistInboxPath(res.filePaths[0])   // reuse app_settings via prepared statement
    return { canceled: false as const, path: res.filePaths[0] }
  })

  ipcMain.handle(Channels.ingestionScan, async (event, raw) => {
    assertTrustedSender(event)
    ScanRequestSchema.parse(raw)         // no renderer-supplied path (avoids path injection)
    return runScan()                     // reads inbox from app_settings itself
  })
}
```

### Anti-Patterns to Avoid
- **Reading bytes before the materialization check.** Magic-byte sniffing, `readFile`, or even opening the file forces a Windows recall / macOS materialization, violating D-11 ("does NOT attempt to force-download placeholders"). Classify by extension; check materialization by metadata; hash last.
- **Recursive directory traversal.** Descending into a dataless *sub*directory materializes it on macOS (the documented `**` glob bug). The inbox is flat (D-01), so `readdir` the one directory and never recurse.
- **`child_process.exec('attrib ' + path)` (shell string).** A folder path or filename with shell metacharacters becomes command injection. Use `execFile('attrib', [pattern])` / `spawn(..., { shell: false })` with an args array.
- **Trusting `fs.stat().blocks` on Windows** as the sole placeholder signal. It is reliable on macOS APFS but not a dependable allocation signal on Windows; use the attribute read there.
- **Interpolating filenames into SQL.** Use the existing prepared-statement pattern (`WHERE hash = ?`); never build SQL from a scanned filename or hash string.
- **Letting the scan force a download to "check the type."** If detection is inconclusive, prefer to skip-and-surface (never silently drop, never force-download); see the Section 1 decision rule and Open Question 1.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| SHA-256 | A JS hash implementation | Node `crypto.createHash('sha256')` streamed | Native, constant-memory, correct. |
| SQLite schema migration | A new migration lib or ad-hoc `CREATE TABLE` at startup | Existing `migrate.ts` + append `migration0002` | Forward-only `user_version` ratchet already proven and tested. |
| IPC transport / validation | A generic `invoke(channel, payload)` bridge | Existing named-channel contract + Zod schemas | Preserves the SC4 trust boundary; a generic bridge would reintroduce the elevation-of-privilege surface Phase 1 closed. |
| Native folder picker | An HTML file input or path text box | Electron `dialog.showOpenDialog({properties:['openDirectory']})` | Only cross-platform native directory chooser; the renderer cannot open dialogs. |
| Duplicate detection | Content similarity / fuzzy matching | Exact SHA-256 equality against the ledger | D-07: exact-file only; near-duplicates are Phase 6. |

**One deliberate exception (correct to hand-roll):** the **file-type check by extension** and the **junk filter**. A magic-byte library would be both a new dependency AND a byte-reading operation that defeats placeholder detection. A dozen-line extension/junk classifier is the right tool here. An OPTIONAL magic-byte confirmation may run *during* hashing (the header bytes are already streaming through) to catch a mis-saved file, but it is not required for MVP and must never run before materialization is confirmed.

**Key insight:** In this domain the usual "sniff the bytes to be safe" instinct is actively harmful, because the act of sniffing changes the file's state (download / materialize). Metadata-only screening is not a shortcut here; it is a correctness requirement.

## Common Pitfalls

### Pitfall 1: A stability poll cannot catch an online-only placeholder
**What goes wrong:** You build a size/mtime settling poll, watch it "settle," hash the file, and on Windows the hash step silently downloads a multi-MB placeholder (or on macOS materializes it), the opposite of D-11.
**Why it happens:** A placeholder is *stable*: `fs.stat().size` reports the full logical size and never changes, so the poll declares it "settled." Stability and materialization are orthogonal properties.
**How to avoid:** Run the explicit materialization check (Section 1) as a separate gate before the stability poll. Never infer "local" from "not changing."
**Warning signs:** Scanning an inbox inside OneDrive/iCloud suddenly downloads gigabytes; test files that were online-only show status `loaded`.

### Pitfall 2: Node's `fs.Stats` exposes neither Windows attributes nor macOS `st_flags`
**What goes wrong:** You reach for a single cross-platform `fs.stat` field to detect placeholders and find none. There is no `stats.attributes` (Windows `FILE_ATTRIBUTE_OFFLINE`) and no `stats.flags` (macOS `SF_DATALESS`).
**Why it happens:** libuv normalizes to a POSIX-ish `Stats`. The only allocation-adjacent field is `blocks`, which is trustworthy on macOS APFS but not a dependable placeholder signal on Windows.
**How to avoid:** Split by platform: pure-Node `blocks`/`.icloud` on macOS; a batched `attrib`/PowerShell attribute read on Windows. Confirm both empirically in Wave 0.
**Warning signs:** A detection function that "works on my Mac" flags nothing on Windows.

### Pitfall 3: Recursive globbing materializes dataless directories on macOS
**What goes wrong:** Using a recursive walk (`**`, `fs.readdir({recursive:true})`, or a globbing lib) over a folder containing evicted iCloud subfolders downloads them just by enumerating.
**Why it happens:** Descending into a dataless *directory* forces the File Provider to materialize it (documented in fish-shell#8399: `ls -l` shows `%` for dataless, which flips to `@` after a recursive glob touches it).
**How to avoid:** The inbox is flat (D-01). Do a single non-recursive `readdir` and never descend. Listing one directory's entries returns names + d_type without materializing file *contents*.
**Warning signs:** iCloud starts re-downloading whole folders after a scan.

### Pitfall 4: Command injection via a crafted inbox path or filename
**What goes wrong:** Shelling out to read Windows attributes with `exec('attrib "' + path + '"')` lets a folder named `x"; del ...` (or a filename with metacharacters) run arbitrary commands.
**Why it happens:** `exec` runs through `cmd.exe`; string concatenation is injectable. This is a real Tampering/EoP threat for a financial tool.
**How to avoid:** `execFile('attrib', [globPattern])` or `spawn` with `shell: false` and an args array; pass the directory path as a discrete argument. Better still, prefer the metadata approach and shell out at most once per scan over the whole directory.
**Warning signs:** Any `exec(`...string...`)` with a filesystem path interpolated.

### Pitfall 5: Hashing before the batch is fully enumerated breaks within-scan collapse
**What goes wrong:** Marking the first copy `loaded` and immediately writing it, then discovering a byte-identical second copy later, with no clean way to relate them.
**Why it happens:** D-10 collapse is a whole-batch operation (group by hash), not a streaming one.
**How to avoid:** Compute all hashes first into an in-memory list, then group by hash for within-scan collapse (D-10) and run the ledger check (D-08). Ledger `duplicate-excluded` takes precedence over `duplicate-in-batch` when both apply.
**Warning signs:** Two identical files both show `loaded`.

### Pitfall 6: `createDirectory` is macOS-only; `app.getPath('documents')` must exist
**What goes wrong:** Relying on the dialog to create folders on Windows, or assuming the Documents path is present.
**Why it happens:** `properties: ['createDirectory']` is documented macOS-only; on Windows the dialog's own "New folder" button covers it. The app-created default (D-01) must `fs.mkdir(..., {recursive:true})` itself regardless of platform.
**How to avoid:** For the default inbox, compute `join(app.getPath('documents'), 'NicoleBooks', 'Inbox')` and `mkdirSync(path, {recursive:true})` in main; do not depend on the dialog to create it.

## Detailed Findings

### Section 1: Cross-platform placeholder / materialization detection (HIGHEST PRIORITY, D-11 / SC4 / ING-03)

**The core constraint:** reading a file's data is what triggers download. On Windows, "Standard Win32 CreateFile/ReadFile calls automatically resolve placeholders when called from a non-FILE_FLAG_OPEN_NO_RECALL context, which triggers the download of the full file content" [CITED: learn.microsoft.com placeholder-files]. On macOS, materialization happens "when the user tries to read" a dataless file, and even *enumerating* a dataless directory can materialize it [CITED: eclecticlight.co; fish-shell#8399]. `fs.stat` reads metadata only and does not fault-in data on either platform, so metadata screening is safe. Node's `fs.open`/`createReadStream` do not expose `FILE_FLAG_OPEN_NO_RECALL`, so there is no pure-Node way to "peek" bytes without risking a download; hence bytes-last.

#### 1.1 macOS (pure Node, no shell, no native module) — HIGH confidence on mechanism, MEDIUM-HIGH on the exact `blocks` threshold
- Modern macOS (Sonoma 2023+ / current) uses **dataless files** via the File Provider framework: "a file or directory is a placeholder ... consist only of file attributes and extended attributes, with no file extents containing the file's data ... When you ask for the file size, it returns the size it would be when downloaded, although the file only takes the space required for its attributes" [CITED: mjtsai.com; eclecticlight.co]. Authoritatively, a dataless file sets `SF_DATALESS` in `stat.st_flags` [CITED: Apple docs via search]. **Node does not expose `st_flags`**, but the "no file extents" property means allocated blocks are ~0. So the pure-Node signal is `stats.size > 0 && Number(stats.blocks) === 0`.
- Legacy (pre-Sonoma / "Optimize Mac Storage" stubs): a sentinel file `.<originalname>.icloud` (typically < 200 bytes) sits beside the evicted file; its presence means `<originalname>` is not downloaded [CITED: eclecticlight.co; macfilos.com]. Cheap to check from the same `readdir` result. Note: because this sentinel starts with a dot, the junk filter must translate `.<name>.icloud` -> "`<name>` is a placeholder" BEFORE applying the generic dotfile-junk rule (Pitfall handled in `filetype.ts`).
- Dropbox / Google Drive on macOS also use the File Provider framework, so the same dataless (`blocks === 0`) signal applies; they do not generally use `.icloud` sentinels.
- **Recommended default (mac):** `size > 0 && blocks === 0` OR a `.<name>.icloud` sibling -> `not-ready-skipped`. `stat` is non-materializing; the single flat `readdir` is safe.

#### 1.2 Windows (batched shell read, no native module) — HIGH confidence on attributes, LOW confidence on pure-Node `blocks`
- OneDrive Files On-Demand marks online-only files with `FILE_ATTRIBUTE_OFFLINE` (0x1000) and placeholders carry `FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS` (0x400000) (and/or `FILE_ATTRIBUTE_RECALL_ON_OPEN` 0x40000) [CITED: learn.microsoft.com; techtarget.com]. State summary from the field: online-only = `-P +U`, locally available = `-P -U`, always-available = `+P -U`, where P = pinned, U = unpinned [CITED: learn.microsoft.com "Query and set Files On-Demand states"].
- **Reading the attribute does NOT trigger a download** [CITED: codegenes.net: "Checking the attribute does not initiate downloads"]. Safe to query.
- Node's `fs.Stats` exposes no Windows attributes, and its `blocks` value is not a reliable allocation signal on Windows (libuv PR context: `blocks`/`blksize` were only recently made non-`undefined` on Windows, node#26056; they are not documented to reflect sparse/placeholder allocation). So do NOT rely on `blocks` on Windows.
- **Recommended default (win):** one batched read per scan via `execFile` (args array, no shell):
  - Option A (precise): PowerShell one-liner returning name + raw attribute integer, then bit-test in Node:
    ```
    powershell -NoProfile -Command "Get-ChildItem -LiteralPath '<dir>' -File | ForEach-Object { \"$($_.Name)`t$([int64]$_.Attributes)\" }"
    ```
    Flag `not-ready` if `(attr & 0x1000) || (attr & 0x400000) || (attr & 0x40000)`. `[int64]$_.Attributes` includes bits that .NET has no named enum member for (0x400000), so bit-testing the integer catches recall placeholders that `[FileAttributes]::Offline` alone would miss.
  - Option B (lighter, no .NET spin-up): `attrib "<dir>\\*"` and parse the letter columns; `O` = offline, `U` = OneDrive unpinned (online-only). Faster cold-start, coarser (does not distinguish recall bits), but sufficient to flag online-only.
  - Prefer A for precision; B is an acceptable fallback. Both are one spawn per scan (not per file), which is negligible for a 5-20-file inbox.
- Native-module alternative (rejected per CONTEXT): `winattr`/`fswin` read the raw DWORD without shelling, but add a native dependency to rebuild against the Electron ABI.

#### 1.3 Partial-write guard (both platforms) — MEDIUM confidence (heuristic, not a hard spec)
- A file mid-copy grows: sample `(size, mtimeMs)` twice with a short gap; if unchanged across two consecutive samples, treat as settled.
- **Recommended defaults:** interval 750 ms, require 2 consecutive equal samples, max 6 samples (~4.5 s ceiling) per file. Files still changing after the ceiling -> `not-ready-skipped` ("re-scan shortly"). These are low-volume-friendly and tunable; treat as starting values, not gospel.
- Order: materialization check first (cheap, no wait), stability poll only for files that are materialized. A file actively downloading from the cloud will register as "changing" in the poll too, which is a harmless second layer.

#### 1.4 The decision rule (skip vs hash)
```
enumerate flat inbox (readdir, no recursion)
for each entry:
  if junk(name):                       drop silently                 (D-13)
  else if not supportedExtension(name): 'unsupported-skipped' + name  (D-12)
  else if isNotMaterialized(...):       'not-ready-skipped'           (D-11)
  else if not settled(...):             'not-ready-skipped'           (D-11 partial write)
  else:                                 hash, then dedupe             (D-07/08/09/10)
```
**Inconclusive-detection tradeoff (flag for planner):** if the Windows attribute read fails entirely (e.g. PowerShell unavailable), fall back to loading (hash) rather than false-skipping every real local bill, accepting the rare risk of downloading a genuine placeholder. Skipping should require positive placeholder evidence. This favors "never false-skip a real bill" over "never ever download," within D-11's spirit that skipped files are always surfaced and re-scannable. See Open Question 1.

### Section 2: File-type detection (ING-05 / D-12 / D-13)
- **Extension-based classification is the recommended default**, because it needs no bytes and therefore does not materialize placeholders (Section 1). Supported set: `.pdf`, `.jpg`, `.jpeg`, `.png`, `.heic`, `.heif` (case-insensitive). Everything else user-visible -> `unsupported-skipped` with its filename in the summary (D-12).
- **Junk set (silently ignored, D-13):** exact names `.DS_Store`, `Thumbs.db`, `desktop.ini`, `.localized`; AppleDouble prefix `._`; and hidden dotfiles (leading `.`). Special-case: a `.<name>.icloud` entry is NOT junk; translate it to a placeholder signal for `<name>` before the dotfile rule.
- **Magic bytes for reference** (only if an optional post-materialization confirmation is added; NOT required for MVP): PDF `25 50 44 46` (`%PDF`) at offset 0; JPEG `FF D8 FF` at 0; PNG `89 50 4E 47 0D 0A 1A 0A` at 0; HEIC/HEIF `ftyp` box (`66 74 79 70`) at **offset 4**, followed by a brand `heic`/`heix`/`hevc`/`hevx`/`mif1`/`msf1` [CITED: filesignature.org; loc.gov; nokiatech HEIF]. The HEIF spec does not require a magic number at byte 0, so the ftyp-at-offset-4 check is the reliable one. If implemented, read only the first ~32 bytes, and only from an already-materialized+settled file, ideally piggybacked on the hash stream's first chunk.
- HEIC recognition at ingestion is **type-only**; decode (heic-convert) is Phase 3 (PARSE-02).

### Section 3: Dedupe ledger schema + SHA-256 (D-07 / D-08 / D-16 / ING-04)

**SHA-256:** stream `fs.createReadStream(path)` through `crypto.createHash('sha256')` via `stream/promises` `pipeline`; `digest('hex')` yields a 64-char lowercase hex string. Streaming (not `readFileSync`) keeps memory constant for large scanned PDFs / phone photos [CITED: nodejs.org/api/crypto]. See Pattern 3.

**Migration (`migration0002`, STRICT, mirrors `0001_init.ts`):**
```sql
CREATE TABLE IF NOT EXISTS posted_file_hashes (
  hash              TEXT PRIMARY KEY,   -- SHA-256 hex, lowercase, 64 chars
  posted_at         TEXT NOT NULL,      -- ISO-8601 UTC; when Phase 7 posted this file to QBO
  original_filename TEXT NOT NULL,      -- provenance: filename at time it was posted
  qbo_entity        TEXT,               -- nullable; 'Bill' | 'Purchase' (Phase 7 fills)
  qbo_id            TEXT                 -- nullable; QBO entity Id (Phase 7 fills)
) STRICT;
```
Wire it into `migrate.ts` as `{ version: 2, up }` appended to the `migrations` array (never renumber 0001). `hash TEXT PRIMARY KEY` gives both the uniqueness constraint and an O(log n) lookup for the dedupe check.

**The Phase 2 / Phase 7 write split (a genuine design fork — recommendation + alternative):**
- **Recommended (Design B: ledger = posted-only; Phase 2 is read-only on it).** A row exists in `posted_file_hashes` **iff** that exact file was posted to QBO. Phase 2 never writes this table; it only runs the check `SELECT 1 FROM posted_file_hashes WHERE hash = ?`. Phase 7 inserts one row per posted file at post time (owning `posted_at`, `original_filename`, `qbo_*`). This is the most literal reading of D-08 ("Phase 2 defines the table and the read/check"; "the write ... happens in Phase 7") and gives the cleanest, lowest-risk boundary for a financial tool: Phase 2 cannot corrupt the posted-ledger because it never writes it. Re-scanning pending (un-posted) bills reloads them automatically because no row exists yet, exactly as D-08 requires. In this design "first-seen timestamp" from the Discretion note is satisfied as the post-time provenance timestamp.
- **Alternative (Design A: true first-seen provenance).** Add a nullable `posted_at` and have Phase 2 `INSERT OR IGNORE` a provenance row (`first_seen_at`, `original_filename`, `posted_at = NULL`) at scan time; Phase 7 flips `posted_at` via UPDATE. The dedupe check becomes `WHERE hash = ? AND posted_at IS NOT NULL`. This literally captures a first-seen timestamp but makes Phase 2 a writer of the ledger, blurring the read/write split, and accumulates rows for files that are scanned but never posted. Choose this only if true first-seen provenance is wanted.
- **Recommendation:** ship Design B for MVP; note Design A as available. Flagged in the Assumptions Log for planner/discuss confirmation.

**Dedupe logic (both designs):**
- Compute all batch hashes first (Pitfall 5).
- **Within-scan collapse (D-10):** group the batch by hash; first occurrence keeps its real status, later byte-identical copies -> `duplicate-in-batch`.
- **Ledger check (D-08/09):** if the hash is in `posted_file_hashes` -> `duplicate-excluded`, surfaced with the posted date, excluded by default, one-click include-anyway override (D-09).
- **Precedence:** `duplicate-excluded` (already posted) outranks `duplicate-in-batch` when both apply.
- No new dependency; `better-sqlite3` prepared statements only (T-01-06 safe).

### Section 4: IPC channel group design (D-15)

**Add to `src/shared/ipc-contract.ts`** (types + string constants only, zero runtime imports):
```typescript
export const Channels = {
  // ...existing seven...
  ingestionResolveInbox: 'ingestion:resolve-inbox',
  ingestionChooseInbox:  'ingestion:choose-inbox',
  ingestionScan:         'ingestion:scan'
} as const

export type ScanFileStatus =
  | 'loaded'
  | 'duplicate-excluded'    // exact hash already posted (ledger, D-08/09)
  | 'duplicate-in-batch'    // within-scan byte-identical copy (D-10)
  | 'not-ready-skipped'     // placeholder or still-being-written (D-11)
  | 'unsupported-skipped'   // wrong file type (D-12)
  // junk (D-13) never appears in the list

export interface ScanFile {
  filename: string
  status: ScanFileStatus
  hash?: string             // present for loaded / duplicate-*
  sizeBytes?: number
  postedAt?: string         // present for duplicate-excluded ("Already entered on ...")
}

export interface ScanResult {
  batchEntryDate: string    // processing date = local day of scan, 'YYYY-MM-DD' (D-05)
  inboxPath: string
  files: ScanFile[]
  summary: { total: number; loaded: number; duplicates: number; notReady: number; unsupported: number }
}

export interface IngestionApi {
  resolveInbox(): Promise<{ path: string; created: boolean }>
  chooseInbox(): Promise<{ canceled: true } | { canceled: false; path: string }>
  scan(): Promise<ScanResult>
}
export interface Api { settings: SettingsApi; secrets: SecretsApi; theme: ThemeApi; ingestion: IngestionApi }
```

**Add to `src/shared/schemas.ts`:** `export const ScanRequestSchema = z.object({}).strict()` (scan takes no renderer payload; the inbox path is read server-side from `app_settings`, which removes any path-injection surface). No inbound payload needs validation for `resolveInbox`/`chooseInbox`; they still run `assertTrustedSender`. Return values are produced by trusted main code, so they do not require Zod-parsing at the boundary (Zod gates renderer -> main inputs).

**Preload (`src/preload/index.ts`):** add an `ingestion` object with three thin `ipcRenderer.invoke` methods on the new channel constants (same shape as `settings`). No `ipcRenderer` or generic invoke is ever exposed (T-01-02 preserved).

**Register (`src/main/ipc/register.ts`):** add `registerIngestionIpc()` to the aggregator.

**Folder picker:** `dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] })` returns `{ canceled, filePaths }` as a Promise [CITED: electronjs.org/docs/latest/api/dialog]. `createDirectory` is macOS-only (harmless on Windows, where the dialog's New Folder button applies). The app-created default inbox must `mkdirSync(join(app.getPath('documents'),'NicoleBooks','Inbox'),{recursive:true})` in main (Pitfall 6).

**Single request/response vs streaming:** for a 5-20-file inbox a single `scan(): Promise<ScanResult>` is correct; the whole scan (enumerate + stat + short polls + a handful of stream-hashes) completes in well under a few seconds. The renderer shows a "Scanning..." state on the button and renders the result on resolve. A `webContents.send('ingestion:progress', ...)` stream is unnecessary now; note it as an easy future addition if volume ever grows. Recommend single request/response.

**Entry date (D-05):** `batchEntryDate` = the local calendar day the scan runs, formatted `YYYY-MM-DD` in the machine's local timezone (use a small local-date formatter, not `toISOString()`, which is UTC and can be off-by-a-day near midnight). Phase 2 does not persist a batch table; the processing date and per-file hashes travel with the in-memory `ScanResult` and become Phase 3's parse-pipeline input. The only new table this phase adds is the dedupe-hash ledger.

## Runtime State Inventory

Not applicable. Phase 2 is additive (new IPC group + one new migration), not a rename/refactor/migration of existing runtime state. Section omitted per template guidance.

## Code Examples

Additional verified patterns beyond Patterns 1-4 above.

### Junk + extension classifier (pure, unit-testable)
```typescript
// src/main/ingestion/filetype.ts
const SUPPORTED = new Set(['.pdf', '.jpg', '.jpeg', '.png', '.heic', '.heif'])
const JUNK_EXACT = new Set(['.ds_store', 'thumbs.db', 'desktop.ini', '.localized'])

export function isJunk(name: string): boolean {
  const lower = name.toLowerCase()
  if (JUNK_EXACT.has(lower)) return true
  if (name.startsWith('._')) return true          // AppleDouble
  if (name.startsWith('.') && !lower.endsWith('.icloud')) return true // hidden dotfile
  return false
}
export function isSupported(name: string): boolean {
  const dot = name.lastIndexOf('.')
  return dot >= 0 && SUPPORTED.has(name.slice(dot).toLowerCase())
}
/** ".foo.pdf.icloud" -> "foo.pdf" (the real file that is a placeholder), else null. */
export function iCloudSentinelTarget(name: string): string | null {
  const l = name.toLowerCase()
  if (name.startsWith('.') && l.endsWith('.icloud')) return name.slice(1, -'.icloud'.length)
  return null
}
```

### Local calendar-day formatter (avoids UTC off-by-one)
```typescript
// processing date = local day of scan (D-05)
export function localDateStamp(d = new Date()): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| iCloud `.<name>.icloud` stub sentinel files (< 200 bytes) | Dataless files/folders via File Provider (`SF_DATALESS`, zero extents; detect via `blocks === 0`) | macOS Sonoma, Oct 2023 | On current macOS the `.icloud` sentinel is a legacy fallback; the `blocks === 0` signal is the primary one. Support both. [CITED: mjtsai.com; eclecticlight.co] |
| keytar / ad-hoc attribute native modules | Built-in metadata (`fs.stat`) + one batched shell read on Windows | — | No native dependency needed for Phase 2 detection. |
| `readFileSync` then hash | Streamed `pipeline(createReadStream, hash)` | Long-standing Node guidance | Constant memory for large scans. |

**Deprecated/outdated:**
- Treating `.icloud` sentinels as the *only* macOS placeholder signal: incomplete on Sonoma+ (dataless files often have no sentinel).
- Magic-byte-first type detection in a cloud-synced folder: actively harmful (forces download/materialize). Superseded by metadata-first screening.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | macOS dataless files reliably report `fs.stat().blocks === 0` (with `size > 0`) via Node/libuv, and `stat` does not materialize them | Section 1.1 | If `blocks` is non-zero for some provider, placeholders load and get downloaded. Mitigation: Wave-0 probe on a real Mac with a real evicted iCloud file. |
| A2 | Windows attribute read (`attrib`/PowerShell) reliably reflects OneDrive online-only state and does not trigger download | Section 1.2 | If a provider does not set OFFLINE/RECALL bits, its placeholders would be hashed (downloaded). Mitigation: Wave-0 probe on real Windows + OneDrive Files On-Demand; document Dropbox/Google-Drive-on-Windows behavior if used. |
| A3 | Design B (ledger = posted-only, Phase 2 read-only) is the intended Phase 2/Phase 7 split | Section 3 | If the team wants true first-seen provenance, switch to Design A. Low cost either way; confirm before coding the migration. |
| A4 | Stability poll defaults (750 ms x up to 6 samples) are adequate for local + cloud-download settling at this volume | Section 1.3 | Too short -> occasional false `not-ready` (recoverable by re-scan); too long -> sluggish scan. Tunable. |
| A5 | Single request/response scan (no progress stream) is acceptable UX for 5-20 files | Section 4 | If real inboxes are much larger, add a progress channel. Volume is explicitly low (CLAUDE.md: 5-20 bills/week). |
| A6 | `execFile('attrib'/powershell)` per scan is an acceptable dependency-free Windows path | Section 1.2 | If shell-out is undesirable, revisit a native attribute module (new dep, gated by legitimacy check). |

**All A1/A2 items are empirically resolvable in Wave 0** and should be, before the detection thresholds are locked.

## Open Questions (RESOLVED)

1. **Inconclusive-detection fallback direction (skip vs load).** RESOLVED: closed by plan 02-03 (load-on-inconclusive fallback in the materialization slice).
   - What we know: skipping is always surfaced and re-scannable (safe); loading a placeholder would download it (mildly violates "don't force-download" but not catastrophic).
   - What's unclear: which failure mode Nicole should experience when detection can't decide.
   - Recommendation: default to LOAD on total detection failure (never false-skip a real bill), skip only on positive placeholder evidence; confirm with Anthony. Documented in Section 1.4.

2. **Design A vs B for the ledger (first-seen provenance vs strict read/write split).** RESOLVED: closed by plans 02-01/02-02 (Design B: Phase 2 read-only ledger, Phase 7 owns the write).
   - See Section 3 + Assumption A3. Recommend B; trivially switchable. A discuss-phase or plan-checker confirmation would close it.

3. **Optional magic-byte confirmation during hashing.** RESOLVED: deferred per recommendation (extension check suffices for MVP; magic-byte hook left in hash.ts).
   - What we know: it can catch a mislabeled/renamed file (e.g. a `.pdf` that is really a `.docx`) using bytes already streaming through the hash.
   - What's unclear: whether the extra complexity is worth it for a trusted, single-user local inbox in MVP.
   - Recommendation: defer for MVP (extension check suffices); leave a hook in `hash.ts` to inspect the first chunk if wanted later.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node `crypto` / `fs` / `child_process` | Hashing, enumeration, Windows attr read | Yes (built-in) | Node 22 (Electron 43) | — |
| `better-sqlite3` | Dedupe ledger | Yes (installed, ABI-rebuilt in Phase 1) | 13.0.1 | — |
| Electron `dialog` / `app` | Folder picker, default path | Yes (built-in) | 43.2.0 | — |
| `attrib.exe` / `powershell.exe` | Windows placeholder attribute read | Yes on all Windows | OS-bundled | `attrib` if PowerShell blocked; else load-on-fail (OQ1) |
| macOS: none extra (pure `fs.stat`) | mac placeholder detection | Yes | — | `.icloud` sentinel check |

**Missing dependencies with no fallback:** none.
**Missing dependencies with fallback:** Windows attribute read has a graceful fallback chain (PowerShell -> `attrib` -> load-on-fail). The macOS path is pure Node with no external tool.

## Validation Architecture

> `workflow.nyquist_validation` is `true` in config.json, so this section is included.

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Vitest 4.1.10 (unit, `environment: 'node'`), Playwright 1.61.1 (`_electron` e2e) |
| Config file | `vitest.config.ts` (`include: ['test/**/*.test.ts']`), `playwright.config.ts` (`testDir: './e2e'`) |
| Quick run command | `npm run test:unit` (`vitest run`) |
| Full suite command | `npm test` (`vitest run && playwright test`) |

### Design-for-testability principle
Keep the risky logic in **pure, injectable functions** that take a directory path and (for cross-platform simulation) an explicit `platform` argument, so tests can exercise macOS and Windows branches on a single CI OS without a real cloud provider:
- `filetype.ts` (`isJunk`, `isSupported`, `iCloudSentinelTarget`) — pure, trivially unit-tested.
- `hash.ts` (`sha256File`) — real temp files with known bytes -> known digest.
- `materialization.ts` (`isNotMaterialized`, `isSettled`) — inject a `stat`-like function and/or `platform`, and a fake "attribute reader" for the Windows branch, so placeholders are simulated deterministically.
- `ledger.ts` — real `better-sqlite3` temp DB (as `migrate.test.ts` already does), not `:memory:`, to exercise persistence.

### Simulating placeholders and partial writes cross-platform (the hard part)
- **Online-only placeholder (unit):** inject a fake `stat` returning `{ size: 12345, blocks: 0 }` -> `isNotMaterialized(..., 'darwin')` must be true; `{ size: 12345, blocks: 24 }` -> false. For Windows, inject a fake attribute-reader returning `0x400000` / `0x1000` set -> true; `0x20` (archive only) -> false.
- **`.icloud` sentinel (unit):** pass a `siblingNames` set containing `.bill.pdf.icloud` -> `bill.pdf` flagged not-ready; `iCloudSentinelTarget('.bill.pdf.icloud') === 'bill.pdf'`.
- **Partial write (integration, real fs):** open a temp file, write a chunk, and while a background timer appends more, run `isSettled` -> it must NOT settle until writing stops; then it settles. Deterministic with a controlled writer and small interval override.
- **Real-provider probe (Wave-0 / cross-OS gate, manual):** on a real Mac, right-click "Remove Download" on a test file in iCloud Drive and log `fs.statSync().blocks`; on real Windows, set a test file to "Free up space" in OneDrive and log the attribute integer. This locks A1/A2 on the actual machines. Fold into the existing 01-08 cross-OS human-verify gate context.

### Phase Requirements -> Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| ING-05 / D-12 / D-13 | Extension accept-set; junk ignored; unsupported surfaced | unit | `vitest run test/ingestion-filetype.test.ts` | Wave 0 |
| ING-04 / D-07 | Known bytes -> known SHA-256; streaming over a large temp file | unit | `vitest run test/ingestion-hash.test.ts` | Wave 0 |
| ING-04 / D-08/09 | Ledger hit -> `duplicate-excluded` (+posted date); miss -> `loaded`; pending reloads | unit (temp DB) | `vitest run test/ingestion-ledger.test.ts` | Wave 0 |
| D-10 | Two byte-identical files in one batch -> one `loaded`, one `duplicate-in-batch` | unit | `vitest run test/ingestion-scan.test.ts` | Wave 0 |
| ING-03 / D-11 (placeholder) | Simulated online-only (blocks 0 / offline attr / .icloud) -> `not-ready-skipped`, never hashed | unit (injected stat/attr) | `vitest run test/ingestion-materialization.test.ts` | Wave 0 |
| ING-03 / D-11 (partial write) | Growing file never settles until writing stops | integration (real fs) | `vitest run test/ingestion-materialization.test.ts` | Wave 0 |
| ING-01 / D-05 | Scan stamps `batchEntryDate` = local day; supported files load | unit + e2e | `vitest run test/ingestion-scan.test.ts` | Wave 0 |
| ING-02 | resolveInbox creates + persists default; chooseInbox persists chosen path | unit (temp DB) + e2e | `vitest run test/ingestion-inbox.test.ts` | Wave 0 |
| D-15 / SC4 | `ingestion:scan` rejects an untrusted sender; Zod rejects a malformed payload; channels are stable strings | unit + e2e | `npm run test:e2e` (extend `e2e/ipc-boundary`) | Extend existing |
| D-04 | Inbox is read-only: file count + mtimes unchanged after a scan | integration | `vitest run test/ingestion-scan.test.ts` | Wave 0 |

### Sampling Rate
- **Per task commit:** `npm run test:unit` (the ingestion unit specs; ~seconds).
- **Per wave merge:** `npm test` (unit + Playwright e2e, including the extended IPC-boundary spec).
- **Phase gate:** full suite green before `/gsd:verify-work`, plus the manual real-provider probe folded into the cross-OS human gate.

### Wave 0 Gaps
- [ ] `test/ingestion-filetype.test.ts` — ING-05, D-12, D-13
- [ ] `test/ingestion-hash.test.ts` — ING-04 (known-vector + large-file streaming)
- [ ] `test/ingestion-ledger.test.ts` — ING-04, D-08/09 (temp better-sqlite3 DB, `migration0002`)
- [ ] `test/ingestion-materialization.test.ts` — D-11 placeholder (injected) + partial-write (real fs)
- [ ] `test/ingestion-scan.test.ts` — D-10 collapse, D-05 date stamp, D-04 read-only invariant
- [ ] `test/ingestion-inbox.test.ts` — ING-02 resolve/choose/persist
- [ ] Extend `e2e/ipc-boundary.*` — the new `ingestion` channels under the sender/Zod gate
- [ ] Framework install: none (Vitest + Playwright already present)

## Security Domain

> `security_enforcement` is `true`, ASVS level 1. Included.

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V1 Architecture | yes | Trust boundary already enforced (Phase 1): all fs/db/hash in main, renderer via typed IPC only (D-15). |
| V2 Authentication | no | Local single-user desktop app; no auth in this phase. |
| V3 Session Management | no | No sessions. |
| V4 Access Control | partial | Filesystem access confined to the user-chosen inbox; scan reads inbox path from `app_settings` (not from renderer) to prevent arbitrary-path reads. |
| V5 Input Validation | yes | Zod at the IPC boundary (`ScanRequestSchema`), `assertTrustedSender` first; prepared statements for all SQL (`WHERE hash = ?`). |
| V6 Cryptography | yes (usage) | SHA-256 via Node `crypto` (not hand-rolled). Note: this is content-dedupe hashing, NOT password/secret hashing, so no salt/KDF applies. No secrets touched in this flow. |
| V12 Files & Resources | yes | Type screening; never executes a scanned file; memory-bounded streaming hash; consider a max-file-size guard to bound DoS. |

### Known Threat Patterns for this stack (Electron main + local filesystem)

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Command injection via a crafted inbox path/filename when reading Windows attributes | Tampering / EoP | `execFile`/`spawn` with an args array and `shell: false`; never `exec` a concatenated string (Pitfall 4). Batch one call per scan. |
| SQL injection via a scanned filename/hash into the ledger | Tampering | Prepared statements only (`?` binds); no string interpolation (matches Phase 1 T-01-06). |
| Path traversal / arbitrary-file read via a renderer-supplied path | Tampering / Info-disclosure | `scan()` takes no path from the renderer; it reads `inbox_path` from `app_settings`. `chooseInbox` gets its path from the OS dialog, not renderer input. |
| Forced download of cloud placeholders (unexpected data egress/cost, silent behavior) | (Availability / user-trust) | Metadata-first screening; never open placeholder bytes (D-11, Section 1). |
| DoS via a huge or adversarial file | Denial of Service | Streaming hash bounds memory; optional configurable max-file-size -> surface as skipped rather than hang. |
| Untrusted renderer invoking `ingestion:*` | Spoofing / EoP | `assertTrustedSender(event)` first in every handler (existing Phase 1 control); preload exposes only named methods, never raw `ipcRenderer`. |
| Symlink in the inbox pointing outside it | Tampering | Use `fs.lstat`/`Dirent.isFile()` and skip symlinks (`isSymbolicLink()`); do not follow links out of the inbox. |

No new secrets, tokens, or network calls are introduced in Phase 2, so the Phase 1 secret-store and network-lockdown controls are untouched.

## Sources

### Primary (HIGH confidence)
- Node.js docs — `crypto` (streaming `createHash`), `fs` (`stat`, `createReadStream`, `readdir`), `child_process` (`execFile`). nodejs.org/api/crypto, /api/fs, /api/child_process.
- Electron docs — `dialog.showOpenDialog` (Promise, `openDirectory`/`createDirectory`, `{canceled, filePaths}`) and `app.getPath('documents')`. electronjs.org/docs/latest/api/dialog, /api/app.
- Microsoft Learn — "Query and set Files On-Demand states in Windows" (P/U pinned/unpinned states); "Placeholder files" compatibility cookbook (CreateFile/ReadFile recall in non-NO_RECALL context). learn.microsoft.com.
- Existing repo seams (read this session): `src/shared/ipc-contract.ts`, `src/main/ipc/settings.ts`, `src/shared/schemas.ts`, `src/main/db/migrate.ts`, `src/main/db/migrations/0001_init.ts`, `src/main/ipc/register.ts`, `src/main/ipc/trusted-sender.ts`, `src/main/db/connection.ts`, `src/preload/index.ts`, `src/main/index.ts`, `test/migrate.test.ts`, `test/ipc-contract.test.ts`, `vitest.config.ts`, `playwright.config.ts`, `package.json`. [VERIFIED: codebase]

### Secondary (MEDIUM confidence, verified against an authoritative source)
- macOS dataless files / `SF_DATALESS` / no-extents behavior: mjtsai.com "iCloud Drive Switches to Dataless Files", eclecticlight.co "How iCloud Drive works in macOS Sonoma" and "Explainer: File Provider and cloud services" (cross-checked with Apple File Provider concepts).
- Windows online-only attribute detection (`FILE_ATTRIBUTE_OFFLINE`, `-band [FileAttributes]::Offline`, check does not trigger download): codegenes.net, techtarget.com "OneDrive File Attributes Uncovered".
- HEIC/HEIF `ftyp`-at-offset-4 brands (heic/heix/hevc/hevx/mif1/msf1), PDF/JPEG/PNG signatures: filesignature.org/heic, loc.gov FDD000526, nokiatech HEIF technical info.
- Node/libuv `blocks`/`blksize` on Windows recently made non-`undefined` (node#26056) — used to justify NOT trusting `blocks` on Windows.

### Tertiary (LOW confidence, flagged for the Wave-0 probe)
- Generic "`blocks === 0 && size > 0` detects OneDrive placeholders" claim surfaced in search summaries — treat as a starting hypothesis for Windows; confirmed reliable only for macOS APFS. Verify empirically (A1/A2).
- fish-shell#8399 (recursive glob materializes dataless macOS directories) — used only to justify the no-recursion rule; the exact triggering syscall is not pinned.

## Metadata

**Confidence breakdown:**
- Standard stack / no-new-dep: HIGH — verified against installed `package.json` and built-in Node/Electron APIs.
- IPC channel group + migration + dedupe design: HIGH — direct mirror of verified Phase 1 seams; the only judgment call (Design A vs B) is flagged.
- macOS placeholder detection: MEDIUM-HIGH — mechanism well-sourced; exact `blocks` value needs a real-Mac probe.
- Windows placeholder detection: MEDIUM-HIGH on attributes (well-sourced, non-triggering), LOW on pure-Node `blocks`; needs a real-Windows+OneDrive probe.
- Stability-poll durations: MEDIUM — sound heuristic, tunable, not a hard spec.
- File-type classification / security: HIGH.

**Research date:** 2026-07-24
**Valid until:** ~2026-08-23 (30 days; stable domain, but re-verify macOS placeholder behavior if the target Mac's OS major version changes, and re-run the Wave-0 probe on the actual deployment machines regardless).
