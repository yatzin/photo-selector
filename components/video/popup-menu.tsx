"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { MoreHorizontal, type LucideIcon } from "lucide-react"
import { cn } from "@/lib/utils"

// A small menu at a point: opened by a right-click (at the pointer) or by an
// ellipsis button (under it). Closes on Esc, a press outside, scroll or
// resize, and when an item is chosen. Used by Personal Storage in the Video
// Editing side panel and in the library.

export type MenuItem = { label: string; icon: LucideIcon; onSelect: () => void; danger?: boolean; disabled?: boolean } | "separator"

const W = 208

export function PopupMenu({ x, y, items, label, onClose }: { x: number; y: number; items: MenuItem[]; label: string; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const close = (e: Event) => {
      if (e.type === "keydown" && (e as KeyboardEvent).key !== "Escape") return
      if (e.type === "pointerdown" && ref.current?.contains(e.target as Node)) return
      onClose()
    }
    window.addEventListener("pointerdown", close, true)
    window.addEventListener("keydown", close, true)
    window.addEventListener("resize", close)
    window.addEventListener("scroll", close, true)
    ref.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus()
    return () => {
      window.removeEventListener("pointerdown", close, true)
      window.removeEventListener("keydown", close, true)
      window.removeEventListener("resize", close)
      window.removeEventListener("scroll", close, true)
    }
  }, [onClose])

  // Keep it on screen near where it was asked for.
  const height = items.reduce((h, i) => h + (i === "separator" ? 9 : 34), 8)
  return (
    <div
      ref={ref}
      role="menu"
      aria-label={label}
      className="fixed z-[60] rounded-lg border bg-popover p-1 text-sm text-popover-foreground shadow-lg"
      style={{ left: Math.max(8, Math.min(x, window.innerWidth - W - 8)), top: Math.max(8, Math.min(y, window.innerHeight - height - 8)), width: W }}
      onContextMenu={(e) => e.preventDefault()}
      onKeyDown={(e) => {
        if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return
        e.preventDefault()
        const buttons = [...(ref.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])]
        const at = buttons.indexOf(document.activeElement as HTMLButtonElement)
        buttons[(at + (e.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length]?.focus()
      }}
    >
      {items.map((item, i) =>
        item === "separator" ? (
          <div key={i} role="separator" className="my-1 h-px bg-border" />
        ) : (
          <button
            key={item.label}
            type="button"
            role="menuitem"
            disabled={item.disabled}
            onClick={() => {
              onClose()
              item.onSelect()
            }}
            className={cn(
              "flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left outline-none hover:bg-muted focus-visible:bg-muted disabled:pointer-events-none disabled:opacity-40",
              item.danger && "text-destructive"
            )}
          >
            <item.icon className="h-4 w-4 shrink-0" />
            {item.label}
          </button>
        )
      )}
    </div>
  )
}

/** The state behind a menu opened at a point: `open` it from a context menu event or a button, render `menu` once. */
export function useMenuState(items: () => MenuItem[], label: string) {
  const [at, setAt] = useState<{ x: number; y: number } | null>(null)
  const close = useCallback(() => setAt(null), [])
  return {
    /** Right-click: at the pointer. Not for touch (a long press there starts other things) unless `anyPointer`. */
    onContextMenu: (e: React.MouseEvent) => {
      e.preventDefault()
      e.stopPropagation()
      setAt({ x: e.clientX, y: e.clientY })
    },
    /** From a button: under it, aligned to its right edge. */
    openFrom: (el: HTMLElement) => {
      const r = el.getBoundingClientRect()
      setAt({ x: r.right - W, y: r.bottom + 4 })
    },
    menu: at ? <PopupMenu x={at.x} y={at.y} items={items()} label={label} onClose={close} /> : null,
  }
}

/** The ellipsis button that opens a menu (the `openFrom` of useMenuState). */
export function EllipsisButton({ label, onOpen, className }: { label: string; onOpen: (el: HTMLElement) => void; className?: string }) {
  return (
    <button
      type="button"
      aria-haspopup="menu"
      title={label}
      onClick={(e) => onOpen(e.currentTarget)}
      className={cn(
        "flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
        className
      )}
    >
      <MoreHorizontal className="h-4 w-4" />
      <span className="sr-only">{label}</span>
    </button>
  )
}
