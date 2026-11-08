"use client"

import { useEffect, useRef, useState } from "react"
import { ArrowDown, ArrowUp, Pause, Play, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import {
  AUDIO_FX_GROUPS, AUDIO_FX_TYPES, AUDIO_PRESETS, audioFxInfo, DEFAULT_AMOUNT, fxAmount, fxPreviewed, MAX_FX, MAX_GAIN_DB, MIN_GAIN_DB, normalizeClipAudio,
  type AudioFx, type AudioFxType, type ClipAudio,
} from "@/lib/video/audio-levels"
import { clipEnd, type Clip, type Project } from "@/lib/video/project"
import { cn } from "@/lib/utils"
import { buildLevels, type LevelsChain } from "./audio-levels-graph"

// The clip menu's "Edit Audio Levels...": the clip's overall volume (-60 to
// +24 dB) and up to MAX_FX effects in order, with presets. Preview plays the
// clip's sound (about six seconds from its in point, or from the playhead when
// it's inside the clip, looping) through the same Web Audio chain the editor
// preview uses, following the controls as they move; effects Web Audio can't
// do are named and play dry. Its AudioContext starts on the button press and
// closes with the dialog. Apply is one edit; Cancel and Escape discard.

/** How long the preview loops (s). */
const LOOP = 6

const fmtDb = (db: number) => `${db > 0 ? "+" : ""}${db}`

/** The typed volume in dB, or null when it isn't a number in range. */
function parseDb(text: string): number | null {
  if (text.trim() === "") return null
  const n = Number(text)
  return Number.isFinite(n) && n >= MIN_GAIN_DB && n <= MAX_GAIN_DB ? n : null
}

export function AudioLevelsDialog({ project, clip, playhead, mediaUrl, onApply, onClose }: {
  project: Project
  clip: Clip
  playhead: number
  /** The clip's media URL (its video or its sound file). */
  mediaUrl: string
  /** Sets the clip's audio levels (undefined: removes them), as one edit. */
  onApply: (audio: ClipAudio | undefined) => void
  onClose: () => void
}) {
  const [gainText, setGainText] = useState(String(clip.audio?.gainDb ?? 0))
  const [fx, setFx] = useState<AudioFx[]>(clip.audio?.fx ?? [])
  const [focused, setFocused] = useState<AudioFxType>(clip.audio?.fx?.[0]?.type ?? "lowcut")
  const [fullNote, setFullNote] = useState(false)
  const [playing, setPlaying] = useState(false)
  const [ctxState, setCtxState] = useState<string>("none")
  const [describe, setDescribe] = useState("")
  const gainDb = parseDb(gainText)
  const audio = gainDb === null ? null : normalizeClipAudio({ gainDb, fx })
  const name = project.assets[clip.asset]?.file ?? "Missing file"

  const el = useRef<HTMLAudioElement>(null)
  const graph = useRef<{ ctx: AudioContext; source: MediaElementAudioSourceNode; levels: LevelsChain | null } | null>(null)
  const raf = useRef(0)
  // Where the loop starts and ends in the source: from the playhead when it's inside the clip, else the in point.
  const loopFrom = playhead >= clip.start && playhead < clipEnd(clip) - 0.5 ? clip.in + (playhead - clip.start) : clip.in
  const loopTo = Math.min(clip.out, loopFrom + LOOP)

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

  function togglePreview() {
    const a = el.current
    if (!a) return
    if (playing) {
      a.pause()
      cancelAnimationFrame(raf.current)
      setPlaying(false)
      return
    }
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
    const loop = () => {
      if (a.currentTime >= loopTo - 0.02 || a.currentTime < loopFrom - 0.3 || a.ended) {
        a.currentTime = loopFrom
        if (a.paused) void a.play().catch(() => {})
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
    onApply(audio)
    onClose()
  }

  const info = audioFxInfo(focused)
  const unpreviewed = fx.filter((f) => !fxPreviewed(f.type)).map((f) => audioFxInfo(f.type).name)
  const gainNumber = gainDb ?? 0

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-[min(52rem,calc(100%-2rem))]" finalFocus={false}>
        <DialogHeader>
          <DialogTitle>Audio levels</DialogTitle>
          <DialogDescription>{name}. The volume and the filters apply to the whole clip, in the preview and the export; filters run in the order listed.</DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-5"
          data-audio-levels
          data-preview-state={ctxState}
          data-preview-chain={describe || undefined}
          onSubmit={(e) => {
            e.preventDefault()
            apply()
          }}
        >
          <fieldset className="grid gap-2">
            <legend className="mb-1 text-sm font-medium">Volume</legend>
            <div className="flex flex-wrap items-center gap-3">
              <input
                type="range"
                aria-label="Volume (dB)"
                min={MIN_GAIN_DB}
                max={MAX_GAIN_DB}
                step={0.5}
                value={gainNumber}
                onChange={(e) => setGainText(e.target.value)}
                onDoubleClick={() => setGainText("0")}
                title="Double-click to reset to 0 dB"
                className="min-w-0 flex-1 accent-editor-accent"
              />
              <div className="flex items-center gap-1.5">
                <Input
                  id="audio-gain"
                  type="number"
                  inputMode="decimal"
                  step={0.5}
                  min={MIN_GAIN_DB}
                  max={MAX_GAIN_DB}
                  value={gainText}
                  aria-label="Volume in dB"
                  aria-invalid={gainDb === null ? true : undefined}
                  aria-describedby="audio-gain-note"
                  onChange={(e) => setGainText(e.target.value)}
                  className="w-24"
                />
                <span className="text-sm text-muted-foreground">dB</span>
              </div>
              <Button type="button" size="sm" variant="outline" onClick={() => setGainText("0")} disabled={gainNumber === 0 && gainDb !== null}>Reset</Button>
            </div>
            <p id="audio-gain-note" className={cn("text-xs", gainDb === null ? "text-destructive" : "text-muted-foreground")}>
              {gainDb === null ? `Enter a number from ${MIN_GAIN_DB} to +${MAX_GAIN_DB}.` : gainNumber === 0 ? "0 dB: the clip as recorded. Mute silences it altogether." : `${fmtDb(gainNumber)} dB${gainNumber > 6 ? ": a big boost can clip; a Limiter after it keeps the peaks in." : "."}`}
            </p>
          </fieldset>

          <fieldset className="grid gap-3">
            <legend className="mb-1 text-sm font-medium">Filters</legend>
            <div className="flex flex-wrap items-center gap-2" data-audio-presets>
              <span className="text-xs text-muted-foreground">Presets</span>
              {AUDIO_PRESETS.map((p) => (
                <Button
                  key={p.name}
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setFx(p.fx.map((type) => ({ type })))
                    setFocused(p.fx[0])
                    setFullNote(false)
                  }}
                >
                  {p.name}
                </Button>
              ))}
            </div>
            <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,18rem)]">
              <div className="grid content-start gap-2.5" data-audio-fx-chips>
                {AUDIO_FX_GROUPS.map((g) => (
                  <div key={g} className="grid gap-1.5">
                    <div className="text-xs font-medium text-muted-foreground">{g}</div>
                    <div className="flex flex-wrap gap-1.5">
                      {AUDIO_FX_TYPES.filter((t) => audioFxInfo(t).group === g).map((t) => {
                        const on = fx.some((f) => f.type === t)
                        return (
                          <button
                            key={t}
                            type="button"
                            aria-pressed={on}
                            data-fx={t}
                            onClick={() => toggleFx(t)}
                            onFocus={() => setFocused(t)}
                            onMouseEnter={() => setFocused(t)}
                            title={fxPreviewed(t) ? undefined : "Heard in export only"}
                            className={cn(
                              "rounded-full border px-2.5 py-1 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring",
                              on ? "border-editor-accent bg-editor-accent text-editor-accent-foreground" : "border-border hover:bg-muted"
                            )}
                          >
                            {audioFxInfo(t).name}
                            {!fxPreviewed(t) && <span aria-hidden className={cn("ml-1", on ? "opacity-80" : "text-muted-foreground")}>*</span>}
                          </button>
                        )
                      })}
                    </div>
                  </div>
                ))}
                <p className="text-xs text-muted-foreground">* Heard in the export only; the preview plays it dry.</p>
              </div>
              <div aria-live="polite" className="grid content-start gap-2 rounded-lg border border-border p-3 text-xs" data-audio-fx-info>
                <div className="text-sm font-medium">{info.name}</div>
                <p className="leading-snug">{info.description}</p>
                {!fxPreviewed(info.id) && <p className="leading-snug text-muted-foreground">Heard in export only: the preview can&apos;t play it faithfully.</p>}
                <div className="grid gap-0.5">
                  <div className="font-medium text-muted-foreground">Best for</div>
                  <p className="leading-snug">{info.bestFor}</p>
                </div>
                <div className="grid gap-0.5">
                  <div className="font-medium text-muted-foreground">Avoid when</div>
                  <p className="leading-snug">{info.avoid}</p>
                </div>
              </div>
            </div>
            {fullNote && (
              <p role="status" className="text-xs text-amber-700 dark:text-amber-300" data-audio-fx-full>
                Up to {MAX_FX} filters: remove one to add another.
              </p>
            )}
            <div className="grid gap-1.5">
              <div className="text-xs font-medium text-muted-foreground">Applied ({fx.length} of {MAX_FX}, in order)</div>
              {fx.length === 0 ? (
                <p className="text-xs text-muted-foreground">None. Pick filters above or a preset.</p>
              ) : (
                <ol className="grid gap-1.5" data-audio-fx-applied>
                  {fx.map((f, i) => {
                    const fi = audioFxInfo(f.type)
                    return (
                      <li key={f.type} data-fx={f.type} className="flex flex-wrap items-center gap-2 rounded-lg border border-border px-2 py-1.5 text-sm">
                        <span className="w-5 text-xs text-muted-foreground">{i + 1}.</span>
                        <span className="min-w-28 font-medium">{fi.name}</span>
                        {fi.amount ? (
                          <label className="flex min-w-0 flex-1 items-center gap-2 text-xs text-muted-foreground">
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
                            <span className="w-8 text-right tabular-nums">{Math.round(fxAmount(f) * 100)}%</span>
                          </label>
                        ) : (
                          <span className="flex-1 text-xs text-muted-foreground">Fixed setting</span>
                        )}
                        {!fxPreviewed(f.type) && <span className="text-xs text-muted-foreground">Export only</span>}
                        <span className="flex items-center gap-0.5">
                          <Button type="button" size="icon-sm" variant="ghost" aria-label={`Move ${fi.name} up`} disabled={i === 0} onClick={() => move(i, -1)}>
                            <ArrowUp className="h-4 w-4" />
                          </Button>
                          <Button type="button" size="icon-sm" variant="ghost" aria-label={`Move ${fi.name} down`} disabled={i === fx.length - 1} onClick={() => move(i, 1)}>
                            <ArrowDown className="h-4 w-4" />
                          </Button>
                          <Button type="button" size="icon-sm" variant="ghost" aria-label={`Remove ${fi.name}`} onClick={() => toggleFx(f.type)}>
                            <X className="h-4 w-4" />
                          </Button>
                        </span>
                      </li>
                    )
                  })}
                </ol>
              )}
            </div>
          </fieldset>

          <div className="flex flex-wrap items-center gap-3 border-t border-border pt-4">
            <Button type="button" variant="outline" onClick={togglePreview} aria-pressed={playing} data-audio-preview>
              {playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
              {playing ? "Pause" : "Preview"}
            </Button>
            <p className="text-xs text-muted-foreground" aria-live="polite">
              {unpreviewed.length > 0 ? `Not previewed: ${unpreviewed.join(", ")} (applied in export). ` : ""}
              Loops {Math.round((loopTo - loopFrom) * 10) / 10} s from {playhead >= clip.start && playhead < clipEnd(clip) - 0.5 ? "the playhead" : "the clip's start"}.
            </p>
            {/* The preview's own element: never on screen, played only through the dialog's chain. */}
            <audio ref={el} preload="none" className="hidden" />
          </div>

          <DialogFooter>
            {clip.audio && (
              <Button
                type="button"
                variant="outline"
                className="sm:mr-auto"
                onClick={() => {
                  onApply(undefined)
                  onClose()
                }}
              >
                Remove all
              </Button>
            )}
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={audio === null}>Apply</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
