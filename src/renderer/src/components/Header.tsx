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
    <header className="z-20 col-span-2 row-start-1 flex items-center justify-between rounded-none border-b border-border bg-secondary px-6">
      {/*
        The logo replaces the old text wordmark. h-8 keeps the ~3:1 lockup (1931x639) at its
        true aspect ratio inside the 56px row, leaving 12px of breathing room above and below.
        The alt text is the bare product name, not "NicoleBooks logo": the image IS the
        wordmark, so a screen reader should announce it exactly as the text it replaced.

        dark:brightness-0 dark:invert is a knockout STOPGAP, not a brand choice, and it wants
        replacing with a proper dark-mode logo variant from the designer. The supplied artwork
        is light-background only: the wordmark's only two inks are #910023 and #000000, which
        measure 1.52:1 and 1.46:1 on the dark --secondary surface, so the whole wordmark
        disappears when the OS is in dark mode (the theme follows the OS live, see main.tsx).
        The knockout renders the lockup solid white at 14.35:1.

        Three alternatives were rendered and measured before settling here:
          - invert(1) hue-rotate(180deg) keeps the icon's shape but turns the crimson into
            #ffbcdf, Lab hue 344.8 against the brand's 25.0. It renders the brand in the wrong
            hue family, which is worse than neutral on a task about brand color.
          - invert(1) alone turns the stiletto cyan.
          - A light plate keeps perfect fidelity, but the PNG carries 188px (29%) of dead
            transparent canvas along its bottom edge, so the plate comes out visibly lopsided.
        The knockout's cost is the icon's interior detail, which flattens to a silhouette at
        this size. It is one class to revert once a real dark asset exists.
      */}
      <img
        src={logoUrl}
        alt="NicoleBooks"
        width={LOGO_INTRINSIC_WIDTH}
        height={LOGO_INTRINSIC_HEIGHT}
        className="h-8 w-auto dark:brightness-0 dark:invert"
      />

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
