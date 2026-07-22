// Plan 01-06 Task 1: the branded top bar (UI-SPEC Layout Frame + Copywriting Contract).
//
// Structural contract: full width, 56px tall (the grid row in App.tsx), structural radius 0
// (never rounded), sits above content at z-index 20 (tokens.json elevation.nav = 20), on the
// secondary surface. Left side carries the plain "NicoleBooks" wordmark (Jost 20px 600, plain
// text, no logo/image per BRAND-02). Right side is the neutral connection-status slot: a filled
// neutral dot plus the label "Not connected", a Phase 1 placeholder that Phase 4 replaces with
// real QuickBooks health. All colors come from semantic theme classes; no hardcoded hex.

import { Circle } from 'lucide-react'

import { Badge } from '@/components/ui/badge'

export function Header(): React.JSX.Element {
  return (
    <header className="z-20 col-span-2 row-start-1 flex items-center justify-between rounded-none border-b border-border bg-secondary px-6">
      {/* Wordmark: plain text only, no logo or image asset (BRAND-02). Jost 20px 600. */}
      <span className="font-heading text-xl font-semibold leading-tight text-foreground">
        NicoleBooks
      </span>

      {/* Connection-status slot: neutral filled dot + label on the muted foreground token. */}
      <Badge
        variant="outline"
        className="h-6 gap-1.5 rounded-full border-border px-2.5 text-sm font-normal text-muted-foreground"
      >
        <Circle className="fill-current" aria-hidden="true" />
        Not connected
      </Badge>
    </header>
  )
}
