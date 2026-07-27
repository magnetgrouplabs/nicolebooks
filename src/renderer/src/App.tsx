// Plan 01-06: the reusable app shell (UI-SPEC Layout Frame, D-07 through D-09).
//
// A CSS grid frame: rows 56px (header) then 1fr, columns 280px (sidebar) then 1fr. The Header
// spans both columns and sits above the content at z-index 20; the Sidebar occupies the left
// column below the header; the content region (24px padding, dominant surface background) swaps
// between the three placeholder screens. Active-destination state lives here and defaults to
// Bills (D-09). The whole tree is wrapped in TooltipProvider because the base-nova primitives
// resolve Base UI (@base-ui/react), whose tooltip primitive requires the provider (01-03).

import { useState } from 'react'

import { Header } from './components/Header'
import { Sidebar, type Destination } from './components/Sidebar'
import { BillsScreen } from './screens/BillsScreen'
import { HistoryScreen } from './screens/HistoryScreen'
import { SettingsScreen } from './screens/SettingsScreen'
import { TooltipProvider } from '@/components/ui/tooltip'

// Phase 6: the Bills screen can send the user onward once a batch settles, so the strip that says
// "3 of 5 entered" can point at the receipt instead of describing where to find it. Navigation
// state stays here, where it already lived; the screen just gets a way to ask.
function renderContent(
  active: Destination,
  onNavigate: (destination: Destination) => void
): React.JSX.Element {
  switch (active) {
    case 'bills':
      return <BillsScreen onNavigate={onNavigate} />
    case 'history':
      return <HistoryScreen />
    case 'settings':
      return <SettingsScreen />
  }
}

function App(): React.JSX.Element {
  const [active, setActive] = useState<Destination>('bills')

  return (
    <TooltipProvider>
      <div className="grid h-screen grid-cols-[280px_1fr] grid-rows-[56px_1fr] bg-background text-foreground">
        <Header />
        <Sidebar active={active} onSelect={setActive} />
        <main className="col-start-2 row-start-2 overflow-auto bg-background p-6">
          {renderContent(active, setActive)}
        </main>
      </div>
    </TooltipProvider>
  )
}

export default App
