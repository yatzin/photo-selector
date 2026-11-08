"use client"

import { useRef, type KeyboardEvent, type PointerEvent, type ReactNode, type Ref } from "react"
import { CircleAlert, Link2, Minus, Plus } from "lucide-react"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { scrubValue } from "@/lib/video/dialog-ui"
import { cn } from "@/lib/utils"

// NumberField: a typed number with its unit inside the field (s, dB),
// steppers either side, Up and Down to step (Shift ten steps, Alt a tenth),
// and its message in place under it (the error, the reason it's disabled,
// or a hint). The label can scrub: drag it left or right to change the value
// (Shift for fine steps). A linked field shows a link icon saying what it
// follows. The text is the caller's, so a half-typed number stays as typed.

const decimalsOf = (step: number) => Math.max(0, Math.ceil(-Math.log10(step) - 1e-9))

/** A label that changes a number when dragged sideways: `step` per 4 px, a tenth of it with Shift. */
export function ScrubLabel({ htmlFor, id, children, value, step, min, max, disabled, onScrub }: {
  htmlFor: string
  id?: string
  children: ReactNode
  value: number | null
  step: number
  min?: number
  max?: number
  disabled?: boolean
  onScrub: (value: number) => void
}) {
  const drag = useRef<{ x: number; start: number; moved: boolean } | null>(null)
  const dragged = useRef(false)
  const onDown = (e: PointerEvent<HTMLLabelElement>) => {
    if (disabled || e.button !== 0 || value === null) return
    drag.current = { x: e.clientX, start: value, moved: false }
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const onMove = (e: PointerEvent<HTMLLabelElement>) => {
    const d = drag.current
    if (!d) return
    const dx = e.clientX - d.x
    if (!d.moved && Math.abs(dx) < 3) return
    d.moved = true
    onScrub(scrubValue(d.start, dx, { step, min, max, fine: e.shiftKey }))
  }
  const onUp = (e: PointerEvent<HTMLLabelElement>) => {
    dragged.current = drag.current?.moved === true
    drag.current = null
    e.currentTarget.releasePointerCapture(e.pointerId)
  }
  return (
    <label
      htmlFor={htmlFor}
      id={id}
      title={disabled ? undefined : "Drag sideways to change (Shift for fine steps)"}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={() => (drag.current = null)}
      onClick={(e) => {
        // A drag isn't a click: the field doesn't take the focus.
        if (dragged.current) e.preventDefault()
        dragged.current = false
      }}
      className={cn("field-label select-none", !disabled && "cursor-ew-resize touch-none")}
      data-scrub-label
    >
      {children}
    </label>
  )
}

export function NumberField({ id, label, value, onChange, unit, step, min, max, disabled, disabledReason, error, hint, linked, scrub = true, autoFocus, inputRef, className, inputClassName, onEnter }: {
  id: string
  label: string
  /** The field's text. */
  value: string
  onChange: (text: string) => void
  unit?: string
  step: number
  min?: number
  max?: number
  disabled?: boolean
  /** Shown in place of the hint while disabled. */
  disabledReason?: string
  error?: string | null
  hint?: ReactNode
  /** What this field follows ("End follows Start and Length"), shown as a link icon with a tooltip. */
  linked?: string
  scrub?: boolean
  autoFocus?: boolean
  inputRef?: Ref<HTMLInputElement>
  className?: string
  inputClassName?: string
  /** Enter in the field (default: the form submits). */
  onEnter?: () => void
}) {
  const n = value.trim() === "" ? null : Number(value)
  const num = n !== null && Number.isFinite(n) ? n : null
  const fmt = (v: number) => String(Number(v.toFixed(decimalsOf(step) + 1)))
  const clamp = (v: number) => Math.min(max ?? Infinity, Math.max(min ?? -Infinity, v))
  const stepBy = (dir: 1 | -1, mult = 1) => onChange(fmt(clamp((num ?? min ?? 0) + dir * step * mult)))
  const message = disabled ? disabledReason : error
  const describedBy = `${id}-note`

  function key(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault()
      stepBy(e.key === "ArrowUp" ? 1 : -1, e.shiftKey ? 10 : e.altKey ? 0.1 : 1)
    } else if (e.key === "Enter" && onEnter) {
      e.preventDefault()
      onEnter()
    }
  }

  const stepper = (dir: 1 | -1) => (
    <button
      type="button"
      tabIndex={-1}
      aria-label={`${dir > 0 ? "Increase" : "Decrease"} ${label}`}
      disabled={disabled || (num !== null && (dir > 0 ? max !== undefined && num >= max : min !== undefined && num <= min))}
      onClick={(e) => stepBy(dir, e.shiftKey ? 10 : 1)}
      className="flex w-8 shrink-0 items-center justify-center text-muted-foreground outline-none hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-40 pointer-coarse:w-11"
    >
      {dir > 0 ? <Plus className="size-3.5" /> : <Minus className="size-3.5" />}
    </button>
  )

  return (
    <div className={cn("grid min-w-0 content-start gap-1.5", className)}>
      <div className="flex min-h-5 items-center gap-1.5">
        {scrub ? (
          <ScrubLabel htmlFor={id} value={num} step={step} min={min} max={max} disabled={disabled} onScrub={(v) => onChange(fmt(v))}>
            {label}
          </ScrubLabel>
        ) : (
          <label htmlFor={id} className="field-label">{label}</label>
        )}
        {linked && (
          <Tooltip>
            <TooltipTrigger
              render={<button type="button" aria-label={linked} className="flex size-5 items-center justify-center rounded text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring" />}
            >
              <Link2 className="size-3.5" />
            </TooltipTrigger>
            <TooltipContent>{linked}</TooltipContent>
          </Tooltip>
        )}
      </div>
      <div
        className={cn(
          "flex h-9 min-w-0 items-stretch overflow-hidden rounded-lg border border-input bg-background transition-[border-color,box-shadow] focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/40 dark:bg-input/30 pointer-coarse:h-11",
          error && !disabled && "border-destructive focus-within:border-destructive focus-within:ring-destructive/25",
          disabled && "opacity-55"
        )}
        data-number-field
      >
        {stepper(-1)}
        <div className="relative flex min-w-0 flex-1 items-center border-x border-input">
          <input
            ref={inputRef}
            id={id}
            type="text"
            inputMode="decimal"
            autoComplete="off"
            spellCheck={false}
            autoFocus={autoFocus}
            value={value}
            disabled={disabled}
            aria-invalid={error && !disabled ? true : undefined}
            aria-describedby={describedBy}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={key}
            onFocus={(e) => e.currentTarget.select()}
            className={cn("h-full w-full min-w-0 bg-transparent px-2 text-center text-sm font-medium tabular-nums outline-none disabled:cursor-not-allowed", unit && "pr-6", inputClassName)}
          />
          {unit && <span aria-hidden className="pointer-events-none absolute right-2 text-xs text-muted-foreground">{unit}</span>}
        </div>
        {stepper(1)}
      </div>
      <p id={describedBy} className={cn("flex min-h-4 items-start gap-1 text-xs leading-snug", error && !disabled ? "text-destructive" : "text-muted-foreground")}>
        {error && !disabled && <CircleAlert aria-hidden className="mt-px size-3.5 shrink-0" />}
        <span>{message ?? hint}</span>
      </p>
    </div>
  )
}
