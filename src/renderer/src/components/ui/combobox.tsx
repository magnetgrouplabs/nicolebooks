// src/renderer/src/components/ui/combobox.tsx
//
// A searchable single-select, built for the review grid's vendor, category, and paid-from cells.
//
// WHY HAND-ROLLED RATHER THAN A PRIMITIVE. Two reasons, in order:
//   1. The lists are long and the parsed text rarely matches them exactly. A plain <select> makes
//      the user scroll a chart of accounts looking for 'Job Expenses:Job Materials'; typing three
//      letters is the whole feature.
//   2. Reconciliation's ranked candidates have to FLOAT TO THE TOP of the list while the rest stays
//      reachable. That is a data-ordering concern no off-the-shelf select exposes, and it is the
//      thing that makes recon useful rather than merely correct.
//
// It renders no portal, so react-dom/server can render it and the specs can assert on the markup
// the user gets. Closed is the SSR state, which is also the state the grid spends its life in.
//
// DESIGN WAVE: this is structural. The classes are brand tokens and nothing is hardcoded, but the
// popup is a plain absolutely-positioned panel and would benefit from real elevation and motion.

import { useId, useMemo, useState } from 'react'

import { cn } from '@/lib/utils'

/** One selectable record. `hint` is a quiet second line (an account type, a vendor's status). */
export interface ComboboxOption {
  id: string
  label: string
  hint?: string
}

/**
 * How many options the popup will render at once.
 *
 * A chart of accounts runs to hundreds of rows and a vendor list to thousands. Rendering all of
 * them into every one of a dozen open-able cells is how a review screen with twelve bills becomes
 * slow to type in. Typing narrows the list, which is what the search box is for, and the footer
 * says out loud when there is more behind the cap so a missing vendor never looks absent.
 */
const MAX_VISIBLE = 40

export function Combobox({
  label,
  value,
  options,
  priorityIds = [],
  placeholder = 'Type to search',
  emptyText = 'No matches.',
  disabled = false,
  marker,
  onChange
}: {
  label: string
  value: string | null
  options: readonly ComboboxOption[]
  /** Ids to float to the top of the list, best first. Reconciliation's ranked candidates. */
  priorityIds?: readonly string[]
  placeholder?: string
  emptyText?: string
  disabled?: boolean
  /** A small note beside the label: "suggested match", "needs your pick". */
  marker?: React.ReactNode
  onChange: (id: string | null) => void
}): React.JSX.Element {
  const inputId = useId()
  const listId = `${inputId}-list`
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)

  const selected = useMemo(
    () => options.find((option) => option.id === value) ?? null,
    [options, value]
  )

  // Filter, then order: matches for what was typed, with the reconciler's candidates first.
  const { visible, hiddenCount } = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const matched = needle === ''
      ? [...options]
      : options.filter((option) => option.label.toLowerCase().includes(needle))
    const rank = new Map(priorityIds.map((id, index) => [id, index]))
    matched.sort((a, b) => {
      const ra = rank.get(a.id)
      const rb = rank.get(b.id)
      if (ra !== undefined && rb !== undefined) return ra - rb
      if (ra !== undefined) return -1
      if (rb !== undefined) return 1
      return 0
    })
    return { visible: matched.slice(0, MAX_VISIBLE), hiddenCount: Math.max(0, matched.length - MAX_VISIBLE) }
  }, [options, priorityIds, query])

  function choose(option: ComboboxOption): void {
    onChange(option.id)
    setQuery('')
    setOpen(false)
    setActive(0)
  }

  function close(): void {
    setQuery('')
    setOpen(false)
    setActive(0)
  }

  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="flex items-center gap-1.5">
        <label htmlFor={inputId} className="font-sans text-xs font-medium text-muted-foreground">
          {label}
        </label>
        {marker}
      </div>
      <div className="relative">
        <input
          id={inputId}
          type="text"
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          autoComplete="off"
          disabled={disabled}
          // Closed, the field reads as the CHOICE. Open, it reads as the search box it has become.
          // Swapping the two is what keeps a selected vendor visible at rest without the user
          // having to clear it before they can search again.
          value={open ? query : (selected?.label ?? '')}
          placeholder={selected === null ? placeholder : undefined}
          onFocus={() => setOpen(true)}
          onChange={(event) => {
            setQuery(event.target.value)
            setActive(0)
            setOpen(true)
          }}
          // The list closes on blur, but a click INSIDE it must land first, so the panel below
          // cancels its own mousedown rather than this handler guessing where focus went.
          onBlur={() => close()}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') {
              event.preventDefault()
              setOpen(true)
              setActive((index) => Math.min(index + 1, Math.max(visible.length - 1, 0)))
            } else if (event.key === 'ArrowUp') {
              event.preventDefault()
              setActive((index) => Math.max(index - 1, 0))
            } else if (event.key === 'Enter') {
              if (open && visible[active]) {
                event.preventDefault()
                choose(visible[active])
              }
            } else if (event.key === 'Escape') {
              close()
            }
          }}
          className={cn(
            'h-8 w-full rounded-lg border border-border bg-background px-2.5 font-sans text-sm text-foreground',
            'placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none',
            'disabled:cursor-not-allowed disabled:opacity-50'
          )}
        />
        {open && (
          <div
            // Keeps the input's blur from firing before the option's click.
            onMouseDown={(event) => event.preventDefault()}
            className="absolute inset-x-0 top-full z-30 mt-1 max-h-64 overflow-y-auto rounded-lg border border-border bg-card py-1 shadow-lg"
          >
            <ul id={listId} role="listbox" aria-label={label}>
              {visible.length === 0 && (
                <li className="px-2.5 py-1.5 font-sans text-sm text-muted-foreground">
                  {emptyText}
                </li>
              )}
              {visible.map((option, index) => (
                <li key={option.id}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={option.id === value}
                    onClick={() => choose(option)}
                    onMouseEnter={() => setActive(index)}
                    className={cn(
                      'flex w-full flex-col items-start gap-0 px-2.5 py-1.5 text-left font-sans text-sm',
                      index === active ? 'bg-muted text-foreground' : 'text-card-foreground'
                    )}
                  >
                    <span className="w-full truncate">{option.label}</span>
                    {option.hint && (
                      <span className="w-full truncate text-xs text-muted-foreground">
                        {option.hint}
                      </span>
                    )}
                  </button>
                </li>
              ))}
              {hiddenCount > 0 && (
                <li className="px-2.5 py-1.5 font-sans text-xs text-muted-foreground">
                  {hiddenCount} more. Type to narrow the list.
                </li>
              )}
            </ul>
          </div>
        )}
      </div>
    </div>
  )
}
