import { defineConfig } from 'vitest/config'

// Unit runner scoped to main-process modules. Later plans (01-02, 01-04) drop specs
// into test/ (the migration runner, the secret-store with a mocked safeStorage, and the
// Zod IPC schemas). No watch mode; the feedback latency budget is 60 seconds.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // No unit specs exist yet (they arrive in 01-02 and 01-04); do not fail an empty run.
    passWithNoTests: true
  }
})
