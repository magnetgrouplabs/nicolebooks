// Plan 01-06 Task 2: the Bills placeholder screen (default landing destination, D-09).
//
// Renders the empty state with the verbatim UI-SPEC copy and the Receipt icon. Real bill
// import and review arrive in a later phase.

import { Receipt } from 'lucide-react'

import { EmptyState } from '../components/EmptyState'

export function BillsScreen(): React.JSX.Element {
  return (
    <EmptyState
      icon={Receipt}
      heading="No bills to review"
      body="Bills you import will appear here for review before they post to QuickBooks."
    />
  )
}
