"use client"

import { useCallback, useEffect, useRef, useState, type ComponentProps, type ReactNode, type RefObject } from "react"
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog"
import { X, type LucideIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"

// The editor dialogs' shared shell: one anatomy for every dialog in the video
// editor. A header (an icon chip in the editor accent, the title, a one-line
// subtitle naming what's edited, Close), a body that scrolls on its own, and
// a footer that stays put (a quiet destructive action on the left, a live
// summary of what Apply will do, Cancel and the primary action on the right).
// Centred from 640 px wide, a bottom sheet below that. It scales and fades in
// and out (still with reduced motion); the dialog stays mounted until its exit
// has played, then the parent's onClose unmounts it, and focus goes back to
// the element that opened it (or `returnFocus`).

/** A dialog's open state: `close` plays the exit, runs `then` (the dialog's edit) and then the parent's onClose. */
export type EditorDialogState = {
  open: boolean
  close: (then?: () => void) => void
  onOpenChangeComplete: (open: boolean) => void
}

export function useEditorDialog(onClose: () => void): EditorDialogState {
  const [open, setOpen] = useState(true)
  const after = useRef<(() => void) | null>(null)
  const closeRef = useRef(onClose)
  useEffect(() => {
    closeRef.current = onClose
  })
  const close = useCallback((then?: () => void) => {
    after.current = then ?? null
    setOpen(false)
  }, [])
  const onOpenChangeComplete = useCallback((isOpen: boolean) => {
    if (isOpen) return
    const then = after.current
    after.current = null
    then?.()
    closeRef.current()
  }, [])
  return { open, close, onOpenChangeComplete }
}

/** The element marked data-initial-focus, else the body's first control (not the header's Close). */
function firstFocus(): HTMLElement | true {
  const popup = document.querySelector("[data-editor-dialog]")
  return (
    popup?.querySelector<HTMLElement>("[data-initial-focus]") ??
    popup?.querySelector<HTMLElement>("[data-dialog-body] :is(input:not([disabled]), textarea:not([disabled]), button:not([disabled]), [tabindex='0'])") ??
    true
  )
}

const SIZES = {
  sm: "sm:max-w-[28rem]",
  md: "sm:max-w-[36rem]",
  lg: "sm:max-w-[52rem]",
  xl: "sm:max-w-[64rem]",
} as const

export function EditorDialog({ state, icon: Icon, title, subtitle, size = "md", onSubmit, footer, children, initialFocus, returnFocus, bodyClassName, formProps, dismissible = true }: {
  state: EditorDialogState
  icon: LucideIcon
  title: string
  /** One line naming what's edited ("Between Beach.mp4 and Sunset.mp4"); the dialog's description. */
  subtitle?: ReactNode
  size?: keyof typeof SIZES
  /** Enter in a field (and the primary button, type="submit") calls it. */
  onSubmit?: () => void
  /** The footer's content: a DialogFooter. */
  footer: ReactNode
  children: ReactNode
  /** What gets the focus on open (default: the element marked data-initial-focus, else the first control). */
  initialFocus?: RefObject<HTMLElement | null>
  /** Where the focus goes on close when the element that opened the dialog is gone. */
  returnFocus?: () => HTMLElement | null
  bodyClassName?: string
  formProps?: Omit<ComponentProps<"form">, "onSubmit" | "className" | "children">
  /** False while busy: Esc and outside presses don't close it. */
  dismissible?: boolean
}) {
  // The element focused when the dialog opened (closing the clip menu focuses the clip first).
  const [opener] = useState<HTMLElement | null>(() => (typeof document === "undefined" ? null : (document.activeElement as HTMLElement | null)))
  const finalFocus = () => {
    const back = opener && opener.isConnected && opener !== document.body ? opener : returnFocus?.()
    return back ?? true
  }
  return (
    <DialogPrimitive.Root
      open={state.open}
      onOpenChange={(open) => {
        if (!open && dismissible) state.close()
      }}
      onOpenChangeComplete={state.onOpenChangeComplete}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Backdrop className="editor-dialog-backdrop fixed inset-0 z-50 bg-black/35 supports-backdrop-filter:backdrop-blur-[2px] dark:bg-black/60" />
        <DialogPrimitive.Popup
          initialFocus={initialFocus ?? firstFocus}
          finalFocus={finalFocus}
          data-editor-dialog
          className={cn(
            "editor-dialog fixed z-50 flex flex-col overflow-hidden bg-popover text-sm text-popover-foreground outline-none",
            // A bottom sheet on narrow screens; centred from 640 px.
            "inset-x-0 bottom-0 max-h-[calc(100dvh-1rem)] rounded-t-2xl pb-[env(safe-area-inset-bottom)]",
            "sm:inset-x-auto sm:bottom-auto sm:top-1/2 sm:left-1/2 sm:w-[calc(100%-2rem)] sm:max-h-[min(calc(100dvh-2rem),56rem)] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-2xl sm:pb-0",
            SIZES[size]
          )}
        >
          <span aria-hidden className="mx-auto mt-2 h-1 w-9 shrink-0 rounded-full bg-foreground/15 sm:hidden" />
          <header className="flex shrink-0 items-start gap-3 border-b border-border px-4 pt-3 pb-3 sm:px-5 sm:pt-4">
            <span aria-hidden className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-xl bg-editor-accent/12 text-editor-accent ring-1 ring-editor-accent/25 ring-inset">
              <Icon className="size-[18px]" strokeWidth={2} />
            </span>
            <div className="grid min-w-0 flex-1 gap-0.5 pt-0.5">
              <DialogPrimitive.Title className="font-heading text-[15px] leading-5 font-semibold tracking-tight">{title}</DialogPrimitive.Title>
              {subtitle && <DialogPrimitive.Description className="truncate text-[13px] leading-5 text-muted-foreground">{subtitle}</DialogPrimitive.Description>}
            </div>
            <DialogPrimitive.Close
              disabled={!dismissible}
              render={<Button type="button" variant="ghost" size="icon" className="-mt-0.5 -mr-1.5 rounded-lg text-muted-foreground hover:text-foreground pointer-coarse:size-11" />}
            >
              <X />
              <span className="sr-only">Close</span>
            </DialogPrimitive.Close>
          </header>
          <form
            {...formProps}
            noValidate
            className="flex min-h-0 flex-1 flex-col"
            onSubmit={(e) => {
              e.preventDefault()
              // A field with an error takes the focus, so its message is read and fixed first.
              e.currentTarget.querySelector<HTMLElement>("[aria-invalid=true]")?.focus()
              onSubmit?.()
            }}
          >
            <div className={cn("min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4 [scrollbar-gutter:stable] sm:px-5", bodyClassName)} data-dialog-body>
              {children}
            </div>
            {footer}
          </form>
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}

/** The footer: `start` (a destructive action) on the left, a live `summary`, then the buttons (children). */
export function DialogFooter({ start, summary, children }: { start?: ReactNode; summary?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-2 border-t border-border bg-muted/40 px-4 py-3 sm:flex-nowrap sm:px-5 dark:bg-black/10" data-dialog-footer>
      <p aria-live="polite" className="order-first min-w-0 basis-full text-xs leading-snug text-muted-foreground empty:hidden sm:order-none sm:basis-auto sm:flex-1 sm:text-right" data-dialog-summary>
        {summary}
      </p>
      {start && <div className="mr-auto flex items-center gap-2 sm:order-first sm:mr-2">{start}</div>}
      <div className="ml-auto flex shrink-0 items-center gap-2">{children}</div>
    </div>
  )
}

/** The footer's Cancel: closes without changing anything (the first focus of a confirmation, with `initialFocus`). */
export function CancelButton({ state, label = "Cancel", disabled, initialFocus }: { state: EditorDialogState; label?: string; disabled?: boolean; initialFocus?: boolean }) {
  return (
    <Button type="button" variant="outline" size="lg" disabled={disabled} className="bg-card px-3.5 pointer-coarse:h-11" onClick={() => state.close()} data-initial-focus={initialFocus || undefined}>
      {label}
    </Button>
  )
}

/** The primary action (a submit button). With `disabledReason` it stays focusable, does nothing and shows why on hover or focus. */
export function PrimaryButton({ children, disabledReason, busy, ...props }: ComponentProps<typeof Button> & { disabledReason?: string | null; busy?: boolean }) {
  const blocked = Boolean(disabledReason) || busy
  const button = (
    <Button
      type="submit"
      size="lg"
      {...props}
      aria-disabled={blocked || undefined}
      onClick={(e) => {
        if (blocked) e.preventDefault()
        else props.onClick?.(e)
      }}
      className={cn("bg-editor-accent px-4 font-semibold text-editor-accent-foreground shadow-sm hover:bg-editor-accent/88 aria-disabled:cursor-not-allowed aria-disabled:opacity-50 pointer-coarse:h-11", props.className)}
      data-primary
    >
      {children}
    </Button>
  )
  if (!disabledReason) return button
  return (
    <Tooltip>
      <TooltipTrigger render={button} />
      <TooltipContent>{disabledReason}</TooltipContent>
    </Tooltip>
  )
}

/** A quiet destructive action for the footer's left ("Remove transition"). */
export function RemoveButton({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return (
    <Button type="button" variant="ghost" size="lg" className="px-2.5 text-destructive hover:bg-destructive/10 hover:text-destructive pointer-coarse:h-11" onClick={onClick} data-remove>
      {children}
    </Button>
  )
}

/** A body section: a small-caps label (with an optional control at its right) over its content. */
export function DialogSection({ title, action, children, className, id }: { title: string; action?: ReactNode; children: ReactNode; className?: string; id?: string }) {
  const labelId = id ? `${id}-label` : undefined
  return (
    <section aria-labelledby={labelId} className={cn("grid min-w-0 content-start gap-2.5", className)}>
      <div className="flex min-h-6 items-center justify-between gap-2">
        <h3 id={labelId} className="section-label">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  )
}
