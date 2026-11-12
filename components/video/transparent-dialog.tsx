"use client"

import { useDeferredValue, useEffect, useMemo, useRef, useState, type PointerEvent } from "react"
import { Eraser, Loader2, Pipette } from "lucide-react"
import { Button } from "@/components/ui/button"
import { MAX_TOLERANCE, pixelAt, removeBackground, type KeyOptions, type Rgb } from "@/lib/video/chroma"
import { CancelButton, DialogFooter, DialogSection, EditorDialog, PrimaryButton, useEditorDialog } from "./ui/editor-dialog"

// The Make background transparent dialog for an image clip. Pick the
// background colour with the dropper (click the picture), then set how close a
// colour has to be to go (Tolerance) and whether only areas touching the edge
// go (so the same colour inside the subject stays). The picture shows the
// result live over a checkerboard, from a reduced copy with the same maths
// the server then runs on the file (lib/video/chroma). Apply stores a new
// image with a transparent background and points the clip at it; the
// original stays in Project media.

const WORK_PX = 640 // the live preview's longest side
const DEFAULT_TOLERANCE = 18

const CHECKER = "repeating-conic-gradient(#d4d4d8 0% 25%, #fafafa 0% 50%) 50% / 16px 16px"

export function TransparentDialog({ imageUrl, name, onApply, onClose, returnFocus }: {
  /** The image's picture (the player's own copy). */
  imageUrl: string
  name: string
  /** Makes the new image from the options; resolves to an error message, or null when it worked (the dialog then closes). */
  onApply: (options: KeyOptions) => Promise<string | null>
  onClose: () => void
  returnFocus?: () => HTMLElement | null
}) {
  const dialog = useEditorDialog(onClose)
  const canvas = useRef<HTMLCanvasElement>(null)
  const [pixels, setPixels] = useState<{ data: Uint8ClampedArray; w: number; h: number } | null>(null)
  const [loadError, setLoadError] = useState(false)
  const [key, setKey] = useState<Rgb | null>(null)
  const [picking, setPicking] = useState(true)
  const [hover, setHover] = useState<Rgb | null>(null)
  const [tolerance, setTolerance] = useState(DEFAULT_TOLERANCE)
  const [contiguous, setContiguous] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const deferredTolerance = useDeferredValue(tolerance)

  // The picture at a working size.
  useEffect(() => {
    let live = true
    const img = new Image()
    img.onload = () => {
      if (!live) return
      const k = Math.min(1, WORK_PX / Math.max(img.naturalWidth, img.naturalHeight))
      const w = Math.max(1, Math.round(img.naturalWidth * k))
      const h = Math.max(1, Math.round(img.naturalHeight * k))
      const c = document.createElement("canvas")
      c.width = w
      c.height = h
      const ctx = c.getContext("2d", { willReadFrequently: true })
      if (!ctx) return setLoadError(true)
      ctx.drawImage(img, 0, 0, w, h)
      try {
        setPixels({ data: ctx.getImageData(0, 0, w, h).data, w, h })
      } catch {
        setLoadError(true)
      }
    }
    img.onerror = () => live && setLoadError(true)
    img.src = imageUrl
    return () => {
      live = false
    }
  }, [imageUrl])

  const options: KeyOptions | null = useMemo(() => (key ? { key, tolerance: deferredTolerance, contiguous } : null), [key, deferredTolerance, contiguous])
  const shown = useMemo(() => (pixels && options ? removeBackground(pixels.data, pixels.w, pixels.h, options) : pixels?.data ?? null), [pixels, options])

  useEffect(() => {
    const c = canvas.current
    if (!c || !pixels || !shown) return
    c.width = pixels.w
    c.height = pixels.h
    c.getContext("2d")?.putImageData(new ImageData(new Uint8ClampedArray(shown), pixels.w, pixels.h), 0, 0)
  }, [pixels, shown])

  /** The working picture's colour under the pointer (from the original pixels, not the result). */
  function colourAt(e: PointerEvent<HTMLCanvasElement>): Rgb | null {
    if (!pixels) return null
    const r = e.currentTarget.getBoundingClientRect()
    return pixelAt(pixels.data, pixels.w, pixels.h, ((e.clientX - r.left) / r.width) * pixels.w, ((e.clientY - r.top) / r.height) * pixels.h)
  }

  async function apply() {
    if (!options || busy) return
    setBusy(true)
    setError(null)
    const failed = await onApply({ ...options, tolerance })
    setBusy(false)
    if (failed) setError(failed)
    else dialog.close()
  }

  const swatch = (c: Rgb | null) => (c ? `rgb(${c[0]} ${c[1]} ${c[2]})` : undefined)

  return (
    <EditorDialog
      state={dialog}
      icon={Eraser}
      title="Make background transparent"
      subtitle={name}
      size="lg"
      onSubmit={apply}
      returnFocus={returnFocus}
      footer={
        <DialogFooter summary={error ?? (key ? undefined : "Pick the background colour first.")}>
          <CancelButton state={dialog} disabled={busy} />
          <PrimaryButton busy={busy} disabledReason={key ? null : "Pick the background colour first."}>
            {busy && <Loader2 className="h-4 w-4 animate-spin" />} Apply
          </PrimaryButton>
        </DialogFooter>
      }
    >
      <div className="grid gap-4">
        <div className="flex max-h-[50dvh] min-h-40 items-center justify-center overflow-hidden rounded-lg border" style={{ background: CHECKER }}>
          {loadError ? (
            <p className="p-6 text-sm text-muted-foreground">This picture couldn&apos;t be loaded.</p>
          ) : !pixels ? (
            <Loader2 className="my-10 h-5 w-5 animate-spin text-muted-foreground" />
          ) : (
            <canvas
              ref={canvas}
              aria-label="The picture: click a colour to make it transparent"
              onPointerMove={(e) => picking && setHover(colourAt(e))}
              onPointerLeave={() => setHover(null)}
              onPointerDown={(e) => {
                if (!picking) return
                const c = colourAt(e)
                if (c) {
                  setKey(c)
                  setPicking(false)
                }
              }}
              className="max-h-[50dvh] max-w-full touch-none object-contain"
              style={{ cursor: picking ? "crosshair" : "default" }}
            />
          )}
        </div>

        <DialogSection title="Background colour">
          <div className="flex flex-wrap items-center gap-3">
            <Button type="button" variant={picking ? "default" : "outline"} onClick={() => setPicking((v) => !v)} aria-pressed={picking} title="Click the picture to choose the background colour">
              <Pipette className="h-4 w-4" /> {picking ? "Click the picture…" : key ? "Pick again" : "Pick colour"}
            </Button>
            <span className="flex items-center gap-2 text-sm text-muted-foreground">
              <span aria-hidden className="h-6 w-6 rounded border" style={{ background: swatch(picking && hover ? hover : key) ?? "transparent" }} />
              {picking && hover ? `rgb(${hover.join(", ")})` : key ? `rgb(${key.join(", ")})` : "None yet"}
            </span>
          </div>
        </DialogSection>

        <DialogSection title="How much goes">
          <div className="grid gap-3">
            <label className="grid gap-1 text-sm">
              <span className="flex justify-between">
                <span>Tolerance</span>
                <span className="tabular-nums text-muted-foreground">{tolerance}</span>
              </span>
              <input type="range" min={0} max={MAX_TOLERANCE / 2} step={1} value={tolerance} onChange={(e) => setTolerance(Number(e.target.value))} disabled={!key} className="w-full accent-[var(--editor-accent,currentColor)]" />
              <span className="text-xs text-muted-foreground">How close to the picked colour a colour has to be to go. Raise it if a fringe or shaded patches are left.</span>
            </label>
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" checked={contiguous} onChange={(e) => setContiguous(e.target.checked)} disabled={!key} className="mt-0.5" />
              <span>
                Only areas connected to the edge
                <span className="block text-xs text-muted-foreground">Keeps the same colour inside the subject (dots, eyes, holes). Turn off to remove it everywhere.</span>
              </span>
            </label>
          </div>
        </DialogSection>
      </div>
    </EditorDialog>
  )
}
