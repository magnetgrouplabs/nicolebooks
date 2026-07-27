// Plan 01-06 Task 2: the permanent Secret store health indicator (D-11, SC2 + SC4 proof).
//
// This is not a throwaway: it is the permanent, user-visible proof that the full
// renderer -> window.api -> IPC -> main -> OS keychain round trip works. On mount it stores a
// non-sensitive canary through window.api.secrets.set then reads it back with
// window.api.secrets.get; the healthy state renders ONLY when the read returns the exact canary
// value. Any thrown error or a non-matching read renders the unavailable state. The raw secret
// value is never rendered or logged; only the ok/unavailable outcome surfaces (threat T-01-05).
//
// All status colors come from semantic theme classes (success / destructive / muted-foreground),
// never hardcoded hex. Copy is verbatim from the UI-SPEC Copywriting Contract.

import { useEffect, useState } from 'react'

import { ShieldAlert, ShieldCheck } from 'lucide-react'

import { cn } from '@/lib/utils'

type HealthState = 'checking' | 'ok' | 'unavailable'

const CANARY_KEY = 'canary'
const CANARY_VALUE = 'ok'

export function HealthIndicator(): React.JSX.Element {
  const [state, setState] = useState<HealthState>('checking')

  useEffect(() => {
    let cancelled = false

    async function check(): Promise<void> {
      try {
        await window.api.secrets.set(CANARY_KEY, CANARY_VALUE)
        const value = await window.api.secrets.get(CANARY_KEY)
        if (cancelled) return
        setState(value === CANARY_VALUE ? 'ok' : 'unavailable')
      } catch {
        if (!cancelled) setState('unavailable')
      }
    }

    void check()
    return () => {
      cancelled = true
    }
  }, [])

  const isOk = state === 'ok'
  const isUnavailable = state === 'unavailable'
  const Icon = isUnavailable ? ShieldAlert : ShieldCheck

  const iconColor = isOk
    ? 'text-success'
    : isUnavailable
      ? 'text-destructive'
      : 'text-muted-foreground'

  const label = isOk
    ? 'Secret store: OK'
    : isUnavailable
      ? 'Secret store: unavailable'
      : 'Checking secret store'

  // Supporting line shows only once the round trip resolves; the transient checking
  // state carries no supporting copy so no non-contract status line is ever shown.
  const supporting = isOk
    ? "Your machine's secure keychain is available and working."
    : isUnavailable
      ? "This machine's secure keychain could not be reached, so credentials cannot be stored yet. Restart NicoleBooks; if it keeps happening, this machine cannot store secrets securely."
      : null

  return (
    <div className="rounded-lg border border-border bg-card p-4 shadow-raised">
      <div className="flex items-center gap-2.5">
        <Icon className={cn('size-4 shrink-0', iconColor)} aria-hidden="true" />
        <span className="font-sans text-sm font-semibold text-card-foreground">{label}</span>
      </div>
      {supporting && (
        <p className="mt-1.5 pl-6.5 font-sans text-sm font-normal text-muted-foreground">
          {supporting}
        </p>
      )}
    </div>
  )
}
