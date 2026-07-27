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
    /*
      The empty state is the only place this app gets to set display type, so it does: a real
      heading at 24px with the tracking a heading that size needs, over a measured line of body
      copy. The icon sits in a bare, muted circle drawn from the border token rather than a tinted
      brand plate, because a coloured icon container is decoration standing in for a design and
      this screen has nothing to celebrate: it is telling the user there is nothing here yet.
    */
    <div className="flex flex-col items-center rounded-lg border border-dashed border-border px-6 py-14 text-center">
      {Icon && (
        <span className="mb-5 flex size-12 items-center justify-center rounded-full border border-border">
          <Icon className="size-5 text-muted-foreground" aria-hidden="true" />
        </span>
      )}
      <h2 className="font-heading text-2xl font-semibold tracking-[-0.015em] text-foreground">
        {heading}
      </h2>
      <p className="mt-3 max-w-prose font-sans text-sm font-normal text-muted-foreground">
        {body}
      </p>
    </div>
  )
}
