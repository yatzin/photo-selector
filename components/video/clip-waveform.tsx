"use client"

import { memo, useEffect, useRef, type RefObject } from "react"
import { waveformBars } from "@/lib/video/peaks"
import { useAssetPeaks } from "./use-asset-peaks"

// A clip's sound drawn over its thumbnail: bars mirrored around the middle,
// for the part of the asset the clip plays [in, out), over a dark scrim. It
// redraws (once a frame at most) when the zoom, a trim or the row height
// changes, never during playback. A clip wider than MAX_CANVAS device px gets
// a canvas that size over the part in view, moved along as the view scrolls.

const STEP = 2 // css px per bar, gap included
const MAX_CANVAS = 4096 // device px

export const ClipWaveform = memo(function ClipWaveform({
  folder, assetId, inSec, outSec, width, height, left, muted, scroller,
}: {
  folder: string
  assetId: string
  inSec: number
  outSec: number
  /** The clip's width and height on screen (css px). */
  width: number
  height: number
  /** The clip's left edge in the scrolled content (css px from the tracks' time 0). */
  left: number
  muted: boolean
  /** The timeline's scroll viewport, for very wide clips. */
  scroller: RefObject<HTMLDivElement | null>
}) {
  const peaks = useAssetPeaks(folder, assetId, true)
  const canvas = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const c = canvas.current
    const el = scroller.current
    if (!c || !peaks || !(width > 0) || !(height > 0)) return
    let frame = 0
    const draw = () => {
      frame = 0
      const dpr = window.devicePixelRatio || 1
      const maxCss = Math.floor(MAX_CANVAS / dpr / STEP) * STEP
      let start = 0
      let w = width
      if (width > maxCss) {
        // The window in view, centred on the viewport, on the bar grid so bars don't shimmer as it moves.
        const view = el ? el.scrollLeft - left - (maxCss - el.clientWidth) / 2 : 0
        start = Math.floor(Math.max(0, Math.min(width - maxCss, view)) / STEP) * STEP
        w = maxCss
      }
      c.style.left = `${start}px`
      c.style.width = `${w}px`
      c.style.height = `${height}px`
      c.width = Math.round(w * dpr)
      c.height = Math.round(height * dpr)
      const ctx = c.getContext("2d")
      if (!ctx) return
      ctx.clearRect(0, 0, c.width, c.height)
      const span = outSec - inSec
      const bars = waveformBars(peaks.peaks, peaks.rate, inSec + (start / width) * span, inSec + ((start + w) / width) * span, w, STEP)
      ctx.fillStyle = muted ? "rgba(255, 255, 255, 0.3)" : "rgba(255, 255, 255, 0.7)"
      const mid = c.height / 2
      const barW = Math.max(1, Math.round(STEP * dpr) - 1)
      const half = (c.height - 2 * dpr) / 2
      bars.forEach((b, j) => {
        const h = Math.max(dpr / 2, b * half)
        ctx.fillRect(Math.round(j * STEP * dpr), Math.round(mid - h), barW, Math.max(1, Math.round(2 * h)))
      })
    }
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(draw)
    }
    schedule()
    const wide = width * (window.devicePixelRatio || 1) > MAX_CANVAS
    if (wide) el?.addEventListener("scroll", schedule, { passive: true })
    return () => {
      cancelAnimationFrame(frame)
      if (wide) el?.removeEventListener("scroll", schedule)
    }
  }, [peaks, inSec, outSec, width, height, left, muted, scroller])

  if (!peaks) return null
  return (
    <>
      <div aria-hidden className="pointer-events-none absolute inset-0 bg-black/35" />
      <canvas ref={canvas} aria-hidden className="pointer-events-none absolute top-0" />
    </>
  )
})
