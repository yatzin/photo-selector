"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { clipAt, clipStarts, totalLength, type Project } from "@/lib/video/project"

// Plays the timeline in the browser with no re-encoding: two <video> elements
// take turns. One shows the current clip while the other waits on the next one
// (already loaded and seeked), so a cut doesn't stall.

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
  const urlRef = useRef(urlFor)
  const raf = useRef(0)
  const tickRef = useRef<() => void>(() => {})
  const [active, setActive] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [time, setTime] = useState(0)
  const [failed, setFailed] = useState<Set<string>>(() => new Set())

  useEffect(() => {
    clipsRef.current = project.clips
    urlRef.current = urlFor
  })

  const el = (slot: number) => (slot === 0 ? slotA.current : slotB.current)

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

  /** Shows the clip at `index` (source time `at`) in the active slot and gets the next clip ready in the other. */
  const showClip = useCallback(
    (index: number, at: number) => {
      const clips = clipsRef.current
      const clip = clips[index]
      if (!clip) return
      clipIndex.current = index
      load(activeSlot.current, clip.asset, at)
      const next = clips[index + 1]
      const other = 1 - activeSlot.current
      if (next) load(other, next.asset, next.in)
      else el(other)?.pause()
    },
    [load]
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

  const seek = useCallback(
    (t: number) => {
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
      if (playingRef.current) void el(activeSlot.current)?.play().catch(() => {})
    },
    [setTimeline, showClip]
  )

  const tick = useCallback(() => {
    if (!playingRef.current) return
    const clips = clipsRef.current
    const idx = clipIndex.current
    const clip = clips[idx]
    const v = el(activeSlot.current)
    if (clip && v) {
      if (v.currentTime >= clip.out - END_MARGIN) {
        const next = clips[idx + 1]
        if (next) {
          // Swap to the waiting slot.
          const old = activeSlot.current
          activeSlot.current = 1 - old
          setActive(activeSlot.current)
          clipIndex.current = idx + 1
          const nv = el(activeSlot.current)
          if (nv) {
            nv.currentTime = next.in
            void nv.play().catch(() => {})
          }
          v.pause()
          const after = clips[idx + 2]
          if (after) load(old, after.asset, after.in)
        } else {
          pause()
          setTimeline(totalLength(clips))
          return
        }
      } else {
        const t = clipStarts(clips)[idx] + (v.currentTime - clip.in)
        if (Math.abs(t - timeRef.current) >= TIME_STEP) setTimeline(t)
      }
    }
    raf.current = requestAnimationFrame(() => tickRef.current())
  }, [load, pause, setTimeline])

  const play = useCallback(() => {
    const clips = clipsRef.current
    if (!clips.length) return
    if (timeRef.current >= totalLength(clips) - 0.01) seek(0)
    else seek(timeRef.current)
    playingRef.current = true
    setPlaying(true)
    void el(activeSlot.current)?.play().catch(() => {})
    cancelAnimationFrame(raf.current)
    raf.current = requestAnimationFrame(() => tickRef.current())
  }, [seek])

  useEffect(() => {
    tickRef.current = tick
  }, [tick])

  const toggle = useCallback(() => (playingRef.current ? pause() : play()), [pause, play])

  // An edit changed the clips: show the frame at the current time again.
  useEffect(() => {
    if (!project.clips.length) {
      // Nothing to play: stop without touching state (the returned time/playing are derived below).
      playingRef.current = false
      timeRef.current = 0
      cancelAnimationFrame(raf.current)
      slotA.current?.pause()
      slotB.current?.pause()
      return
    }
    seek(Math.min(timeRef.current, totalLength(project.clips)))
    // seek is stable; only an edit should re-run this
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.clips])

  useEffect(() => () => cancelAnimationFrame(raf.current), [])

  const onVideoError = useCallback((slot: number) => {
    const id = loaded.current[slot]
    if (id) setFailed((f) => new Set(f).add(id))
  }, [])

  const hasClips = project.clips.length > 0
  return { slotA, slotB, active, playing: playing && hasClips, time: hasClips ? time : 0, failed, play, pause, toggle, seek, onVideoError }
}

export type PreviewPlayer = ReturnType<typeof usePreviewPlayer>
