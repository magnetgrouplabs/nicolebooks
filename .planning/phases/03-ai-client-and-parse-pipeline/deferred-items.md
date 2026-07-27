# Phase 3 — Deferred Items

Out-of-scope discoveries logged during execution. Not fixed in the owning plan; tracked here.

| # | Found in | Item | Why deferred | Suggested owner |
|---|----------|------|--------------|-----------------|
| 1 | 03-01 Task 1 | `npm run typecheck` (`tsc --build`) does not cover `test/` or `e2e/`. `tsconfig.node.json` includes only `electron.vite.config.ts` + `src/main`, `src/preload`, `src/shared`; `tsconfig.web.json` includes only `src/renderer/src`. So a type error in a spec or in `test/helpers/*` is invisible to the typecheck gate (vitest strips types without checking them). | Pre-existing since Phase 1, unrelated to this plan's changes. Adding a third project reference for `test/` + `e2e/` needs `types: ["node", "vitest/globals"]` and a Playwright `Window.api` declaration — a build-config change with blast radius beyond a foundation plan. `test/helpers/fake-openai-client.ts` was instead verified with a standalone strict `tsc --noEmit` run (exit 0). | A dedicated tooling/quality plan, or Phase 8 packaging hardening |
