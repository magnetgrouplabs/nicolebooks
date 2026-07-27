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

import { Circle } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import logoUrl from '@/assets/nicolebooks-logo-full.png'

// Intrinsic size of the lockup, declared so the browser reserves the right box before the
// image decodes and the 56px row never reflows.
const LOGO_INTRINSIC_WIDTH = 1931
const LOGO_INTRINSIC_HEIGHT = 639

export function Header(): React.JSX.Element {
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

      {/* Connection-status slot: neutral filled dot + label on the muted foreground token. */}
      <Badge
        variant="outline"
        className="h-6 gap-1.5 rounded-full border-header-foreground/20 px-2.5 text-sm font-normal text-header-foreground/70"
      >
        <Circle className="fill-current" aria-hidden="true" />
        Not connected
      </Badge>
    </header>
  )
}
