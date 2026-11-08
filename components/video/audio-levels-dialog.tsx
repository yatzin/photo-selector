"use client"

import { useEffect, useRef, useState } from "react"
import { ArrowDown, ArrowUp, AudioLines, Check, ChevronRight, Loader2, Radio as RadioIcon, RotateCcw, RotateCw, SlidersHorizontal, Sparkles, Wand2, Waves, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  AUDIO_FX_GROUPS, AUDIO_FX_TYPES, AUDIO_PRESETS, audioFxInfo, DEFAULT_AMOUNT, fxAmount, fxPreviewed, MAX_FX, MAX_GAIN_DB, MIN_GAIN_DB, normalizeClipAudio,
  type AudioFx, type AudioFxType, type ClipAudio,
} from "@/lib/video/audio-levels"
import { PREVIEW_CAP } from "@/lib/video/audio-preview"
import { clipEnd, type Clip, type Project } from "@/lib/video/project"
import { formatClock } from "@/lib/video/source-precision"
import { cn } from "@/lib/utils"
import { dbText, levelsSummary } from "@/lib/video/dialog-ui"
import { buildLevels, type LevelsChain } from "./audio-levels-graph"
import { Callout } from "./ui/callout"
import { CancelButton, DialogFooter, DialogSection, EditorDialog, PrimaryButton, RemoveButton, useEditorDialog } from "./ui/editor-dialog"
import { NumberField } from "./ui/number-field"
import { PreviewMonitor, PreviewTransport } from "./ui/preview-transport"
import { TileGrid } from "./ui/tile-grid"

// The clip menu's "Edit Audio Levels...": the clip's overall volume (-60 to
// +24 dB) and up to MAX_FX effects in order, with presets. Preview plays the
// clip's sound (about six seconds from its in point, or from the playhead when
// it's inside the clip, looping) through the same Web Audio chain the editor
// preview uses, following the controls as they move; effects Web Audio can't
// do are named and play dry. Its AudioContext starts on the button press and
// closes with the dialog. Apply is one edit; Cancel and Escape discard.
//
// With such an effect in the list, a warning under the monitor names them and offers Generate preview: the server renders the first
// PREVIEW_CAP seconds of the clip through the export's own chain (the
// audio-preview route), Cancel closes the request, and the result plays in the
// monitor. While it matches the controls, the monitor's play button plays it
// (everything heard, Chipmunk included, with a seek bar); after a change it
// offers Re-render and play goes back to the live chain.
//
// Layout (the shared dialog shell): the monitor (the sound chain in order,
// live or rendered, with the transport) is the hero, the export-only note under
// it; Volume (slider with a 0 dB tick and a dB field), presets and the applied
// list beside it; the 29 effects as a searchable tile grid with the focused
// effect's description beside it.

/** How long the preview loops (s). */
const LOOP = 6

type Render =
  | { status: "idle" }
  | { status: "rendering"; started: number }
  | { status: "ready"; url: string; durationSec: number; key: string }
  | { status: "error"; message: string }

/** The rendered preview: a request for it, its state and its own <audio> element. */
function useRenderedPreview(folder: string, clip: Clip) {
  const [render, setRender] = useState<Render>({ status: "idle" })
  const [now, setNow] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [time, setTime] = useState(0)
  const el = useRef<HTMLAudioElement>(null)
  const request = useRef<AbortController | null>(null)

  // The elapsed time while it renders.
  useEffect(() => {
    if (render.status !== "rendering") return
    const id = setInterval(() => setNow(Date.now()), 250)
    return () => clearInterval(id)
  }, [render.status])

  // Closing the dialog drops the request (the server stops the render) and the file.
  useEffect(
    () => () => {
      request.current?.abort()
      const a = el.current
      if (a) {
        a.pause()
        a.removeAttribute("src")
        a.load()
      }
    },
    []
  )

  async function generate(audio: ClipAudio | undefined, key: string) {
    request.current?.abort()
    const ctl = new AbortController()
    request.current = ctl
    el.current?.pause()
    const started = Date.now()
    setNow(started)
    setRender({ status: "rendering", started })
    try {
      const r = await fetch(`/api/video-projects/${encodeURIComponent(folder)}/audio-preview`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assetId: clip.asset, in: clip.in, out: clip.out, gainDb: audio?.gainDb, fx: audio?.fx }),
        signal: ctl.signal,
      })
      const data = (await r.json().catch(() => ({}))) as { url?: string; durationSec?: number; error?: string }
      if (!r.ok || !data.url) throw new Error(data.error || "The preview couldn't be rendered.")
      setTime(0)
      setRender({ status: "ready", url: data.url, durationSec: data.durationSec ?? 0, key })
    } catch (error) {
      if (ctl.signal.aborted) return
      setRender({ status: "error", message: error instanceof Error && error.message !== "Failed to fetch" ? error.message : "The preview couldn't be rendered." })
    }
  }

  function cancel() {
    request.current?.abort()
    request.current = null
    setRender({ status: "idle" })
  }

  function toggle() {
    const a = el.current
    if (!a) return
    if (!a.paused) return a.pause()
    void a.play().catch(() => setPlaying(false))
  }

  function pause() {
    el.current?.pause()
  }

  const audioEl = (
    <audio
      ref={el}
      src={render.status === "ready" ? render.url : undefined}
      preload="auto"
      loop
      className="hidden"
      data-rendered-preview
      onPlay={() => setPlaying(true)}
      onPause={() => setPlaying(false)}
      onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
    />
  )

  const seek = (t: number) => {
    if (el.current) el.current.currentTime = t
    setTime(t)
  }

  return { render, elapsed: render.status === "rendering" ? Math.max(0, (now - render.started) / 1000) : 0, playing, time, generate, cancel, toggle, pause, seek, audioEl }
}

const GROUP_ICON = { "Clean-up and tone": SlidersHorizontal, Space: Waves, Character: RadioIcon, Creative: Wand2 } as const

/** The typed volume in dB, or null when it isn't a number in range. */
function parseDb(text: string): number | null {
  if (text.trim() === "") return null
  const n = Number(text)
  return Number.isFinite(n) && n >= MIN_GAIN_DB && n <= MAX_GAIN_DB ? n : null
}

/** The volume slider: a 0 dB tick, a value bubble over the thumb while it's used, double-click for 0 dB. */
function GainSlider({ value, onChange }: { value: number; onChange: (db: number) => void }) {
  const at = (db: number) => ((db - MIN_GAIN_DB) / (MAX_GAIN_DB - MIN_GAIN_DB)) * 100
  return (
    <div className="group/gain relative pt-6 pb-4">
      <span
        aria-hidden
        className="pointer-events-none absolute top-0 -translate-x-1/2 rounded-md bg-foreground px-1.5 py-0.5 text-[11px] font-semibold text-background tabular-nums opacity-0 motion-safe:transition-opacity group-focus-within/gain:opacity-100 group-hover/gain:opacity-100"
        style={{ left: `calc(${at(value)}% + ${8 - at(value) * 0.16}px)` }}
      >
        {dbText(value)}
      </span>
      <input
        type="range"
        aria-label="Volume (dB)"
        aria-valuetext={dbText(value)}
        min={MIN_GAIN_DB}
        max={MAX_GAIN_DB}
        step={0.5}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        onDoubleClick={() => onChange(0)}
        title="Double-click for 0 dB"
        className="relative z-[1] block w-full accent-editor-accent"
      />
      {[MIN_GAIN_DB, -24, 0, MAX_GAIN_DB].map((db) => (
        <span key={db} aria-hidden className="absolute bottom-0 -translate-x-1/2 text-[10px] text-muted-foreground tabular-nums" style={{ left: `calc(${at(db)}% + ${8 - at(db) * 0.16}px)` }}>
          <span className={cn("absolute -top-3.5 left-1/2 w-px -translate-x-1/2 bg-foreground/35", db === 0 ? "h-2.5 bg-foreground/60" : "h-1.5")} />
          {db > 0 ? `+${db}` : db}
        </span>
      ))}
    </div>
  )
}

export function AudioLevelsDialog({ project, folder, clip, playhead, mediaUrl, onApply, onClose }: {
  project: Project
  /** The project's folder, for the rendered preview. */
  folder: string
  clip: Clip
  playhead: number
  /** The clip's media URL (its video or its sound file). */
  mediaUrl: string
  /** Sets the clip's audio levels (undefined: removes them), as one edit. */
  onApply: (audio: ClipAudio | undefined) => void
  onClose: () => void
}) {
  const dialog = useEditorDialog(onClose)
  const [gainText, setGainText] = useState(String(clip.audio?.gainDb ?? 0))
  const [fx, setFx] = useState<AudioFx[]>(clip.audio?.fx ?? [])
  const [focused, setFocused] = useState<AudioFxType>(clip.audio?.fx?.[0]?.type ?? "lowcut")
  const [fullNote, setFullNote] = useState(false)
  const [playing, setPlaying] = useState(false)
  const [livePos, setLivePos] = useState(0)
  const [ctxState, setCtxState] = useState<string>("none")
  const [describe, setDescribe] = useState("")
  const gainDb = parseDb(gainText)
  const audio = gainDb === null ? null : normalizeClipAudio({ gainDb, fx })
  const name = project.assets[clip.asset]?.file ?? "Missing file"

  const el = useRef<HTMLAudioElement>(null)
  const graph = useRef<{ ctx: AudioContext; source: MediaElementAudioSourceNode; levels: LevelsChain | null } | null>(null)
  const raf = useRef(0)
  // Where the loop starts and ends in the source: from the playhead when it's inside the clip, else the in point.
  const fromPlayhead = playhead >= clip.start && playhead < clipEnd(clip) - 0.5
  const loopFrom = fromPlayhead ? clip.in + (playhead - clip.start) : clip.in
  const loopTo = Math.min(clip.out, loopFrom + LOOP)
  const rendered = useRenderedPreview(folder, clip)
  // What the rendered preview must match to stand for the controls.
  const renderKey = JSON.stringify(audio ?? null)
  const renderCurrent = rendered.render.status === "ready" && rendered.render.key === renderKey
  const { pause: pauseRendered } = rendered
  // A change makes the rendered preview stale: it stops, and Preview plays the live chain again.
  useEffect(() => {
    if (!renderCurrent) pauseRendered()
  }, [renderCurrent]) // eslint-disable-line react-hooks/exhaustive-deps

  // The preview's chain follows the controls (at 0 dB while the volume field isn't a valid number), rebuilt only when they change.
  const previewKey = JSON.stringify((audio === null ? normalizeClipAudio({ fx }) : audio) ?? null)
  useEffect(() => {
    const g = graph.current
    if (!g) return
    g.source.disconnect()
    g.levels?.dispose()
    g.levels = buildLevels(g.ctx, (JSON.parse(previewKey) as ClipAudio | null) ?? undefined, el.current)
    g.source.connect(g.levels.input)
    g.levels.output.connect(g.ctx.destination)
    setDescribe(g.levels.describe)
  }, [previewKey, playing])

  // Closing the dialog stops the sound and lets the context go.
  useEffect(
    () => () => {
      cancelAnimationFrame(raf.current)
      el.current?.pause()
      const g = graph.current
      graph.current = null
      g?.levels?.dispose()
      void g?.ctx.close().catch(() => {})
    },
    []
  )

  function stopLive() {
    el.current?.pause()
    cancelAnimationFrame(raf.current)
    setPlaying(false)
  }

  function togglePreview() {
    // A rendered preview that matches the controls plays instead of the live chain.
    if (renderCurrent) {
      stopLive()
      rendered.toggle()
      return
    }
    const a = el.current
    if (!a) return
    if (playing) {
      a.pause()
      cancelAnimationFrame(raf.current)
      setPlaying(false)
      return
    }
    rendered.pause()
    if (!graph.current) {
      // Made inside the press, so the browser lets it start.
      const ctx = new AudioContext()
      ctx.addEventListener("statechange", () => setCtxState(ctx.state))
      graph.current = { ctx, source: ctx.createMediaElementSource(a), levels: null }
      setCtxState(ctx.state)
    }
    void graph.current.ctx.resume().catch(() => {})
    if (!a.src) a.src = mediaUrl
    try {
      a.currentTime = loopFrom
    } catch {
      // Not seekable yet: the loop below moves it.
    }
    void a.play().catch(() => setPlaying(false))
    setPlaying(true)
    let shown = 0
    const loop = (now: number) => {
      if (a.currentTime >= loopTo - 0.02 || a.currentTime < loopFrom - 0.3 || a.ended) {
        a.currentTime = loopFrom
        if (a.paused) void a.play().catch(() => {})
      }
      // The bar moves a few times a second, not every frame.
      if (now - shown > 120) {
        shown = now
        setLivePos(a.currentTime - loopFrom)
      }
      raf.current = requestAnimationFrame(loop)
    }
    raf.current = requestAnimationFrame(loop)
  }

  function toggleFx(type: AudioFxType) {
    setFocused(type)
    if (fx.some((f) => f.type === type)) {
      setFx(fx.filter((f) => f.type !== type))
      setFullNote(false)
    } else if (fx.length >= MAX_FX) setFullNote(true)
    else {
      setFx([...fx, { type }])
      setFullNote(false)
    }
  }

  function move(i: number, by: number) {
    const j = i + by
    if (j < 0 || j >= fx.length) return
    const next = [...fx]
    ;[next[i], next[j]] = [next[j], next[i]]
    setFx(next)
  }

  function apply() {
    if (audio === null) return
    dialog.close(() => onApply(audio))
  }

  const info = audioFxInfo(focused)
  const unpreviewed = fx.filter((f) => !fxPreviewed(f.type)).map((f) => audioFxInfo(f.type).name)
  const gainNumber = gainDb ?? 0
  const r = rendered.render
  const previewPlaying = renderCurrent ? rendered.playing : playing
  const loopLen = Math.round((loopTo - loopFrom) * 10) / 10
  const activePreset = AUDIO_PRESETS.find((p) => p.fx.length === fx.length && p.fx.every((t, i) => fx[i]?.type === t))?.name

  // Effects the live preview can't play: named, with Generate preview; once rendered, the monitor plays it.
  const exportOnly = unpreviewed.length > 0 && (
    <Callout
      tone={renderCurrent ? "success" : "warning"}
      title={renderCurrent ? "Preview ready, with every effect" : "Heard in the export only"}
      data-audio-render={r.status === "ready" ? (renderCurrent ? "ready" : "stale") : r.status}
      live
      action={
        <>
          {r.status === "rendering" ? (
            <>
              <Button type="button" size="sm" variant="secondary" disabled>
                <Loader2 className="motion-safe:animate-spin" />
                Rendering…
              </Button>
              <span className="tabular-nums opacity-80" data-audio-render-elapsed>{rendered.elapsed.toFixed(1)} s</span>
              <Button type="button" size="sm" variant="ghost" onClick={rendered.cancel} data-audio-render-cancel>Cancel</Button>
            </>
          ) : r.status === "ready" ? (
            !renderCurrent && (
              <Button type="button" size="sm" variant="secondary" disabled={audio === null} onClick={() => void rendered.generate(audio ?? undefined, renderKey)} data-audio-render-go>
                <RotateCw />
                Re-render
              </Button>
            )
          ) : (
            <Button type="button" size="sm" variant="secondary" disabled={audio === null} onClick={() => void rendered.generate(audio ?? undefined, renderKey)} data-audio-render-go>
              {r.status === "error" ? <RotateCw /> : <Sparkles />}
              {r.status === "error" ? "Retry" : "Generate preview"}
            </Button>
          )}
          <span className="opacity-80">Covers the first {PREVIEW_CAP} s.</span>
        </>
      }
    >
      {renderCurrent ? (
        <p>The monitor plays the server&apos;s render of the first {Math.round((r.status === "ready" ? r.durationSec : 0) * 10) / 10} s, exactly as the export will sound.</p>
      ) : (
        <p>The live preview plays these dry: <span className="font-semibold" data-audio-export-only>{unpreviewed.join(", ")}</span>. Generate a preview to hear them.</p>
      )}
      {r.status === "rendering" && <div aria-hidden className="shimmer h-1 overflow-hidden rounded-full bg-current/15" />}
      {r.status === "ready" && !renderCurrent && <p className="font-medium" data-audio-render-stale>Settings changed since this preview.</p>}
      {r.status === "error" && <p role="alert" className="font-medium text-destructive">{r.message}</p>}
    </Callout>
  )

  const progress = renderCurrent && r.status === "ready" ? (r.durationSec > 0 ? rendered.time / r.durationSec : 0) : playing && loopLen > 0 ? Math.min(1, Math.max(0, livePos / loopLen)) : 0

  return (
    <EditorDialog
      state={dialog}
      icon={AudioLines}
      title="Audio levels"
      subtitle={name}
      size="xl"
      onSubmit={apply}
      formProps={{ "data-audio-levels": true, "data-preview-state": ctxState, "data-preview-chain": describe || undefined } as Record<string, unknown>}
      footer={
        <DialogFooter
          start={clip.audio && <RemoveButton onClick={() => dialog.close(() => onApply(undefined))}>Remove all</RemoveButton>}
          summary={audio && <>Sets <span className="font-medium text-foreground">{levelsSummary(gainNumber, fx.length)}</span> for the whole clip.</>}
        >
          <CancelButton state={dialog} />
          <PrimaryButton disabledReason={audio === null ? `Volume: enter a number from ${MIN_GAIN_DB} to +${MAX_GAIN_DB}.` : null}>Apply levels</PrimaryButton>
        </DialogFooter>
      }
    >
      <div className="grid gap-6">
        <div className="grid gap-x-6 gap-y-5 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
          <div className="grid min-w-0 content-start gap-3">
            <PreviewMonitor
              stageClassName="min-h-36 bg-[radial-gradient(120%_90%_at_50%_0%,rgb(56_189_248/0.10),transparent_60%)] bg-neutral-950"
              footer={
                <PreviewTransport
                  playing={previewPlaying}
                  onToggle={togglePreview}
                  progress={progress}
                  onSeek={renderCurrent && r.status === "ready" ? (f) => rendered.seek(f * r.durationSec) : undefined}
                  seek={{ label: "Rendered preview position" }}
                  time={renderCurrent && r.status === "ready" ? `${formatClock(rendered.time)} / ${formatClock(r.durationSec)}` : `${loopLen} s loop`}
                  playLabel="sound with these levels"
                />
              }
            >
              <div className="flex h-full min-h-36 flex-col justify-between gap-3 p-3.5" data-audio-preview data-audio-preview-source={renderCurrent ? "rendered" : "live"} aria-pressed={previewPlaying}>
                <div className="flex items-center justify-between gap-2 text-[11px] text-white/70">
                  <span className="flex items-center gap-1.5">
                    <span aria-hidden className={cn("size-1.5 rounded-full", previewPlaying ? "bg-emerald-400 motion-safe:animate-pulse" : "bg-white/35")} />
                    {renderCurrent ? "Rendered preview, every effect" : `Live preview, ${loopLen} s from ${fromPlayhead ? "the playhead" : "the clip's start"}`}
                  </span>
                  <span className="tabular-nums">{dbText(gainNumber)}</span>
                </div>
                {/* The chain the sound goes through, in order. */}
                <ol aria-label="Sound chain" className="flex flex-wrap items-center gap-1.5 text-[12px]">
                  <li className="rounded-md bg-white/10 px-2 py-1 text-white/85">Clip</li>
                  {fx.map((f) => (
                    <li key={f.type} className="flex items-center gap-1.5">
                      <ChevronRight aria-hidden className="size-3.5 text-white/35" />
                      <span className={cn("rounded-md px-2 py-1", fxPreviewed(f.type) ? "bg-editor-accent/20 text-editor-accent" : "border border-dashed border-amber-300/60 text-amber-200")}>
                        {audioFxInfo(f.type).name}
                        {!fxPreviewed(f.type) && <span className="sr-only"> (export only)</span>}
                      </span>
                    </li>
                  ))}
                  <li className="flex items-center gap-1.5">
                    <ChevronRight aria-hidden className="size-3.5 text-white/35" />
                    <span className="rounded-md bg-white/10 px-2 py-1 text-white/85">Out</span>
                  </li>
                </ol>
                <p className="text-[11px] text-white/55">{fx.length === 0 ? "No effects: the clip plays with its volume only." : "Effects run left to right. Dashed ones are heard in the export only."}</p>
              </div>
            </PreviewMonitor>
            {exportOnly}
            {/* The preview's own element: never on screen, played only through the dialog's chain. */}
            <audio ref={el} preload="none" className="hidden" />
            {/* The rendered preview's element, played as it is. */}
            {rendered.audioEl}
          </div>
          <div className="grid min-w-0 content-start gap-5">
            <DialogSection
              title="Volume"
              id="audio-volume"
              action={
                <Button type="button" size="xs" variant="ghost" className="text-muted-foreground" onClick={() => setGainText("0")} disabled={gainNumber === 0 && gainDb !== null}>
                  <RotateCcw />
                  Reset to 0 dB
                </Button>
              }
            >
              <div className="grid grid-cols-[minmax(0,1fr)_7.5rem] items-start gap-4">
                <GainSlider value={gainNumber} onChange={(db) => setGainText(String(db))} />
                <NumberField
                  id="audio-gain"
                  label="Volume in dB"
                  unit="dB"
                  step={0.5}
                  min={MIN_GAIN_DB}
                  max={MAX_GAIN_DB}
                  value={gainText}
                  onChange={setGainText}
                  error={gainDb === null ? `From ${MIN_GAIN_DB} to +${MAX_GAIN_DB}.` : null}
                  initialFocus
                />
              </div>
              <p id="audio-gain-note" className="text-xs leading-snug text-muted-foreground">
                {gainNumber === 0 ? "0 dB plays the clip as recorded. Mute silences it altogether." : gainNumber > 6 ? "A big boost can clip; a Limiter after it keeps the peaks in." : `${dbText(gainNumber)} for the whole clip, in the preview and the export.`}
              </p>
            </DialogSection>
            <DialogSection title="Presets" id="audio-presets">
              <div className="flex flex-wrap gap-1.5" data-audio-presets>
                {AUDIO_PRESETS.map((p) => (
                  <button
                    key={p.name}
                    type="button"
                    aria-pressed={activePreset === p.name}
                    onClick={() => {
                      setFx(p.fx.map((type) => ({ type })))
                      setFocused(p.fx[0])
                      setFullNote(false)
                    }}
                    className="rounded-full border border-border px-3 py-1.5 text-xs font-medium outline-none hover:border-foreground/25 hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring aria-pressed:border-editor-accent aria-pressed:bg-editor-accent/10 aria-pressed:text-foreground pointer-coarse:py-2.5"
                  >
                    {p.name}
                  </button>
                ))}
              </div>
            </DialogSection>
            <DialogSection title={`Applied (${fx.length} of ${MAX_FX})`} id="audio-applied">
              {fx.length === 0 ? (
                <p className="rounded-xl border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">No effects yet. Pick some below, or start from a preset.</p>
              ) : (
                <ol className="grid gap-1.5" data-audio-fx-applied>
                  {fx.map((f, i) => {
                    const fi = audioFxInfo(f.type)
                    return (
                      <li key={f.type} data-fx={f.type} className="grid grid-cols-[1.25rem_minmax(0,1fr)_auto] items-center gap-x-2 gap-y-1 rounded-xl border border-border bg-card px-2.5 py-1.5 dark:bg-white/[0.03]">
                        <span className="text-xs text-muted-foreground tabular-nums">{i + 1}</span>
                        <span className="flex min-w-0 items-center gap-1.5 text-[13px] font-medium">
                          <span className="truncate">{fi.name}</span>
                          {!fxPreviewed(f.type) && <span className="shrink-0 rounded border border-dashed border-amber-600/50 px-1 text-[10px] font-normal text-amber-800 dark:border-amber-300/50 dark:text-amber-200">Export only</span>}
                        </span>
                        <span className="flex items-center">
                          <Button type="button" size="icon-sm" variant="ghost" aria-label={`Move ${fi.name} up`} disabled={i === 0} onClick={() => move(i, -1)}>
                            <ArrowUp />
                          </Button>
                          <Button type="button" size="icon-sm" variant="ghost" aria-label={`Move ${fi.name} down`} disabled={i === fx.length - 1} onClick={() => move(i, 1)}>
                            <ArrowDown />
                          </Button>
                          <Button type="button" size="icon-sm" variant="ghost" aria-label={`Remove ${fi.name}`} onClick={() => toggleFx(f.type)}>
                            <X />
                          </Button>
                        </span>
                        {fi.amount ? (
                          <label className="col-start-2 col-end-4 flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
                            Intensity
                            <input
                              type="range"
                              min={0}
                              max={100}
                              step={1}
                              value={Math.round(fxAmount(f) * 100)}
                              aria-label={`${fi.name} intensity`}
                              onChange={(e) => {
                                const amount = Number(e.target.value) / 100
                                setFx(fx.map((x) => (x.type === f.type ? (amount === DEFAULT_AMOUNT ? { type: x.type } : { type: x.type, amount }) : x)))
                              }}
                              className="min-w-0 flex-1 accent-editor-accent"
                            />
                            <span className="w-9 text-right text-foreground tabular-nums">{Math.round(fxAmount(f) * 100)}%</span>
                          </label>
                        ) : (
                          <span className="col-start-2 col-end-4 text-xs text-muted-foreground">Fixed setting</span>
                        )}
                      </li>
                    )
                  })}
                </ol>
              )}
              {fullNote && (
                <Callout tone="warning" live data-audio-fx-full>
                  Up to {MAX_FX} effects: remove one to add another.
                </Callout>
              )}
            </DialogSection>
          </div>
        </div>
        <DialogSection title="Effects" id="audio-effects">
          <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,17rem)]">
            <div data-audio-fx-chips className="min-w-0">
              <TileGrid
                mode="multi"
                label="Effects"
                groups={AUDIO_FX_GROUPS.map((g) => ({ name: g, items: AUDIO_FX_TYPES.filter((t) => audioFxInfo(t).group === g) }))}
                isOn={(t) => fx.some((f) => f.type === t)}
                onToggle={toggleFx}
                onFocusItem={setFocused}
                nameOf={(t) => audioFxInfo(t).name}
                keywordsOf={(t) => audioFxInfo(t).description}
                describe={(t) => (fxPreviewed(t) ? undefined : "heard in the export only")}
                tileData={(t) => ({ "data-fx": t })}
                glyphBox={false}
                minTile="8.5rem"
                searchLabel="Search effects"
                maxHeight="min(16rem, 40dvh)"
                glyph={(t) => {
                  const Icon = GROUP_ICON[audioFxInfo(t).group]
                  return (
                    <span className="flex min-w-0 items-center gap-2">
                      <span aria-hidden className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground group-data-on/tile:bg-editor-accent group-data-on/tile:text-editor-accent-foreground">
                        <Icon className="size-3.5" />
                      </span>
                      <span className="grid min-w-0 leading-tight">
                        <span className="truncate text-[13px] font-medium">{audioFxInfo(t).name}</span>
                        {!fxPreviewed(t) && <span className="truncate text-[10.5px] text-amber-800 dark:text-amber-200">Export only</span>}
                      </span>
                    </span>
                  )
                }}
              />
            </div>
            <div aria-live="polite" className="grid content-start gap-2 self-start rounded-xl border border-border bg-card/60 p-3.5 text-xs leading-relaxed md:sticky md:top-0 dark:bg-white/[0.03]" data-audio-fx-info>
              <div className="flex items-center justify-between gap-2">
                <div className="text-[13px] font-semibold">{info.name}</div>
                {!fxPreviewed(focused) && <span className="rounded border border-dashed border-amber-600/50 px-1 text-[10px] text-amber-800 dark:border-amber-300/50 dark:text-amber-200">Export only</span>}
              </div>
              <p>{info.description}</p>
              <div className="flex gap-2">
                <span aria-hidden className="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"><Check className="size-2.5" strokeWidth={3} /></span>
                <p><span className="block font-semibold">Best for</span>{info.bestFor}</p>
              </div>
              <div className="flex gap-2">
                <span aria-hidden className="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full bg-rose-500/15 text-rose-700 dark:text-rose-300"><X className="size-2.5" strokeWidth={3} /></span>
                <p><span className="block font-semibold">Avoid when</span>{info.avoid}</p>
              </div>
            </div>
          </div>
        </DialogSection>
      </div>
    </EditorDialog>
  )
}
