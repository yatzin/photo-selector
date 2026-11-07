"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { assetKind, clipLength, MAX_TRACKS, totalLength, trackClipAt, trackStarts, type Clip, type Project } from "@/lib/video/project"

// Plays the timeline in the browser with no re-encoding. Every track (layer)
// has a lane of two <video> elements that take turns: one shows the track's
// current clip while the other waits on its next one (already loaded and
// seeked), so a cut doesn't stall. All lanes play at once from one clock, so
// every track's sound mixes; the preview shows the topmost lane with a clip.
// The lowest lane playing a healthy video drives the clock (a stall waits for
// it); with none, wall time does. A clip the browser can't play still takes
// its time on the timeline, and so does an image clip: the preview shows it
// as an <img>, no video element loads it, and the waiting slot holds the next
// video.

const END_MARGIN = 0.04 // seconds before a clip's out point at which we move on
const TIME_STEP = 1 / 30 // re-render the playhead at most this often
const DRIFT = 0.3 // seconds a following lane may drift from the clock before it is re-seeked

/** One track's playback state: the asset loaded in each slot, the slot on show and the clip playing (-1: none). */
type Lane = { loaded: (string | null)[]; active: number; index: number; primed: boolean[] }

const newLane = (): Lane => ({ loaded: [null, null], active: 0, index: -1, primed: [false, false] })

export function usePreviewPlayer(project: Project, urlFor: (assetId: string) => string) {
  const els = useRef<(HTMLVideoElement | null)[][]>(Array.from({ length: MAX_TRACKS }, () => [null, null]))
  const lanes = useRef<Lane[]>(Array.from({ length: MAX_TRACKS }, newLane))
  const timeRef = useRef(0)
  // While playing: timeline time `t` at frame time `at` (ms).
  const clock = useRef({ t: 0, at: 0 })
  const playingRef = useRef(false)
  const projectRef = useRef(project)
  const urlRef = useRef(urlFor)
  const raf = useRef(0)
  const tickRef = useRef<(now: number) => void>(() => {})
  const failedRef = useRef<Set<string>>(new Set())
  const [active, setActive] = useState<number[]>(() => Array.from({ length: MAX_TRACKS }, () => 0))
  const [playing, setPlaying] = useState(false)
  const [time, setTime] = useState(0)
  const [failed, setFailed] = useState<Set<string>>(() => new Set())
  const [missing, setMissing] = useState<Set<string>>(() => new Set())

  useEffect(() => {
    projectRef.current = project
    urlRef.current = urlFor
  })

  const el = (lane: number, slot: number) => els.current[lane]?.[slot] ?? null

  /**
   * The ref callback for a lane's video slot. React detaches (null) and
   * reattaches an inline ref on every render, so null is ignored and only a
   * different element resets the slot: it starts empty, unprimed and with its
   * track's mute. An unmounted element is paused by the browser and by the
   * next seek (its lane has no track then).
   */
  const attach = useCallback((lane: number, slot: number, v: HTMLVideoElement | null) => {
    if (!v || els.current[lane]?.[slot] === v || lane >= MAX_TRACKS) return
    els.current[lane][slot] = v
    lanes.current[lane].loaded[slot] = null
    lanes.current[lane].primed[slot] = false
    v.muted = Boolean(projectRef.current.tracks[lane]?.muted)
  }, [])

  const isImage = useCallback((clip: Clip | undefined) => {
    const asset = clip && projectRef.current.assets[clip.asset]
    return asset !== undefined && assetKind(asset) === "image"
  }, [])

  /** The first video (not image) clip on `lane` from index `from` on: the one its waiting slot should hold. */
  const nextVideo = useCallback(
    (lane: number, from: number): Clip | undefined => {
      const clips = projectRef.current.tracks[lane]?.clips ?? []
      for (let i = Math.max(0, from); i < clips.length; i++) if (!isImage(clips[i])) return clips[i]
      return undefined
    },
    [isImage]
  )

  /** The index of the clip after time `t` on `lane`: the one after the clip playing, or the first that starts later. */
  const upcoming = useCallback((lane: number, index: number, t: number): number => {
    if (index >= 0) return index + 1
    const track = projectRef.current.tracks[lane]
    if (!track) return Infinity
    const starts = trackStarts(track, lane === 0)
    const i = starts.findIndex((s) => s > t)
    return i < 0 ? Infinity : i
  }, [])

  const load = useCallback((lane: number, slot: number, assetId: string, at: number) => {
    const v = el(lane, slot)
    if (!v) return
    if (lanes.current[lane].loaded[slot] !== assetId) {
      lanes.current[lane].loaded[slot] = assetId
      v.src = urlRef.current(assetId)
    }
    try {
      v.currentTime = at
    } catch {
      // Not seekable yet; the browser starts from the clip start and the next seek corrects it.
    }
  }, [])

  /**
   * Shows `lane`'s clip at time `t` in its active slot and gets the track's next
   * video ready in the other. An image, a gap or the end loads no video: the
   * active slot pauses, and the other still waits on the next video.
   */
  const showLane = useCallback(
    (lane: number, t: number) => {
      const L = lanes.current[lane]
      const track = projectRef.current.tracks[lane]
      const at = track ? trackClipAt(track, lane === 0, t) : null
      L.index = at ? at.index : -1
      const clip = at && track ? track.clips[at.index] : undefined
      if (clip && at && !isImage(clip)) load(lane, L.active, clip.asset, at.sourceTime)
      else el(lane, L.active)?.pause()
      const next = nextVideo(lane, upcoming(lane, L.index, t))
      if (next) load(lane, 1 - L.active, next.asset, next.in)
      else el(lane, 1 - L.active)?.pause()
    },
    [load, isImage, nextVideo, upcoming]
  )

  const setTimeline = useCallback((t: number) => {
    timeRef.current = t
    setTime(t)
  }, [])

  const pauseAll = useCallback(() => {
    for (const lane of els.current) for (const v of lane) v?.pause()
  }, [])

  const pause = useCallback(() => {
    playingRef.current = false
    cancelAnimationFrame(raf.current)
    pauseAll()
    setPlaying(false)
  }, [pauseAll])

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
    (lane: number, slot: number) => {
      const v = el(lane, slot)
      if (!v) return
      v.play().catch((error: unknown) => {
        const name = error instanceof DOMException ? error.name : ""
        // A newer load, seek or pause replaced this play: nothing is wrong.
        if (name === "AbortError") return
        // The file can't play here; that clip runs on the clock.
        if (name === "NotSupportedError") {
          const id = lanes.current[lane].loaded[slot]
          if (id) markFailed(id)
          return
        }
        if (playingRef.current && lanes.current[lane].active === slot) pause()
      })
    },
    [markFailed, pause]
  )

  /** The clip playing on `lane`, if it's a video the browser can play. */
  const playableClip = useCallback(
    (lane: number): Clip | undefined => {
      const clip = projectRef.current.tracks[lane]?.clips[lanes.current[lane].index]
      return clip && !isImage(clip) && !failedRef.current.has(clip.asset) ? clip : undefined
    },
    [isImage]
  )

  const seek = useCallback(
    (t: number) => {
      const p = projectRef.current
      const total = totalLength(p)
      if (!(total > 0)) return setTimeline(0)
      const clamped = Math.min(Math.max(0, t), total)
      // At or past the end: rest on the last frame.
      const look = clamped >= total ? Math.max(0, total - 0.001) : clamped
      clock.current = { t: clamped, at: performance.now() }
      for (let lane = 0; lane < MAX_TRACKS; lane++) showLane(lane, look)
      setTimeline(clamped)
      if (playingRef.current) for (let lane = 0; lane < p.tracks.length; lane++) if (playableClip(lane)) playSlot(lane, lanes.current[lane].active)
    },
    [setTimeline, showLane, playSlot, playableClip]
  )

  const tick = useCallback(
    (now: number) => {
      if (!playingRef.current) return
      const p = projectRef.current
      const total = totalLength(p)

      // The clock: the lowest lane playing a healthy video, else wall time. It never runs backwards.
      let t = clock.current.t + Math.max(0, now - clock.current.at) / 1000
      let master = -1
      for (let lane = 0; lane < p.tracks.length; lane++) {
        const clip = playableClip(lane)
        const v = el(lane, lanes.current[lane].active)
        if (!clip || !v) continue
        if (v.error) {
          markFailed(clip.asset)
          continue
        }
        // A file that ends (or stalls at its real end) before the clip's out point can't drive the clock.
        if (v.paused || v.ended || (Number.isFinite(v.duration) && v.currentTime >= v.duration - END_MARGIN)) continue
        const start = trackStarts(p.tracks[lane], lane === 0)[lanes.current[lane].index]
        t = Math.max(clock.current.t, start + (v.currentTime - clip.in))
        if (v.currentTime >= clip.out - END_MARGIN) t = Math.max(t, start + clipLength(clip))
        master = lane
        break
      }
      clock.current = { t, at: now }
      if (t >= total - END_MARGIN) {
        pause()
        setTimeline(total)
        return
      }

      let cut = false
      let swapped = false
      for (let lane = 0; lane < p.tracks.length; lane++) {
        const track = p.tracks[lane]
        const isBase = lane === 0
        const L = lanes.current[lane]
        const starts = trackStarts(track, isBase)
        const current = track.clips[L.index]
        // Move on just before the current clip's out point, as if at its end.
        const end = current ? starts[L.index] + clipLength(current) : Infinity
        const look = t >= end - END_MARGIN ? Math.max(t, end) : t
        const at = trackClipAt(track, isBase, look)
        const index = at ? at.index : -1
        if (index === L.index) {
          // Keep a following lane's video with the clock.
          const clip = lane === master ? undefined : playableClip(lane)
          const v = el(lane, L.active)
          if (clip && v && !v.seeking && !v.ended) {
            const expected = clip.in + (t - starts[L.index])
            if (Math.abs(v.currentTime - expected) > DRIFT && expected < clip.out && !(expected >= v.duration - END_MARGIN)) {
              try {
                v.currentTime = expected
              } catch {
                // Not seekable yet.
              }
            }
          }
          continue
        }
        cut = true
        const old = L.active
        const v = el(lane, old)
        L.index = index
        const next = at ? track.clips[index] : undefined
        if (!next || !at || isImage(next)) {
          // An image, a gap or the track's end: no slot to swap to. The video stops,
          // and the waiting slot keeps (or gets) the track's next video clip.
          v?.pause()
          const after = nextVideo(lane, upcoming(lane, index, look))
          if (after) load(lane, 1 - old, after.asset, after.in)
        } else {
          // Swap to the waiting slot.
          L.active = 1 - old
          swapped = true
          load(lane, L.active, next.asset, at.sourceTime)
          if (!failedRef.current.has(next.asset)) playSlot(lane, L.active)
          v?.pause()
          const after = nextVideo(lane, index + 1)
          if (after) load(lane, old, after.asset, after.in)
        }
      }
      if (swapped) setActive(lanes.current.map((l) => l.active))
      if (cut || Math.abs(t - timeRef.current) >= TIME_STEP) setTimeline(t)
      raf.current = requestAnimationFrame((n) => tickRef.current(n))
    },
    [load, markFailed, pause, playSlot, setTimeline, isImage, nextVideo, upcoming, playableClip]
  )

  const play = useCallback(() => {
    const p = projectRef.current
    const total = totalLength(p)
    if (!(total > 0)) return
    if (timeRef.current >= total - 0.01) seek(0)
    else seek(timeRef.current)
    playingRef.current = true
    setPlaying(true)
    clock.current = { t: timeRef.current, at: performance.now() }
    const anyVideo = p.tracks.flatMap((t) => t.clips).find((c) => !isImage(c))
    for (let lane = 0; lane < p.tracks.length; lane++) {
      const L = lanes.current[lane]
      const clip = p.tracks[lane].clips[L.index]
      const showingVideo = clip !== undefined && !isImage(clip)
      if (showingVideo) {
        playSlot(lane, L.active)
        L.primed[L.active] = true
      }
      // Safari lets a later play() from the frame loop (at a cut) through only on an
      // element that was played inside a user gesture, so prime the waiting one now
      // (both, when an image or nothing is showing on this track).
      for (const slot of showingVideo ? [1 - L.active] : [0, 1]) {
        const v = el(lane, slot)
        if (!v || L.primed[slot]) continue
        if (!v.src) {
          // An empty slot would get its first src at a cut, unprimed, and Safari would
          // refuse that play(): load an upcoming video (any video, failing that) into it now.
          const held = L.loaded[1 - slot]
          const from = upcoming(lane, L.index, timeRef.current)
          const later = p.tracks[lane].clips.slice(Number.isFinite(from) ? from : p.tracks[lane].clips.length).find((c) => !isImage(c) && c.asset !== held)
          const fill = later ?? nextVideo(lane, 0) ?? anyVideo
          if (!fill) continue
          load(lane, slot, fill.asset, fill.in)
        }
        L.primed[slot] = true
        void v.play().catch(() => {})
        v.pause()
      }
    }
    cancelAnimationFrame(raf.current)
    raf.current = requestAnimationFrame((n) => tickRef.current(n))
  }, [seek, playSlot, isImage, nextVideo, upcoming, load])

  useEffect(() => {
    tickRef.current = tick
  }, [tick])

  const toggle = useCallback(() => (playingRef.current ? pause() : play()), [pause, play])

  const hasClips = project.tracks.some((t) => t.clips.length > 0)

  // An edit changed the tracks: apply each track's mute and show the frame at the current time again.
  useEffect(() => {
    project.tracks.forEach((t, lane) => {
      for (const v of els.current[lane] ?? []) if (v) v.muted = Boolean(t.muted)
    })
    if (!project.tracks.some((t) => t.clips.length > 0)) {
      // Nothing to play: stop the media here; `playing` is reset during render below.
      playingRef.current = false
      timeRef.current = 0
      cancelAnimationFrame(raf.current)
      pauseAll()
      return
    }
    seek(Math.min(timeRef.current, totalLength(project)))
    // seek is stable; only an edit should re-run this
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.tracks])

  useEffect(() => () => cancelAnimationFrame(raf.current), [])

  const onVideoError = useCallback(
    (lane: number, slot: number) => {
      const id = lanes.current[lane].loaded[slot]
      if (id) markFailed(id)
    },
    [markFailed]
  )

  // The timeline was emptied while playing: adding a clip later mustn't come back "playing".
  if (!hasClips && playing) setPlaying(false)
  return { attach, active, playing: playing && hasClips, time: hasClips ? time : 0, failed, missing, play, pause, toggle, seek, onVideoError }
}

export type PreviewPlayer = ReturnType<typeof usePreviewPlayer>
