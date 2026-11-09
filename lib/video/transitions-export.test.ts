import { execFile } from "child_process"
import fs from "fs"
import os from "os"
import path from "path"
import sharp from "sharp"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))

import { AFADE_CURVE, buildExportArgs, buildExportGraph, probeMedia, runExport } from "./ffmpeg-server"
import { newProject, totalLength, type Clip, type Project } from "./project"
import { IDENTITY } from "./transform"
import { AUDIO_CURVES, type AnyTransitionType, type AudioTransitionType } from "./transition-types"

/** Two 4 s cuts of a 10 s sound file joined on the audio layer at 4 s (2 s of handle each side), under a 8 s image. */
function audioPair(type?: AudioTransitionType, duration = 1, muted = false): Project {
  return {
    ...newProject("A"),
    assets: { i: { file: "i.png", duration: 5, hasAudio: false, kind: "image" }, m: { file: "m.wav", duration: 10, hasAudio: true, kind: "audio" } },
    tracks: [{ id: "t1", clips: [{ id: "img", asset: "i", in: 0, out: 8, start: 0 }] }],
    audioTrack: {
      id: "audio",
      clips: [
        { id: "a1", asset: "m", in: 2, out: 6, start: 0, ...(muted ? { muted: true } : {}) },
        { id: "a2", asset: "m", in: 2, out: 6, start: 4, ...(type ? { transition: { type, duration } } : {}) },
      ],
    },
  }
}
const files = { i: "i.png", m: "m.wav", v: "v.mp4", t: "t.png" }
const graph = (p: Project) => buildExportGraph(p, files).graph

describe("audio crossfades between audio clips in the export", () => {
  it("each curve fades both sounds on its afade curve over the transition, centred on the cut", () => {
    for (const curve of AUDIO_CURVES) {
      const g = graph(audioPair(curve, 2))
      // The outgoing sound runs 1 s past its out point and fades out over 2 s; the incoming one starts 1 s early and fades in.
      expect(g).toContain(`atrim=2:7,asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo,afade=t=out:st=3:d=2:curve=${AFADE_CURVE[curve]},adelay=delays=0S:all=1`)
      expect(g).toContain(`atrim=1:6,asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo,afade=t=in:st=0:d=2:curve=${AFADE_CURVE[curve]},adelay=delays=${3 * 48000}S:all=1`)
    }
    expect(AFADE_CURVE).toEqual({ "audio-linear": "tri", "audio-equalpower": "qsin", "audio-scurve": "hsin", "audio-log": "log", "audio-exp": "exp" })
  })

  it("dip to silence: out over the first 40%, in over the last 40%, no overlap", () => {
    const g = graph(audioPair("audio-dip", 2))
    expect(g).toContain("atrim=2:6,asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo,afade=t=out:st=3:d=0.8:curve=qsin,adelay=delays=0S:all=1")
    expect(g).toContain(`atrim=2:6,asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo,afade=t=in:st=0.2:d=0.8:curve=qsin,adelay=delays=${4 * 48000}S:all=1`)
  })

  it("low-pass sweep: the outgoing tail swept down in steps while it fades; the incoming fades in", () => {
    const g = graph(audioPair("audio-lowpass", 2))
    expect(g).toContain("asplit=2")
    expect(g).toMatch(/atrim=5:7,asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo\[s\d+y1\]/)
    expect(g).toContain("lowpass=f=")
    expect(g).toContain("enable='between(t,0,0.25)'")
    expect(g).toContain(`atrim=1:6,asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo,afade=t=in:st=0:d=2:curve=qsin,adelay=delays=${3 * 48000}S:all=1`)
  })

  it("tape stop: the outgoing last half second of source slowed in eight steps into the transition's length", () => {
    const g = graph(audioPair("audio-tapestop", 1))
    expect(g).toContain("asplit=9")
    expect(g).toContain("asetrate=45000,aresample=48000")
    expect(g).toContain("asetrate=3000,aresample=48000")
    expect(g).toContain("concat=n=8:v=0:a=1,afade=t=out:st=0.7:d=0.3:curve=qsin")
  })

  it("echo out: the outgoing tail padded and echoed; telephone swap: band-limited on both sides", () => {
    const echo = graph(audioPair("audio-echo", 2))
    expect(echo).toContain("apad=whole_dur=2,aecho=0.8:0.9:200|400|600:0.5|0.35|0.2,atrim=0:2")
    const phone = graph(audioPair("audio-telephone", 2))
    expect(phone).toContain("highpass=f=300,lowpass=f=3400,afade=t=out:st=0:d=2:curve=qsin")
    expect(phone).toContain("highpass=f=300:enable='lt(t,1.5)',lowpass=f=3400:enable='lt(t,1.5)',afade=t=in:st=0:d=2:curve=qsin")
  })

  it("a muted clip stays out of the mix; its partner still fades", () => {
    const g = graph(audioPair("audio-equalpower", 2, true))
    expect(g).not.toContain("atrim=2:7")
    expect(g).toContain("afade=t=in:st=0:d=2:curve=qsin")
  })
})

/** An image (0-4) on layer 1 under a video with sound on layer 2 (1-5), and a sound clip on the audio layer. */
function edges(): Project {
  return {
    ...newProject("E"),
    assets: { i: { file: "i.png", duration: 5, hasAudio: false, kind: "image" }, v: { file: "v.mp4", duration: 10, hasAudio: true }, m: { file: "m.wav", duration: 10, hasAudio: true, kind: "audio" } },
    tracks: [
      { id: "t1", clips: [{ id: "img", asset: "i", in: 0, out: 4, start: 0 }] },
      { id: "t2", clips: [{ id: "vid", asset: "v", in: 1, out: 5, start: 1 }] },
    ],
    audioTrack: { id: "audio", clips: [{ id: "snd", asset: "m", in: 0, out: 6, start: 0 }] },
  }
}
const withEdge = (p: Project, id: string, key: "edgeIn" | "edgeOut", type: AnyTransitionType, duration = 1): Project => {
  const set = (c: Clip) => (c.id === id ? { ...c, [key]: { type, duration } } : c)
  return { ...p, tracks: p.tracks.map((t) => ({ ...t, clips: t.clips.map(set) })), ...(p.audioTrack ? { audioTrack: { ...p.audioTrack, clips: p.audioTrack.clips.map(set) } } : {}) }
}

describe("edge transitions in the export", () => {
  it("an image's in edge: xfade from a transparent copy of its first second", () => {
    const g = graph(withEdge(edges(), "img", "edgeIn", "wipeleft"))
    expect(g).toMatch(/\[ts\d+\]format=yuva420p,split\[ei0r\]\[ei0c\]/)
    expect(g).toContain("[ei0c]trim=duration=1,setpts=PTS-STARTPTS,lutyuv=a=0[ei0t]")
    expect(g).toContain("[ei0t][ei0r]xfade=transition=wipeleft:duration=1:offset=0[ei0x]")
    expect(g).toContain("[ei0x]setpts=PTS+0/TB[u0]")
  })

  it("a video's out edge covers it into its transparent last seconds, and fades its own sound with it", () => {
    const g = graph(withEdge(edges(), "vid", "edgeOut", "circleclose", 1.5))
    expect(g).toContain("[eo1c]trim=start=2.5,setpts=PTS-STARTPTS,lutyuv=a=0[eo1t]")
    expect(g).toContain("[eo1r][eo1t]xfade=transition=circleclose:duration=1.5:offset=2.5[eo1x]")
    expect(g).toContain("atrim=1:5,asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo,afade=t=out:st=2.5:d=1.5:curve=qsin,adelay=delays=48000S:all=1")
  })

  it("the app's own transitions work on planar RGB at an edge too, a whip with its blur", () => {
    const g = graph(withEdge(edges(), "img", "edgeIn", "whip-left"))
    expect(g).toContain("[ei0t]format=gbrap[ei0a]")
    expect(g).toContain("xfade=transition=custom:duration=1:offset=0:expr='")
    expect(g).toContain("gblur=sigma=")
  })

  it("both edges on a transformed, turned clip", () => {
    let p = withEdge(withEdge(edges(), "vid", "edgeIn", "fade"), "vid", "edgeOut", "slideup")
    p = { ...p, tracks: [p.tracks[0], { ...p.tracks[1], clips: [{ ...p.tracks[1].clips[0], transform: { ...IDENTITY, scale: 0.5, rotation: 20 } }] }] }
    const g = graph(p)
    expect(g).toContain("rotate=")
    expect(g).toContain("[ei1t][ei1r]xfade=transition=fade:duration=1:offset=0[ei1x]")
    expect(g).toContain("[ei1x]format=yuva420p,split[eo1r][eo1c]")
    expect(g).toContain("[eo1r][eo1t]xfade=transition=slideup:duration=1:offset=3[eo1x]")
  })

  it("an audio clip's edges: curve fades, a low-pass sweep, a tape start, an echo tail", () => {
    expect(graph(withEdge(edges(), "snd", "edgeIn", "audio-scurve", 2))).toContain("atrim=0:6,asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo,afade=t=in:st=0:d=2:curve=hsin,adelay")
    expect(graph(withEdge(edges(), "snd", "edgeOut", "audio-exp", 2))).toContain("afade=t=out:st=4:d=2:curve=exp,adelay")
    expect(graph(withEdge(edges(), "snd", "edgeIn", "audio-lowpass", 2))).toContain("enable='between(t,1.75,2)',afade=t=in:st=0:d=2:curve=qsin")
    const tape = graph(withEdge(edges(), "snd", "edgeIn", "audio-tapestop", 2))
    expect(tape).toContain("asetrate=3000,aresample=48000")
    // The tape start takes 1 s of source for its 2 s; the rest plays to 1 s before the out point, so the clip keeps its 6 s.
    expect(tape).toMatch(/atrim=1:5,asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo\[s\d+y8\]/)
    expect(graph(withEdge(edges(), "snd", "edgeOut", "audio-echo", 2))).toContain("aecho=")
  })

  it("leaves a text clip's graph as it was (text uses its animations)", () => {
    const text: Project = { ...newProject("T"), tracks: [{ id: "t1", clips: [{ id: "x", asset: "", in: 0, out: 3, start: 0, text: { content: "Hi", color: "#ffffff", orientation: "horizontal" } }] }] }
    const before = buildExportGraph(text, { "text:x": "t.png" }).graph
    expect(before).not.toContain("xfade")
    expect(before).not.toContain("lutyuv")
  })

  it("a project without any of the new fields builds the same graph as before (no split, no lutyuv, no asplit)", () => {
    const g = graph(edges())
    expect(g).not.toContain("lutyuv")
    expect(g).not.toContain("asplit")
    expect(g).toContain("[0:v]setpts=PTS-STARTPTS,scale=1920:1080")
    expect(graph(audioPair())).not.toContain("afade")
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

/** The RMS level (0 to 1) of `file`'s sound from `from` to `to` s. */
async function rms(file: string, from: number, to: number): Promise<number> {
  const pcm = (await ffmpeg(["-ss", String(from), "-t", String(to - from), "-i", file, "-map", "0:a", "-ac", "1", "-ar", "48000", "-f", "s16le", "-"])).stdout
  const n = Math.floor(pcm.length / 2)
  let sum = 0
  for (let k = 0; k < n; k++) sum += (pcm.readInt16LE(2 * k) / 32768) ** 2
  return n > 0 ? Math.sqrt(sum / n) : 0
}

;(hasFfmpeg ? describe : describe.skip)(hasFfmpeg ? "audio and edge transitions with real ffmpeg" : "audio and edge transitions with real ffmpeg (SKIPPED: .data/ffmpeg.exe not found)", () => {
  const dir = path.join(os.tmpdir(), `ps-n1-${process.pid}-${Date.now()}`)
  const tone = path.join(dir, "tone.wav")
  const green = path.join(dir, "green.png")
  const red = path.join(dir, "red.png")

  beforeAll(async () => {
    process.env.FFMPEG_PATH = FFMPEG
    fs.mkdirSync(dir, { recursive: true })
    await ffmpeg(["-f", "lavfi", "-i", "sine=frequency=440:duration=10:sample_rate=48000", "-y", tone])
    await sharp({ create: { width: 320, height: 180, channels: 3, background: "#00c000" } }).png().toFile(green)
    await sharp({ create: { width: 320, height: 180, channels: 3, background: "#e00000" } }).png().toFile(red)
  }, 60_000)
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

  async function render(p: Project, name: string, map: Record<string, string>) {
    const out = path.join(dir, `${name}.mp4`)
    const script = path.join(dir, `${name}.graph.txt`)
    fs.writeFileSync(script, buildExportGraph(p, map).graph)
    await runExport(buildExportArgs(p, map, out, script), out, totalLength(p), () => {})
    return out
  }
  async function pixel(file: string, t: number, x = 960, y = 540): Promise<number[]> {
    const px = await ffmpeg(["-ss", String(t), "-i", file, "-frames:v", "1", "-vf", `crop=2:2:${x}:${y},format=rgb24`, "-f", "rawvideo", "-"])
    return [px.stdout[0], px.stdout[1], px.stdout[2]]
  }
  const isGreen = ([r, g, b]: number[]) => g > 150 && r < 70 && b < 70
  const isRed = ([r, g, b]: number[]) => r > 170 && g < 70 && b < 70

  it("an equal-power crossfade between two tones keeps the length and the level through the middle", async () => {
    const out = await render(audioPair("audio-equalpower", 2), "eq", { i: green, m: tone })
    expect(Math.abs((await probeMedia(out)).duration - 8)).toBeLessThan(0.15)
    const steady = await rms(out, 1, 2)
    const mid = await rms(out, 3.8, 4.2)
    // The same tone on both sides, each at -3 dB at the cut: they add in phase-ish to about the steady level or more, never a hole.
    expect(steady).toBeGreaterThan(0.05)
    expect(mid).toBeGreaterThan(steady * 0.7)
  }, 120_000)

  it("a tape stop and an echo out leave sound in the outgoing tail past the cut", async () => {
    for (const type of ["audio-tapestop", "audio-echo"] as const) {
      const p = audioPair(type, 2)
      // The incoming clip muted: only the outgoing tail is heard after the cut.
      const q: Project = { ...p, audioTrack: { ...p.audioTrack!, clips: [p.audioTrack!.clips[0], { ...p.audioTrack!.clips[1], muted: true }] } }
      const out = await render(q, type, { i: green, m: tone })
      expect(Math.abs((await probeMedia(out)).duration - 8)).toBeLessThan(0.15)
      expect(await rms(out, 4.05, 4.5)).toBeGreaterThan(0.002)
      expect(await rms(out, 5.5, 7.5)).toBeLessThan(0.001)
    }
  }, 180_000)

  it("an image's fade-in edge over a red lower layer: red at 0, the image at the end of the fade", async () => {
    const p: Project = {
      ...newProject("F"),
      assets: { r: { file: "r", duration: 5, hasAudio: false, kind: "image" }, g: { file: "g", duration: 5, hasAudio: false, kind: "image" } },
      tracks: [
        { id: "t1", clips: [{ id: "base", asset: "r", in: 0, out: 4, start: 0 }] },
        { id: "t2", clips: [{ id: "top", asset: "g", in: 0, out: 4, start: 0, edgeIn: { type: "fade", duration: 2 } }] },
      ],
    }
    const out = await render(p, "edge-fade", { r: red, g: green })
    expect(isRed(await pixel(out, 0))).toBe(true)
    const mid = await pixel(out, 1)
    expect(mid[0]).toBeGreaterThan(60)
    expect(mid[1]).toBeGreaterThan(50)
    expect(isGreen(await pixel(out, 2.2))).toBe(true)
  }, 120_000)

  it("a wipe-in edge is half over the lower layer at its middle", async () => {
    const p: Project = {
      ...newProject("W"),
      assets: { r: { file: "r", duration: 5, hasAudio: false, kind: "image" }, g: { file: "g", duration: 5, hasAudio: false, kind: "image" } },
      tracks: [
        { id: "t1", clips: [{ id: "base", asset: "r", in: 0, out: 4, start: 0 }] },
        { id: "t2", clips: [{ id: "top", asset: "g", in: 0, out: 4, start: 0, edgeIn: { type: "wipeleft", duration: 2 } }] },
      ],
    }
    const out = await render(p, "edge-wipe", { r: red, g: green })
    // wipeleft uncovers from the right: at 1 s the right half is the image, the left still the red below.
    expect(isGreen(await pixel(out, 1, 1440))).toBe(true)
    expect(isRed(await pixel(out, 1, 480))).toBe(true)
    expect(isGreen(await pixel(out, 3, 480))).toBe(true)
  }, 120_000)

  it("an audio clip's fade-in edge: the level rises over its first seconds", async () => {
    const p: Project = {
      ...newProject("S"),
      assets: { m: { file: "m", duration: 10, hasAudio: true, kind: "audio" } },
      tracks: [{ id: "t1", clips: [] }],
      audioTrack: { id: "audio", clips: [{ id: "s", asset: "m", in: 0, out: 6, start: 0, edgeIn: { type: "audio-linear", duration: 3 } }] },
    }
    const out = await render(p, "edge-audio", { m: tone })
    const a = await rms(out, 0.2, 0.6)
    const b = await rms(out, 1.3, 1.7)
    const c = await rms(out, 2.4, 2.8)
    const d = await rms(out, 4, 5)
    expect(a).toBeLessThan(b)
    expect(b).toBeLessThan(c)
    expect(c).toBeLessThan(d * 1.01)
  }, 120_000)

  it("a video with sound: the app's own transitions at both edges render, its sound fading with the picture", async () => {
    const video = path.join(dir, "v.mp4")
    await ffmpeg(["-f", "lavfi", "-i", "color=c=blue:s=320x180:r=30:d=6", "-f", "lavfi", "-i", "sine=frequency=660:duration=6", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-y", video])
    const p: Project = {
      ...newProject("V"),
      assets: { r: { file: "r", duration: 5, hasAudio: false, kind: "image" }, v: { file: "v", duration: 6, hasAudio: true } },
      tracks: [
        { id: "t1", clips: [{ id: "base", asset: "r", in: 0, out: 5, start: 0 }] },
        { id: "t2", clips: [{ id: "top", asset: "v", in: 0, out: 5, start: 0, edgeIn: { type: "whip-left", duration: 1 }, edgeOut: { type: "collage", duration: 1.5 } }] },
      ],
    }
    const out = await render(p, "edge-video", { r: red, v: video })
    expect(Math.abs((await probeMedia(out)).duration - 5)).toBeLessThan(0.15)
    expect(isRed(await pixel(out, 0.02))).toBe(true)
    const blue = await pixel(out, 2.5)
    expect(blue[2]).toBeGreaterThan(150)
    expect(isRed(await pixel(out, 4.9))).toBe(true)
    expect(await rms(out, 0, 0.2)).toBeLessThan(await rms(out, 2, 3))
    expect(await rms(out, 4.8, 5)).toBeLessThan(await rms(out, 2, 3))
  }, 120_000)
})
