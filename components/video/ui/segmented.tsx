"use client"

import { useRef, type ReactNode } from "react"
import { cn } from "@/lib/utils"

// Segmented: a few mutually exclusive options in one pill (a radiogroup, or
// tabs with `tabs`): one tab stop, Left and Right (and Up and Down) move and
// pick, Home and End go to the ends. An option can be disabled with a reason
// shown on hover and read with it.

export type SegmentOption<T extends string> = { value: T; label: ReactNode; icon?: ReactNode; disabledReason?: string; marker?: boolean; id?: string; controls?: string }

export function Segmented<T extends string>({ label, options, value, onChange, tabs = false, size = "md", className, autoFocus }: {
  label: string
  options: SegmentOption<T>[]
  value: T
  onChange: (value: T) => void
  /** Tabs (role tab, aria-selected) rather than radios. */
  tabs?: boolean
  size?: "sm" | "md"
  className?: string
  autoFocus?: boolean
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([])
  const enabled = options.map((o, i) => (o.disabledReason ? -1 : i)).filter((i) => i >= 0)
  const move = (from: number, key: string) => {
    const at = enabled.indexOf(from)
    if (key === "Home") return enabled[0]
    if (key === "End") return enabled[enabled.length - 1]
    const step = key === "ArrowRight" || key === "ArrowDown" ? 1 : key === "ArrowLeft" || key === "ArrowUp" ? -1 : 0
    return step ? enabled[(at + step + enabled.length) % enabled.length] : -1
  }
  return (
    <div role={tabs ? "tablist" : "radiogroup"} aria-label={label} className={cn("inline-flex max-w-full rounded-xl bg-muted p-1 dark:bg-white/[0.06]", className)}>
      {options.map((o, i) => {
        const on = o.value === value
        const disabled = Boolean(o.disabledReason)
        return (
          <button
            key={o.value}
            ref={(el) => {
              refs.current[i] = el
            }}
            id={o.id}
            type="button"
            role={tabs ? "tab" : "radio"}
            aria-selected={tabs ? on : undefined}
            aria-checked={tabs ? undefined : on}
            aria-controls={o.controls}
            aria-disabled={disabled || undefined}
            aria-description={o.disabledReason}
            title={o.disabledReason}
            tabIndex={on ? 0 : -1}
            autoFocus={autoFocus && on}
            onClick={() => !disabled && onChange(o.value)}
            onKeyDown={(e) => {
              const to = move(i, e.key)
              if (to === undefined || to < 0) return
              e.preventDefault()
              onChange(options[to].value)
              refs.current[to]?.focus()
            }}
            className={cn(
              "relative inline-flex flex-1 basis-auto items-center justify-center gap-1.5 rounded-lg font-medium whitespace-nowrap outline-none motion-safe:transition-[background-color,color,box-shadow] motion-safe:duration-150",
              size === "sm" ? "h-7 px-2.5 text-xs" : "h-8 px-3 text-[13px]",
              "focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:h-11",
              on ? "bg-card text-foreground shadow-sm ring-1 ring-black/5 dark:bg-white/14 dark:ring-white/10" : "text-muted-foreground hover:text-foreground",
              disabled && "cursor-not-allowed opacity-45 hover:text-muted-foreground",
              "forced-colors:aria-checked:outline-2 forced-colors:aria-selected:outline-2"
            )}
          >
            {o.icon}
            <span>{o.label}</span>
            {o.marker && <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-editor-accent" />}
          </button>
        )
      })}
    </div>
  )
}
