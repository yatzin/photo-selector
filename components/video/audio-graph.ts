"use client"

import { PLAIN, type AudioFxState } from "@/lib/video/audio-fx"
import { sameClipAudio, type ClipAudio } from "@/lib/video/audio-levels"
import { buildLevels, type LevelsChain } from "./audio-levels-graph"

// Plays an <audio> or <video> element's sound as an AudioFxState says
// (lib/video/audio-fx): its gain, and, once it needs a filter or an echo, a
// Web Audio chain of its own (high-pass, low-pass, gain, and a feedback delay
// for the echo). An element joins the chain the first time it needs one and
// stays in it (a media element can be connected only once); until then only
// its volume and speed are set. A tape's speed is the element's playbackRate
// with its pitch following (preservesPitch off; browsers go no lower than
// MIN_RATE). Each element's data-fx attribute shows the state applied, for
// tests and debugging (no one can listen in a headless browser).
//
// A clip's audio levels (Clip.audio: gain and effects, ./audio-levels-graph)
// sit between the element's source and the high-pass: setLevels swaps them
// when the element takes another clip. An element whose clips have no levels
// and need no filter never joins a chain, so it keeps the plain element path;
// one that has joined keeps its chain and takes its volume there (setVolume).

/** The lowest playback rate browsers accept. */
const MIN_RATE = 0.0625
/** The echo's delay (s) and how much of it feeds back. */
const ECHO_DELAY = 0.2
const ECHO_FEEDBACK = 0.55

type Chain = { ctx: AudioContext; source: MediaElementAudioSourceNode; high: BiquadFilterNode; low: BiquadFilterNode; gain: GainNode; wet: GainNode; levels: LevelsChain | null; audio: ClipAudio | undefined }

let shared: AudioContext | null = null
const chains = new WeakMap<HTMLMediaElement, Chain>()

/** The page's AudioContext, made on first use (null where there is none). */
function context(): AudioContext | null {
  if (shared) return shared
  const Ctor = typeof window === "undefined" ? undefined : window.AudioContext
  if (!Ctor) return null
  shared = new Ctor()
  return shared
}

/** The element's chain: source, high-pass, low-pass, gain to the speakers, and the gain into a delay that feeds back on itself (the echo). */
function chainFor(el: HTMLMediaElement): Chain | null {
  const found = chains.get(el)
  if (found) return found
  const ctx = context()
  if (!ctx) return null
  try {
    const source = ctx.createMediaElementSource(el)
    const high = ctx.createBiquadFilter()
    high.type = "highpass"
    high.frequency.value = 10
    const low = ctx.createBiquadFilter()
    low.type = "lowpass"
    low.frequency.value = 22000
    const gain = ctx.createGain()
    const wet = ctx.createGain()
    wet.gain.value = 0
    const delay = ctx.createDelay(1)
    delay.delayTime.value = ECHO_DELAY
    const feedback = ctx.createGain()
    feedback.gain.value = ECHO_FEEDBACK
    source.connect(high).connect(low).connect(gain).connect(ctx.destination)
    gain.connect(delay)
    delay.connect(feedback).connect(delay)
    delay.connect(wet).connect(ctx.destination)
    const chain: Chain = { ctx, source, high, low, gain, wet, levels: null, audio: undefined }
    chains.set(el, chain)
    return chain
  } catch {
    return null
  }
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v))
const round = (v: number) => Math.round(v * 1000) / 1000

/** Sets an element's sound to `s`: its volume (or its chain's gain), filters, echo and speed. */
export function applyFx(el: HTMLMediaElement, s: AudioFxState = PLAIN) {
  const needs = s.lowpass !== null || s.highpass !== null || s.echo > 0
  const chain = needs ? chainFor(el) : chains.get(el)
  if (chain) {
    if (chain.ctx.state === "suspended") void chain.ctx.resume().catch(() => {})
    el.volume = 1
    chain.gain.gain.value = clamp01(s.gain)
    chain.low.frequency.value = s.lowpass ?? 22000
    chain.high.frequency.value = s.highpass ?? 10
    chain.wet.gain.value = clamp01(s.echo) * 0.6
  } else {
    el.volume = clamp01(s.gain)
  }
  const rate = Math.max(MIN_RATE, s.rate)
  if (el.playbackRate !== rate) {
    // A tape's pitch drops with its speed.
    el.preservesPitch = rate === 1
    el.playbackRate = rate
  }
  el.dataset.fx = `gain=${round(clamp01(s.gain))};lowpass=${s.lowpass === null ? "-" : Math.round(s.lowpass)};highpass=${s.highpass === null ? "-" : Math.round(s.highpass)};rate=${round(rate)};echo=${round(s.echo)};chain=${chain ? "on" : "off"}`
}

/**
 * Sets the audio levels of the clip an element holds: rebuilt between its
 * source and its filters when they change. Nothing happens for an element with
 * no chain and a clip with no levels (the plain path stays).
 */
export function setLevels(el: HTMLMediaElement, audio: ClipAudio | undefined) {
  const found = chains.get(el)
  if (!found && !audio) return
  const chain = found ?? chainFor(el)
  if (!chain) return
  if (!found) el.volume = 1
  if (chain.ctx.state === "suspended") void chain.ctx.resume().catch(() => {})
  if (Boolean(chain.levels) === Boolean(audio) && sameClipAudio(chain.audio, audio)) return
  chain.source.disconnect()
  chain.levels?.dispose()
  chain.levels = audio ? buildLevels(chain.ctx, audio, el) : null
  chain.audio = audio
  if (chain.levels) {
    chain.source.connect(chain.levels.input)
    chain.levels.output.connect(chain.high)
  } else chain.source.connect(chain.high)
  el.dataset.levels = chain.levels ? chain.levels.describe : "-"
}

/** An element's volume (0 to 1): its chain's gain once it has one (the element's own volume isn't heard there in every browser), else the element's. */
export function setVolume(el: HTMLMediaElement, volume: number) {
  const chain = chains.get(el)
  const v = clamp01(volume)
  if (chain) {
    if (el.volume !== 1) el.volume = 1
    chain.gain.gain.value = v
  } else el.volume = v
  const shown = String(round(v))
  if (el.dataset.volume !== shown) el.dataset.volume = shown
}

/** Whether an element plays at a tape's speed now (it then runs off the clock on purpose: no resync). */
export const offSpeed = (el: HTMLMediaElement) => el.playbackRate !== 1
