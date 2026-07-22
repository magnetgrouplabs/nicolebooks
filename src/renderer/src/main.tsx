import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

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
