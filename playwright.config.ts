import { resolve } from 'node:path'
import { defineConfig, _electron } from '@playwright/test'

// The built Electron main entry that every e2e spec boots via _electron.launch({ args: [MAIN_ENTRY] }).
// `npm run build` must run first so out/main/index.js and out/renderer/index.html exist.
export const MAIN_ENTRY = resolve(__dirname, 'out', 'main', 'index.js')

// Re-exported for spec convenience so specs launch the app through the same Electron handle.
export { _electron }

// No watch flags; feedback latency budget is 60 seconds.
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: 'list',
  timeout: 30_000
})
