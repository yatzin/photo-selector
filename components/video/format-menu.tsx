"use client"

import { useState } from "react"
import { Check, ChevronDown, Monitor, PanelRight, PanelTop, RectangleHorizontal, RectangleVertical } from "lucide-react"
import { toast } from "sonner"
import { buttonVariants } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { FieldHelp } from "@/components/ui/field-help"
import { setFormatAction } from "@/lib/actions/video-projects"
import { ORIENTATIONS, orientationOf, RESOLUTIONS, resolutionOf, sizeFor, sizeText, type Orientation, type ResolutionId } from "@/lib/video/format"
import { cn } from "@/lib/utils"

// The two format menus in the middle of the editor's top bar: Orientation
// (Horizontal or Vertical, with a picture of the frame) and Resolution (a
// plain name, the pixel size, and what it is good for). Choosing saves at once
// (the server owns the size) and the preview and export follow. Greyed while
// the project exports, since the size is part of what an export is made from.

const ORIENTATION_ICON = { horizontal: RectangleHorizontal, vertical: RectangleVertical } as const

/** Where the preview sits in the editor (a view setting, kept in this browser, not part of the project). */
export const PREVIEW_LAYOUTS: { id: Orientation; label: string; note: string; icon: typeof PanelTop }[] = [
  { id: "horizontal", label: "Horizontal", note: "Preview above the timeline.", icon: PanelTop },
  { id: "vertical", label: "Vertical", note: "Preview on the right, timeline on the left. Good for tall video.", icon: PanelRight },
]

export function FormatMenus({ width, height, disabled, folder, onChanged, layout, onLayout }: { width: number; height: number; disabled: boolean; folder: string; onChanged: (size: { width: number; height: number }) => void; layout: Orientation; onLayout: (layout: Orientation) => void }) {
  const [busy, setBusy] = useState(false)
  const orientation = orientationOf(width, height)
  const resolution = resolutionOf(width, height)
  const current = RESOLUTIONS.find((r) => r.id === resolution)
  const OrientationIcon = ORIENTATION_ICON[orientation]

  async function choose(change: { orientation?: Orientation; resolution?: ResolutionId }) {
    if (busy) return
    setBusy(true)
    try {
      const r = await setFormatAction(folder, change)
      if ("error" in r) return void toast.error(r.error)
      onChanged(r)
    } catch {
      toast.error("Couldn't change the format.")
    } finally {
      setBusy(false)
    }
  }

  const trigger = cn(buttonVariants({ variant: "outline", size: "sm" }), "gap-1.5")
  const off = disabled || busy

  return (
    <div role="group" aria-label="Video format" className="flex items-center gap-2">
      <DropdownMenu>
        <DropdownMenuTrigger disabled={off} className={trigger} aria-label={`Orientation: ${ORIENTATIONS.find((o) => o.id === orientation)!.label}`} title={disabled ? "Not while exporting" : "Wide or tall video"}>
          <OrientationIcon className="h-4 w-4" />
          <ChevronDown className="h-3.5 w-3.5 opacity-60" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="center" className="min-w-72">
          <DropdownMenuGroup>
            <DropdownMenuLabel>Orientation</DropdownMenuLabel>
          </DropdownMenuGroup>
          {ORIENTATIONS.map((o) => {
            const Icon = ORIENTATION_ICON[o.id]
            return (
              <DropdownMenuItem key={o.id} onClick={() => o.id !== orientation && void choose({ orientation: o.id })} className="items-start gap-2.5 py-2">
                <Icon className="mt-0.5 h-5 w-5 shrink-0" />
                <span className="min-w-0 flex-1">
                  <span className="block font-medium">{o.label}</span>
                  <span className="block whitespace-normal text-xs text-muted-foreground">{o.note}</span>
                </span>
                {o.id === orientation && <Check className="mt-0.5 h-4 w-4 shrink-0" />}
              </DropdownMenuItem>
            )
          })}
        </DropdownMenuContent>
      </DropdownMenu>
      <FieldHelp id="video.orientation" />

      <DropdownMenu>
        <DropdownMenuTrigger disabled={off} className={trigger} aria-label={`Resolution: ${current?.label ?? sizeText(width, height)}`} title={disabled ? "Not while exporting" : "How sharp the exported video is"}>
          <Monitor className="h-4 w-4" />
          <span className="hidden sm:inline">{current?.label ?? "Custom"}</span>
          <ChevronDown className="h-3.5 w-3.5 opacity-60" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="center" className="min-w-80">
          <DropdownMenuGroup>
            <DropdownMenuLabel>Resolution</DropdownMenuLabel>
          </DropdownMenuGroup>
          {RESOLUTIONS.map((r) => {
            const size = sizeFor(orientation, r.id)
            return (
              <DropdownMenuItem key={r.id} onClick={() => r.id !== resolution && void choose({ resolution: r.id })} className="items-start gap-2.5 py-2">
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-baseline gap-x-2">
                    <span className="font-medium">{r.label}</span>
                    <span className="text-xs tabular-nums text-muted-foreground">{sizeText(size.width, size.height)}</span>
                    {r.badge && <span className="rounded-full bg-primary/10 px-1.5 py-px text-[10px] font-medium text-primary">{r.badge}</span>}
                  </span>
                  <span className="block whitespace-normal text-xs text-muted-foreground">{r.note}</span>
                </span>
                {r.id === resolution && <Check className="mt-0.5 h-4 w-4 shrink-0" />}
              </DropdownMenuItem>
            )
          })}
          {!current && <DropdownMenuItem disabled>Custom size {sizeText(width, height)}: pick one above to change it.</DropdownMenuItem>}
        </DropdownMenuContent>
      </DropdownMenu>
      <FieldHelp id="video.resolution" />

      <div aria-hidden className="mx-1 h-5 w-px bg-border" />
      <DropdownMenu>
        <DropdownMenuTrigger className={trigger} aria-label={`Preview layout: ${PREVIEW_LAYOUTS.find((l) => l.id === layout)!.label}`} title="Where the preview sits next to the timeline">
          {(() => {
            const Icon = PREVIEW_LAYOUTS.find((l) => l.id === layout)!.icon
            return <Icon className="h-4 w-4" />
          })()}
          <span className="hidden xl:inline">Preview</span>
          <ChevronDown className="h-3.5 w-3.5 opacity-60" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="center" className="min-w-72">
          <DropdownMenuGroup>
            <DropdownMenuLabel>Preview layout</DropdownMenuLabel>
          </DropdownMenuGroup>
          {PREVIEW_LAYOUTS.map((l) => (
            <DropdownMenuItem key={l.id} onClick={() => l.id !== layout && onLayout(l.id)} className="items-start gap-2.5 py-2">
              <l.icon className="mt-0.5 h-5 w-5 shrink-0" />
              <span className="min-w-0 flex-1">
                <span className="block font-medium">{l.label}</span>
                <span className="block whitespace-normal text-xs text-muted-foreground">{l.note}</span>
              </span>
              {l.id === layout && <Check className="mt-0.5 h-4 w-4 shrink-0" />}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      <FieldHelp id="video.preview-layout" />
    </div>
  )
}
