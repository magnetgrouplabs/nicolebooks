---
status: partial
phase: 03-ai-client-and-parse-pipeline
source: [03-VERIFICATION.md]
started: 2026-07-27
updated: 2026-07-27
---

## Current Test

[awaiting human testing]

## Tests

### 1. Live end-to-end parse with a real API key
expected: With a real OpenAI-compatible key + base URL entered in Settings and a vision-capable model selected, dropping a mix of real bill documents into the inbox and pressing "Scan now" auto-parses every file. Each row shows vendor, date, total, and a suggested category; low-confidence fields are visibly flagged. A second scan of the same unchanged files parses instantly from cache and makes ZERO model calls (no new charges on the provider's usage dashboard).
result: [pending]

### 2. D-20 routing-threshold tuning against Nicole's real bill mix
expected: The Docling-style native-vs-scan gate (0.75 bitmap coverage / 0.90 invisible-OCR / 50 chars + embedded font / 50% of pages) correctly classifies the actual documents Nicole receives. Digital vendor PDFs take the cheap text path; scanned, faxed, and photographed bills route to vision. No document with junk OCR text gets sent down the native path (that is the failure this gate exists to prevent). Thresholds are research starting values and may need adjustment once real bills are seen.
result: [pending]

### 3. Visual and interaction check of the new UI surfaces
expected: The Settings AI-config section (key field, base-URL presets, Connect/Test, vision-badged model picker, use-anyway confirm) and the Bills parse-status surface (parsing N/M progress, per-file parsed / parse-failed / cached status, retry affordance, confidence flags) both render correctly in light and dark mode, match the Magnet Group brand tokens, and behave sensibly. "Scan now" is disabled while a parse is in flight.
result: [pending]

## Summary

total: 3
passed: 0
issues: 0
pending: 3
skipped: 0
blocked: 0

## Gaps
