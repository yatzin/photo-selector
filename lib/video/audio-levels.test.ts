import { describe, expect, it } from "vitest"
import {
  AUDIO_FX_GROUPS, AUDIO_FX_TYPES, AUDIO_PRESETS, audioFxInfo, audioLevelFilters, audioSummary, flangerParams, fxFilters, fxNodes, fxPreviewed, MAX_FX, noiseSamples,
  normalizeClipAudio, passQ, sameClipAudio, shaperCurve, shapeValue, vibratoDelay, type AudioFxType,
} from "./audio-levels"

describe("audioFxInfo", () => {
  it("has a name, group, description, best for and avoid when for every effect, ids unique, no text repeated", () => {
    expect(new Set(AUDIO_FX_TYPES).size).toBe(AUDIO_FX_TYPES.length)
    const texts: string[] = []
    for (const t of AUDIO_FX_TYPES) {
      const info = audioFxInfo(t)
      expect(info.id).toBe(t)
      expect(info.name.length).toBeGreaterThan(2)
      expect(AUDIO_FX_GROUPS).toContain(info.group)
      for (const s of [info.description, info.bestFor, info.avoid]) expect(s.trim().length).toBeGreaterThan(20)
      expect(typeof info.amount).toBe("boolean")
      texts.push(info.description, info.bestFor, info.avoid)
    }
    expect(new Set(texts).size).toBe(texts.length)
    expect(new Set(AUDIO_FX_TYPES.map((t) => audioFxInfo(t).name)).size).toBe(AUDIO_FX_TYPES.length)
  })

  it("puts the user's examples first in Character, and every group has effects", () => {
    const character = AUDIO_FX_TYPES.filter((t) => audioFxInfo(t).group === "Character")
    expect(character.slice(0, 4)).toEqual(["lofi", "telephone", "radio", "can"])
    for (const g of AUDIO_FX_GROUPS) expect(AUDIO_FX_TYPES.some((t) => audioFxInfo(t).group === g)).toBe(true)
  })

  it("marks the effects the preview can't play", () => {
    const exportOnly = AUDIO_FX_TYPES.filter((t) => !fxPreviewed(t))
    expect(exportOnly).toEqual(["gate", "denoise", "normalize", "chipmunk", "deep"])
  })

  it("has presets of known effects within the limit", () => {
    expect(AUDIO_PRESETS.map((p) => p.name)).toEqual(["Voice clean-up", "Radio", "Phone", "Muffled hallway"])
    expect(AUDIO_PRESETS[0].fx).toEqual(["lowcut", "compressor", "voice", "normalize"])
    expect(AUDIO_PRESETS[3].fx).toEqual(["muffled", "room"])
    for (const p of AUDIO_PRESETS) expect(p.fx.length).toBeLessThanOrEqual(MAX_FX)
  })
})

describe("normalizeClipAudio", () => {
  it("keeps a gain and effects, drops what's empty or default", () => {
    expect(normalizeClipAudio({ gainDb: 3, fx: [{ type: "telephone", amount: 0.2 }] })).toEqual({ gainDb: 3, fx: [{ type: "telephone", amount: 0.2 }] })
    expect(normalizeClipAudio({ gainDb: 0, fx: [] })).toBeUndefined()
    expect(normalizeClipAudio({})).toBeUndefined()
    // No slider: the amount isn't stored.
    expect(normalizeClipAudio({ fx: [{ type: "limiter", amount: 0.9 }] })).toEqual({ fx: [{ type: "limiter" }] })
    expect(normalizeClipAudio({ gainDb: -60 })).toEqual({ gainDb: -60 })
    expect(normalizeClipAudio({ gainDb: 24 })).toEqual({ gainDb: 24 })
  })

  it("refuses out-of-range gains, too many, unknown or repeated effects and bad intensities", () => {
    for (const bad of [
      null, [], 5, { gainDb: 24.5 }, { gainDb: -61 }, { gainDb: Infinity }, { gainDb: "3" }, { fx: "telephone" },
      { fx: [{ type: "nope" }] }, { fx: [{ type: "echo" }, { type: "echo" }] }, { fx: [{ type: "echo", amount: 1.1 }] }, { fx: [{ type: "echo", amount: -0.1 }] },
      { fx: [{ type: "echo", amount: NaN }] }, { fx: [{ type: "lowcut" }, { type: "highcut" }, { type: "bass" }, { type: "treble" }, { type: "voice" }] }, { fx: [null] },
    ]) expect(normalizeClipAudio(bad)).toBeNull()
  })

  it("compares levels by sound: absent equals 0 dB, a missing intensity equals the default", () => {
    expect(sameClipAudio(undefined, {})).toBe(true)
    expect(sameClipAudio({ fx: [{ type: "echo" }] }, { fx: [{ type: "echo", amount: 0.5 }] })).toBe(true)
    expect(sameClipAudio({ fx: [{ type: "echo" }] }, { fx: [{ type: "echo", amount: 0.6 }] })).toBe(false)
    expect(sameClipAudio({ gainDb: 1 }, undefined)).toBe(false)
    expect(sameClipAudio({ fx: [{ type: "echo" }, { type: "room" }] }, { fx: [{ type: "room" }, { type: "echo" }] })).toBe(false)
  })

  it("summarises the gain and the effects for a title", () => {
    expect(audioSummary({ gainDb: 3, fx: [{ type: "telephone" }] })).toBe("+3 dB, Telephone")
    expect(audioSummary({ gainDb: -6.5 })).toBe("-6.5 dB")
    expect(audioSummary({ fx: [{ type: "radio" }] })).toBe("Old-time radio")
  })
})

describe("ffmpeg filters", () => {
  const expected: Record<AudioFxType, string[]> = {
    lowcut: ["highpass=f=120"], highcut: ["lowpass=f=6928"], bass: ["bass=g=7.5:f=100:t=s:w=1"], treble: ["treble=g=7.5:f=5000:t=s:w=1"],
    voice: ["highpass=f=90", "equalizer=f=3000:t=q:w=1:g=5"], deess: ["equalizer=f=7000:t=q:w=1.5:g=-7.5"], compressor: ["acompressor="], limiter: ["alimiter=limit=0.891251"],
    gate: ["agate="], denoise: ["afftdn=nr=18"], normalize: ["loudnorm=I=-16"], mono: ["pan=stereo|c0=0.5*c0+0.5*c1"], wide: ["adelay=delays=0|12"],
    room: ["aecho=1:"], hall: ["aecho=1:", "lowpass=f=6000"], echo: ["aecho=1:", ":300|600|900:"], slapback: [":110:"],
    lofi: ["highpass=f=300", "lowpass=f=4000", "aeval=exprs='round((tanh(2.5*val(0))"], telephone: ["highpass=f=400", "lowpass=f=3400", "tanh(2*val(0))"],
    radio: ["pan=stereo", "highpass=f=500", "lowpass=f=3000", "equalizer=f=1800", "random(0)"], can: ["bandpass=f=1600:t=q:w=3", "equalizer=f=2600:t=q:w=8", "aecho=0.8:"],
    megaphone: ["highpass=f=500", "lowpass=f=4000", "clip(7.5*val(0),-1,1)", "volume=-3dB"], muffled: ["lowpass=f=474"], underwater: ["lowpass=f=600", "vibrato=f=1:d=0.5"],
    robot: ["sin(2*PI*75*t)", "aecho=1:"], chipmunk: ["asetrate=64072", "aresample=48000", "atempo=0.749157"], deep: ["asetrate=35959", "atempo=1.334854"],
    alien: ["flanger=delay=1:depth=5.5:regen=60:width=71:speed=0.6", "vibrato=f=6:d=0.25"], vinyl: ["highpass=f=40", "lowpass=f=9000", "random(1)"],
  }

  it("builds each effect's chain at the default intensity", () => {
    for (const t of AUDIO_FX_TYPES) {
      const chain = fxFilters({ type: t }).join(",")
      for (const part of expected[t]) expect(chain, t).toContain(part)
    }
  })

  it("scales with the intensity", () => {
    expect(fxFilters({ type: "lowcut", amount: 0 })).toEqual(["highpass=f=40"])
    expect(fxFilters({ type: "lowcut", amount: 1 })).toEqual(["highpass=f=200"])
    expect(fxFilters({ type: "highcut", amount: 1 })).toEqual(["lowpass=f=3000"])
    expect(fxFilters({ type: "muffled", amount: 1 })).toEqual(["lowpass=f=250", "lowpass=f=250"])
    expect(fxFilters({ type: "robot", amount: 0 })[0]).toContain("sin(2*PI*30*t)")
    // No slider: the intensity is ignored.
    expect(fxFilters({ type: "limiter", amount: 1 })).toEqual(fxFilters({ type: "limiter" }))
  })

  it("puts the gain first, then the effects in order; nothing for absent levels", () => {
    expect(audioLevelFilters(undefined)).toEqual([])
    expect(audioLevelFilters({ gainDb: 6 })).toEqual(["volume=6dB"])
    const stack = audioLevelFilters({ gainDb: -3, fx: [{ type: "lowcut" }, { type: "compressor" }, { type: "voice" }, { type: "normalize" }] })
    expect(stack[0]).toBe("volume=-3dB")
    expect(stack.findIndex((f) => f.startsWith("highpass"))).toBeLessThan(stack.findIndex((f) => f.startsWith("acompressor")))
    expect(stack[stack.length - 1]).toBe("aresample=48000")
  })

  it("keeps the taps' mix from clipping and the numbers deterministic", () => {
    for (const t of ["room", "hall", "echo", "slapback", "can", "robot"] as const) {
      for (const n of fxNodes({ type: t, amount: 1 })) {
        if (n.kind !== "taps") continue
        expect(n.out).toBeLessThanOrEqual(1)
        for (const d of n.decays) expect(d).toBeLessThanOrEqual(1)
      }
    }
    expect(fxFilters({ type: "radio" })).toEqual(fxFilters({ type: "radio" }))
  })
})

describe("preview maths", () => {
  it("shapes soft and hard clipping and bit reduction", () => {
    expect(shapeValue({ curve: "soft", drive: 2 }, 1)).toBeCloseTo(1)
    expect(shapeValue({ curve: "soft", drive: 2 }, 0)).toBe(0)
    expect(shapeValue({ curve: "hard", drive: 4 }, 0.5)).toBe(1)
    expect(shapeValue({ curve: "hard", drive: 4 }, 0.1)).toBeCloseTo(0.4)
    expect(shapeValue({ curve: "soft", drive: 1, levels: 4 }, 0.3) * 4 % 1).toBe(0)
    const curve = shaperCurve({ curve: "soft", drive: 3 }, 5)
    expect(curve.length).toBe(5)
    expect(curve[2]).toBe(0)
    expect(curve[0]).toBeCloseTo(-1)
  })

  it("makes the same noise every time, within its level", () => {
    const spec = { hiss: 0.01, crackle: 0.2, rate: 0.001 }
    const a = noiseSamples(spec, 48000)
    expect(a).toEqual(noiseSamples(spec, 48000))
    expect(Math.max(...a.map(Math.abs))).toBeLessThanOrEqual(0.21)
    const pops = a.filter((v) => Math.abs(v) > 0.011).length
    expect(pops).toBeGreaterThan(5)
    expect(pops).toBeLessThan(150)
  })

  it("converts Q, vibrato and flanger settings for Web Audio", () => {
    expect(passQ()).toBeCloseTo(-3.01, 2)
    expect(passQ(1)).toBe(0)
    expect(vibratoDelay(0.5)).toEqual({ base: 0.00125, sweep: 0.00125 })
    expect(flangerParams({ delay: 1, depth: 4, regen: 50, width: 100 })).toEqual({ base: 0.003, sweep: 0.002, feedback: 0.5, dry: 0.5, wet: 0.5 })
  })
})
