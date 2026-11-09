"use client"

import type { CSSProperties, ReactNode } from "react"
import { Pause, Play, Repeat, Volume2, VolumeX } from "lucide-react"
import { cn } from "@/lib/utils"

// The editor dialogs' preview monitor: a dark stage (dark in either theme, as
// a program monitor is) with its transport docked under it. The transport:
// play and pause, a progress bar with the event band (the transition, an
// audio overlap) and marks (the cut), seekable when `onSeek` is given (an
// invisible range input over the bar, so the keyboard and screen readers get
// a real slider), the time, loop, mute and volume. Every preview in the
// editor's dialogs uses it, so they look and work alike.

/** A span on the progress bar, as fractions of the whole (0 to 1). */
export type TransportBand = { from: number; to: number; tone: "event" | "audio"; label?: string }

const pctOf = (f: number) => `${Math.min(100, Math.max(0, f * 100))}%`

export function PreviewMonitor({ children, stageClassName, stageStyle, label, footer, ...data }: {
  children: ReactNode
  stageClassName?: string
  stageStyle?: CSSProperties
  /** The stage's description (role img); none: its content describes itself. */
  label?: string
  /** The transport (and anything else) docked under the stage. */
  footer?: ReactNode
} & { [key: `data-${string}`]: string | boolean | undefined }) {
  return (
    // "dark" scopes the theme's dark tokens to the monitor.
    <div {...data} className="dark preview-monitor overflow-hidden rounded-xl bg-neutral-950 text-foreground ring-1 ring-black/15 dark:ring-white/10">
      <div className={cn("relative w-full overflow-hidden bg-black", stageClassName)} style={stageStyle} role={label ? "img" : undefined} aria-label={label}>
        {children}
      </div>
      {footer && <div className="border-t border-white/8 bg-neutral-900/90 px-2 py-1.5">{footer}</div>}
    </div>
  )
}

const iconButton = "flex size-8 shrink-0 touch-manipulation items-center justify-center rounded-lg text-white/75 outline-none hover:bg-white/10 hover:text-white focus-visible:ring-2 focus-visible:ring-editor-accent aria-pressed:text-editor-accent pointer-coarse:size-11"

export function PreviewTransport({ playing, onToggle, progress, bands = [], marks = [], onSeek, seek, time, muted, onMute, loop, onLoop, volume, onVolume, playLabel = "preview", children }: {
  playing: boolean
  onToggle: () => void
  /** Where the playhead is, 0 to 1. */
  progress: number
  bands?: TransportBand[]
  /** Thin lines across the bar (the cut), as fractions. */
  marks?: number[]
  /** Seeks to a fraction; without it the bar only shows. */
  onSeek?: (fraction: number) => void
  /** The seek slider's name and its value text. */
  seek?: { label: string; valueText?: string }
  /** "0:01.2 / 0:04.0". */
  time?: string
  muted?: boolean
  onMute?: () => void
  loop?: boolean
  onLoop?: () => void
  volume?: number
  onVolume?: (v: number) => void
  /** What play and pause name: "Play the preview". */
  playLabel?: string
  children?: ReactNode
}) {
  return (
    <div className="flex min-w-0 items-center gap-1.5" data-transport>
      <button
        type="button"
        onClick={onToggle}
        aria-label={playing ? `Pause the ${playLabel}` : `Play the ${playLabel}`}
        aria-pressed={playing}
        title={playing ? "Pause (Space)" : "Play (Space)"}
        data-preview-play
        className="flex size-8 shrink-0 items-center justify-center rounded-full bg-editor-accent text-editor-accent-foreground outline-none hover:bg-editor-accent/85 focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-neutral-900 pointer-coarse:size-11"
      >
        {playing ? <Pause className="size-3.5 fill-current" /> : <Play className="ml-0.5 size-3.5 fill-current" />}
      </button>
      <div className="group/seek relative mx-1.5 h-8 min-w-0 flex-1">
        <div aria-hidden className="absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 overflow-hidden rounded-full bg-white/12">
          {bands.map((b, i) => (
            <div key={i} className={cn("absolute inset-y-0", b.tone === "event" ? "bg-amber-400/70" : "bg-teal-300/80")} style={{ left: pctOf(b.from), width: `calc(${pctOf(b.to)} - ${pctOf(b.from)})` }} />
          ))}
          <div className="absolute inset-y-0 left-0 bg-editor-accent/55" style={{ width: pctOf(progress) }} />
        </div>
        {marks.map((m, i) => (
          <div key={i} aria-hidden className="absolute top-1/2 h-3.5 w-px -translate-y-1/2 bg-white/60" style={{ left: pctOf(m) }} />
        ))}
        <div
          aria-hidden
          className="pointer-events-none absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white shadow ring-2 ring-editor-accent group-has-[:focus-visible]/seek:ring-4"
          style={{ left: pctOf(progress) }}
        />
        {onSeek && (
          <input
            type="range"
            min={0}
            max={1000}
            step={1}
            value={Math.round(Math.min(1, Math.max(0, progress)) * 1000)}
            aria-label={seek?.label ?? "Position"}
            aria-valuetext={seek?.valueText}
            onChange={(e) => onSeek(Number(e.target.value) / 1000)}
            className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
          />
        )}
      </div>
      {time && <span className="shrink-0 px-1 text-[11px] text-white/70 tabular-nums" data-preview-time>{time}</span>}
      {onLoop && (
        <button type="button" onClick={onLoop} aria-pressed={loop} aria-label="Loop" title={loop ? "Loop is on" : "Loop is off"} className={iconButton} data-preview-loop>
          <Repeat className="size-4" />
        </button>
      )}
      {onMute && (
        <button type="button" onClick={onMute} aria-pressed={muted} aria-label={muted ? "Unmute preview" : "Mute preview"} title={muted ? "Unmute" : "Mute"} className={iconButton}>
          {muted ? <VolumeX className="size-4" /> : <Volume2 className="size-4" />}
        </button>
      )}
      {onVolume && volume !== undefined && (
        <input
          type="range"
          aria-label="Preview volume"
          min={0}
          max={1}
          step={0.05}
          value={volume}
          onChange={(e) => onVolume(Number(e.target.value))}
          className="hidden w-20 accent-editor-accent sm:block"
        />
      )}
      {children}
    </div>
  )
}

/** A legend entry under a preview: a swatch and what it marks. */
export function TransportLegend({ items }: { items: { tone: "event" | "audio" | "out" | "in"; label: string }[] }) {
  const swatch = { event: "h-1.5 bg-amber-400/80", audio: "h-1.5 bg-teal-500 dark:bg-teal-300", out: "h-0.5 bg-sky-600 dark:bg-sky-300", in: "h-0.5 bg-amber-600 dark:bg-amber-300" }
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
      {items.map((i) => (
        <span key={i.label} className="flex items-center gap-1.5">
          <span aria-hidden className={cn("w-3 rounded-full", swatch[i.tone])} />
          {i.label}
        </span>
      ))}
    </div>
  )
}
