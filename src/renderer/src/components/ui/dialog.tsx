// src/renderer/src/components/ui/dialog.tsx
//
// The app's modal primitive, on Base UI (@base-ui/react), following the same copy-in idiom as
// button.tsx, badge.tsx and tooltip.tsx: a thin styled wrapper over the primitive, no behaviour of
// its own, every colour a semantic token.
//
// WHAT THIS REPLACES, and why it is not cosmetic. The two modal surfaces in this app were plain
// `position: fixed` divs. They carried role="dialog" and aria-modal="true", so they ANNOUNCED
// themselves as modal, and then delivered none of it: Tab walked straight out of the panel into the
// screen behind it, Escape did nothing, the page under the scrim kept scrolling, and nothing was
// hidden from a screen reader. A phone-upload panel you cannot dismiss with Escape is an annoyance;
// a send confirmation you can Tab out of, on the last screen before entries reach somebody's books,
// is worse than that.
//
// Base UI's Dialog gives all of it: focus trap, focus return to the trigger on close, Escape,
// outside-press dismissal, scroll lock, and aria-hidden on everything outside the popup.
//
// ONE THING TO KNOW WHEN TESTING. Dialog.Portal renders through the DOM, so react-dom/server
// produces an empty string for anything inside it. That is why the panels themselves
// (PhoneUploadPanel, SendConfirm) stayed plain SSR-renderable components and only the frame lives
// here: their copy and their disabled rules stay provable without a DOM, and the modal behaviour
// this file adds is pinned where it is real, in e2e/dialog.spec.ts against the running app.

import { Dialog as DialogPrimitive } from '@base-ui/react/dialog'

import { cn } from '@/lib/utils'

function Dialog(props: DialogPrimitive.Root.Props): React.JSX.Element {
  return <DialogPrimitive.Root {...props} />
}

function DialogTrigger(props: DialogPrimitive.Trigger.Props): React.JSX.Element {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />
}

function DialogClose(props: DialogPrimitive.Close.Props): React.JSX.Element {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />
}

/** Required by the primitive: Dialog.Popup throws without a Portal above it. */
function DialogPortal(props: DialogPrimitive.Portal.Props): React.JSX.Element {
  return <DialogPrimitive.Portal {...props} />
}

/**
 * The scrim.
 *
 * `bg-overlay`, a real token, because the old panels used `bg-foreground/40`: in dark mode
 * --foreground is #f0f0f0, so the "dim" behind a dark modal was a WHITE wash.
 */
function DialogBackdrop({ className, ...props }: DialogPrimitive.Backdrop.Props): React.JSX.Element {
  return (
    <DialogPrimitive.Backdrop
      data-slot="dialog-backdrop"
      className={cn(
        'fixed inset-0 z-30 bg-overlay',
        'transition-opacity duration-150 ease-standard data-closed:opacity-0 data-open:opacity-100',
        className
      )}
      {...props}
    />
  )
}

/**
 * The modal surface itself.
 *
 * z-30 is tokens.json elevation.overlay. Radius is --radius-2xl, the modal rung of the ladder, one
 * step above the cards it floats over so the two never read as the same kind of surface. Elevation
 * comes from `shadow-overlay`, which is a soft shadow on a light theme and a light hairline on a
 * dark one.
 *
 * Motion is short and asymmetric on purpose: 150ms in with a slight scale so the panel arrives from
 * where it will live, 100ms out so dismissing never feels like waiting.
 */
function DialogPopup({ className, ...props }: DialogPrimitive.Popup.Props): React.JSX.Element {
  return (
    <DialogPrimitive.Popup
      data-slot="dialog-popup"
      className={cn(
        'fixed top-1/2 left-1/2 z-30 flex max-h-[calc(100vh-4rem)] w-[calc(100vw-3rem)] max-w-md',
        '-translate-x-1/2 -translate-y-1/2 flex-col gap-4 overflow-y-auto',
        'rounded-2xl border border-border bg-card p-5 text-card-foreground shadow-overlay outline-none',
        'transition-[opacity,scale] duration-150 ease-standard',
        'data-closed:scale-[0.98] data-closed:opacity-0 data-closed:duration-100',
        'data-open:scale-100 data-open:opacity-100',
        className
      )}
      {...props}
    />
  )
}

/** The modal's heading. Base UI wires the popup's aria-labelledby to whatever id this carries. */
function DialogTitle({ className, ...props }: DialogPrimitive.Title.Props): React.JSX.Element {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn('font-heading text-lg font-semibold text-card-foreground', className)}
      {...props}
    />
  )
}

/** The modal's supporting line, wired to the popup's aria-describedby the same way. */
function DialogDescription({
  className,
  ...props
}: DialogPrimitive.Description.Props): React.JSX.Element {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn('font-sans text-sm text-muted-foreground', className)}
      {...props}
    />
  )
}

export {
  Dialog,
  DialogBackdrop,
  DialogClose,
  DialogDescription,
  DialogPopup,
  DialogPortal,
  DialogTitle,
  DialogTrigger
}
