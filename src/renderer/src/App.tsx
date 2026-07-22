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

function renderContent(active: Destination): React.JSX.Element {
  switch (active) {
    case 'bills':
      return <BillsScreen />
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
          {renderContent(active)}
        </main>
      </div>
    </TooltipProvider>
  )
}

export default App
