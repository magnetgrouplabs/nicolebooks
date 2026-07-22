// Plan 01-06 Task 1: the centered empty-state block (UI-SPEC Typography + Layout Frame).
//
// The primary visual anchor on the placeholder screens: a heading (Jost 24px 600) over a
// supporting body line (DM Sans 16px 400), centered, with a space.16 (64px) top offset. An
// optional lucide icon sits above the heading. Heading and body are props so each screen
// supplies its own locked copy. All colors are semantic theme classes; no hardcoded hex.

import type { ComponentType } from 'react'

import type { LucideProps } from 'lucide-react'

interface EmptyStateProps {
  heading: string
  body: string
  icon?: ComponentType<LucideProps>
}

export function EmptyState({ heading, body, icon: Icon }: EmptyStateProps): React.JSX.Element {
  return (
    <div className="flex flex-col items-center pt-16 text-center">
      {Icon && <Icon className="mb-4 size-10 text-muted-foreground" aria-hidden="true" />}
      <h2 className="font-heading text-2xl font-semibold leading-tight text-foreground">
        {heading}
      </h2>
      <p className="mt-4 max-w-md font-sans text-base font-normal text-muted-foreground">
        {body}
      </p>
    </div>
  )
}
