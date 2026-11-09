"use client"

import { dbToGain, flangerParams, fxNodes, fxPreviewed, noiseSamples, passQ, shaperCurve, vibratoDelay, type AudioFxType, type AudioNodeSpec, type ClipAudio } from "@/lib/video/audio-levels"

// A clip's audio levels as a Web Audio chain (lib/video/audio-levels): its
// gain, then each effect's steps in order, built from the same specs the
// export turns into ffmpeg filters. An effect with a step Web Audio can't do
// faithfully (an "export" step: a gate, noise reduction, loudness, a pitch
// shift) is left out and named in `skipped`. Noise steps play only while
// `el` plays, so a paused preview stays silent.

export type LevelsChain = {
  input: AudioNode
  output: AudioNode
  /** Effects left out of the chain (heard in the export only). */
  skipped: AudioFxType[]
  /** What was built, for data attributes and tests: "gain=1.413;lowpass:6928,..." */
  describe: string
  dispose: () => void
}

type Built = { input: AudioNode; output: AudioNode; label: string }

const BIQUAD: Record<Extract<AudioNodeSpec, { kind: "filter" }>["type"], BiquadFilterType> = {
  highpass: "highpass", lowpass: "lowpass", bandpass: "bandpass", peaking: "peaking", lowshelf: "lowshelf", highshelf: "highshelf",
}

/** Builds one step; `later` collects what needs starting or stopping (oscillators, noise sources, listeners). */
function buildNode(ctx: BaseAudioContext, n: AudioNodeSpec, el: HTMLMediaElement | null, cleanup: (() => void)[]): Built | null {
  switch (n.kind) {
    case "filter": {
      const f = ctx.createBiquadFilter()
      f.type = BIQUAD[n.type]
      f.frequency.value = n.frequency
      if (n.type === "highpass" || n.type === "lowpass") f.Q.value = passQ(n.q)
      else if (n.type === "bandpass" || n.type === "peaking") f.Q.value = n.q ?? (n.type === "bandpass" ? Math.SQRT1_2 : 1)
      if (n.gain !== undefined) f.gain.value = n.gain
      return { input: f, output: f, label: `${n.type}:${n.frequency}` }
    }
    case "gain": {
      const g = ctx.createGain()
      g.gain.value = dbToGain(n.db)
      return { input: g, output: g, label: `gain:${n.db}` }
    }
    case "compressor":
    case "limiter": {
      const c = ctx.createDynamicsCompressor()
      const makeup = ctx.createGain()
      if (n.kind === "compressor") {
        c.threshold.value = n.threshold
        c.ratio.value = n.ratio
        c.knee.value = n.knee
        c.attack.value = n.attack
        c.release.value = n.release
        makeup.gain.value = dbToGain(n.makeup)
      } else {
        c.threshold.value = n.ceiling
        c.ratio.value = 20
        c.knee.value = 0
        c.attack.value = n.attack
        c.release.value = n.release
      }
      c.connect(makeup)
      return { input: c, output: makeup, label: n.kind === "compressor" ? `compressor:${n.threshold}/${n.ratio}` : `limiter:${n.ceiling}` }
    }
    case "shaper": {
      const s = ctx.createWaveShaper()
      s.curve = shaperCurve(n) as Float32Array<ArrayBuffer>
      return { input: s, output: s, label: `shaper:${n.curve}${n.drive}${n.levels ? `/${n.levels}` : ""}` }
    }
    case "noise": {
      const sum = ctx.createGain()
      const length = Math.round(ctx.sampleRate * 2)
      const buffer = ctx.createBuffer(1, length, ctx.sampleRate)
      buffer.copyToChannel(noiseSamples(n, length) as Float32Array<ArrayBuffer>, 0)
      const src = ctx.createBufferSource()
      src.buffer = buffer
      src.loop = true
      const level = ctx.createGain()
      // Heard only while the element plays.
      const gate = () => {
        level.gain.value = el && !el.paused ? 1 : 0
      }
      gate()
      if (el) {
        for (const type of ["play", "playing", "pause", "ended", "emptied"]) el.addEventListener(type, gate)
        cleanup.push(() => {
          for (const type of ["play", "playing", "pause", "ended", "emptied"]) el.removeEventListener(type, gate)
        })
      }
      src.connect(level).connect(sum)
      src.start()
      cleanup.push(() => src.stop())
      return { input: sum, output: sum, label: `noise:${n.hiss}/${n.crackle}` }
    }
    case "ring": {
      const g = ctx.createGain()
      g.gain.value = 0
      const osc = ctx.createOscillator()
      osc.frequency.value = n.frequency
      osc.connect(g.gain)
      osc.start()
      cleanup.push(() => osc.stop())
      return { input: g, output: g, label: `ring:${n.frequency}` }
    }
    case "taps": {
      const input = ctx.createGain()
      const sum = ctx.createGain()
      const out = ctx.createGain()
      out.gain.value = n.out
      const dry = ctx.createGain()
      dry.gain.value = n.dry
      input.connect(dry).connect(sum)
      n.delays.forEach((ms, k) => {
        const d = ctx.createDelay(Math.max(1, ms / 1000 + 0.1))
        d.delayTime.value = ms / 1000
        const g = ctx.createGain()
        g.gain.value = n.decays[k]
        input.connect(d).connect(g).connect(sum)
      })
      sum.connect(out)
      return { input, output: out, label: `taps:${n.delays.join("|")}` }
    }
    case "mono": {
      // One channel, the browser's own downmix ((L + R) / 2); the next node copies it back to both sides.
      const g = ctx.createGain()
      g.channelCount = 1
      g.channelCountMode = "explicit"
      g.channelInterpretation = "speakers"
      return { input: g, output: g, label: "mono" }
    }
    case "haas": {
      const input = ctx.createGain()
      input.channelCount = 2
      input.channelCountMode = "explicit"
      const split = ctx.createChannelSplitter(2)
      const merge = ctx.createChannelMerger(2)
      const d = ctx.createDelay(0.1)
      d.delayTime.value = n.ms / 1000
      input.connect(split)
      split.connect(merge, 0, 0)
      split.connect(d, 1).connect(merge, 0, 1)
      return { input, output: merge, label: `haas:${n.ms}` }
    }
    case "vibrato": {
      const { base, sweep } = vibratoDelay(n.depth)
      const d = ctx.createDelay(0.05)
      d.delayTime.value = base
      const osc = ctx.createOscillator()
      osc.frequency.value = n.rate
      const amp = ctx.createGain()
      amp.gain.value = sweep
      osc.connect(amp).connect(d.delayTime)
      osc.start()
      cleanup.push(() => osc.stop())
      return { input: d, output: d, label: `vibrato:${n.rate}/${n.depth}` }
    }
    case "flanger": {
      const p = flangerParams(n)
      const input = ctx.createGain()
      const sum = ctx.createGain()
      const dry = ctx.createGain()
      dry.gain.value = p.dry
      const wet = ctx.createGain()
      wet.gain.value = p.wet
      const d = ctx.createDelay(0.05)
      d.delayTime.value = p.base
      const fb = ctx.createGain()
      fb.gain.value = p.feedback
      const osc = ctx.createOscillator()
      osc.frequency.value = n.speed
      const amp = ctx.createGain()
      amp.gain.value = p.sweep
      osc.connect(amp).connect(d.delayTime)
      osc.start()
      cleanup.push(() => osc.stop())
      input.connect(dry).connect(sum)
      input.connect(d)
      d.connect(fb).connect(d)
      d.connect(wet).connect(sum)
      return { input, output: sum, label: `flanger:${n.depth}/${n.regen}` }
    }
    case "export":
      return null
  }
}

/** The chain for `audio` in `ctx` (input: the clip's gain, always two channels so a mono source widens and splits correctly). */
export function buildLevels(ctx: BaseAudioContext, audio: ClipAudio | undefined, el: HTMLMediaElement | null = null): LevelsChain {
  const cleanup: (() => void)[] = []
  const nodes: AudioNode[] = []
  const input = ctx.createGain()
  input.channelCount = 2
  input.channelCountMode = "explicit"
  input.channelInterpretation = "speakers"
  const gain = dbToGain(audio?.gainDb ?? 0)
  input.gain.value = gain
  nodes.push(input)
  let output: AudioNode = input
  const skipped: AudioFxType[] = []
  const labels: string[] = []
  for (const fx of audio?.fx ?? []) {
    if (!fxPreviewed(fx.type)) {
      skipped.push(fx.type)
      continue
    }
    for (const spec of fxNodes(fx)) {
      const built = buildNode(ctx, spec, el, cleanup)
      if (!built) continue
      output.connect(built.input)
      output = built.output
      nodes.push(built.input, built.output)
      labels.push(built.label)
    }
  }
  return {
    input,
    output,
    skipped,
    describe: `gain=${Math.round(gain * 1000) / 1000};${labels.join(",") || "-"}${skipped.length ? `;skipped=${skipped.join(",")}` : ""}`,
    dispose: () => {
      for (const f of cleanup) {
        try {
          f()
        } catch {
          // Already stopped.
        }
      }
      for (const n of nodes) n.disconnect()
    },
  }
}
