// Plan 01-06 Task 2: the History placeholder screen.
//
// Renders the empty state with the verbatim UI-SPEC copy and the History icon. The real
// batch history arrives in a later phase.

import { History } from 'lucide-react'

import { EmptyState } from '../components/EmptyState'

export function HistoryScreen(): React.JSX.Element {
  return (
    <EmptyState
      icon={History}
      heading="No history yet"
      body="Batches you send to QuickBooks will be listed here, along with the entries in each."
    />
  )
}
