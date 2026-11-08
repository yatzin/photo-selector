import { execFile } from "child_process"
import fs from "fs"
import os from "os"
import path from "path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { AUDIO_FX_TYPES, fxFilters, type ClipAudio } from "./audio-levels"
import { buildExportArgs, buildExportGraph, runExport } from "./ffmpeg-server"
import { newProject, setClipAudio, setClipMuted, totalLength, type Project } from "./project"

/** A video with sound on the base (0-4 s) and a song on the audio layer at 1 s, 2 s long from its 3 s mark. */
function withSong(): Project {
  return {
    ...newProject("Levels"),
    assets: {
      v: { file: "v.mp4", duration: 10, hasAudio: true },
      w: { file: "w.mp4", duration: 10, hasAudio: true },
      m: { file: "song.mp3", duration: 30, hasAudio: true, kind: "audio" },
    },
    tracks: [{ id: "t1", clips: [{ id: "c1", asset: "v", in: 0, out: 4, start: 0 }] }],
    audioTrack: { id: "audio", clips: [{ id: "a1", asset: "m", in: 3, out: 5, start: 1 }] },
  }
}
const files = { v: "/media/v.mp4", w: "/media/w.mp4", m: "/media/song.mp3" }
const graph = (p: Project) => buildExportGraph(p, files).graph

describe("buildExportGraph with audio levels", () => {
  it("puts a video's gain after its cut and before its delay, and takes the uniform graph", () => {
    const g = graph(setClipAudio(withSong(), "c1", { gainDb: 6 }))
    expect(g).toContain("[0:a]atrim=0:4,asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo,volume=6dB,atrim=end=4,adelay=delays=0S:all=1[a0]")
    expect(g).toContain("[bg]")
  })

  it("runs an audio clip's effects in order after its gain", () => {
    const audio: ClipAudio = { gainDb: -3, fx: [{ type: "lowcut" }, { type: "compressor" }, { type: "voice" }, { type: "normalize" }] }
    const g = graph(setClipAudio(withSong(), "a1", audio))
    const chain = ["volume=-3dB", ...audio.fx!.flatMap(fxFilters)].join(",")
    expect(g).toContain(`[1:a]atrim=3:5,asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo,${chain},atrim=end=2,adelay=delays=48000S:all=1[a1]`)
  })

  it("builds every effect into the graph", () => {
    for (const type of AUDIO_FX_TYPES) {
      const g = graph(setClipAudio(withSong(), "a1", { fx: [{ type }] }))
      expect(g, type).toContain(`aformat=channel_layouts=stereo,${fxFilters({ type }).join(",")},atrim=end=2,`)
    }
  })

  it("applies the levels before a J-cut's fade and an edge fade, over the whole stretch", () => {
    let p = withSong()
    p.tracks[0].clips = [
      { id: "c1", asset: "v", in: 0, out: 4, start: 0 },
      { id: "c2", asset: "w", in: 2, out: 6, start: 4, cutAudio: { mode: "j", duration: 1 }, edgeOut: { type: "fade", duration: 1 } },
    ]
    p = setClipAudio(p, "c2", { gainDb: 2, fx: [{ type: "telephone" }] })
    const g = graph(p)
    // The J-cut's second before, then the four seconds: five, with its fades after the levels.
    expect(g).toMatch(/\[1:a\]atrim=1:6,asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo,volume=2dB,[^;]*,atrim=end=5,afade=t=in:[^;]*afade=t=out:[^;]*adelay=delays=144000S:all=1\[a1\]/)
  })

  it("applies the levels after an audio transition's pieces are joined", () => {
    let p = withSong()
    p.audioTrack!.clips = [
      { id: "a1", asset: "m", in: 3, out: 5, start: 1 },
      { id: "a2", asset: "m", in: 10, out: 13, start: 3, transition: { type: "audio-tapestop", duration: 1 } },
    ]
    p = setClipAudio(p, "a1", { fx: [{ type: "echo" }] })
    const g = graph(p)
    // The tape stop's pieces, then the echo over all of them (2.5 s: the clip and half the transition).
    expect(g).toContain("[s1p0][s1p1]concat=n=2:v=0:a=1,aecho=1:0.729:300|600|900:0.45|0.203|0.091,atrim=end=2.5,adelay=delays=48000S:all=1[a1]")
  })

  it("leaves a muted clip out entirely, levels or not", () => {
    const g = graph(setClipMuted(setClipAudio(withSong(), "a1", { gainDb: 6, fx: [{ type: "normalize" }] }), "a1", true))
    expect(g).not.toContain("[1:a]")
    expect(g).not.toContain("loudnorm")
  })

  it("keeps a project without levels byte for byte", () => {
    const p = withSong()
    delete p.audioTrack
    const before = buildExportArgs(p, files, "out.mp4")
    const set = setClipAudio(p, "c1", { gainDb: 3 })
    const cleared = setClipAudio(set, "c1", undefined)
    expect(buildExportArgs(cleared, files, "out.mp4")).toEqual(before)
    expect(before.join(" ")).not.toContain("[bg]")
  })

  it("keeps labels unique with many clips with levels", () => {
    let p = withSong()
    p.tracks[0].clips = Array.from({ length: 12 }, (_, k) => ({ id: `c${k}`, asset: "v", in: 0, out: 0.5, start: k }))
    for (let k = 0; k < 12; k++) p = setClipAudio(p, `c${k}`, { fx: [{ type: "room" }, { type: "radio" }] })
    const g = graph(p)
    const outs = [...g.matchAll(/\[([a-z]+\d+[a-z0-9]*)\](?=;|$)/g)].map((m) => m[1])
    expect(new Set(outs).size).toBe(outs.length)
  })
})

// Real ffmpeg: only .data/ffmpeg.exe is needed (the media is generated). The suite's name says why when it's skipped.
const FFMPEG = path.resolve(".data/ffmpeg.exe")
const hasFfmpeg = fs.existsSync(FFMPEG)

function ffmpeg(args: string[]): Promise<{ stdout: Buffer; stderr: string }> {
  return new Promise((resolve) => {
    execFile(FFMPEG, ["-hide_banner", ...args], { encoding: "buffer", maxBuffer: 64 * 1024 * 1024 }, (_e, stdout, stderr) => resolve({ stdout, stderr: stderr.toString() }))
  })
}

/** The RMS level (dBFS) of `file`'s sound from `from` to `to` s, after the filters in `af` (e.g. a band to measure). */
async function rmsDb(file: string, from: number, to: number, af = "anull"): Promise<number> {
  const { stderr } = await ffmpeg(["-ss", String(from), "-t", String(to - from), "-i", file, "-vn", "-af", `${af},astats=measure_perchannel=none`, "-f", "null", "-"])
  const m = /RMS level dB:\s*(-?[\d.]+|-inf)/.exec(stderr)
  return !m || m[1] === "-inf" ? -Infinity : Number(m[1])
}

/** The dominant frequency (Hz) of `file`'s sound from `from` to `to` s, from its zero crossings (a pure tone). */
async function toneHz(file: string, from: number, to: number): Promise<number> {
  const { stdout } = await ffmpeg(["-ss", String(from), "-t", String(to - from), "-i", file, "-vn", "-ac", "1", "-ar", "48000", "-f", "f32le", "-"])
  const s = new Float32Array(stdout.buffer, stdout.byteOffset, Math.floor(stdout.length / 4))
  let crossings = 0
  for (let k = 1; k < s.length; k++) if (s[k - 1] < 0 && s[k] >= 0) crossings++
  return crossings / (s.length / 48000)
}

/** Integrated loudness (LUFS) of `file`'s sound. */
async function lufs(file: string): Promise<number> {
  const { stderr } = await ffmpeg(["-i", file, "-vn", "-af", "ebur128", "-f", "null", "-"])
  const all = [...stderr.matchAll(/I:\s*(-?[\d.]+) LUFS/g)]
  return Number(all[all.length - 1][1])
}

;(hasFfmpeg ? describe : describe.skip)(hasFfmpeg ? "audio levels with real ffmpeg" : "audio levels with real ffmpeg (SKIPPED: .data/ffmpeg.exe not found)", () => {
  const dir = path.join(os.tmpdir(), `ps-levels-${process.pid}-${Date.now()}`)
  const tone = path.join(dir, "tone.wav")
  const noise = path.join(dir, "noise.wav")
  const quiet = path.join(dir, "quiet.wav")

  beforeAll(async () => {
    process.env.FFMPEG_PATH = FFMPEG
    fs.mkdirSync(dir, { recursive: true })
    await ffmpeg(["-f", "lavfi", "-i", "sine=frequency=440:duration=8:sample_rate=48000", "-y", tone])
    await ffmpeg(["-f", "lavfi", "-i", "anoisesrc=d=8:c=white:r=48000:a=0.25:seed=7", "-y", noise])
    await ffmpeg(["-f", "lavfi", "-i", "sine=frequency=440:duration=8:sample_rate=48000", "-af", "volume=-20dB", "-y", quiet])
  }, 60_000)
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

  /** Exports `file` as an audio clip (0-6 s) with `audio`; the output's path. */
  async function exportWith(name: string, file: string, audio?: ClipAudio, length = 6): Promise<string> {
    let p: Project = {
      ...newProject("Levels"),
      width: 64,
      height: 64,
      assets: { t: { file: "t.wav", duration: 8, hasAudio: true, kind: "audio" } },
      tracks: [{ id: "t1", clips: [] }],
      audioTrack: { id: "audio", clips: [{ id: "a1", asset: "t", in: 0, out: length, start: 0 }] },
    }
    if (audio) p = setClipAudio(p, "a1", audio)
    const out = path.join(dir, `${name}.mp4`)
    const script = path.join(dir, `${name}.graph.txt`)
    fs.writeFileSync(script, buildExportGraph(p, { t: file }).graph)
    await runExport(buildExportArgs(p, { t: file }, out, script), out, totalLength(p), () => {})
    return out
  }

  it("raises the level by the gain: +6 dB is about 6 dB louder", async () => {
    const dry = await rmsDb(await exportWith("dry", tone), 1, 5)
    const loud = await rmsDb(await exportWith("plus6", tone, { gainDb: 6 }), 1, 5)
    expect(Math.abs(loud - dry - 6)).toBeLessThan(0.5)
  }, 120_000)

  it("takes high frequencies out with High cut", async () => {
    const band = "highpass=f=7000,highpass=f=7000"
    const dry = await rmsDb(await exportWith("noise-dry", noise), 1, 5, band)
    const cut = await rmsDb(await exportWith("noise-highcut", noise, { fx: [{ type: "highcut", amount: 1 }] }), 1, 5, band)
    expect(dry - cut).toBeGreaterThan(15)
  }, 120_000)

  it("band-limits Telephone, Old-time radio and Through a can: energy outside the band drops", async () => {
    const low = "lowpass=f=150,lowpass=f=150"
    const high = "highpass=f=7000,highpass=f=7000"
    const dryOut = await exportWith("noise-dry2", noise)
    const dryLow = await rmsDb(dryOut, 1, 5, low)
    const dryHigh = await rmsDb(dryOut, 1, 5, high)
    for (const type of ["telephone", "radio", "can"] as const) {
      const out = await exportWith(`noise-${type}`, noise, { fx: [{ type }] })
      expect(dryLow - (await rmsDb(out, 1, 5, low)), type).toBeGreaterThan(10)
      expect(dryHigh - (await rmsDb(out, 1, 5, high)), type).toBeGreaterThan(10)
    }
  }, 180_000)

  it("shifts the pitch with Chipmunk and Deep voice and keeps the length", async () => {
    expect(Math.abs((await toneHz(await exportWith("tone-dry", tone), 1, 5)) - 440)).toBeLessThan(5)
    const up = await exportWith("tone-chipmunk", tone, { fx: [{ type: "chipmunk" }] })
    expect(Math.abs((await toneHz(up, 1, 5)) / 440 - 2 ** (5 / 12))).toBeLessThan(0.02)
    const down = await exportWith("tone-deep", tone, { fx: [{ type: "deep" }] })
    expect(Math.abs((await toneHz(down, 1, 5)) / 440 - 2 ** (-5 / 12))).toBeLessThan(0.02)
    // The shifted sound still runs to the clip's end.
    for (const out of [up, down]) expect(await rmsDb(out, 5.2, 5.9)).toBeGreaterThan(-30)
  }, 120_000)

  it("brings a quiet clip to -16 LUFS with Normalize", async () => {
    const out = await exportWith("quiet-normalize", quiet, { fx: [{ type: "normalize" }] }, 8)
    expect(Math.abs((await lufs(out)) + 16)).toBeLessThan(2)
  }, 120_000)
})
