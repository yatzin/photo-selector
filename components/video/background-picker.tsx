"use client"

import { useEffect, useRef } from "react"
import { cn } from "@/lib/utils"
import { DEFAULT_BACKGROUND } from "@/lib/video/project"

// The canvas color under every layer (the "void" that shows where no clip
// covers the picture, and that the export fills the same way). A small panel
// at a point, opened by the toolbar button (under it) or a right-click on the
// preview. Picking applies at once; it closes on Esc or a press outside.

const W = 224
const PRESETS = ["#000000", "#ffffff", "#808080", "#1e3a8a", "#15803d", "#b91c1c", "#facc15", "#7c3aed"]

export function BackgroundPicker({ x, y, color, onChange, onClose }: { x: number; y: number; color: string; onChange: (color: string) => void; onClose: () => void }) {
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
    ref.current?.querySelector<HTMLButtonElement>("button")?.focus()
    return () => {
      window.removeEventListener("pointerdown", close, true)
      window.removeEventListener("keydown", close, true)
      window.removeEventListener("resize", close)
    }
  }, [onClose])

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label="Background color"
      className="fixed z-[60] grid gap-2.5 rounded-lg border bg-popover p-3 text-sm text-popover-foreground shadow-lg"
      style={{ left: Math.max(8, Math.min(x, window.innerWidth - W - 8)), top: Math.max(8, Math.min(y, window.innerHeight - 180)), width: W }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <p className="text-xs text-muted-foreground">Shows wherever no clip covers the picture. The export uses it too.</p>
      <div role="group" aria-label="Preset colors" className="flex flex-wrap gap-1.5">
        {PRESETS.map((c) => {
          const on = color === c
          return (
            <button
              key={c}
              type="button"
              title={c.toUpperCase()}
              aria-label={`Use color ${c.toUpperCase()}`}
              aria-pressed={on}
              onClick={() => onChange(c)}
              className={cn(
                "size-7 rounded-full ring-1 ring-black/20 ring-inset outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring dark:ring-white/25 pointer-coarse:size-11",
                on && "outline-2 outline-offset-2 outline-editor-accent"
              )}
              style={{ backgroundColor: c }}
            />
          )
        })}
      </div>
      <div className="flex items-center justify-between gap-2">
        <label className="relative flex h-9 cursor-pointer items-center gap-2 rounded-lg border border-input bg-card pr-3 pl-1 focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/40 dark:bg-input/30 pointer-coarse:h-11">
          <span aria-hidden className="size-7 rounded-md ring-1 ring-black/15 ring-inset dark:ring-white/20" style={{ backgroundColor: color }} />
          <span className="text-sm font-medium tabular-nums uppercase">{color}</span>
          <input type="color" aria-label="Custom background color" value={color} onChange={(e) => onChange(e.target.value.toLowerCase())} className="absolute inset-0 cursor-pointer opacity-0" />
        </label>
        <button type="button" disabled={color === DEFAULT_BACKGROUND} onClick={() => onChange(DEFAULT_BACKGROUND)} className="rounded-md px-2 py-1 text-xs text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40">
          Black
        </button>
      </div>
    </div>
  )
}
