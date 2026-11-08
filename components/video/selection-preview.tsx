"use client"

import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react"
import { useTheme } from "next-themes"
import { cn } from "@/lib/utils"
import { waveformBars } from "@/lib/video/peaks"
import { formatClock, selectionOffset } from "@/lib/video/source-precision"
import { timeToX, xToTime, type SourceSelection } from "@/lib/video/source-window"
import { useAssetPeaksState } from "./use-asset-peaks"
import type { SelectionPlayer } from "./use-selection-player"
import { PreviewMonitor, PreviewTransport } from "./ui/preview-transport"

// The Edit length dialog's Preview column: the selection's picture (a video
// clip's own source in a black letterboxed box, no project transforms) or, for
// a sound file, the selection's waveform drawn large with a playhead, above
// the shared transport (components/video/ui/preview-transport): Play/Pause, a
// seek bar over the selection only with its time, loop, mute and volume.
// Space toggles play anywhere in the column except on its controls.

const WAVE_HEIGHT = 140 // css px
const STEP = 3 // css px per bar, gap included

/** Space toggles play, unless a control that uses it has the focus. */
export function spaceToggles(e: KeyboardEvent<HTMLElement>, toggle: () => void) {
  if (e.key !== " " || e.repeat) return
  const t = e.target as HTMLElement
  if (t.closest("button, input, select, textarea, a")) return
  e.preventDefault()
  toggle()
}

/** The selection's waveform across the column, with the playhead; a click or drag seeks. */
function SelectionWave({ folder, assetId, selection, position, muted, onSeek }: {
  folder: string
  assetId: string
  selection: SourceSelection
  position: number
  muted: boolean
  onSeek: (t: number) => void
}) {
  const { status, peaks } = useAssetPeaksState(folder, assetId, true)
  const { resolvedTheme } = useTheme()
  const wrap = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const [width, setWidth] = useState(0)
  const [scrubbing, setScrubbing] = useState(false)
  const len = selection.out - selection.in

  useEffect(() => {
    const el = wrap.current
    if (!el) return
    const ro = new ResizeObserver(() => setWidth(el.clientWidth))
    ro.observe(el)
    setWidth(el.clientWidth)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    const c = canvas.current
    if (!c || !peaks || !(width > 0)) return
    const frame = requestAnimationFrame(() => {
      const dpr = window.devicePixelRatio || 1
      c.width = Math.round(width * dpr)
      c.height = Math.round(WAVE_HEIGHT * dpr)
      const ctx = c.getContext("2d")
      if (!ctx) return
      ctx.clearRect(0, 0, c.width, c.height)
      ctx.fillStyle = getComputedStyle(c).color
      const bars = waveformBars(peaks.peaks, peaks.rate, selection.in, selection.out, width, STEP)
      const mid = c.height / 2
      const barW = Math.max(1, Math.round(STEP * dpr) - 1)
      const half = (c.height - 8 * dpr) / 2
      bars.forEach((b, j) => {
        const h = Math.max(dpr / 2, b * half)
        ctx.fillRect(Math.round(j * STEP * dpr), Math.round(mid - h), barW, Math.max(1, Math.round(2 * h)))
      })
    })
    return () => cancelAnimationFrame(frame)
  }, [peaks, width, selection.in, selection.out, muted, resolvedTheme])

  const seekAt = (e: PointerEvent<HTMLDivElement>) => onSeek(selection.in + xToTime(e.clientX - e.currentTarget.getBoundingClientRect().left, len, width))

  return (
    <div
      ref={wrap}
      aria-hidden
      data-selection-wave
      className="relative cursor-pointer touch-none overflow-hidden"
      style={{ height: WAVE_HEIGHT }}
      onPointerDown={(e) => {
        if (e.button !== 0 || !(width > 0)) return
        e.currentTarget.setPointerCapture(e.pointerId)
        setScrubbing(true)
        seekAt(e)
      }}
      onPointerMove={(e) => scrubbing && seekAt(e)}
      onPointerUp={() => setScrubbing(false)}
      onPointerCancel={() => setScrubbing(false)}
    >
      {status === "ready" && <canvas ref={canvas} className={cn("absolute inset-0 h-full w-full", muted ? "text-muted-foreground" : "text-editor-accent")} />}
      {status === "loading" && <div className="shimmer absolute inset-0" />}
      {status === "failed" && <p className="absolute inset-0 flex items-center justify-center text-xs text-muted-foreground">Waveform unavailable</p>}
      <div className="pointer-events-none absolute inset-y-0 w-0.5 -translate-x-1/2 bg-white" style={{ left: timeToX(selectionOffset(position, selection), len, width) }} />
    </div>
  )
}

export function SelectionPreview({ kind, src, folder, assetId, selection, mediaRef, player, muted, note }: {
  kind: "video" | "audio"
  /** The clip's media file. */
  src: string
  folder: string
  assetId: string
  selection: SourceSelection
  /** The media element's callback ref (SelectionPlayer.attach). */
  mediaRef: SelectionPlayer["attach"]
  player: Omit<SelectionPlayer, "attach">
  /** The clip is muted on the timeline (its waveform shows grey). */
  muted: boolean
  /** A line under the transport (what the preview leaves out). */
  note?: string
}) {
  const len = selection.out - selection.in
  const offset = selectionOffset(player.position, selection)

  return (
    <div className="grid content-start gap-2" data-selection-preview data-playing={player.playing || undefined} onKeyDown={(e) => spaceToggles(e, player.toggle)}>
      <PreviewMonitor
        stageClassName={kind === "video" ? "aspect-video" : "bg-neutral-950"}
        footer={
          <PreviewTransport
            playing={player.playing}
            onToggle={player.toggle}
            progress={len > 0 ? Math.min(offset, len) / len : 0}
            onSeek={(f) => player.seek(selection.in + f * len)}
            seek={{ label: "Position in the selection", valueText: `${formatClock(offset)} of ${formatClock(len)}` }}
            time={`${formatClock(offset)} / ${formatClock(len)}`}
            loop={player.loop}
            onLoop={() => player.setLoop(!player.loop)}
            muted={player.muted}
            onMute={() => player.setMuted(!player.muted)}
            volume={player.volume}
            onVolume={player.setVolume}
            playLabel="selection"
          />
        }
      >
        {kind === "video" ? (
          <video ref={mediaRef} src={src} preload="auto" playsInline className="absolute inset-0 h-full w-full object-contain" />
        ) : (
          <>
            <SelectionWave folder={folder} assetId={assetId} selection={selection} position={player.position} muted={muted} onSeek={player.seek} />
            <audio ref={mediaRef} src={src} preload="auto" className="hidden" />
          </>
        )}
      </PreviewMonitor>
      {note && <p className="text-xs leading-snug text-muted-foreground">{note}</p>}
    </div>
  )
}
