# Finish Sprint (2026-07-27) - GSD bypassed by Anthony's instruction

Fable plans and reviews; Opus agents execute. Goal: finished app + installers on
github.com/magnetgrouplabs/nicolebooks (public), ready for real use.

## Scope changes vs original roadmap

1. Ingestion UX: native file picker ("Add files") + phone upload via QR code to an
   embedded LAN-only HTTP server. Both feed the existing managed inbox + scan pipeline.
   The folder is now an internal detail, not the primary UX.
2. Design overhaul at the end: vibe-check audit, corporate look, larger header logo.
   Logo/icon image assets must never be edited.
3. Ship unsigned installers (NSIS + DMG/zip) via GitHub Actions to public Releases.

## Waves

- Wave 0 (done): creds validated (AI key, QBO sandbox realm 9341457604445280,
  tokens in .credentials/qbo-tokens.json), repo public, history email-scrubbed.
- Wave 1 (parallel): SEAMS (IPC contract + deps, main checkout) + PACKAGING (worktree).
- Wave 2 (parallel, after SEAMS merge): QBO-CONNECT, INGEST-UX, POSTING-ENGINE
  (worktrees) + LIVE-SEED (sandbox seeding + test corpus, no src changes).
- Wave 3 (parallel): RECON + REVIEW-UI (worktrees).
- Wave 4: E2E-INTEGRATION (live sandbox full flow) + PROD-MODE (env picker, production
  OAuth redirect via GitHub Pages forwarder, Anthony's own questionnaire step documented).
- Wave 5: DESIGN (vibe-check + corporate pass over final surfaces).
- Wave 6: RELEASE (README rewrite per Anthony's 2026-07-27 feedback: upload from computer
  or phone, no folder framing, Settings credential walkthrough, live-company section;
  draft needs Anthony's approval before it lands on the public repo; then the release
  tag, CI installers, GitHub release, local NSIS smoke test).
- Version format (Anthony, 2026-07-27): YY.M.version. First release is 26.7.1, tag
  v26.7.1. Valid semver, so electron-updater comparisons still work.

Fable merges worktree branches and reviews between waves. Suite must stay green
(419 unit tests + playwright e2e at wave 0; grows every wave).

## Fixed integration contracts

- IPC channel groups (defined by SEAMS in src/shared/ipc-contract.ts): qbo, recon,
  posting, upload, plus ingestion:pick-files. Downstream agents implement handler
  bodies in src/main/ipc/{qbo,recon,posting,upload}.ts and may refine their group's
  schemas, but channel names are fixed.
- Migration numbers: 0004 = qbo reference cache (QBO-CONNECT), 0005 = posting/audit
  (POSTING-ENGINE). No other agent adds migrations without Fable assigning a number.
- OAuth loopback: http://localhost:8734/oauth/callback (registered in Intuit portal).
- qbo:create-vendor channel (assigned 2026-07-27, E2E-INTEGRATION implements): explicit
  user-confirmed vendor creation from the review table's unknown-vendor state, prefilled
  with the editable parsed name. Silent creation stays forbidden (RECON-03).
- QBO tokens for live testing: .credentials/qbo-tokens.json. Refresh rotates the
  refresh token: re-read the file before refreshing, write back immediately after.
  LIVE-SEED never refreshes (works within the 1h access token window).
- Deps preinstalled by SEAMS: express, multer, qrcode, intuit-oauth,
  @tanstack/react-table (runtime); pdf-lib (dev). PACKAGING adds electron-builder
  (dev) + electron-updater (runtime).

## Rules for every agent

- Follow existing patterns: sender-gated IPC (assertTrustedSender), Zod-gated
  payloads, parse(raw ?? {}) for payload-free channels, secrets never in SQLite or
  logs, renderer never touches fs/db/network directly.
- No em dashes or en dashes in ANY user-facing text: UI copy, README, release
  notes, error messages. Restructure with commas/colons/parentheses instead.
- Do not edit logo/icon image assets (src/renderer/src/assets, build/icon.*).
- Do not read or modify .credentials/ unless the task explicitly grants it.
- Tests for new logic; whole suite green before finishing; conventional commits.
