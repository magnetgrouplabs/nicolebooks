---
status: partial
phase: 02-ingestion-and-dedupe
source: [02-VERIFICATION.md]
started: "2026-07-24T17:00:06Z"
updated: "2026-07-24T17:00:06Z"
---

## Current Test

[awaiting human testing]

## Tests

### 1. macOS real iCloud eviction probe
expected: On a real Mac, evict a test file from iCloud Drive (right-click > Remove Download), drop it in the configured NicoleBooks inbox, click Scan now. The file appears under "Not downloaded yet" in the Bills screen results, is never force-downloaded (Finder shows no re-download), and a subsequent scan after it re-materializes loads it normally.
why_human: Requires a real macOS machine with a real iCloud Drive sync client to produce a genuine dataless APFS file (size>0, blocks===0). The automated suite only proves this against an injected stat() double (test/ingestion-materialization.test.ts); it cannot fabricate a real cloud-eviction state in this environment.
result: [pending]

### 2. Windows real OneDrive offline-attribute probe
expected: On a real Windows machine with OneDrive, set a test file to "Free up space" (cloud-only/OFFLINE), drop it in the configured NicoleBooks inbox, click Scan now. The file appears under "Not downloaded yet"; the Windows attribute read (FILE_ATTRIBUTE_OFFLINE / RECALL_ON_DATA_ACCESS / RECALL_ON_OPEN) correctly identifies it without opening its bytes (no recall/download triggered).
why_human: Requires a real Windows machine with a real OneDrive (or similar) sync client to produce genuine OFFLINE/RECALL attribute bits and to exercise the actual subprocess/attribute path. The automated suite only proves the bit-testing logic against an injected readWinFlags() double; it cannot spawn or verify against a real OneDrive placeholder in this environment.
result: [pending]

## Summary

total: 2
passed: 0
issues: 0
pending: 2
skipped: 0
blocked: 0

## Gaps
