import { resolve } from 'node:path'
import { defineConfig, _electron } from '@playwright/test'

// The LIVE drill config, deliberately separate from playwright.config.ts.
//
// WHY A SECOND CONFIG RATHER THAN A TAG. The default config's testDir is './e2e', so e2e-live/ is
// invisible to `npm run test:e2e` and to CI by construction, not by a flag someone has to remember.
// These specs make REAL OpenAI vision calls and REAL QuickBooks sandbox writes against credentials
// that live only on the builder's machine: a CI run that picked them up would fail, and a CI run
// that somehow had the credentials would spend money and create entities nobody asked for.
//
// Two gates, both required:
//   1. this config, which nothing else references
//   2. LIVE_QBO=1, checked inside the spec, so even running this config by hand skips rather than
//      half-executing against a company that may not be seeded
//
// Timeouts are large because they have to be: nine documents through a vision model, then a batch
// posted one entry at a time, then read back.

export const MAIN_ENTRY = resolve(__dirname, 'out', 'main', 'index.js')

export { _electron }

export default defineConfig({
  testDir: './e2e-live',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: 'list',
  // One drill, several sequential steps, real network in every one of them.
  timeout: 15 * 60_000
})
