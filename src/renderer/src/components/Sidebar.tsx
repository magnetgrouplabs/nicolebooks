// Plan 01-06 Task 1: the persistent 280px left navigation (UI-SPEC Layout Frame + Color + Motion).
//
// Structural contract: fixed 280px wide, full height below the header, structural radius 0, on
// the secondary surface. Three icon+text destinations (Bills, History, Settings); each item is
// full width, min height 40px, with a 20px icon, a 14px label, a 12px gap and 12px horizontal
// padding (tokens.json space.3 = 12px, space.10 = 40px). The active item gets violet text
// (text-primary) plus a violet left-edge indicator bar and semibold weight. Hover uses the
// primary tint at 6% opacity, pressed at 16% (tokens.json opacity.hover/pressed), transitioning
// at 150ms with the standard easing. Keyboard focus uses the ring token at 32% (shadow.focus).
// Every color is a semantic theme value; no hardcoded hex.

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
      className="col-start-1 row-start-2 w-[280px] rounded-none border-r border-border bg-secondary py-2"
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
              'relative flex min-h-10 w-full items-center gap-3 px-3 text-sm outline-none',
              'transition-colors duration-150 ease-[cubic-bezier(0.2,0,0,1)]',
              'hover:bg-primary/[0.06] active:bg-primary/[0.16]',
              'focus-visible:ring-[3px] focus-visible:ring-ring/[0.32]',
              isActive ? 'font-semibold text-primary' : 'font-normal text-foreground'
            )}
          >
            {isActive && (
              <span
                aria-hidden="true"
                className="absolute inset-y-0 left-0 w-[3px] bg-primary"
              />
            )}
            <Icon className="size-5" aria-hidden="true" />
            {label}
          </button>
        )
      })}
    </nav>
  )
}
