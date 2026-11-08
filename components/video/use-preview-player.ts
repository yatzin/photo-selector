"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { clockStalled, resyncTo } from "@/lib/video/follow"
import { audioCutState, audioEdgeState, combineFx, PLAIN, pictureEdgeGain } from "@/lib/video/audio-fx"
import { clipLength, isStill, MAX_TRACKS, totalLength, trackStarts, type Clip, type Project } from "@/lib/video/project"
import { isAudioTransitionType, isTransitionType } from "@/lib/video/transition-types"
import { cutGains, edgeAt, entrySourceTime, laneClipAt, laneElementAt, overlapAt, tailSourceTime, transitionAt } from "@/lib/video/transitions"
import { applyFx, offSpeed } from "./audio-graph"

// Plays the timeline in the browser with no re-encoding. Every track (layer)
// has a lane of two <video> elements that take turns: one shows the track's
// current clip while the other waits on its next one (already loaded and
// seeked), so a cut doesn't stall. All lanes play at once from one clock, so
// every track's sound mixes; the preview shows every lane with a clip, stacked.
// The lowest lane playing a healthy video drives the clock (a stall waits for
// it, and the other lanes pause until it plays on); with none, wall time does. A clip the browser can't play still takes
// its time on the timeline, and so does an image clip: the preview shows it
// as an <img>, no video element loads it, and the waiting slot holds the next
// video.
//
// A transition (lib/video/transitions) is centred on its cut: from the
// window's start the incoming clip is the lane's clip (laneClipAt, playing
// from before its in point), and the outgoing one, a video, plays on as the
// lane's tail in the other slot (in the active one when the incoming clip is
// a still) until the window ends; the preview draws the two blended. Their
// sound crossfades with equal-power gains.
//
// A J-cut or L-cut at a cut widens that same window (overlapAt): the incoming
// clip's video starts its length before the cut (its picture hidden until
// the transition, or the cut) and the outgoing one plays on that long after
// it (its picture hidden after them). Their volumes follow cutGains: each
// sound full from its new edge (a short fade there), cut at the picture cut
// on the other side, both mixed in between.
//
// The audio layer (Project.audioTrack) plays through two <audio> elements
// that take turns the same way (one plays the clip at the playhead, the other
// waits on the next clip), seeked to in + (t - start) and kept with the clock
// as a following lane's video is; a muted clip's element is muted. Audio
// clips have no picture, so they never drive the clock and the preview shows
// nothing for them. An audio transition works as a picture one does: from
// its window's start the incoming clip plays in one element and the outgoing
// one plays on as the tail in the other until the window ends, each shaped as
// the export shapes it (lib/video/audio-fx: the curve's gain, and for the
// creative ones Web Audio filters, a feedback delay or a tape's playbackRate,
// components/video/audio-graph). An audio clip's edge transition shapes its
// own element the same way; a picture clip's edge transition fades its
// video's sound with the picture (equal power). An element running at a
// tape's speed is left off the clock until it's back to normal speed.

const END_MARGIN = 0.04 // seconds before a clip's out point at which we move on
const TIME_STEP = 1 / 30 // re-render the playhead at most this often

/**
 * One track's playback state: the asset loaded in each slot, the slot on show, the clip playing (-1: none)
 * and the slot playing a transition's outgoing video (-1: none).
 */
type Lane = { loaded: (string | null)[]; active: number; index: number; primed: boolean[]; tail: number }

const newLane = (): Lane => ({ loaded: [null, null], active: 0, index: -1, primed: [false, false], tail: -1 })

/** The same clip for playback: what plays and when, and how its edges sound (a transform only changes where it shows, a mute only what's heard). */
const samePlayback = (a: Clip, b: Clip) =>
  a === b ||
  (a.id === b.id && a.asset === b.asset && a.in === b.in && a.out === b.out && a.start === b.start && a.transition?.type === b.transition?.type && a.transition?.duration === b.transition?.duration &&
    a.cutAudio?.mode === b.cutAudio?.mode && a.cutAudio?.duration === b.cutAudio?.duration && a.edgeIn?.type === b.edgeIn?.type && a.edgeIn?.duration === b.edgeIn?.duration &&
    a.edgeOut?.type === b.edgeOut?.type && a.edgeOut?.duration === b.edgeOut?.duration)

/** Whether two lists of track clips play the same lane by lane (an empty lane matches a missing one). */
function sameClips(a: Clip[][], b: Clip[][]): boolean {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? []
    const y = b[i] ?? []
    if (x !== y && (x.length !== y.length || x.some((c, k) => !samePlayback(c, y[k])))) return false
  }
  return true
}

export function usePreviewPlayer(project: Project, urlFor: (assetId: string) => string, audioUrlFor: (assetId: string) => string) {
  const els = useRef<(HTMLVideoElement | null)[][]>(Array.from({ length: MAX_TRACKS }, () => [null, null]))
  // The audio layer's two elements, the clip each holds (id and asset), the one playing and the clip at the playhead (-1: none).
  const audioEls = useRef<(HTMLAudioElement | null)[]>([null, null])
  // `tail`: the element playing an audio transition's outgoing clip (-1: none).
  const audioLane = useRef({ loaded: [null, null] as (string | null)[], clipIds: [null, null] as (string | null)[], active: 0, index: -1, tail: -1 })
  const lastAudioResync = useRef(-Infinity)
  const audioUrlRef = useRef(audioUrlFor)
  const lanes = useRef<Lane[]>(Array.from({ length: MAX_TRACKS }, newLane))
  const timeRef = useRef(0)
  // The playhead at every frame (timeRef re-renders at most every TIME_STEP), and who follows it (subscribeFrame).
  const frameRef = useRef(0)
  const frameListeners = useRef(new Set<() => void>())
  // While playing: timeline time `t` at frame time `at` (ms).
  const clock = useRef({ t: 0, at: 0 })
  const playingRef = useRef(false)
  const projectRef = useRef(project)
  const urlRef = useRef(urlFor)
  const raf = useRef(0)
  const tickRef = useRef<(now: number) => void>(() => {})
  const failedRef = useRef<Set<string>>(new Set())
  // The lane driving the clock at the last frame (-1: wall time).
  const masterRef = useRef(-1)
  // The clock's video and when its time last moved, to tell a stall.
  const stallRef = useRef<{ v: HTMLVideoElement | null; time: number; at: number }>({ v: null, time: 0, at: 0 })
  // True while the other lanes are paused for a stalled clock.
  const heldRef = useRef(false)
  // Per lane, the frame time (ms) of its last corrective seek, and of its tail's.
  const lastResync = useRef<number[]>(Array.from({ length: MAX_TRACKS }, () => -Infinity))
  const lastTailResync = useRef<number[]>(Array.from({ length: MAX_TRACKS }, () => -Infinity))
  // The clips the preview last seeked for, to tell a clip edit from a mute toggle (samePlayback ignores the mute).
  const shownClips = useRef<Clip[][] | null>(null)
  const [active, setActive] = useState<number[]>(() => Array.from({ length: MAX_TRACKS }, () => 0))
  const [playing, setPlaying] = useState(false)
  const [time, setTime] = useState(0)
  const [failed, setFailed] = useState<Set<string>>(() => new Set())
  const [missing, setMissing] = useState<Set<string>>(() => new Set())

  useEffect(() => {
    projectRef.current = project
    urlRef.current = urlFor
    audioUrlRef.current = audioUrlFor
  })

  const el = (lane: number, slot: number) => els.current[lane]?.[slot] ?? null

  /**
   * The ref callback for a lane's video slot. React detaches (null) and
   * reattaches an inline ref on every render, so null is ignored and only a
   * different element resets the slot: it starts empty and unprimed (load
   * sets its mute from the clip it gets). An unmounted element is paused by the browser and by the
   * next seek (its lane has no track then).
   */
  const attach = useCallback((lane: number, slot: number, v: HTMLVideoElement | null) => {
    if (!v || els.current[lane]?.[slot] === v || lane >= MAX_TRACKS) return
    els.current[lane][slot] = v
    lanes.current[lane].loaded[slot] = null
    lanes.current[lane].primed[slot] = false
  }, [])

  /** The ref callback for one of the audio layer's two elements (null is ignored, as for the videos). */
  const attachAudio = useCallback((slot: number, a: HTMLAudioElement | null) => {
    if (!a || audioEls.current[slot] === a) return
    audioEls.current[slot] = a
    audioLane.current.loaded[slot] = null
    audioLane.current.clipIds[slot] = null
  }, [])

  /** Loads an audio clip into one of the audio layer's elements at source time `at`, muted when the clip is. */
  const loadAudio = useCallback((slot: number, clip: Clip, at: number) => {
    const a = audioEls.current[slot]
    if (!a) return
    const A = audioLane.current
    a.muted = Boolean(clip.muted)
    a.volume = 1
    A.clipIds[slot] = clip.id
    if (A.loaded[slot] !== clip.asset) {
      A.loaded[slot] = clip.asset
      a.src = audioUrlRef.current(clip.asset)
    }
    try {
      a.currentTime = at
    } catch {
      // Not seekable yet; the next seek corrects it.
    }
  }, [])

  /**
   * The audio layer at time `t`: its clip (through a transition, the incoming
   * one, from before its in point) in the playing element, seeked; the
   * transition's outgoing clip in the other as the tail, or else the next
   * clip waiting there; silence (paused) in a gap.
   */
  const showAudio = useCallback(
    (t: number) => {
      const A = audioLane.current
      const track = projectRef.current.audioTrack
      const at = track ? laneClipAt(track, t) : null
      A.index = at ? at.index : -1
      const clip = at && track ? track.clips[at.index] : undefined
      const w = track ? transitionAt(track, t) : null
      const from = w && track ? track.clips[w.from] : undefined
      A.tail = from ? 1 - A.active : -1
      if (clip && at) loadAudio(A.active, clip, at.sourceTime)
      else audioEls.current[A.active]?.pause()
      if (A.tail >= 0 && from && w && track) {
        loadAudio(A.tail, from, tailSourceTime(track, w, t))
        return
      }
      const next = track ? (at ? track.clips[at.index + 1] : track.clips.find((c) => c.start > t)) : undefined
      audioEls.current[1 - A.active]?.pause()
      if (next && track) loadAudio(1 - A.active, next, entrySourceTime(track, next))
    },
    [loadAudio]
  )

  /** Plays the audio layer's clip at the playhead and a transition's outgoing clip, if there are any (a refusal just leaves them silent). */
  const playAudio = useCallback(() => {
    const A = audioLane.current
    if (A.index >= 0) audioEls.current[A.active]?.play().catch(() => {})
    if (A.tail >= 0) audioEls.current[A.tail]?.play().catch(() => {})
  }, [])

  /** The audio layer's two elements shaped for `t`: an audio transition's two sounds (audioCutState) and the clip's own edge transition (audioEdgeState); plain otherwise. */
  const mixAudio = useCallback((t: number) => {
    const A = audioLane.current
    const track = projectRef.current.audioTrack
    const w = track ? transitionAt(track, t) : null
    const audioCut = w && isAudioTransitionType(w.type) ? w.type : null
    let own = audioCut && w ? audioCutState(audioCut, "in", w.progress) : PLAIN
    const clip = track?.clips[A.index]
    const e = clip ? edgeAt(clip, t) : null
    if (e && isAudioTransitionType(e.type)) own = combineFx(own, audioEdgeState(e.type, e.edge, e.progress))
    const active = audioEls.current[A.active]
    if (active) applyFx(active, own)
    const tail = A.tail >= 0 ? audioEls.current[A.tail] : null
    if (tail) applyFx(tail, audioCut && w ? audioCutState(audioCut, "out", w.progress) : PLAIN)
    const idle = A.tail >= 0 ? null : audioEls.current[1 - A.active]
    if (idle) applyFx(idle, PLAIN)
  }, [])

  // A still (an image's or a text clip) has nothing for a <video> to play.
  const isImage = useCallback((clip: Clip | undefined) => clip !== undefined && isStill(projectRef.current, clip), [])

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
    const starts = trackStarts(track)
    const i = starts.findIndex((s) => s > t)
    return i < 0 ? Infinity : i
  }, [])

  /** Loads `clip`'s video into a lane's slot at source time `at`, muted when the clip is. */
  const load = useCallback((lane: number, slot: number, clip: Clip, at: number) => {
    const v = el(lane, slot)
    if (!v) return
    v.muted = Boolean(clip.muted)
    v.volume = 1
    if (lanes.current[lane].loaded[slot] !== clip.asset) {
      lanes.current[lane].loaded[slot] = clip.asset
      v.src = urlRef.current(clip.asset)
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
      const at = track ? laneElementAt(track, t) : null
      L.index = at ? at.index : -1
      const clip = at && track ? track.clips[at.index] : undefined
      // Inside a transition or audio overlap the outgoing video plays on as the tail: in the other slot, or in this one under a still.
      const w = track ? overlapAt(track, t) : null
      const from = w && track ? track.clips[w.from] : undefined
      const incomingVideo = clip !== undefined && at !== null && !isImage(clip)
      L.tail = from && !isImage(from) ? (incomingVideo ? 1 - L.active : L.active) : -1
      if (incomingVideo && clip && at) load(lane, L.active, clip, at.sourceTime)
      else if (L.tail !== L.active) el(lane, L.active)?.pause()
      if (L.tail >= 0 && from && w && track) load(lane, L.tail, from, tailSourceTime(track, w, t))
      if (L.tail === 1 - L.active) return
      const next = nextVideo(lane, upcoming(lane, L.index, t))
      if (next && track) load(lane, 1 - L.active, next, entrySourceTime(track, next))
      else el(lane, 1 - L.active)?.pause()
    },
    [load, isImage, nextVideo, upcoming]
  )

  /**
   * Through a cut's overlap, the two videos' volumes as cutGains says (a
   * transition's equal-power crossfade, or a J- or L-cut's); else full
   * volume. A clip's picture edge transition fades its own sound with it.
   */
  const mixVolumes = useCallback((lane: number, t: number) => {
    const L = lanes.current[lane]
    const track = projectRef.current.tracks[lane]
    const w = track ? overlapAt(track, t) : null
    const g = w ? cutGains(w, t) : { out: 1, in: 1 }
    const clip = track?.clips[L.index]
    const e = clip ? edgeAt(clip, t) : null
    const edge = e && isTransitionType(e.type) ? pictureEdgeGain(e.edge, e.progress) : 1
    const active = el(lane, L.active)
    if (L.tail >= 0) {
      const tail = el(lane, L.tail)
      if (tail) tail.volume = g.out
    }
    if (active && L.tail !== L.active) active.volume = g.in * edge
  }, [])

  /** Moves the frame-rate playhead and tells its followers. */
  const setFrame = useCallback((t: number) => {
    if (frameRef.current === t) return
    frameRef.current = t
    for (const listener of frameListeners.current) listener()
  }, [])

  const setTimeline = useCallback(
    (t: number) => {
      timeRef.current = t
      setTime(t)
      setFrame(t)
    },
    [setFrame]
  )

  const pauseAll = useCallback(() => {
    for (const lane of els.current) for (const v of lane) v?.pause()
    for (const a of audioEls.current) a?.pause()
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

  /**
   * play() on a slot. A refusal (autoplay policy) on the base or the clock's
   * lane stops playback so the button doesn't claim it's playing; any other
   * lane just stays paused (stalled) until the next play() primes it.
   */
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
        const clockLane = lane === 0 || masterRef.current < 0 || lane === masterRef.current
        if (playingRef.current && clockLane && lanes.current[lane].active === slot) pause()
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
      // Every lane is seeked (and played) afresh: none is held for a stall now.
      heldRef.current = false
      stallRef.current = { v: null, time: 0, at: 0 }
      for (let lane = 0; lane < MAX_TRACKS; lane++) {
        showLane(lane, look)
        mixVolumes(lane, look)
      }
      showAudio(look)
      mixAudio(look)
      setTimeline(clamped)
      if (playingRef.current) {
        for (let lane = 0; lane < p.tracks.length; lane++) {
          const L = lanes.current[lane]
          if (playableClip(lane)) playSlot(lane, L.active)
          if (L.tail >= 0) playSlot(lane, L.tail)
        }
        playAudio()
      }
    },
    [setTimeline, showLane, mixVolumes, playSlot, playableClip, showAudio, mixAudio, playAudio]
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
        const start = trackStarts(p.tracks[lane])[lanes.current[lane].index]
        t = Math.max(clock.current.t, start + (v.currentTime - clip.in))
        if (v.currentTime >= clip.out - END_MARGIN) t = Math.max(t, start + clipLength(clip))
        master = lane
        break
      }
      clock.current = { t, at: now }
      masterRef.current = master

      // The clock's video stalls (buffering, or decoding slower than real time): hold the
      // other lanes so they don't run ahead and get re-seeked over and over; resume them after.
      let stalled = false
      if (master >= 0) {
        const v = el(master, lanes.current[master].active)
        if (v) {
          const s = stallRef.current
          if (s.v !== v || s.time !== v.currentTime) stallRef.current = { v, time: v.currentTime, at: now }
          stalled = clockStalled(v.readyState, now - stallRef.current.at)
        }
      }
      if (stalled !== heldRef.current) {
        heldRef.current = stalled
        for (let lane = 0; lane < p.tracks.length; lane++) {
          const v = el(lane, lanes.current[lane].active)
          if (lane === master || !v || !playableClip(lane)) continue
          if (stalled) v.pause()
          // play() on an ended video would start it over.
          else if (!v.ended) playSlot(lane, lanes.current[lane].active)
        }
        if (stalled) for (const a of audioEls.current) a?.pause()
        else playAudio()
      }

      if (t >= total - END_MARGIN) {
        pause()
        setTimeline(total)
        return
      }

      let cut = false
      let swapped = false
      for (let lane = 0; lane < p.tracks.length; lane++) {
        const track = p.tracks[lane]
        const L = lanes.current[lane]
        const starts = trackStarts(track)
        const current = track.clips[L.index]
        // A transition's (or audio overlap's) window is over: its outgoing video stops, and its slot waits on the next video.
        if (L.tail >= 0 && overlapAt(track, t)?.to !== L.index) {
          const slot = L.tail
          L.tail = -1
          el(lane, slot)?.pause()
          const after = slot === L.active ? undefined : nextVideo(lane, upcoming(lane, L.index, t))
          if (after) load(lane, slot, after, entrySourceTime(track, after))
        }
        // Move on just before the current clip's out point, as if at its end.
        const end = current ? starts[L.index] + clipLength(current) : Infinity
        const look = t >= end - END_MARGIN ? Math.max(t, end) : t
        const at = laneElementAt(track, look)
        const index = at ? at.index : -1
        if (index === L.index) {
          // Keep the tail (an overlap's outgoing video) with the clock too: an L-cut runs it for seconds.
          const tw = L.tail >= 0 && !heldRef.current ? overlapAt(track, t) : null
          const tv = tw ? el(lane, L.tail) : null
          if (tw && tv && !tv.paused && !tv.seeking && !tv.ended) {
            const to = resyncTo({ current: tv.currentTime, expected: tailSourceTime(track, tw, t), limit: Number.isFinite(tv.duration) ? tv.duration - END_MARGIN : Infinity, now, lastResync: lastTailResync.current[lane] })
            if (to !== null) {
              lastTailResync.current[lane] = now
              try {
                tv.currentTime = to
              } catch {
                // Not seekable yet.
              }
            }
          }
          // Keep a following lane's video with the clock (not while it's held for a stall).
          const clip = lane === master || heldRef.current ? undefined : playableClip(lane)
          const v = el(lane, L.active)
          if (clip && v && !v.seeking && !v.ended) {
            const expected = clip.in + (t - starts[L.index])
            const limit = Number.isFinite(v.duration) ? Math.min(clip.out, v.duration - END_MARGIN) : clip.out
            const to = resyncTo({ current: v.currentTime, expected, limit, now, lastResync: lastResync.current[lane] })
            if (to !== null) {
              lastResync.current[lane] = now
              try {
                v.currentTime = to
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
        // A transition or audio overlap from the video on show starts: that video plays on as the tail.
        const w = overlapAt(track, look)
        const entering = w !== null && w.to === index && w.from === L.index && current !== undefined && !isImage(current)
        L.index = index
        const next = at ? track.clips[index] : undefined
        if (!next || !at || isImage(next)) {
          // An image, a gap or the track's end: no slot to swap to. The video stops (or plays on as the tail
          // under a still), and the waiting slot keeps (or gets) the track's next video clip.
          if (entering) L.tail = old
          else v?.pause()
          const after = nextVideo(lane, upcoming(lane, index, look))
          if (after) load(lane, 1 - old, after, entrySourceTime(track, after))
        } else {
          // Swap to the waiting slot.
          L.active = 1 - old
          swapped = true
          load(lane, L.active, next, at.sourceTime)
          // A lane held for a stalled clock starts when the hold ends.
          if (!failedRef.current.has(next.asset) && !(heldRef.current && lane !== master)) playSlot(lane, L.active)
          if (entering) {
            // The old slot gets the next video once the transition is over.
            L.tail = old
          } else {
            v?.pause()
            const after = nextVideo(lane, index + 1)
            if (after) load(lane, old, after, entrySourceTime(track, after))
          }
        }
      }
      // The audio layer: at a cut, the waiting element takes over (when it holds the new clip); else it keeps with the clock.
      // Through an audio transition the outgoing element plays on as the tail until the window ends.
      const A = audioLane.current
      const audioTrack = p.audioTrack
      const aAt = audioTrack ? laneClipAt(audioTrack, t) : null
      const aIndex = aAt ? aAt.index : -1
      if (A.tail >= 0 && (!audioTrack || transitionAt(audioTrack, t)?.to !== A.index)) {
        // The transition's window is over: the outgoing element stops and waits on the next clip.
        const slot = A.tail
        A.tail = -1
        audioEls.current[slot]?.pause()
        const after = audioTrack?.clips[A.index + 1]
        if (after && audioTrack) loadAudio(slot, after, entrySourceTime(audioTrack, after))
      }
      if (aIndex !== A.index) {
        const w = audioTrack ? transitionAt(audioTrack, t) : null
        const entering = w !== null && A.index >= 0 && w.from === A.index && w.to === aIndex
        const old = A.active
        const next = aAt && audioTrack ? audioTrack.clips[aAt.index] : undefined
        if (next && aAt) {
          A.active = 1 - old
          // The waiting element holds it already (seeked to its entry): just bring it to the clock.
          if (A.clipIds[A.active] === next.id) {
            const a = audioEls.current[A.active]
            if (a && Math.abs(a.currentTime - aAt.sourceTime) > 0.05) loadAudio(A.active, next, aAt.sourceTime)
          } else loadAudio(A.active, next, aAt.sourceTime)
        } else audioEls.current[old]?.pause()
        A.index = aIndex
        if (entering && next) A.tail = old
        else {
          if (next) audioEls.current[old]?.pause()
          A.tail = -1
          const after = audioTrack ? (next ? audioTrack.clips[aIndex + 1] : audioTrack.clips.find((c) => c.start > t)) : undefined
          if (after && audioTrack) loadAudio(next ? old : 1 - A.active, after, entrySourceTime(audioTrack, after))
        }
        if (!heldRef.current) playAudio()
      } else if (aAt && audioTrack && !heldRef.current) {
        const clip = audioTrack.clips[aAt.index]
        const a = audioEls.current[A.active]
        // An element at a tape's speed runs off the clock on purpose.
        if (a && !a.seeking && !a.ended && !offSpeed(a)) {
          if (a.paused) playAudio()
          const to = resyncTo({ current: a.currentTime, expected: aAt.sourceTime, limit: Number.isFinite(a.duration) ? Math.min(clip.out, a.duration - END_MARGIN) : clip.out, now, lastResync: lastAudioResync.current })
          if (to !== null) {
            lastAudioResync.current = now
            try {
              a.currentTime = to
            } catch {
              // Not seekable yet.
            }
          }
        }
      }
      mixAudio(t)
      for (let lane = 0; lane < p.tracks.length; lane++) mixVolumes(lane, t)
      if (swapped) setActive(lanes.current.map((l) => l.active))
      if (cut || Math.abs(t - timeRef.current) >= TIME_STEP) setTimeline(t)
      else setFrame(t)
      raf.current = requestAnimationFrame((n) => tickRef.current(n))
    },
    [load, markFailed, pause, playSlot, setTimeline, setFrame, isImage, nextVideo, upcoming, playableClip, mixVolumes, playAudio, loadAudio, mixAudio]
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
    for (let lane = 0; lane < p.tracks.length; lane++) {
      const L = lanes.current[lane]
      const clip = p.tracks[lane].clips[L.index]
      const showingVideo = clip !== undefined && !isImage(clip)
      if (showingVideo) {
        playSlot(lane, L.active)
        L.primed[L.active] = true
      }
      // A transition's outgoing video plays too (seek above already loaded it).
      if (L.tail >= 0) {
        playSlot(lane, L.tail)
        L.primed[L.tail] = true
      }
      // Safari lets a later play() from the frame loop (at a cut) through only on an
      // element that was played inside a user gesture, so prime the waiting one now
      // (both, when an image or nothing is showing on this track). A track with no
      // video yet is skipped and primed by a later play(), once it has one.
      for (const slot of showingVideo ? [1 - L.active] : [0, 1]) {
        const v = el(lane, slot)
        if (!v || L.primed[slot]) continue
        if (!v.src) {
          // An empty slot would get its first src at a cut, unprimed, and Safari would
          // refuse that play(): load an upcoming video of this track (failing that, its first) into it now.
          const held = L.loaded[1 - slot]
          const from = upcoming(lane, L.index, timeRef.current)
          const later = p.tracks[lane].clips.slice(Number.isFinite(from) ? from : p.tracks[lane].clips.length).find((c) => !isImage(c) && c.asset !== held)
          const fill = later ?? nextVideo(lane, 0)
          if (!fill) continue
          load(lane, slot, fill, fill.in)
        }
        L.primed[slot] = true
        void v.play().catch(() => {})
        v.pause()
      }
    }
    // The audio layer: its clip at the playhead plays (seek loaded it), and the waiting element is primed inside this gesture too.
    playAudio()
    const waiting = audioLane.current.tail >= 0 ? null : audioEls.current[1 - audioLane.current.active]
    if (waiting?.src) {
      void waiting.play().catch(() => {})
      waiting.pause()
    }
    cancelAnimationFrame(raf.current)
    raf.current = requestAnimationFrame((n) => tickRef.current(n))
  }, [seek, playSlot, isImage, nextVideo, upcoming, load, playAudio])

  useEffect(() => {
    tickRef.current = tick
  }, [tick])

  const toggle = useCallback(() => (playingRef.current ? pause() : play()), [pause, play])

  const hasClips = project.tracks.some((t) => t.clips.length > 0) || (project.audioTrack?.clips.length ?? 0) > 0

  // An edit changed the tracks: each slot takes the mute of the clip it holds, the one playing and the
  // one waiting (without a re-seek, which would be heard).
  useEffect(() => {
    project.tracks.forEach((t, lane) => {
      const L = lanes.current[lane]
      const playingClip = t.clips[L.index]
      const waiting = nextVideo(lane, upcoming(lane, L.index, timeRef.current))
      // A transition's outgoing clip (the one before the clip playing) sits in the tail slot.
      const tailClip = L.tail >= 0 ? t.clips[L.index - 1] : undefined
      const a = el(lane, L.active)
      const b = el(lane, 1 - L.active)
      const inA = L.tail === L.active ? tailClip : playingClip
      const inB = L.tail === 1 - L.active ? tailClip : waiting
      if (a && inA) a.muted = Boolean(inA.muted)
      if (b && inB) b.muted = Boolean(inB.muted)
    })
    // The audio layer's elements take their clips' mute.
    audioEls.current.forEach((a, slot) => {
      const clip = project.audioTrack?.clips.find((c) => c.id === audioLane.current.clipIds[slot])
      if (a && clip) a.muted = Boolean(clip.muted)
    })
  }, [project.tracks, project.audioTrack, nextVideo, upcoming])

  // An edit changed the clips: show the frame at the current time again.
  useEffect(() => {
    // The audio layer's clips are compared after the picture layers'.
    const clips = [...project.tracks.map((t) => t.clips), project.audioTrack?.clips ?? []]
    const prev = shownClips.current
    shownClips.current = clips
    if (prev && sameClips(prev, clips)) return
    if (!hasClips) {
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
  }, [project.tracks, project.audioTrack])

  useEffect(() => () => cancelAnimationFrame(raf.current), [])

  /** A lane's slot video element (null: none yet), for what mirrors it (a transition's copies). */
  const videoAt = useCallback((lane: number, slot: number) => els.current[lane]?.[slot] ?? null, [])

  /** The asset loaded in a lane's slot (null: none), for event handlers. */
  const assetIn = useCallback((lane: number, slot: number) => lanes.current[lane]?.loaded[slot] ?? null, [])

  const onVideoError = useCallback(
    (lane: number, slot: number) => {
      const id = lanes.current[lane].loaded[slot]
      if (id) markFailed(id)
    },
    [markFailed]
  )

  /**
   * The playhead at every animation frame, for the few things that follow it
   * that closely (an animated text) without re-rendering the editor: a
   * useSyncExternalStore subscription and its snapshot.
   */
  const subscribeFrame = useCallback((listener: () => void) => {
    frameListeners.current.add(listener)
    return () => {
      frameListeners.current.delete(listener)
    }
  }, [])
  const frameTime = useCallback(() => frameRef.current, [])

  // The timeline was emptied while playing: adding a clip later mustn't come back "playing".
  if (!hasClips && playing) setPlaying(false)
  return { attach, attachAudio, assetIn, videoAt, active, playing: playing && hasClips, time: hasClips ? time : 0, failed, missing, play, pause, toggle, seek, onVideoError, subscribeFrame, frameTime }

}

export type PreviewPlayer = ReturnType<typeof usePreviewPlayer>
