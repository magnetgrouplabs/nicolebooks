// Plan 01-06 Task 1: the branded top bar (UI-SPEC Layout Frame + Copywriting Contract).
// Quick task 260727-k05: the plain text wordmark is replaced by the real NicoleBooks logo.
//
// Structural contract: full width, 56px tall (the grid row in App.tsx), structural radius 0
// (never rounded), sits above content at z-index 20 (tokens.json elevation.nav = 20), on the
// secondary surface. Left side carries the NicoleBooks logo lockup (crimson stiletto over
// stacked pages, then the wordmark). Right side is the neutral connection-status slot: a filled
// neutral dot plus the label "Not connected", a Phase 1 placeholder that Phase 4 replaces with
// real QuickBooks health. All colors come from semantic theme classes; no hardcoded hex.
//
// Why the PNG and not the SVG: the supplied SVG is not usable. It carries no @font-face at all
// (0 font faces load in Chromium), yet its wordmark is a live <text> element set in the
// commercial "TT Norms Pro Trl Expanded" trial face. That face happens to be installed on the
// build machine, so the SVG looks right here and silently falls back to a system font on the
// end user's machine. The SVG is also a 500x500 square that still contains legacy raster layers
// (two base64 <image> payloads of an older "Bookkeeping" mark) stacked on top of the current
// artwork, so it renders as overlapping logos at any size. The PNG is the flattened, correct
// lockup. See the quick-task summary for the render evidence.

import { useEffect, useState } from 'react'

import { Circle } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import logoUrl from '@/assets/nicolebooks-logo-full.png'
import type { QboStatus } from '@shared/ipc-contract'

// Intrinsic size of the lockup, declared so the browser reserves the right box before the
// image decodes and the 56px row never reflows.
const LOGO_INTRINSIC_WIDTH = 1931
const LOGO_INTRINSIC_HEIGHT = 639

/**
 * What the connection slot says, and how loudly.
 *
 * Pure and exported, so the wording is provable without a DOM.
 *
 * THE BUG THIS REPLACES. The slot was a Phase 1 placeholder that read "Not connected" always, and
 * nothing ever replaced it. The live drill screenshotted the app posting eight entries into a
 * QuickBooks company with "Not connected" sitting in the top right of the same window. For a
 * non-technical user that is worse than no indicator: the one always-visible piece of status in the
 * app was contradicting what the app was doing.
 *
 * The company NAME is the useful fact when connected, because the thing a person needs to be sure
 * of before sending money entries is WHICH set of books they are about to touch.
 *
 * 'expired' says "Reconnect needed" rather than "Not connected", matching the Settings card: the
 * fix is one click on a button that reopens the same consent screen, and telling somebody their
 * setup is gone would invite them to start over.
 */
export function connectionLabel(status: QboStatus | null): string {
  if (status === null) return 'Checking QuickBooks'
  if (status.state === 'connected') return status.companyName ?? 'Connected to QuickBooks'
  if (status.state === 'expired') return 'Reconnect needed'
  return 'Not connected'
}

/** The dot's colour, from semantic tokens only. Neutral while the answer is still unknown. */
export function connectionTone(status: QboStatus | null): string {
  if (status === null) return 'text-header-foreground/40'
  if (status.state === 'connected') return 'text-success'
  if (status.state === 'expired') return 'text-destructive'
  return 'text-header-foreground/40'
}

export function Header({ status: injected }: { status?: QboStatus | null } = {}): React.JSX.Element {
  // null means "not answered yet", which is a third state and not the same as disconnected.
  const [status, setStatus] = useState<QboStatus | null>(injected ?? null)

  useEffect(() => {
    // An injected status is a test or a story driving the component; do not fight it with a read.
    if (injected !== undefined) return
    let cancelled = false
    void (async () => {
      try {
        const next = await window.api.qbo.status()
        if (!cancelled) setStatus(next)
      } catch {
        // A rejection here means the app cannot answer, which is not the same as disconnected, so
        // the slot stays in its neutral checking state rather than asserting something false.
        if (!cancelled) setStatus(null)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [injected])

  // The broadcast, so connecting or disconnecting on the Settings screen updates the header without
  // a navigation. Same subscribe/dispose shape as theme.onChange.
  useEffect(() => {
    if (injected !== undefined) return
    return window.api.qbo.onStatusChanged(setStatus)
  }, [injected])

  return <HeaderChrome status={status} />
}

function HeaderChrome({ status }: { status: QboStatus | null }): React.JSX.Element {
  return (
    <header className="z-20 col-span-2 row-start-1 flex items-center justify-between rounded-none border-b border-border bg-header px-6 text-header-foreground">
      {/*
        The logo is fixed artwork and is never filtered, plated, recolored, or trimmed.
        Its inks are #910023 crimson and #0a0a0f near-black, which need a light surface,
        so the SURFACE is what gives: --header stays light in both themes (see globals.css).
        An earlier dark:brightness-0 dark:invert knockout flattened the stiletto to a
        featureless white blob and is gone for good. Do not reintroduce a filter here.
      */}
      <img
        src={logoUrl}
        alt="NicoleBooks"
        width={LOGO_INTRINSIC_WIDTH}
        height={LOGO_INTRINSIC_HEIGHT}
        className="h-9 w-auto"
      />

      {/* Connection-status slot: a filled dot whose colour carries the state, plus the label. */}
      <Badge
        variant="outline"
        aria-live="polite"
        className="h-6 max-w-[22rem] gap-1.5 truncate rounded-full border-header-foreground/20 px-2.5 text-sm font-normal text-header-foreground/70"
      >
        <Circle className={cn('shrink-0 fill-current', connectionTone(status))} aria-hidden="true" />
        {connectionLabel(status)}
      </Badge>
    </header>
  )
}
