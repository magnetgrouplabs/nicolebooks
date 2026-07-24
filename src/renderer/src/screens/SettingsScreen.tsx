// Plan 01-06 Task 2 + plan 02-01 Task 4: the Settings screen.
//
// Two sections in one section-stack:
//   1. "Secret store" (unchanged): the permanent HealthIndicator (SC2 + SC4 round-trip proof)
//      and the muted note. Copy is verbatim from the UI-SPEC.
//   2. "Inbox folder" (02-01): the D-01 "configure once, repoint anywhere" home for the inbox
//      path. On mount it shows the resolved inbox path; a "Change inbox folder" button opens the
//      native OS folder picker (window.api.ingestion.chooseInbox) and, on a non-canceled result,
//      updates the displayed path (which the next Bills scan reads). Cancel is a no-op.
//
// The renderer performs zero direct fs/db access; all resolve/choose/persist runs main-side.
// All colors are semantic theme classes (no hardcoded hex).

import { useEffect, useState } from 'react'

import { HealthIndicator } from '../components/HealthIndicator'
import { Button } from '../components/ui/button'

export function SettingsScreen(): React.JSX.Element {
  const [inboxPath, setInboxPath] = useState<string | null>(null)
  const [choosing, setChoosing] = useState(false)
  const [chooseError, setChooseError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    async function loadInbox(): Promise<void> {
      try {
        const resolved = await window.api.ingestion.resolveInbox()
        if (!cancelled) setInboxPath(resolved.path)
      } catch {
        if (!cancelled) setInboxPath(null)
      }
    }
    void loadInbox()
    return () => {
      cancelled = true
    }
  }, [])

  async function chooseInbox(): Promise<void> {
    setChoosing(true)
    setChooseError(null)
    try {
      const result = await window.api.ingestion.chooseInbox()
      // On a non-canceled result, reflect the chosen path; a canceled dialog is a no-op.
      if (!result.canceled) setInboxPath(result.path)
    } catch {
      // The picker rejected (the main handler threw before returning). Surface a plain,
      // recoverable message instead of leaving the button looking inert (same fix as CR-01).
      setChooseError('Could not open the folder picker. Please try again.')
    } finally {
      setChoosing(false)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <h2 className="font-sans text-sm font-semibold text-muted-foreground">Secret store</h2>
      <HealthIndicator />
      <p className="font-sans text-sm font-normal text-muted-foreground">
        Connection and model settings will appear here in a later update.
      </p>

      <h2 className="font-sans text-sm font-semibold text-muted-foreground">Inbox folder</h2>
      <p className="font-mono text-sm text-muted-foreground">
        {inboxPath ?? 'Locating your inbox folder...'}
      </p>
      <div>
        <Button variant="outline" disabled={choosing} onClick={() => void chooseInbox()}>
          Change inbox folder
        </Button>
      </div>
      {chooseError && (
        <p
          role="alert"
          className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 font-sans text-sm text-destructive"
        >
          {chooseError}
        </p>
      )}
    </div>
  )
}
