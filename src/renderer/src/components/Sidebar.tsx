// Plan 01-06 Task 1: the persistent 280px left navigation (UI-SPEC Layout Frame + Color + Motion).
//
// Structural contract: fixed 280px wide, full height below the header, structural radius 0, on
// the secondary surface. Three icon+text destinations (Bills, History, Settings); each item is
// full width, 40px tall, with an 18px icon, a 14px label, and 24px horizontal padding so the icon
// column lands under the logo's left edge in the header above it. Hover uses the primary tint at
// 6% opacity, pressed at 16% (tokens.json opacity.hover/pressed), transitioning at 150ms with the
// standard easing. Keyboard focus uses the ring token at 32% (shadow.focus). Every color is a
// semantic theme value; no hardcoded hex.
//
// THE ACTIVE ITEM WAS UNREADABLE IN DARK MODE. It set `text-primary`, and --primary is the true
// logo crimson #910023, which is 1.6:1 on the dark sidebar surface #2a2a2a: the current screen's
// name was the least legible label in the app. It now uses --primary-vivid, the brand red at a
// lightness the current surface can carry, on a tinted well, with the crimson rail kept because an
// active-nav indicator is the one place brand colour belongs unconditionally.

import type { ComponentType } from 'react'

import { History, Receipt, Settings, type LucideProps } from 'lucide-react'

import { cn } from '@/lib/utils'

export type Destination = 'bills' | 'history' | 'settings'

interface NavItem {
  id: Destination
  label: string
  Icon: ComponentType<LucideProps>
}

// Order fixes the default landing destination: Bills is first (D-09).
const NAV_ITEMS: NavItem[] = [
  { id: 'bills', label: 'Bills', Icon: Receipt },
  { id: 'history', label: 'History', Icon: History },
  { id: 'settings', label: 'Settings', Icon: Settings }
]

interface SidebarProps {
  active: Destination
  onSelect: (destination: Destination) => void
}

export function Sidebar({ active, onSelect }: SidebarProps): React.JSX.Element {
  return (
    <nav
      aria-label="Primary"
      className="col-start-1 row-start-2 w-[280px] rounded-none border-r border-border bg-secondary py-3"
    >
      {NAV_ITEMS.map(({ id, label, Icon }) => {
        const isActive = id === active
        return (
          <button
            key={id}
            type="button"
            aria-current={isActive ? 'page' : undefined}
            onClick={() => onSelect(id)}
            className={cn(
              'relative flex h-10 w-full cursor-pointer items-center gap-3 px-6 text-sm outline-none',
              'transition-colors duration-150 ease-standard',
              'hover:bg-primary/[0.06] active:bg-primary/[0.16]',
              'focus-visible:ring-[3px] focus-visible:ring-ring/[0.32] focus-visible:ring-inset',
              isActive
                ? 'bg-primary/[0.08] font-semibold text-primary-vivid'
                : 'font-normal text-muted-foreground hover:text-foreground'
            )}
          >
            {isActive && (
              <span
                aria-hidden="true"
                className="absolute inset-y-0 left-0 w-[3px] bg-primary-vivid"
              />
            )}
            <Icon className="size-[18px]" aria-hidden="true" />
            {label}
          </button>
        )
      })}
    </nav>
  )
}
