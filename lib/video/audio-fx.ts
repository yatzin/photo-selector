import { isAudioCurve, type AudioCurve, type AudioTransitionType, type Edge } from "./transition-types"

// How the audio transitions and edge fades sound, in numbers the export
// (lib/video/ffmpeg-server, afade curves and filters) and the preview (gain
// and Web Audio nodes) share. Plain maths, safe on the client.

/**
 * The gain (0 to 1) of ffmpeg's afade curve for each audio curve at `x`, the
 * fraction of a fade-in done (for a fade-out, what is left of it): tri, qsin,
 * hsin, log and exp, with ffmpeg's own formulas.
 */
export function curveGain(curve: AudioCurve, x: number): number {
  const g = Math.min(1, Math.max(0, x))
  switch (curve) {
    case "audio-linear":
      return g
    case "audio-equalpower":
      return Math.sin((g * Math.PI) / 2)
    case "audio-scurve":
      return (1 - Math.cos(g * Math.PI)) / 2
    case "audio-log":
      return g <= 0 ? 0 : Math.min(1, Math.max(0, 1 + 0.2 * Math.log10(g)))
    case "audio-exp":
      return g <= 0 ? 0 : Math.exp(-11.512925464970227 * (1 - g))
  }
}

/** An equal-power fade's gain at `x` (qsin). */
export const equalPower = (x: number) => curveGain("audio-equalpower", x)

/** A low-pass sweep's cutoffs (Hz): open and closed. */
export const SWEEP_OPEN = 12000
export const SWEEP_CLOSED = 300

/** A low-pass sweep's cutoff `q` (0 to 1) of the way through: from open to closed when `closing`, else back up; even steps in pitch. */
export const sweepCutoff = (q: number, closing: boolean) => {
  const t = Math.min(1, Math.max(0, q))
  return closing ? SWEEP_OPEN * (SWEEP_CLOSED / SWEEP_OPEN) ** t : SWEEP_CLOSED * (SWEEP_OPEN / SWEEP_CLOSED) ** t
}

/** The telephone band (Hz). */
export const PHONE_BAND = { low: 300, high: 3400 }

/** An echo trail's repeats: delay (s) and level. */
export const ECHO_DELAYS = [
  { delay: 0.2, decay: 0.5 },
  { delay: 0.4, decay: 0.35 },
  { delay: 0.6, decay: 0.2 },
]

/** Stretches a tape stop (or start) plays at, each at its own speed. */
export const TAPE_STEPS = 8

/** A tape's speed in each of its stretches: from nearly full down to nearly nothing (a stop), or back up (a start). */
export const tapeRates = (stop: boolean) => Array.from({ length: TAPE_STEPS }, (_, k) => (stop ? 1 - (k + 0.5) / TAPE_STEPS : (k + 0.5) / TAPE_STEPS))

/**
 * How one sound plays at a moment: its gain, a low-pass and a high-pass
 * cutoff (Hz; null: none), its speed (a tape's: pitch with it) and how much
 * of it feeds an echo (0: none).
 */
export type AudioFxState = { gain: number; lowpass: number | null; highpass: number | null; rate: number; echo: number }

export const PLAIN: AudioFxState = { gain: 1, lowpass: null, highpass: null, rate: 1, echo: 0 }

const at = (s: Partial<AudioFxState>): AudioFxState => ({ ...PLAIN, ...s })

/** A tape's speed `x` (0 to 1) of the way through a stop or a start: what tapeRates steps through. */
const tapeRate = (x: number, stop: boolean) => {
  const k = Math.min(TAPE_STEPS - 1, Math.floor(Math.min(1, Math.max(0, x)) * TAPE_STEPS))
  return tapeRates(stop)[k]
}

/**
 * How the outgoing (`role` "out") or incoming sound of an audio transition
 * plays `progress` (0 to 1) of the way through its window, as the export
 * builds it: a curve crossfades on it; a dip fades out over the first 40% and
 * in over the last 40%; a low-pass sweep closes over the outgoing sound and a
 * telephone band narrows it as it fades (equal power); a tape stop slows the
 * outgoing sound from the window's start, fading over its last 30%; an echo
 * trail sends the outgoing sound into echoes from the window's start, the
 * dry sound gone by the cut and the echoes fading over the second half. The
 * incoming sound fades in on equal power (in the telephone band for the first
 * three quarters of a telephone swap).
 */
export function audioCutState(type: AudioTransitionType, role: "out" | "in", progress: number): AudioFxState {
  const x = Math.min(1, Math.max(0, progress))
  if (isAudioCurve(type)) return at({ gain: curveGain(type, role === "in" ? x : 1 - x) })
  if (type === "audio-dip") return at({ gain: role === "out" ? equalPower(Math.max(0, 1 - x / 0.4)) : equalPower(Math.max(0, (x - 0.6) / 0.4)) })
  if (role === "in") return at({ gain: equalPower(x), ...(type === "audio-telephone" && x < 0.75 ? { lowpass: PHONE_BAND.high, highpass: PHONE_BAND.low } : {}) })
  switch (type) {
    case "audio-lowpass":
      return at({ gain: equalPower(1 - x), lowpass: sweepCutoff(x, true) })
    case "audio-telephone":
      return at({ gain: equalPower(1 - x), lowpass: PHONE_BAND.high, highpass: PHONE_BAND.low })
    case "audio-tapestop":
      return at({ gain: x < 0.7 ? 1 : equalPower((1 - x) / 0.3), rate: tapeRate(x, true) })
    default:
      // The echo: the dry sound (its source runs out at the cut) fades over the last 30% of the first half; the echoes ring on, fading over the second half.
      return at({ gain: x < 0.35 ? 1 : x < 0.5 ? equalPower((0.5 - x) / 0.15) : 0, echo: x < 0.5 ? 1 : equalPower((1 - x) / 0.5) })
  }
}

/**
 * How an audio clip's sound plays `progress` (0 to 1) of the way through its
 * edge transition at `edge`: a curve fades on it (in from silence, out to
 * it); a low-pass sweep opens as it fades in or closes as it fades out (equal
 * power); a tape starts from nearly still (fading in over its first 30%) or
 * stops (fading over its last 30%); an echo tail trails the sound off into
 * echoes (its dry sound gone halfway, the echoes fading over the second half).
 */
export function audioEdgeState(type: AudioTransitionType, edge: Edge, progress: number): AudioFxState {
  const x = Math.min(1, Math.max(0, progress))
  if (isAudioCurve(type)) return at({ gain: curveGain(type, edge === "in" ? x : 1 - x) })
  switch (type) {
    case "audio-lowpass":
      return edge === "in" ? at({ gain: equalPower(x), lowpass: sweepCutoff(x, false) }) : at({ gain: equalPower(1 - x), lowpass: sweepCutoff(x, true) })
    case "audio-tapestop":
      return edge === "in" ? at({ gain: x < 0.3 ? equalPower(x / 0.3) : 1, rate: tapeRate(x, false) }) : at({ gain: x < 0.7 ? 1 : equalPower((1 - x) / 0.3), rate: tapeRate(x, true) })
    case "audio-echo":
      return at({ gain: x < 0.35 ? 1 : x < 0.5 ? equalPower((0.5 - x) / 0.15) : 0, echo: x < 0.5 ? 1 : equalPower((1 - x) / 0.5) })
    default:
      return PLAIN
  }
}

/** A picture clip's own sound at a picture edge transition: an equal-power fade with the picture. */
export const pictureEdgeGain = (edge: Edge, progress: number) => equalPower(edge === "in" ? progress : 1 - progress)

/** Two states on one sound (an edge's and a cut's): gains multiply, the lower low-pass and the higher high-pass win, speeds multiply, the stronger echo wins. */
export function combineFx(a: AudioFxState, b: AudioFxState): AudioFxState {
  const lower = (x: number | null, y: number | null) => (x === null ? y : y === null ? x : Math.min(x, y))
  const higher = (x: number | null, y: number | null) => (x === null ? y : y === null ? x : Math.max(x, y))
  return { gain: a.gain * b.gain, lowpass: lower(a.lowpass, b.lowpass), highpass: higher(a.highpass, b.highpass), rate: a.rate * b.rate, echo: Math.max(a.echo, b.echo) }
}
