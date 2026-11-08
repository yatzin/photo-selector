"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import type { ClipAudio } from "@/lib/video/audio-levels"
import { keepPlaying, loopTick, seekInSelection } from "@/lib/video/source-precision"
import type { SourceSelection } from "@/lib/video/source-window"
import { buildLevels, type LevelsChain } from "./audio-levels-graph"

// The Edit length dialog's preview: one <audio> or <video> element that plays
// exactly [in, out) of the current selection, looping or stopping at out. A
// selection that changes while it plays keeps the time when the new one still
// holds it, else starts again at in (keepPlaying). With audio levels the
// element goes through the same Web Audio chain as the editor's preview (made
// on the first Play press, closed with the dialog); export-only effects play
// dry there. Nothing plays until Play is pressed, and the element lets go of
// its file when the dialog closes.

export type SelectionPlayer = {
  /** The callback ref for the media element. */
  attach: (el: HTMLMediaElement | null) => void
  playing: boolean
  /** The element's time in the source (s). */
  position: number
  loop: boolean
  setLoop: (on: boolean) => void
  volume: number
  setVolume: (v: number) => void
  muted: boolean
  setMuted: (on: boolean) => void
  toggle: () => void
  /** Moves to source time `t`, kept inside the selection. */
  seek: (t: number) => void
}

export function useSelectionPlayer(selection: SourceSelection, audio: ClipAudio | undefined): SelectionPlayer {
  const el = useRef<HTMLMediaElement | null>(null)
  const sel = useRef(selection)
  const [playing, setPlaying] = useState(false)
  const [position, setPosition] = useState(selection.in)
  const [loop, setLoopState] = useState(true)
  const loopRef = useRef(true)
  const [volume, setVolume] = useState(1)
  const [muted, setMuted] = useState(false)
  const graph = useRef<{ ctx: AudioContext; levels: LevelsChain } | null>(null)
  const raf = useRef(0)

  const setLoop = useCallback((on: boolean) => {
    loopRef.current = on
    setLoopState(on)
  }, [])

  const moveTo = useCallback((t: number) => {
    const a = el.current
    if (a) {
      try {
        a.currentTime = t
      } catch {
        // Not seekable yet: loadedmetadata puts it at in.
      }
    }
    setPosition(t)
  }, [])

  // A new selection: carry on where it is if the new one still holds that time, else start again at in.
  useEffect(() => {
    sel.current = selection
    const a = el.current
    const t = keepPlaying(a ? a.currentTime : selection.in, selection)
    if (!a || Math.abs(t - a.currentTime) > 1e-3) moveTo(t)
  }, [selection.in, selection.out, moveTo]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const a = el.current
    if (!a) return
    a.volume = volume
    a.muted = muted
  }, [volume, muted])

  const stopLoop = () => cancelAnimationFrame(raf.current)

  const attach = useCallback((node: HTMLMediaElement | null) => {
    el.current = node
    if (!node) return
    const start = () => {
      try {
        node.currentTime = sel.current.in
      } catch {
        // Seeks once it can.
      }
    }
    node.addEventListener("loadedmetadata", start, { once: true })
  }, [])

  // Closing: stop, let the file go and close the audio context.
  useEffect(
    () => () => {
      stopLoop()
      const a = el.current
      if (a) {
        a.pause()
        a.removeAttribute("src")
        a.load()
      }
      const g = graph.current
      graph.current = null
      g?.levels.dispose()
      void g?.ctx.close().catch(() => {})
    },
    []
  )

  const toggle = useCallback(() => {
    const a = el.current
    if (!a) return
    if (!a.paused) {
      a.pause()
      stopLoop()
      setPlaying(false)
      // Where it stopped, not the last frame's time, so Set In/Out to playhead takes what was heard.
      setPosition(a.currentTime)
      return
    }
    if (audio && !graph.current) {
      // Made inside the press, so the browser lets it start.
      const ctx = new AudioContext()
      const levels = buildLevels(ctx, audio, a)
      ctx.createMediaElementSource(a).connect(levels.input)
      levels.output.connect(ctx.destination)
      graph.current = { ctx, levels }
    }
    void graph.current?.ctx.resume().catch(() => {})
    const s = sel.current
    if (loopTick(a.currentTime, s, true) !== "play") a.currentTime = s.in
    void a.play().catch(() => setPlaying(false))
    setPlaying(true)
    stopLoop()
    // Each frame: wrap at out (or stop there with loop off), pull a stray time back to in, and report the time.
    const tick = () => {
      const s = sel.current
      const what = loopTick(a.currentTime, s, loopRef.current)
      if (what === "restart" || (what === "play" && a.ended)) {
        a.currentTime = s.in
        if (a.paused) void a.play().catch(() => {})
      } else if (what === "stop" || a.ended) {
        a.pause()
        a.currentTime = s.in
        setPlaying(false)
        setPosition(s.in)
        return
      }
      setPosition(a.currentTime)
      raf.current = requestAnimationFrame(tick)
    }
    raf.current = requestAnimationFrame(tick)
  }, [audio])

  const seek = useCallback((t: number) => moveTo(seekInSelection(sel.current, t - sel.current.in)), [moveTo])

  return { attach, playing, position, loop, setLoop, volume, setVolume, muted, setMuted, toggle, seek }
}
