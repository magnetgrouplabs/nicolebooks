# Phase 2: Ingestion and Dedupe - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-07-23
**Phase:** 2-Ingestion and Dedupe
**Areas discussed:** Scan model, Date parsing, Duplicate rules, Edge-case files

---

## Scan model

### Q1 — When Nicole runs a scan, what does she point the app at?

| Option | Description | Selected |
|--------|-------------|----------|
| One date folder per scan | Pick a single folder named for the entry date; scan just it | |
| Parent inbox, many date subfolders | Set a root inbox; scan all date-named subfolders at once | |
| Auto-detect either | If folder name is a date scan it, else scan its date subfolders | |

**User's choice:** Free-text reframe. Anthony rejected the whole date-named-folder premise: one flat inbox to dump bills in (no date subfolders on input), entry date driven by processing date + the bill's own date, and the app creating dated subfolders on the OUTPUT side after processing. Asked for a better name than "to be processed."

**Notes:** This reframing removed the folder-name-as-date mechanism (ING-01/ING-03) and introduced an output-archive concept. Follow-ups below resolved the buildable shape.

### Q2 — With no date-named input folder, what determines a bill's entry date?

| Option | Description | Selected |
|--------|-------------|----------|
| Bill's own date, fallback to processing date | Use printed date (Phase 3 parse), fall back to scan day; drops folder-name parsing | |
| Processing date only | Entry date = day of scan; editable in review | ✓ |
| Keep a folder-name date too | Flat inbox but still honor a date in the name | |

**User's choice:** Processing date only.

**Notes:** Flagged that "the date on the bill" requires parsing (Phase 3), so Phase 2 cannot finalize an entry date from bill content. Entry date = processing date, editable per row in Phase 6.

### Q3 — The "move each processed bill into a Processed/dated subfolder" idea — when, and is it Phase 2?

| Option | Description | Selected |
|--------|-------------|----------|
| Defer the move to Phase 7, after posting | A file in Processed means it is genuinely in QuickBooks | ✓ |
| Move right after import, in Phase 2/3 | Empties inbox fast but "Processed" holds un-sent bills | |
| Do not auto-move files at all | Track state in-app; dedupe already prevents re-processing | |

**User's choice:** Defer the move to Phase 7, after posting.

### Q4 — How does Nicole set up and trigger the inbox?

| Option | Description | Selected |
|--------|-------------|----------|
| Configure once in Settings, "Scan now" on Bills | App creates a default inbox, repointable; scan button on Bills | ✓ |
| Pick the folder every scan | "Choose folder and scan"; nothing persisted | |
| Configure once, but she creates the folder herself | Set path in Settings; app does not auto-create | |

**User's choice:** Configure once in Settings, "Scan now" on Bills.

### Q5 — What should the inbox folder be named?

| Option | Description | Selected |
|--------|-------------|----------|
| New Bills | Clean, descriptive | |
| Drop Bills Here | Most self-explanatory, reads like an instruction | |
| Inbox | Short, familiar; pairs with a Posted/Archive output folder | ✓ |

**User's choice:** Inbox.

---

## Date parsing

Dissolved by the Scan-model reframe. With a flat inbox and processing-date entry dates, there is no folder-name date to parse and no unparseable-date prompt. ING-03 / Success Criterion 2 are dropped (flagged for a requirements/roadmap update).

---

## Duplicate rules

### Q1 — A file counts as an "already-processed" duplicate to skip when...

| Option | Description | Selected |
|--------|-------------|----------|
| It was already sent to QuickBooks | Ledger marks hash "done" at post time (Phase 7); Phase 2 builds table + check | ✓ |
| It was already loaded in any prior scan | Hash recorded at first scan; re-scanning a pending inbox flags everything | |
| Only within the current scan | Catches copies in one batch, forgets across runs | |

**User's choice:** It was already sent to QuickBooks.

**Notes:** Boundary set: exact-file (SHA-256) only; content near-dupes are Phase 6 (REVIEW-08). Within-scan identical copies still collapsed regardless of ledger.

### Q2 — When a scan catches a duplicate, what does Nicole see?

| Option | Description | Selected |
|--------|-------------|----------|
| Flagged and excluded by default, with "include anyway" | Marked "Already entered on <date>", left out of batch, one-click override | ✓ |
| Silently omitted from the list | Cleanest view but no signal and no forced re-entry | |
| Shown normally, just a warning icon, included by default | Least friction, easiest to double-enter | |

**User's choice:** Flagged and excluded by default, with "include anyway".

---

## Edge-case files

### Q1 — How should the scan handle a file not fully landed on disk (cloud placeholder / partial write)?

| Option | Description | Selected |
|--------|-------------|----------|
| Wait briefly, then flag-and-skip if still not local | Settle window, then include; online-only placeholders flagged "not downloaded yet" and skipped; no force-download | ✓ |
| Skip not-ready files silently | Process what is ready, no signal on the rest | |
| Force-download online-only files, then process | Provider-specific, slow, fragile | |

**User's choice:** Wait briefly, then flag-and-skip if still not local.

### Q2 — What happens to files in the inbox that are not a supported bill format?

| Option | Description | Selected |
|--------|-------------|----------|
| Ignore them, but show a "skipped" summary | Load supported types only; "N files skipped (unsupported)" with names | ✓ |
| Silently ignore anything unsupported | Cleanest, but a mis-saved bill vanishes | |
| Flag each unsupported file as an error needing attention | Maximally visible, noisy | |

**User's choice:** Ignore them, but show a "skipped" summary.

**Notes:** OS junk (`.DS_Store`, `Thumbs.db`, dotfiles) silently ignored, not counted in the skipped summary. Supported set: text/scanned PDF, JPEG, PNG, HEIC.

---

## Claude's Discretion

- IPC channel names/shapes for the scan/dedupe group (follow Phase 1 conventions).
- Dedupe-ledger schema and how Phase 7's "mark sent" write references it.
- File-stability wait strategy and cross-platform placeholder detection (Windows offline/recall attributes vs macOS `.icloud`/dataless files) and durations.
- HEIC handled as type-recognition only in Phase 2; decode is Phase 3.
- Minimal Bills-screen results UI styling; empty/all-duplicate/all-skipped states.

## Deferred Ideas

- App-created dated-subfolder archive after posting (Phase 7); pairs with the `Inbox` name.
- Requirements/roadmap revision (ACTION NEEDED): drop ING-03 + SC2, rewrite ING-01 + SC1, entry date = processing date — else Phase 2 verification fails against removed criteria.
- Background auto-watcher (already V2-03) — not this phase; scan stays manual.

## Post-scan results UI (offered, resolved by assumption)

Anthony chose "Ready for context" and accepted the working assumption: Phase 2 shows a minimal loaded-files list with per-file status + a one-line scan summary; the rich editable review table stays in Phase 6.
