import { mergeProps } from "@base-ui/react/merge-props"
import { useRender } from "@base-ui/react/use-render"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

/*
 * STATUS CHIP ANATOMY, which is what this component actually is in NicoleBooks.
 *
 * Every chip is a light tint of one hue carrying a darker label of the SAME hue, over a hairline
 * border of that hue. That is the enterprise treatment (Stripe, Atlassian), and it replaces what
 * shipped: `default` was a solid saturated crimson slab with white text, worn by "Sent", "Entered",
 * "Ready to review", "Connected" and "Vision" all at once. Five saturated brand slabs per screen is
 * how a product ends up looking like it was coloured in rather than designed, and it also spent the
 * primary colour, whose one job is the action the user is meant to take next.
 *
 * The vocabulary the app already documents (BillsScreen.statusChip) maps onto the hues directly:
 *
 *   default      done and good            success tint    with a dot
 *   secondary    in progress, or benign   neutral tint    with a dot
 *   warning      needs you, calmly        amber tint      with a dot
 *   destructive  needs you, urgently      orange-red tint with a dot
 *   outline      inert: skipped, gone     hairline only   NO dot
 *
 * The dot is the tell that a chip reports a LIVE state; `outline` withholds it because "Removed",
 * "Unsupported" and "Not connected" describe something that is not happening. It is drawn from
 * `currentColor`, so it can never drift from its label.
 *
 * The variant NAMES are load-bearing: statusChip, batchChip, entryChip and sendStateChip all return
 * these literals and four specs pin them. Retinting a variant is safe; renaming one is not.
 */
const badgeVariants = cva(
  "group/badge inline-flex h-5 w-fit max-w-64 shrink-0 items-center justify-center gap-1.5 overflow-hidden rounded-full border px-2 py-0.5 text-xs font-medium text-ellipsis whitespace-nowrap transition-colors duration-150 ease-standard focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 [&>svg]:pointer-events-none [&>svg]:size-3!",
  {
    variants: {
      variant: {
        default:
          "border-success/25 bg-success/12 text-success-foreground before:size-1.5 before:shrink-0 before:rounded-full before:bg-current before:content-['']",
        secondary:
          "border-border bg-secondary text-secondary-foreground before:size-1.5 before:shrink-0 before:rounded-full before:bg-current before:opacity-50 before:content-['']",
        destructive:
          "border-destructive/25 bg-destructive/10 text-destructive focus-visible:ring-destructive/20 dark:bg-destructive/20 dark:focus-visible:ring-destructive/40 before:size-1.5 before:shrink-0 before:rounded-full before:bg-current before:content-['']",
        warning:
          "border-warning/30 bg-warning/15 text-warning-foreground before:size-1.5 before:shrink-0 before:rounded-full before:bg-current before:content-['']",
        outline: "border-border text-muted-foreground [a]:hover:bg-muted",
        ghost:
          "border-transparent hover:bg-muted hover:text-muted-foreground dark:hover:bg-muted/50",
        link: "border-transparent text-primary-vivid underline-offset-4 hover:underline",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

function Badge({
  className,
  variant = "default",
  render,
  ...props
}: useRender.ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return useRender({
    defaultTagName: "span",
    props: mergeProps<"span">(
      {
        className: cn(badgeVariants({ variant }), className),
      },
      props
    ),
    render,
    state: {
      slot: "badge",
      variant,
    },
  })
}

export { Badge, badgeVariants }
