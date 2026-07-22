import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Three-artifact build (RESEARCH Pattern 1):
//  - main:    externalize dependencies so native/npm deps (better-sqlite3) stay external.
//  - preload: single bundled CJS file, sandbox-safe (no externalize, electron built-ins only).
//  - renderer: React plus Tailwind v4, with @ and @shared path aliases.
export default defineConfig({
  main: {
    // Externalize native/npm deps so better-sqlite3 is NOT bundled (it cannot be).
    plugins: [externalizeDepsPlugin()]
  },
  preload: {
    // Preload runs under sandbox: it must be a single bundled CJS file.
    // Do NOT externalize deps here; keep the preload minimal (electron built-ins only).
    build: { rollupOptions: { output: { format: 'cjs' } } }
  },
  renderer: {
    resolve: {
      alias: {
        '@': resolve('src/renderer/src'),
        '@shared': resolve('src/shared')
      }
    },
    plugins: [react(), tailwindcss()]
  }
})
