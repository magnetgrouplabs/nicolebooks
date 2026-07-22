// Plan 01-06 Task 2: the Settings screen.
//
// Hosts the "Secret store" section: a section label, the permanent HealthIndicator (the SC2 +
// SC4 round-trip proof, the primary anchor on this screen per UI-SPEC), and a muted note that
// the connection and model settings arrive later. Copy is verbatim from the UI-SPEC.

import { HealthIndicator } from '../components/HealthIndicator'

export function SettingsScreen(): React.JSX.Element {
  return (
    <div className="flex flex-col gap-4">
      <h2 className="font-sans text-sm font-semibold text-muted-foreground">Secret store</h2>
      <HealthIndicator />
      <p className="font-sans text-sm font-normal text-muted-foreground">
        Connection and model settings will appear here in a later update.
      </p>
    </div>
  )
}
