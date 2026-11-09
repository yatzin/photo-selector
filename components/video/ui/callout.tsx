"use client"

import { useState, type ReactNode } from "react"
import { Check, ChevronDown, CircleCheck, Info, Lightbulb, TriangleAlert, X, OctagonAlert } from "lucide-react"
import { cn } from "@/lib/utils"

// Callout: a short note in a tone (info, warning, success, danger) with its
// icon, so colour is never the only signal. Tips: the guidance under a
// preview (what it does, best for, avoid when) as a collapsible card with a
// check and a cross; it remembers being open or shut for this page.

const TONES = {
  info: { icon: Info, box: "border-sky-600/25 bg-sky-500/8 text-foreground dark:border-sky-300/25 dark:bg-sky-400/10", mark: "text-sky-700 dark:text-sky-300" },
  warning: { icon: TriangleAlert, box: "border-amber-600/35 bg-amber-500/10 text-amber-950 dark:border-amber-300/30 dark:bg-amber-400/10 dark:text-amber-50", mark: "text-amber-700 dark:text-amber-300" },
  success: { icon: CircleCheck, box: "border-emerald-600/30 bg-emerald-500/10 text-emerald-950 dark:border-emerald-300/30 dark:bg-emerald-400/10 dark:text-emerald-50", mark: "text-emerald-700 dark:text-emerald-300" },
  danger: { icon: OctagonAlert, box: "border-destructive/35 bg-destructive/8 text-foreground dark:bg-destructive/12", mark: "text-destructive" },
} as const

export type CalloutTone = keyof typeof TONES

export function Callout({ tone = "info", title, children, action, className, live, ...data }: {
  tone?: CalloutTone
  title?: ReactNode
  children?: ReactNode
  /** Buttons at the bottom. */
  action?: ReactNode
  className?: string
  /** Announce changes (an async result). */
  live?: boolean
} & { [key: `data-${string}`]: string | undefined }) {
  const t = TONES[tone]
  const Icon = t.icon
  return (
    <div {...data} role={live ? "status" : undefined} className={cn("grid gap-2 rounded-xl border px-3 py-2.5 text-xs leading-snug forced-colors:border-[CanvasText]", t.box, className)}>
      <div className="flex gap-2.5">
        <Icon aria-hidden className={cn("mt-px size-4 shrink-0", t.mark)} />
        <div className="grid min-w-0 flex-1 gap-1">
          {title && <div className="text-[13px] leading-5 font-semibold">{title}</div>}
          {children}
        </div>
      </div>
      {action && <div className="flex flex-wrap items-center gap-2 pl-6.5">{action}</div>}
    </div>
  )
}

const TIPS_KEY = "ps-editor-tips-open"
const readOpen = () => {
  try {
    return sessionStorage.getItem(TIPS_KEY) !== "0"
  } catch {
    return true
  }
}

/** The guidance for a choice: what it does, then best for (check) and avoid when (cross), collapsible. */
export function Tips({ name, does, bestFor, avoid, note, className }: { name: string; does: string; bestFor: string; avoid: string; note?: string; className?: string }) {
  const [open, setOpen] = useState(readOpen)
  const toggle = () => {
    setOpen(!open)
    try {
      sessionStorage.setItem(TIPS_KEY, open ? "0" : "1")
    } catch {
      // Private mode: it just isn't remembered.
    }
  }
  return (
    <div className={cn("rounded-xl border border-border bg-card/60 dark:bg-white/[0.03]", className)} data-transition-guide>
      <button
        type="button"
        aria-expanded={open}
        onClick={toggle}
        className="flex w-full items-center gap-2 rounded-xl px-3 py-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Lightbulb aria-hidden className="size-4 shrink-0 text-editor-accent" />
        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold">{name}</span>
        <span className="shrink-0 text-xs text-muted-foreground">{open ? "Hide tips" : "Show tips"}</span>
        <ChevronDown aria-hidden className={cn("size-4 shrink-0 text-muted-foreground motion-safe:transition-transform motion-safe:duration-200", open && "rotate-180")} />
      </button>
      {open && (
        <div aria-live="polite" className="grid gap-2.5 border-t border-border px-3 pt-2.5 pb-3 text-xs leading-relaxed">
          {note && <p className="text-muted-foreground">{note}</p>}
          <p>{does}</p>
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="flex gap-2">
              <span aria-hidden className="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"><Check className="size-2.5" strokeWidth={3} /></span>
              <p><span className="block font-semibold">Best for</span>{bestFor}</p>
            </div>
            <div className="flex gap-2">
              <span aria-hidden className="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full bg-rose-500/15 text-rose-700 dark:text-rose-300"><X className="size-2.5" strokeWidth={3} /></span>
              <p><span className="block font-semibold">Avoid when</span>{avoid}</p>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
