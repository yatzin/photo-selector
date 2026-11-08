"use client"

import { useEffect, useRef, useState, type CSSProperties } from "react"
import { Pause, Play, Volume2, VolumeX } from "lucide-react"
import { audioCutState, audioEdgeState, PLAIN, pictureEdgeGain, type AudioFxState } from "@/lib/video/audio-fx"
import { clipLength, isStill, isTextClip, type Clip, type Project } from "@/lib/video/project"
import { textSize } from "@/lib/video/text"
import { IDENTITY } from "@/lib/video/transform"
import { edgeLook, loopPlan } from "@/lib/video/transition-preview"
import type { AudioTransitionType, Edge, TransitionType } from "@/lib/video/transition-types"
import { applyFx, offSpeed } from "./audio-graph"
import { placement, TextPicture } from "./preview"
import { FxCopies, FxOverlays, fxStyle, TransitionFxDefs, VideoMirror } from "./transition-layers"

// The Transition dialog's loops for what CutLoopPreview doesn't show: a
// clip's edge transition against nothing (EdgeLoopPreview: the picture over a
// checkerboard, 2 s of nothing before an in edge or after an out one and up
// to 2 s of the clip on the other side; a video's sound fading with it), and
// the sound of an audio transition or an audio clip's edge (AudioLoopPreview:
// the real files through <audio> elements shaped as the editor's player and
// the export shape them, lib/video/audio-fx, over a bar with the transition's
// band and each sound's gain drawn along it). Each plays on a wall clock,
// re-seeking a file that drifts (not one running at a tape's speed), pauses
// with the tab hidden, starts paused with reduced motion, and has a speaker
// button; a browser that refuses sound starts it muted.

const DRIFT = 0.25
const LEAD = 2

const reducedMotion = () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches

function seekTo(v: HTMLMediaElement, at: number, slack: number) {
  if (v.seeking || Math.abs(v.currentTime - at) <= slack) return
  try {
    v.currentTime = Math.max(0, at)
  } catch {
    // Not seekable yet.
  }
}

function holdFile(v: HTMLMediaElement | null, url: string) {
  if (!v || !url) return
  v.src = url
  return () => {
    v.pause()
    v.removeAttribute("src")
    v.load()
  }
}

/** The loop's clock: `t` from 0 to `total`, wrapping; paused with the tab hidden; starting paused at `rest` with reduced motion. */
function useLoopClock(total: number, rest: number) {
  const [playing, setPlaying] = useState(() => !reducedMotion())
  const [t, setT] = useState(() => (reducedMotion() ? rest : 0))
  const [shownTotal, setShownTotal] = useState(total)
  const totalRef = useRef(total)
  if (shownTotal !== total) {
    setShownTotal(total)
    setT(playing ? 0 : rest)
  }
  useEffect(() => {
    totalRef.current = total
  }, [total])
  useEffect(() => {
    if (!playing) return
    let raf = 0
    let last = performance.now()
    const step = (now: number) => {
      const dt = (now - last) / 1000
      last = now
      setT((x) => (x + dt >= totalRef.current ? 0 : x + dt))
      raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [playing])
  useEffect(() => {
    const onVisibility = () => document.hidden && setPlaying(false)
    document.addEventListener("visibilitychange", onVisibility)
    return () => document.removeEventListener("visibilitychange", onVisibility)
  }, [])
  return { t, playing, setPlaying }
}

/** Plays a media element as the loop says at this moment: seeked (unless it runs at a tape's speed), playing or waiting, shaped by `fx`. */
function drive(v: HTMLMediaElement | null, opts: { playing: boolean; runs: boolean; at: number; rest: number; muted: boolean; fx: AudioFxState; onRefused: () => void }) {
  if (!v) return
  v.muted = opts.muted
  applyFx(v, opts.fx)
  if (!opts.playing || !opts.runs) {
    if (!v.paused) v.pause()
    seekTo(v, opts.runs ? opts.at : opts.rest, 0.02)
    return
  }
  if (!offSpeed(v)) seekTo(v, opts.at, DRIFT)
  if (v.paused) {
    v.play().catch((error: unknown) => {
      if (error instanceof DOMException && error.name === "NotAllowedError" && !v.muted) {
        v.muted = true
        opts.onRefused()
        void v.play().catch(() => {})
      }
    })
  }
}

function Controls({ playing, setPlaying, soundOn, setSoundOn, children }: { playing: boolean; setPlaying: (f: (p: boolean) => boolean) => void; soundOn: boolean; setSoundOn: (f: (p: boolean) => boolean) => void; children: React.ReactNode }) {
  const button = "flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
  return (
    <div className="flex items-center gap-2">
      <button type="button" onClick={() => setPlaying((p) => !p)} aria-label={playing ? "Pause the preview" : "Play the preview"} title={playing ? "Pause" : "Play"} className={button}>
        {playing ? <Pause className="h-3.5 w-3.5 fill-current" /> : <Play className="h-3.5 w-3.5 fill-current" />}
      </button>
      <button type="button" onClick={() => setSoundOn((on) => !on)} aria-pressed={!soundOn} aria-label={soundOn ? "Mute preview" : "Unmute preview"} title={soundOn ? "Mute preview" : "Unmute preview"} className={button}>
        {soundOn ? <Volume2 className="h-3.5 w-3.5" /> : <VolumeX className="h-3.5 w-3.5" />}
      </button>
      {children}
    </div>
  )
}

/** A checkerboard: the "nothing" an edge transition comes from or goes to. */
const CHECKER: CSSProperties = { backgroundColor: "#1f1f1f", backgroundImage: "conic-gradient(#2e2e2e 25%, transparent 0 50%, #2e2e2e 0 75%, transparent 0)", backgroundSize: "24px 24px" }

/** Where an edge loop is: `lead` s before the edge transition, `d` of it, `tail` after; the clip's own time at loop time t is `t - offset`. */
function edgePlan(length: number, edge: Edge, d: number) {
  const lead = edge === "in" ? LEAD : Math.max(0, Math.min(LEAD, length - d))
  const tail = edge === "in" ? Math.max(0, Math.min(LEAD, length - d)) : LEAD
  // Clip time = t - offset: an in edge starts the clip at the lead; an out edge ends it at lead + d.
  const offset = edge === "in" ? lead : lead + d - length
  return { lead, tail, total: lead + d + tail, offset }
}

export function EdgeLoopPreview({ project, clip, edge, type, duration, videoUrl, imageUrl }: {
  project: Project
  clip: Clip
  edge: Edge
  /** The edge transition shown ("none": the clip just starts or ends), `duration` s long. */
  type: TransitionType | "none"
  duration: number
  videoUrl: (assetId: string) => string
  imageUrl: (assetId: string) => string
}) {
  const length = clipLength(clip)
  const d = type === "none" ? 0 : Math.min(duration, length)
  const plan = edgePlan(length, edge, d)
  const { t, playing, setPlaying } = useLoopClock(plan.total, plan.lead + d / 2)
  const [soundOn, setSoundOn] = useState(true)
  const [aspect, setAspect] = useState<number | null>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const { width: W, height: H } = project
  const url = isStill(project, clip) ? "" : videoUrl(clip.asset)
  useEffect(() => holdFile(videoRef.current, url), [url])

  const local = t - plan.offset
  const shown = local >= 0 && local < length
  const inside = d > 0 && t >= plan.lead && t < plan.lead + d
  const progress = inside ? (t - plan.lead) / d : null
  const look = progress !== null && type !== "none" ? edgeLook(type, edge, progress, W / H) : null

  useEffect(() => {
    drive(videoRef.current, {
      playing, runs: shown, at: clip.in + local, rest: clip.in + (edge === "in" ? 0 : Math.max(0, length - d - plan.lead)), muted: !soundOn || Boolean(clip.muted),
      fx: { ...PLAIN, gain: progress !== null ? pictureEdgeGain(edge, progress) : 1 }, onRefused: () => setSoundOn(false),
    })
  })

  const tf = clip.transform ?? IDENTITY
  const picture = (mirror = false) => {
    if (isTextClip(clip)) return <div className="absolute" style={placement(textSize(clip.text, H), W, H, tf)}><TextPicture text={clip.text} ready /></div>
    const style = placement(aspect ?? W / H, W, H, tf)
    // A clip with no transform fills the canvas letterboxed in black, as in the editor.
    if (isStill(project, clip)) {
      // eslint-disable-next-line @next/next/no-img-element
      return <img src={imageUrl(clip.asset)} alt="" draggable={false} className="absolute object-contain" style={style} onLoad={(e) => setAspect(e.currentTarget.naturalWidth / e.currentTarget.naturalHeight)} />
    }
    if (mirror) return <VideoMirror video={() => videoRef.current} className="absolute object-contain" style={style} />
    return <video ref={videoRef} playsInline preload="auto" aria-hidden className="absolute object-contain" style={style} onLoadedMetadata={(e) => setAspect(e.currentTarget.videoWidth / e.currentTarget.videoHeight)} />
  }
  const pct = (s: number) => `${Math.min(100, Math.max(0, (s / plan.total) * 100))}%`
  return (
    <div className="grid gap-1.5" data-edge-loop={edge}>
      <div className="relative w-full overflow-hidden rounded-lg" style={{ aspectRatio: `${W} / ${H}`, ...CHECKER }} role="img" aria-label={`Preview of the ${edge === "in" ? "in" : "out"} transition against nothing, looping`}>
        <div className="absolute inset-0 isolate">
          <TransitionFxDefs />
          <div className="absolute inset-0" style={{ zIndex: 2, visibility: shown ? "visible" : "hidden", ...fxStyle(look?.to) }}>{picture()}</div>
          {shown && <FxCopies styles={look?.toCopies} zIndex={2} id="edge">{picture(true)}</FxCopies>}
          <FxOverlays overlays={look?.overlays} zIndex={4} />
        </div>
      </div>
      <Controls playing={playing} setPlaying={setPlaying} soundOn={soundOn} setSoundOn={setSoundOn}>
        <div aria-hidden className="relative h-4 min-w-0 flex-1">
          <div className="absolute inset-x-0 top-1 h-1 rounded-full bg-muted" />
          {d > 0 && <div className="absolute top-0.5 h-2 rounded-sm bg-amber-400/80 dark:bg-amber-500/80" style={{ left: pct(plan.lead), width: `calc(${pct(plan.lead + d)} - ${pct(plan.lead)})` }} />}
          <div className="absolute top-1 h-1 rounded-full bg-editor-accent" style={{ width: pct(t) }} />
        </div>
      </Controls>
    </div>
  )
}

/** One sound in an audio loop: its clip and file, and at loop time t whether it plays, where in its source, and how it sounds. */
type LoopSound = { clip: Clip; url: string; at: (t: number) => { plays: boolean; source: number; fx: AudioFxState }; rest: number }

/**
 * The loop of an audio transition between two audio clips (`cut`: the clips
 * before and after it) or of an audio clip's edge (`edge`), with the type and
 * length shown (the type "none": a plain cut, or no edge fade).
 */
export function AudioLoopPreview({ cut, edge, type, duration, audioUrl }: {
  cut?: { from: Clip; to: Clip }
  edge?: { clip: Clip; edge: Edge }
  type: AudioTransitionType | "none"
  duration: number
  audioUrl: (assetId: string) => string
}) {
  let total = 0
  let band: [number, number] | null = null
  let sounds: LoopSound[] = []
  if (cut) {
    const d = type === "none" ? 0 : duration
    const plan = loopPlan(clipLength(cut.from), clipLength(cut.to), d)
    const start = plan.cut - d / 2
    const end = plan.cut + d / 2
    const p = (t: number) => (d > 0 ? (t - start) / d : t < plan.cut ? 0 : 1)
    total = plan.total
    band = d > 0 ? [start, end] : null
    sounds = [
      {
        clip: cut.from, url: audioUrl(cut.from.asset), rest: cut.from.out - plan.cut,
        at: (t) => ({ plays: t < (d > 0 ? end : plan.cut), source: cut.from.out + (t - plan.cut), fx: d > 0 && type !== "none" && t >= start ? audioCutState(type, "out", p(t)) : PLAIN }),
      },
      {
        clip: cut.to, url: audioUrl(cut.to.asset), rest: cut.to.in - (plan.cut - start),
        at: (t) => ({ plays: t >= (d > 0 ? start : plan.cut), source: cut.to.in + (t - plan.cut), fx: d > 0 && type !== "none" && t < end ? audioCutState(type, "in", p(t)) : PLAIN }),
      },
    ]
  } else if (edge) {
    const length = clipLength(edge.clip)
    const d = type === "none" ? 0 : Math.min(duration, length)
    const plan = edgePlan(length, edge.edge, d)
    total = plan.total
    band = d > 0 ? [plan.lead, plan.lead + d] : null
    sounds = [
      {
        clip: edge.clip, url: audioUrl(edge.clip.asset), rest: edge.clip.in + (edge.edge === "in" ? 0 : Math.max(0, length - d - plan.lead)),
        at: (t) => {
          const local = t - plan.offset
          const inside = d > 0 && type !== "none" && t >= plan.lead && t < plan.lead + d
          return { plays: local >= 0 && local < length, source: edge.clip.in + local, fx: inside ? audioEdgeState(type, edge.edge, (t - plan.lead) / d) : PLAIN }
        },
      },
    ]
  }
  const { t, playing, setPlaying } = useLoopClock(total, band ? (band[0] + band[1]) / 2 : 0)
  const [soundOn, setSoundOn] = useState(true)
  const refs = useRef<(HTMLAudioElement | null)[]>([null, null])
  const urls = sounds.map((s) => s.url).join("\n")
  useEffect(() => {
    const cleanups = urls.split("\n").map((u, i) => holdFile(refs.current[i], u))
    return () => cleanups.forEach((c) => c?.())
  }, [urls])
  useEffect(() => {
    sounds.forEach((s, i) => {
      const now = s.at(t)
      drive(refs.current[i], { playing, runs: now.plays, at: now.source, rest: s.rest, muted: !soundOn || Boolean(s.clip.muted), fx: now.plays ? now.fx : PLAIN, onRefused: () => setSoundOn(false) })
    })
  })

  // Each sound's gain along the loop, drawn over the bar.
  const POINTS = 80
  const lines = sounds.map((s) =>
    Array.from({ length: POINTS + 1 }, (_, k) => {
      const at = (k / POINTS) * total
      const now = s.at(at)
      return `${(k / POINTS) * 100},${(1 - (now.plays ? now.fx.gain : 0)) * 22 + 1}`
    }).join(" ")
  )
  const pct = (s: number) => `${Math.min(100, Math.max(0, total > 0 ? (s / total) * 100 : 0))}%`
  const colours = ["stroke-sky-600 dark:stroke-sky-300", "stroke-amber-600 dark:stroke-amber-300"]
  return (
    <div className="grid gap-1.5" data-audio-loop={cut ? "cut" : "edge"}>
      <div className="relative h-24 overflow-hidden rounded-lg border border-border bg-muted/40" role="img" aria-label="Preview of the sound, looping: each clip's level along the loop">
        {band && <div className="absolute inset-y-0 bg-amber-400/25 dark:bg-amber-500/20" style={{ left: pct(band[0]), width: `calc(${pct(band[1])} - ${pct(band[0])})` }} />}
        <svg aria-hidden viewBox="0 0 100 24" preserveAspectRatio="none" className="absolute inset-x-0 top-3 bottom-3 h-[calc(100%-1.5rem)] w-full">
          {lines.map((pts, i) => <polyline key={i} points={pts} fill="none" strokeWidth={1.5} vectorEffect="non-scaling-stroke" className={colours[i]} />)}
        </svg>
        <div className="absolute inset-y-0 w-px bg-editor-accent" style={{ left: pct(t) }} />
        {sounds.map((s, i) => <audio key={i} ref={(el) => { refs.current[i] = el }} preload="auto" data-loop-audio={i} hidden />)}
      </div>
      <Controls playing={playing} setPlaying={setPlaying} soundOn={soundOn} setSoundOn={setSoundOn}>
        <div aria-hidden className="relative h-4 min-w-0 flex-1">
          <div className="absolute inset-x-0 top-1 h-1 rounded-full bg-muted" />
          {band && <div className="absolute top-0.5 h-2 rounded-sm bg-amber-400/80 dark:bg-amber-500/80" style={{ left: pct(band[0]), width: `calc(${pct(band[1])} - ${pct(band[0])})` }} />}
          <div className="absolute top-1 h-1 rounded-full bg-editor-accent" style={{ width: pct(t) }} />
        </div>
      </Controls>
      {cut && (
        <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
          <span className="flex items-center gap-1"><span aria-hidden className="h-0.5 w-3 bg-sky-600 dark:bg-sky-300" />Outgoing</span>
          <span className="flex items-center gap-1"><span aria-hidden className="h-0.5 w-3 bg-amber-600 dark:bg-amber-300" />Incoming</span>
        </div>
      )}
    </div>
  )
}
