import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

// Unit runner scoped to main-process modules. Later plans (01-02, 01-04) drop specs
// into test/ (the migration runner, the secret-store with a mocked safeStorage, and the
// Zod IPC schemas). No watch mode; the feedback latency budget is 60 seconds.
//
// The two renderer aliases mirror electron.vite.config.ts's renderer block. They exist so a spec
// can import a renderer component and render it with react-dom/server (no DOM required, so the
// node environment stays) to assert what the user actually SEES — which is the only layer where
// a finding like "the row displays a value without its validation flag" is provable.
export default defineConfig({
  resolve: {
    alias: {
      '@': resolve('src/renderer/src'),
      '@shared': resolve('src/shared')
    }
  },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // Vitest's 5 second default is calibrated for pure in-memory unit tests. A good part of this
    // suite is not that: specs open a real SQLite file, run the migrations, and drive whole
    // send/undo batches through it. Locally the slowest of them finishes in about a second, but a
    // shared CI runner executing 69 files across parallel workers can stretch that past 5 seconds
    // and fail a test that is not actually broken (release run 30314357818, posting-undo). The
    // budget below is generous enough that only a genuine hang trips it.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // No unit specs exist yet (they arrive in 01-02 and 01-04); do not fail an empty run.
    passWithNoTests: true
  }
})
