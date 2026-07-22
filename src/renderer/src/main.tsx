import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
// Plan 01-03: load the Magnet Group brand theme (BRAND-01 seam). This activates the
// Tailwind v4 @theme, both light/dark palettes, and the locally bundled fonts so every
// UI phase (starting with the shell in 01-06) inherits the tokens. The full shell wiring
// and the OS dark-class mirror land in 01-06; this import is only the stylesheet seam.
import './globals.css'

// Plan 01-01: minimal placeholder renderer. The real branded App shell (Header plus
// Sidebar plus content region) arrives in plan 01-06; the Magnet Group brand theme in
// plan 01-03. For now this renders only the NicoleBooks wordmark so the launch smoke
// test in e2e/launch.spec.ts can confirm the window boots and is not white-screening.
function Placeholder() {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100vh',
        margin: 0,
        fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
        fontSize: '20px',
        fontWeight: 600
      }}
    >
      NicoleBooks
    </div>
  )
}

const rootElement = document.getElementById('root')
if (rootElement) {
  createRoot(rootElement).render(
    <StrictMode>
      <Placeholder />
    </StrictMode>
  )
}
