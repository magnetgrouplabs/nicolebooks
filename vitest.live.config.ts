import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

// The LIVE unit runner, deliberately separate from vitest.config.ts.
//
// WHY A SECOND CONFIG RATHER THAN A TAG, the same reasoning as playwright.live.config.ts: the
// default runner's include is 'test/**/*.test.ts', so nothing under live/ is visible to
// `npm run test:unit` or to CI by construction, not by a flag someone has to remember. The specs
// here make REAL calls to a paid vision model with a key that exists only on the builder's machine.
//
// Two gates, both required:
//   1. this config, which only `npm run test:live` references
//   2. LIVE_AI=1, checked inside the spec, so running the config by hand still skips rather than
//      failing on a machine with no credentials file
//
// The timeout is large because it has to be: four documents, two of them image-only and therefore
// paying the D-22 second cross-call, all through a real vision model.

export default defineConfig({
  resolve: {
    alias: {
      '@': resolve('src/renderer/src'),
      '@shared': resolve('src/shared')
    }
  },
  test: {
    include: ['live/**/*.live.test.ts'],
    environment: 'node',
    testTimeout: 10 * 60_000,
    hookTimeout: 60_000,
    // Sequential: these are paid network calls, not CPU work, and interleaved output would make
    // the revalidation table unreadable.
    fileParallelism: false,
    passWithNoTests: true
  }
})
