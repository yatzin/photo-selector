"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { assetKind, clipAt, clipStarts, totalLength, type Clip, type Project } from "@/lib/video/project"

// Plays the timeline in the browser with no re-encoding: two <video> elements
// take turns. One shows the current clip while the other waits on the next one
// (already loaded and seeked), so a cut doesn't stall. A clip the browser can't
// play still takes its time on the timeline: it runs on the clock instead. So
// does an image clip: the preview shows it as an <img>, no video element loads
// it, the video slots pause under it and the waiting one holds the next video.

const END_MARGIN = 0.04 // seconds before a clip's out point at which we move on
const TIME_STEP = 1 / 30 // re-render the playhead at most this often

export function usePreviewPlayer(project: Project, urlFor: (assetId: string) => string) {
  const slotA = useRef<HTMLVideoElement>(null)
  const slotB = useRef<HTMLVideoElement>(null)
  const loaded = useRef<(string | null)[]>([null, null]) // asset id loaded in each slot
  const activeSlot = useRef(0)
  const clipIndex = useRef(0)
  const timeRef = useRef(0)
  const playingRef = useRef(false)
  const clipsRef = useRef(project.clips)
  const assetsRef = useRef(project.assets)
  const urlRef = useRef(urlFor)
  const raf = useRef(0)
  const tickRef = useRef<(now: number) => void>(() => {})
  const failedRef = useRef<Set<string>>(new Set())
  // For a clip that can't play: its source time at the frame time `at` (ms).
  const clock = useRef<{ index: number; pos: number; at: number } | null>(null)
  const primed = useRef([false, false])
  const [active, setActive] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [time, setTime] = useState(0)
  const [failed, setFailed] = useState<Set<string>>(() => new Set())
  const [missing, setMissing] = useState<Set<string>>(() => new Set())

  useEffect(() => {
    clipsRef.current = project.clips
    assetsRef.current = project.assets
    urlRef.current = urlFor
  })

  const el = (slot: number) => (slot === 0 ? slotA.current : slotB.current)

  const isImage = useCallback((clip: Clip | undefined) => {
    const asset = clip && assetsRef.current[clip.asset]
    return asset !== undefined && assetKind(asset) === "image"
  }, [])

  /** The first video (not image) clip from `from` on: the one a waiting slot should hold. */
  const nextVideo = useCallback(
    (from: number): Clip | undefined => {
      const clips = clipsRef.current
      for (let i = from; i < clips.length; i++) if (!isImage(clips[i])) return clips[i]
      return undefined
    },
    [isImage]
  )

  const load = useCallback((slot: number, assetId: string, at: number) => {
    const v = el(slot)
    if (!v) return
    if (loaded.current[slot] !== assetId) {
      loaded.current[slot] = assetId
      v.src = urlRef.current(assetId)
    }
    try {
      v.currentTime = at
    } catch {
      // Not seekable yet; the browser starts from the clip start and the next seek corrects it.
    }
  }, [])

  /**
   * Shows the clip at `index` (source time `at`) in the active slot and gets the
   * next video clip ready in the other. An image clip loads no video: both slots
   * pause under the image, and the other slot still waits on the next video.
   */
  const showClip = useCallback(
    (index: number, at: number) => {
      const clips = clipsRef.current
      const clip = clips[index]
      if (!clip) return
      clipIndex.current = index
      const other = 1 - activeSlot.current
      if (isImage(clip)) el(activeSlot.current)?.pause()
      else load(activeSlot.current, clip.asset, at)
      const next = nextVideo(index + 1)
      if (next) load(other, next.asset, next.in)
      else el(other)?.pause()
    },
    [load, isImage, nextVideo]
  )

  const setTimeline = useCallback((t: number) => {
    timeRef.current = t
    setTime(t)
  }, [])

  const pause = useCallback(() => {
    playingRef.current = false
    cancelAnimationFrame(raf.current)
    slotA.current?.pause()
    slotB.current?.pause()
    setPlaying(false)
  }, [])

  /** The browser can't play this asset: say so in the preview, and tell a missing file (404) from one it can't decode. */
  const markFailed = useCallback((assetId: string) => {
    if (failedRef.current.has(assetId)) return
    failedRef.current = new Set(failedRef.current).add(assetId)
    setFailed(failedRef.current)
    const url = urlRef.current(assetId)
    const markMissing = () => setMissing((m) => new Set(m).add(assetId))
    if (!url) return markMissing()
    fetch(url, { headers: { Range: "bytes=0-0" } }).then(
      (r) => {
        void r.body?.cancel()
        if (r.status === 404) markMissing()
      },
      () => {}
    )
  }, [])

  /** play() on a slot; a refusal (autoplay policy) stops playback so the button doesn't claim it's playing. */
  const playSlot = useCallback(
    (slot: number) => {
      const v = el(slot)
      if (!v) return
      v.play().catch((error: unknown) => {
        const name = error instanceof DOMException ? error.name : ""
        // A newer load, seek or pause replaced this play: nothing is wrong.
        if (name === "AbortError") return
        // The file can't play here; the frame loop runs that clip on the clock.
        if (name === "NotSupportedError") {
          const id = loaded.current[slot]
          if (id) markFailed(id)
          return
        }
        if (playingRef.current && activeSlot.current === slot) pause()
      })
    },
    [markFailed, pause]
  )

  const seek = useCallback(
    (t: number) => {
      clock.current = null
      const clips = clipsRef.current
      if (!clips.length) return setTimeline(0)
      const total = totalLength(clips)
      const at = clipAt(clips, Math.min(Math.max(0, t), total))
      if (at) {
        showClip(at.index, at.sourceTime)
        setTimeline(t < 0 ? 0 : t)
      } else {
        // At or past the end: rest on the last frame.
        const last = clips.length - 1
        showClip(last, clips[last].out)
        setTimeline(total)
      }
      if (playingRef.current && !isImage(clips[clipIndex.current])) playSlot(activeSlot.current)
    },
    [setTimeline, showClip, playSlot, isImage]
  )

  const tick = useCallback(
    (now: number) => {
      if (!playingRef.current) return
      const clips = clipsRef.current
      const idx = clipIndex.current
      const clip = clips[idx]
      const v = el(activeSlot.current)
      if (clip && v) {
        let pos: number
        let done: boolean
        if (isImage(clip) || failedRef.current.has(clip.asset)) {
          // Run this clip on the clock and cut at its out point as usual.
          if (clock.current?.index !== idx) clock.current = { index: idx, pos: clip.in + Math.max(0, timeRef.current - clipStarts(clips)[idx]), at: now }
          pos = clock.current.pos + (now - clock.current.at) / 1000
          done = pos >= clip.out - END_MARGIN
        } else {
          pos = v.currentTime
          if (v.error) markFailed(clip.asset)
          // A file that ends (or stalls at its real end) before the clip's out point would otherwise hang here.
          done = pos >= clip.out - END_MARGIN || v.ended || (Number.isFinite(v.duration) && pos >= v.duration - END_MARGIN)
        }
        if (done) {
          const next = clips[idx + 1]
          if (next && isImage(next)) {
            // An image comes next: no slot to swap to. The video stops under it, and the
            // waiting slot keeps (or gets) the next video clip.
            clipIndex.current = idx + 1
            clock.current = null
            v.pause()
            setTimeline(clipStarts(clips)[idx + 1])
            const after = nextVideo(idx + 2)
            if (after) load(1 - activeSlot.current, after.asset, after.in)
          } else if (next) {
            // Swap to the waiting slot.
            const old = activeSlot.current
            activeSlot.current = 1 - old
            setActive(activeSlot.current)
            clipIndex.current = idx + 1
            clock.current = null
            load(activeSlot.current, next.asset, next.in)
            playSlot(activeSlot.current)
            v.pause()
            setTimeline(clipStarts(clips)[idx + 1])
            const after = nextVideo(idx + 2)
            if (after) load(old, after.asset, after.in)
          } else {
            pause()
            setTimeline(totalLength(clips))
            return
          }
        } else {
          const t = clipStarts(clips)[idx] + (pos - clip.in)
          if (Math.abs(t - timeRef.current) >= TIME_STEP) setTimeline(t)
        }
      }
      raf.current = requestAnimationFrame((n) => tickRef.current(n))
    },
    [load, markFailed, pause, playSlot, setTimeline, isImage, nextVideo]
  )

  const play = useCallback(() => {
    const clips = clipsRef.current
    if (!clips.length) return
    if (timeRef.current >= totalLength(clips) - 0.01) seek(0)
    else seek(timeRef.current)
    playingRef.current = true
    setPlaying(true)
    const image = isImage(clipsRef.current[clipIndex.current])
    if (!image) {
      playSlot(activeSlot.current)
      primed.current[activeSlot.current] = true
    }
    // Safari lets a later play() from the frame loop (at a cut) through only on an
    // element that was played inside a user gesture, so prime the waiting one now
    // (both, when an image is showing and neither was just played).
    for (const slot of image ? [0, 1] : [1 - activeSlot.current]) {
      const v = el(slot)
      if (!v || primed.current[slot]) continue
      if (!v.src) {
        // An empty slot would get its first src at a cut, unprimed, and Safari would
        // refuse that play(): load an upcoming video (any video, failing that) into it now.
        const held = loaded.current[1 - slot]
        const upcoming = clipsRef.current.slice(clipIndex.current + 1).find((c) => !isImage(c) && c.asset !== held) ?? nextVideo(0)
        if (!upcoming) continue
        load(slot, upcoming.asset, upcoming.in)
      }
      primed.current[slot] = true
      void v.play().catch(() => {})
      v.pause()
    }
    cancelAnimationFrame(raf.current)
    raf.current = requestAnimationFrame((n) => tickRef.current(n))
  }, [seek, playSlot, isImage, nextVideo, load])

  useEffect(() => {
    tickRef.current = tick
  }, [tick])

  const toggle = useCallback(() => (playingRef.current ? pause() : play()), [pause, play])

  // An edit changed the clips: show the frame at the current time again.
  useEffect(() => {
    if (!project.clips.length) {
      // Nothing to play: stop the media here; `playing` is reset during render below.
      playingRef.current = false
      timeRef.current = 0
      cancelAnimationFrame(raf.current)
      slotA.current?.pause()
      slotB.current?.pause()
      return
    }
    seek(Math.min(timeRef.current, totalLength(project.clips)))
    // seek and pause are stable; only an edit should re-run this
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.clips])

  useEffect(() => () => cancelAnimationFrame(raf.current), [])

  const onVideoError = useCallback(
    (slot: number) => {
      const id = loaded.current[slot]
      if (id) markFailed(id)
    },
    [markFailed]
  )

  const hasClips = project.clips.length > 0
  // The timeline was emptied while playing: adding a clip later mustn't come back "playing".
  if (!hasClips && playing) setPlaying(false)
  return { slotA, slotB, active, playing: playing && hasClips, time: hasClips ? time : 0, failed, missing, play, pause, toggle, seek, onVideoError }
}

export type PreviewPlayer = ReturnType<typeof usePreviewPlayer>
