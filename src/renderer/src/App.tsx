// Plan 01-06 Task 1: the reusable app shell (UI-SPEC Layout Frame, D-07 through D-09).
//
// A CSS grid frame: rows 56px (header) then 1fr, columns 280px (sidebar) then 1fr. The Header
// spans both columns and sits above the content at z-index 20; the Sidebar occupies the left
// column below the header; the content region (24px padding, dominant surface background) swaps
// between the three placeholder screens. Active-destination state lives here and defaults to
// Bills (D-09). The whole tree is wrapped in TooltipProvider because the base-nova primitives
// resolve Base UI (@base-ui/react), whose tooltip primitive requires the provider (01-03).
//
// Task 1 renders the branded content inline so the shell builds and runs standalone; Task 2
// extracts the dedicated screen components (Bills, History, Settings + the HealthIndicator
// round trip) and rewires the content switch to render them.

import { useState } from 'react'

import { History, Receipt } from 'lucide-react'

import { EmptyState } from './components/EmptyState'
import { Header } from './components/Header'
import { Sidebar, type Destination } from './components/Sidebar'
import { TooltipProvider } from '@/components/ui/tooltip'

function renderContent(active: Destination): React.JSX.Element {
  switch (active) {
    case 'bills':
      return (
        <EmptyState
          icon={Receipt}
          heading="No bills to review"
          body="Bills you import will appear here for review before they post to QuickBooks."
        />
      )
    case 'history':
      return (
        <EmptyState
          icon={History}
          heading="No history yet"
          body="Batches you send to QuickBooks will be listed here, along with the entries in each."
        />
      )
    case 'settings':
      return (
        <p className="text-sm text-muted-foreground">
          Connection and model settings will appear here in a later update.
        </p>
      )
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
