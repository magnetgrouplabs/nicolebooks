import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

// Plan 01-03: load the Magnet Group brand theme (BRAND-01 seam). This activates the
// Tailwind v4 @theme, both light/dark palettes, and the locally bundled fonts so every
// UI phase inherits the tokens.
import './globals.css'

// Plan 01-06: the real branded App shell (Header + Sidebar + swappable content region).
import App from './App'

// Plan 01-06 Task 1: the OS light/dark mirror (RESEARCH Pitfall 4, no FOUC).
//
// The main process keeps the window hidden (show:false) until ready-to-show, and here we
// resolve the OS color scheme and toggle the `dark` class on the documentElement BEFORE the
// first React render, so the correct palette is in place before the first meaningful paint.
// We then subscribe to window.api.theme.onChange so the renderer follows live OS appearance
// changes. window.api.theme.get() is an async IPC call, so we await it before rendering
// rather than painting light-first and correcting after (which would flash).
async function boot(): Promise<void> {
  const rootElement = document.getElementById('root')
  if (!rootElement) return

  // Apply the base typography (DM Sans body font, antialiasing) on the render root.
  rootElement.classList.add('font-sans', 'antialiased')

  try {
    const isDark = await window.api.theme.get()
    document.documentElement.classList.toggle('dark', isDark)
  } catch {
    // If the theme bridge is unreachable, fall back to the light palette (no dark class)
    // rather than blocking the launch.
  }

  // Follow live OS appearance changes for the lifetime of the window.
  window.api.theme.onChange((isDark) => {
    document.documentElement.classList.toggle('dark', isDark)
  })

  createRoot(rootElement).render(
    <StrictMode>
      <App />
    </StrictMode>
  )
}

void boot()
