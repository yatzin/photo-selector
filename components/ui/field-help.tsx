"use client"

import { useEffect, useState } from "react"
import { CircleHelp } from "lucide-react"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import type { FieldHelpEntry, FieldHelpMap } from "@/lib/field-help"
import { cn } from "@/lib/utils"

// The help text is a few dozen KB across every form, so it isn't part of the page: it's fetched the
// first time someone points at, focuses or opens a "?", then kept for the rest of the visit.
let helpText: Promise<FieldHelpMap> | null = null
function loadHelpText(): Promise<FieldHelpMap> {
  helpText ??= import("@/lib/field-help").then((m) => m.FIELD_HELP)
  return helpText
}

/**
 * The small "?" beside a field label. Opens a popover with what the field is, how HomeCenter
 * uses it and, where the choices behave differently, what each one does. Text comes from
 * lib/field-help (a test keeps ids and entries in step).
 */
export function FieldHelp({ id, className }: { id: string; className?: string }) {
  const [entry, setEntry] = useState<FieldHelpEntry | null | undefined>(undefined) // undefined = not asked for yet
  const [open, setOpen] = useState(false)

  function warm() {
    if (entry !== undefined) return
    void loadHelpText().then((all) => setEntry(all[id] ?? null))
  }

  useEffect(() => {
    if (open) warm()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        type="button"
        aria-label="Help for this field"
        // Inside a <label> a click would also toggle its checkbox or focus its input.
        onClick={(e) => e.stopPropagation()}
        onPointerEnter={warm}
        onFocus={warm}
        className={cn(
          "relative inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors max-sm:before:absolute max-sm:before:top-1/2 max-sm:before:left-1/2 max-sm:before:size-10 max-sm:before:-translate-1/2",
          "hover:text-primary focus-visible:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 data-popup-open:text-primary",
          className,
        )}
      >
        <CircleHelp className="h-3.5 w-3.5" aria-hidden="true" />
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={6}
        className="w-80 max-w-[calc(100vw-2rem)] max-h-[min(70vh,28rem)] gap-0 overflow-y-auto border-t-2 border-t-primary p-0"
      >
        <div className="space-y-3 p-3.5">
          {entry === undefined && <p className="text-sm text-muted-foreground">Loading…</p>}
          {entry === null && <p className="text-sm text-muted-foreground">No help written for this field yet.</p>}
          {entry && (
            <>
              <div className="font-heading text-sm font-semibold leading-snug">{entry.title}</div>
              <p className="text-sm leading-relaxed text-popover-foreground">{entry.what}</p>
              {entry.use && (
                <div className="space-y-1">
                  <div className="text-[11px] font-semibold uppercase tracking-wide text-primary">In Photo Selector</div>
                  <p className="text-sm leading-relaxed text-muted-foreground">{entry.use}</p>
                </div>
              )}
              {entry.values && entry.values.length > 0 && (
                <div className="space-y-1.5">
                  <div className="text-[11px] font-semibold uppercase tracking-wide text-primary">Choices</div>
                  <dl className="space-y-1.5">
                    {entry.values.map((v) => (
                      <div key={v.label} className="rounded-md bg-muted/60 px-2.5 py-1.5">
                        <dt className="text-sm font-medium">{v.label}</dt>
                        <dd className="text-sm leading-snug text-muted-foreground">{v.effect}</dd>
                      </div>
                    ))}
                  </dl>
                </div>
              )}
            </>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
