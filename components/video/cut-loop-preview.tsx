"use client"

import { useEffect, useRef, useState, type RefObject } from "react"
import { Pause, Play, Volume2, VolumeX } from "lucide-react"
import { clipLength, isStill, isTextClip, type Clip, type Project } from "@/lib/video/project"
import { textSize } from "@/lib/video/text"
import { IDENTITY } from "@/lib/video/transform"
import { loopFrame, loopPlan, loopSound, transitionLook } from "@/lib/video/transition-preview"
import type { CutAudio, TransitionType } from "@/lib/video/transition-types"
import { fxStyle, placement, TextPicture } from "./preview"

// The Transition dialog's live preview of one cut: the two real clips (video,
// image or text, placed by their transforms) looping from up to 2 s before the
// transition to up to 2 s after it (loopPlan), drawn with the editor
// preview's own transition looks, with their sound mixed as the editor mixes
// it (loopSound: the crossfade, or a J- or L-cut's timing, which also shows as
// a band on the progress bar); a speaker button mutes it, and a browser that
// won't play sound starts it muted. Two <video> elements of its own, played on
// a wall clock and re-seeked when they drift; paused while the tab is hidden,
// and emptied when it goes. With reduced motion it starts paused on the cut.

const DRIFT = 0.25 // s a video may be off before it's re-seeked

const reducedMotion = () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches

/** Sets a video to source time `at`, unless it's already within `slack` of it. */
function seekTo(v: HTMLVideoElement, at: number, slack: number) {
  if (v.seeking || Math.abs(v.currentTime - at) <= slack) return
  try {
    v.currentTime = Math.max(0, at)
  } catch {
    // Not seekable yet; the next frame tries again.
  }
}

/** Loads `url` into a video; the cleanup stops it and empties it. */
function holdFile(v: HTMLVideoElement | null, url: string) {
  if (!v || !url) return
  v.src = url
  return () => {
    v.pause()
    v.removeAttribute("src")
    v.load()
  }
}

export function CutLoopPreview({ project, from, to, type, duration, audio, videoUrl, imageUrl }: {
  project: Project
  /** The clips before and after the cut. */
  from: Clip
  to: Clip
  /** The transition to show ("none": a hard cut), `duration` seconds long. */
  type: TransitionType | "none"
  duration: number
  /** The cut's audio overlap, drawn on the progress bar (null: none). */
  audio: CutAudio | null
  videoUrl: (assetId: string) => string
  imageUrl: (assetId: string) => string
}) {
  const plan = loopPlan(clipLength(from), clipLength(to), type === "none" ? 0 : duration)
  const [playing, setPlaying] = useState(() => !reducedMotion())
  const [t, setT] = useState(() => (reducedMotion() ? plan.cut : 0))
  const [aspects, setAspects] = useState<Record<string, number>>({})
  // Sound on unless the person turns it off, or the browser refuses to play it.
  const [soundOn, setSoundOn] = useState(true)
  const fromRef = useRef<HTMLVideoElement>(null)
  const toRef = useRef<HTMLVideoElement>(null)
  const [shownTotal, setShownTotal] = useState(plan.total)
  const totalRef = useRef(plan.total)
  const { width: W, height: H } = project

  // A new length (another transition, another duration) starts the loop over; paused, on the cut.
  if (shownTotal !== plan.total) {
    setShownTotal(plan.total)
    setT(playing ? 0 : plan.cut)
  }
  useEffect(() => {
    totalRef.current = plan.total
  }, [plan.total])

  // The clock: wall time, wrapping at the loop's end.
  useEffect(() => {
    if (!playing) return
    let raf = 0
    let last = performance.now()
    const step = (now: number) => {
      const dt = (now - last) / 1000
      last = now
      setT((x) => {
        const n = x + dt
        return n >= totalRef.current ? 0 : n
      })
      raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [playing])

  // A hidden tab pauses the loop.
  useEffect(() => {
    const onVisibility = () => document.hidden && setPlaying(false)
    document.addEventListener("visibilitychange", onVisibility)
    return () => document.removeEventListener("visibilitychange", onVisibility)
  }, [])

  // Each video gets its file here, and lets go of it (stopped, emptied) when it changes or the preview goes.
  const fromUrl = isStill(project, from) ? "" : videoUrl(from.asset)
  const toUrl = isStill(project, to) ? "" : videoUrl(to.asset)
  useEffect(() => holdFile(fromRef.current, fromUrl), [fromUrl])
  useEffect(() => holdFile(toRef.current, toUrl), [toUrl])

  const frame = loopFrame(plan, t)
  // Seconds from the cut, and each clip's source time there.
  const r = t - plan.cut
  const fromAt = from.out + r
  const toAt = to.in + r

  const sound = loopSound(plan, t, audio)

  // Each video follows the loop while it shows or is heard, and waits at its edge when it doesn't.
  useEffect(() => {
    const drive = (v: HTMLVideoElement | null, clip: Clip, at: number, runs: boolean, gain: number, rest: number) => {
      if (!v) return
      v.muted = !soundOn || Boolean(clip.muted)
      v.volume = Math.min(1, Math.max(0, gain))
      if (!playing || !runs) {
        if (!v.paused) v.pause()
        seekTo(v, runs ? at : rest, 0.02)
        return
      }
      seekTo(v, at, DRIFT)
      if (v.paused) {
        v.play().catch((error: unknown) => {
          // Sound refused (autoplay policy): carry on muted, the speaker showing it.
          if (error instanceof DOMException && error.name === "NotAllowedError" && !v.muted) {
            v.muted = true
            setSoundOn(false)
            void v.play().catch(() => {})
          }
        })
      }
    }
    // Waiting, the outgoing video sits where the loop starts and the incoming one where it comes in.
    drive(fromRef.current, from, fromAt, frame.from || sound.from.plays, sound.from.gain, from.out - plan.cut)
    drive(toRef.current, to, toAt, frame.to || sound.to.plays, sound.to.gain, to.in + Math.max(0, plan.cut - Math.max(plan.duration / 2, audio?.mode === "j" ? audio.duration : 0)) - plan.cut)
  })

  const look = frame.progress !== null && type !== "none" ? transitionLook(type, frame.progress) : null
  const learn = (assetId: string, w: number, h: number) => {
    if (!(w > 0 && h > 0)) return
    setAspects((a) => (a[assetId] === w / h ? a : { ...a, [assetId]: w / h }))
  }

  const picture = (clip: Clip, ref: RefObject<HTMLVideoElement | null>) => {
    const t = clip.transform ?? IDENTITY
    if (isTextClip(clip)) {
      return (
        <div className="absolute" style={placement(textSize(clip.text, H), W, H, t)}>
          <TextPicture text={clip.text} ready />
        </div>
      )
    }
    const style = placement(aspects[clip.asset] ?? W / H, W, H, t)
    if (isStill(project, clip)) {
      // eslint-disable-next-line @next/next/no-img-element
      return <img src={imageUrl(clip.asset)} alt="" draggable={false} className="absolute object-contain" style={style} onLoad={(e) => learn(clip.asset, e.currentTarget.naturalWidth, e.currentTarget.naturalHeight)} />
    }
    return (
      <video
        ref={ref}
        playsInline
        preload="auto"
        aria-hidden
        className="absolute object-contain"
        style={style}
        onLoadedMetadata={(e) => learn(clip.asset, e.currentTarget.videoWidth, e.currentTarget.videoHeight)}
      />
    )
  }

  const pct = (s: number) => `${Math.min(100, Math.max(0, (s / plan.total) * 100))}%`
  const half = plan.duration / 2
  // The audio overlap's span on the bar: before the cut for a J, after it for an L.
  const band = audio ? (audio.mode === "j" ? [plan.cut - audio.duration, plan.cut] : [plan.cut, plan.cut + audio.duration]) : null
  const bandLabel = audio ? (audio.mode === "j" ? `Audio starts early (J-cut, ${audio.duration} s)` : `Audio carries on (L-cut, ${audio.duration} s)`) : null

  return (
    <div className="grid gap-1.5">
      <div className="relative w-full overflow-hidden rounded-lg bg-black" style={{ aspectRatio: `${W} / ${H}` }} role="img" aria-label="Preview of the cut, looping">
        <div className="absolute inset-0 isolate">
          <div className="absolute inset-0" style={{ zIndex: 1, visibility: frame.from ? "visible" : "hidden", ...fxStyle(look?.from) }}>
            {picture(from, fromRef)}
          </div>
          <div className="absolute inset-0" style={{ zIndex: 2, visibility: frame.to ? "visible" : "hidden", ...fxStyle(look?.to) }}>
            {picture(to, toRef)}
          </div>
          {look?.tint && <div aria-hidden className="absolute inset-0" style={{ zIndex: 3, background: look.tint.color, opacity: look.tint.opacity }} />}
        </div>
      </div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => setPlaying((p) => !p)}
          aria-label={playing ? "Pause the preview" : "Play the preview"}
          title={playing ? "Pause" : "Play"}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
        >
          {playing ? <Pause className="h-3.5 w-3.5 fill-current" /> : <Play className="h-3.5 w-3.5 fill-current" />}
        </button>
        <button
          type="button"
          onClick={() => setSoundOn((on) => !on)}
          aria-pressed={!soundOn}
          aria-label={soundOn ? "Mute preview" : "Unmute preview"}
          title={soundOn ? "Mute preview" : "Unmute preview"}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
        >
          {soundOn ? <Volume2 className="h-3.5 w-3.5" /> : <VolumeX className="h-3.5 w-3.5" />}
        </button>
        <div aria-hidden className="relative h-4 min-w-0 flex-1">
          <div className="absolute inset-x-0 top-1 h-1 rounded-full bg-muted" />
          {plan.duration > 0 && (
            <div className="absolute top-0.5 h-2 rounded-sm bg-amber-400/80 dark:bg-amber-500/80" style={{ left: pct(plan.cut - half), width: `calc(${pct(plan.cut + half)} - ${pct(plan.cut - half)})` }} />
          )}
          <div className="absolute top-0 h-3 w-px bg-foreground/50" style={{ left: pct(plan.cut) }} />
          {band && (
            <div title={bandLabel ?? undefined} className="absolute bottom-0 flex h-1 items-center rounded-full bg-teal-500 dark:bg-teal-300" style={{ left: pct(band[0]), width: `calc(${pct(band[1])} - ${pct(band[0])})` }} />
          )}
          <div className="absolute top-1 h-1 rounded-full bg-editor-accent" style={{ width: pct(t) }} />
        </div>
      </div>
      {bandLabel && (
        <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <span aria-hidden className="h-1 w-3 rounded-full bg-teal-500 dark:bg-teal-300" />
          {bandLabel}
        </div>
      )}
    </div>
  )
}
