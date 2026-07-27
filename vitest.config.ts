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
    // No unit specs exist yet (they arrive in 01-02 and 01-04); do not fail an empty run.
    passWithNoTests: true
  }
})
