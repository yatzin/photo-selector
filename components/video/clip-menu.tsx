"use client"

import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { Check } from "lucide-react"
import { cn } from "@/lib/utils"

// The timeline's right-click menu on a clip: a small role="menu" at the
// pointer, kept inside the window. Focus moves to the first item that works;
// the arrows, Home and End move it, Enter or Space runs it. Escape, Tab, a
// press outside, any scroll, a resize or the window losing focus closes it,
// and so does running an item. Items with `checked` are a radio pair (a
// check mark on the one that's on), set off from the others by a line. An
// item with `dot` shows a small dot after its label (it has settings already),
// and a `destructive` one is in the destructive color. It scales in from the
// pointer (still with reduced motion).

export type ClipMenuItem = {
  label: string
  /** The key that does the same, shown at the right (Delete, S, M). */
  hint?: string
  disabled?: boolean
  /** A small dot after the label: the item already has settings (e.g. audio levels set). */
  dot?: boolean
  /** A choice of several (menuitemradio): whether it's the one that's on. */
  checked?: boolean
  /** It deletes something: shown in the destructive color. */
  destructive?: boolean
  onSelect: () => void
}

const MARGIN = 8 // px kept between the menu and the window's edges

export function ClipMenu({ x, y, label, items, onClose }: {
  /** The pointer, in viewport px. */
  x: number
  y: number
  /** The menu's accessible name. */
  label: string
  items: ClipMenuItem[]
  onClose: () => void
}) {
  const menu = useRef<HTMLDivElement>(null)
  const buttons = useRef<(HTMLButtonElement | null)[]>([])
  const [at, setAt] = useState<{ left: number; top: number } | null>(null)
  const close = useRef(onClose)
  useEffect(() => {
    close.current = onClose
  })

  // Measure, then open towards the left or upwards where it would leave the window.
  useLayoutEffect(() => {
    const el = menu.current
    if (!el) return
    const { width, height } = el.getBoundingClientRect()
    const left = x + width + MARGIN > window.innerWidth ? Math.max(MARGIN, window.innerWidth - width - MARGIN) : x
    const top = y + height + MARGIN > window.innerHeight ? Math.max(MARGIN, window.innerHeight - height - MARGIN) : y
    setAt({ left, top })
  }, [x, y])

  // Focus the first item that works, once it's placed.
  useEffect(() => {
    if (at) buttons.current.find((b) => b && !b.disabled)?.focus({ preventScroll: true })
  }, [at])

  useEffect(() => {
    const shut = () => close.current()
    const down = (e: PointerEvent) => {
      if (!(e.target instanceof Node && menu.current?.contains(e.target))) shut()
    }
    window.addEventListener("pointerdown", down, true)
    window.addEventListener("scroll", shut, true)
    window.addEventListener("resize", shut)
    window.addEventListener("blur", shut)
    return () => {
      window.removeEventListener("pointerdown", down, true)
      window.removeEventListener("scroll", shut, true)
      window.removeEventListener("resize", shut)
      window.removeEventListener("blur", shut)
    }
  }, [])

  function onKeyDown(e: React.KeyboardEvent) {
    const enabled = buttons.current.filter((b): b is HTMLButtonElement => b !== null && !b.disabled)
    const now = enabled.indexOf(document.activeElement as HTMLButtonElement)
    let to: number | null = null
    if (e.key === "ArrowDown") to = now < 0 ? 0 : (now + 1) % enabled.length
    else if (e.key === "ArrowUp") to = now < 0 ? enabled.length - 1 : (now - 1 + enabled.length) % enabled.length
    else if (e.key === "Home") to = 0
    else if (e.key === "End") to = enabled.length - 1
    else if (e.key === "Escape" || e.key === "Tab") {
      e.preventDefault()
      e.stopPropagation()
      onClose()
      return
    }
    if (to !== null) {
      e.preventDefault()
      enabled[to]?.focus({ preventScroll: true })
    }
  }

  return createPortal(
    <div
      ref={menu}
      role="menu"
      aria-label={label}
      onKeyDown={onKeyDown}
      onContextMenu={(e) => e.preventDefault()}
      className="fixed z-50 min-w-52 origin-top-left rounded-xl bg-popover p-1 text-sm text-popover-foreground shadow-lg ring-1 ring-foreground/10 outline-none motion-safe:animate-in motion-safe:fade-in-0 motion-safe:zoom-in-95 motion-safe:duration-100 dark:ring-white/10"
      style={at ? { left: at.left, top: at.top } : { left: x, top: y, visibility: "hidden" }}
    >
      {items.map((item, i) => (
        <button
          key={item.label}
          ref={(el) => {
            buttons.current[i] = el
          }}
          type="button"
          role={item.checked === undefined ? "menuitem" : "menuitemradio"}
          aria-checked={item.checked}
          tabIndex={-1}
          disabled={item.disabled}
          aria-disabled={item.disabled || undefined}
          // Enter and Space click a focused button already.
          onClick={() => {
            onClose()
            item.onSelect()
          }}
          className={cn(
            "flex min-h-8 w-full items-center justify-between gap-6 rounded-lg px-2.5 py-1.5 text-left outline-none pointer-coarse:min-h-11",
            "hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground focus:bg-accent focus:text-accent-foreground",
            "forced-colors:focus:outline-2 forced-colors:focus:outline-[Highlight]",
            item.destructive && "text-destructive hover:bg-destructive/10 hover:text-destructive focus:bg-destructive/10 focus:text-destructive focus-visible:bg-destructive/10 focus-visible:text-destructive",
            "disabled:pointer-events-none disabled:opacity-50",
            // A line above the first of a radio group.
            item.checked !== undefined && items[i - 1]?.checked === undefined && i > 0 && "relative mt-2 before:absolute before:inset-x-0 before:-top-1 before:h-px before:bg-border"
          )}
        >
          <span className="flex items-center gap-2">
            {item.checked !== undefined && <Check aria-hidden className={cn("h-3.5 w-3.5", !item.checked && "invisible")} />}
            {item.label}
            {item.dot && (
              <>
                <span aria-hidden data-menu-dot className="h-1.5 w-1.5 rounded-full bg-editor-accent" />
                <span className="sr-only">(set)</span>
              </>
            )}
          </span>
          {item.hint && <kbd className="rounded border border-border bg-muted/60 px-1.5 py-px font-sans text-[11px] text-muted-foreground">{item.hint}</kbd>}
        </button>
      ))}
    </div>,
    document.body
  )
}
