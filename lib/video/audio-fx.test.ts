import { describe, expect, it } from "vitest"
import { audioCutState, audioEdgeState, combineFx, curveGain, ECHO_DELAYS, PLAIN, pictureEdgeGain, SWEEP_CLOSED, SWEEP_OPEN, sweepCutoff, tapeRates } from "./audio-fx"
import { AUDIO_CURVES, AUDIO_TRANSITION_TYPES, EDGE_AUDIO_TYPES } from "./transition-types"

describe("curveGain", () => {
  it("runs from 0 to 1 on every curve, as ffmpeg's afade does", () => {
    for (const c of AUDIO_CURVES) {
      expect(curveGain(c, 0)).toBeCloseTo(0, 4)
      expect(curveGain(c, 1)).toBeCloseTo(1, 6)
    }
    expect(curveGain("audio-linear", 0.5)).toBe(0.5)
    expect(curveGain("audio-equalpower", 0.5)).toBeCloseTo(Math.SQRT1_2)
    expect(curveGain("audio-scurve", 0.25)).toBeCloseTo((1 - Math.cos(Math.PI / 4)) / 2)
    // Log comes up early, exp late.
    expect(curveGain("audio-log", 0.5)).toBeGreaterThan(0.9)
    expect(curveGain("audio-exp", 0.5)).toBeLessThan(0.01)
  })
})

describe("audioCutState", () => {
  it("an equal-power crossfade keeps the summed power at 1", () => {
    for (const x of [0, 0.25, 0.5, 0.9]) {
      const out = audioCutState("audio-equalpower", "out", x).gain
      const inn = audioCutState("audio-equalpower", "in", x).gain
      expect(out ** 2 + inn ** 2).toBeCloseTo(1)
    }
  })

  it("a dip is silent through its middle fifth", () => {
    expect(audioCutState("audio-dip", "out", 0.5).gain).toBe(0)
    expect(audioCutState("audio-dip", "in", 0.5).gain).toBe(0)
    expect(audioCutState("audio-dip", "out", 0).gain).toBe(1)
    expect(audioCutState("audio-dip", "in", 1).gain).toBe(1)
  })

  it("the creative ones shape the outgoing sound and fade the incoming one in", () => {
    expect(audioCutState("audio-lowpass", "out", 0).lowpass).toBeCloseTo(SWEEP_OPEN)
    expect(audioCutState("audio-lowpass", "out", 1).lowpass).toBeCloseTo(SWEEP_CLOSED)
    expect(audioCutState("audio-tapestop", "out", 0.9).rate).toBeLessThan(0.2)
    expect(audioCutState("audio-echo", "out", 0.7)).toMatchObject({ gain: 0 })
    expect(audioCutState("audio-echo", "out", 0.7).echo).toBeGreaterThan(0)
    expect(audioCutState("audio-telephone", "in", 0.5)).toMatchObject({ lowpass: 3400, highpass: 300 })
    expect(audioCutState("audio-telephone", "in", 0.9).lowpass).toBeNull()
    for (const t of AUDIO_TRANSITION_TYPES) expect(audioCutState(t, "in", 1).gain).toBeCloseTo(1)
  })
})

describe("audioEdgeState", () => {
  it("fades in from silence and out to it", () => {
    for (const t of EDGE_AUDIO_TYPES.in) {
      expect(audioEdgeState(t, "in", 0).gain).toBeLessThan(0.05)
      expect(audioEdgeState(t, "in", 1).gain).toBeCloseTo(1)
    }
    for (const t of EDGE_AUDIO_TYPES.out) expect(audioEdgeState(t, "out", 1).gain).toBeCloseTo(0)
    expect(audioEdgeState("audio-tapestop", "in", 0.05).rate).toBeLessThan(0.1)
    expect(audioEdgeState("audio-lowpass", "in", 0).lowpass).toBeCloseTo(SWEEP_CLOSED)
  })
})

describe("helpers", () => {
  it("tape rates halve the source used, sweep cutoffs step in pitch, echoes decay", () => {
    expect(tapeRates(true).reduce((a, b) => a + b, 0) / tapeRates(true).length).toBeCloseTo(0.5)
    expect(tapeRates(false)[0]).toBeLessThan(tapeRates(false)[7])
    expect(sweepCutoff(0.5, true)).toBeCloseTo(Math.sqrt(SWEEP_OPEN * SWEEP_CLOSED))
    expect(ECHO_DELAYS.map((e) => e.decay)).toEqual([...ECHO_DELAYS.map((e) => e.decay)].sort((a, b) => b - a))
    expect(pictureEdgeGain("in", 0.5)).toBeCloseTo(Math.SQRT1_2)
    expect(combineFx({ ...PLAIN, gain: 0.5, lowpass: 1000 }, { ...PLAIN, gain: 0.5, lowpass: 500, highpass: 300 })).toEqual({ gain: 0.25, lowpass: 500, highpass: 300, rate: 1, echo: 0 })
  })
})
