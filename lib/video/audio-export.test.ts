import { execFile } from "child_process"
import fs from "fs"
import os from "os"
import path from "path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { exportFingerprint } from "./export-state"
import { buildExportArgs, buildExportGraph, probeMedia, probeStreams, runExport } from "./ffmpeg-server"
import { kindFromProbe } from "./import"
import { newProject, setClipMuted, totalLength, type Project } from "./project"

/** A video clip on the base (0-4 s), and a song on the audio layer at 1 s, 2 s long from its 3 s mark. */
function withSong(): Project {
  return {
    ...newProject("Mix"),
    assets: {
      v: { file: "v.mp4", duration: 10, hasAudio: true },
      m: { file: "song.mp3", duration: 30, hasAudio: true, kind: "audio" },
    },
    tracks: [{ id: "t1", clips: [{ id: "c1", asset: "v", in: 0, out: 4, start: 0 }] }],
    audioTrack: { id: "audio", clips: [{ id: "a1", asset: "m", in: 3, out: 5, start: 1 }] },
  }
}
const files = { v: "/media/v.mp4", m: "/media/song.mp3", i: "/media/still.png" }
const graph = (p: Project) => buildExportGraph(p, files)

describe("buildExportGraph with audio clips", () => {
  it("mixes an audio clip's sound in, trimmed and delayed to its start, with no picture of its own", () => {
    const { graph: g, inputs } = graph(withSong())
    expect(inputs).toEqual([["-i", "/media/v.mp4"], ["-i", "/media/song.mp3"]])
    expect(g).toContain("[1:a]atrim=3:5,asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo,adelay=delays=48000S:all=1[a1]")
    expect(g).not.toContain("[1:v]")
    expect(g).toContain("[asil][a0][a1]amix=inputs=3")
  })

  it("leaves a muted audio clip out of the mix", () => {
    const g = graph(setClipMuted(withSong(), "a1", true)).graph
    expect(g).not.toContain("[1:a]")
    expect(g).toContain("[asil][a0]amix=inputs=2")
  })

  it("exports audio clips alone over the black canvas", () => {
    const p = { ...withSong(), tracks: [{ id: "t1", clips: [] }] }
    const g = graph(p).graph
    // The clip ends at 3 s: so does the timeline.
    expect(g).toContain("color=c=black:s=1920x1080:r=30:d=3,format=yuv420p[bg]")
    expect(g).toContain("[bg]null[v]")
    expect(g).toContain("[0:a]atrim=3:5")
  })

  it("keeps a project without audio clips on the graph it always had", () => {
    const p = withSong()
    delete p.audioTrack
    const g = graph(p).graph
    expect(g).toBe("[0:v]trim=0:4,setpts=PTS-STARTPTS,scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30[v0];[0:a]atrim=0:4,asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo[a0];[v0][a0]concat=n=1:v=1:a=1[v][a]")
  })

  it("maps the mixed sound in the arguments", () => {
    const args = buildExportArgs(withSong(), files, "out.mp4")
    expect(args).toContain("[a]")
  })
})

describe("exportFingerprint with audio clips", () => {
  it("changes with the audio layer's clips, and not for a project without them", () => {
    const p = withSong()
    const base = exportFingerprint(p)
    expect(exportFingerprint(setClipMuted(p, "a1", true))).not.toBe(base)
    expect(exportFingerprint({ ...p, audioTrack: { id: "audio", clips: [{ ...p.audioTrack!.clips[0], start: 2 }] } })).not.toBe(base)
    const none = withSong()
    delete none.audioTrack
    const unused = { ...none, assets: { v: none.assets.v } }
    expect(exportFingerprint(none)).toBe(exportFingerprint(unused))
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

/** The loudest level (dBFS) of `file`'s sound from `from` to `to` seconds. */
async function peakDb(file: string, from: number, to: number): Promise<number> {
  const { stderr } = await ffmpeg(["-ss", String(from), "-t", String(to - from), "-i", file, "-vn", "-af", "volumedetect", "-f", "null", "-"])
  const m = /max_volume:\s*(-?[\d.]+|-inf) dB/.exec(stderr)
  return !m || m[1] === "-inf" ? -Infinity : Number(m[1])
}

;(hasFfmpeg ? describe : describe.skip)(hasFfmpeg ? "audio clips with real ffmpeg" : "audio clips with real ffmpeg (SKIPPED: .data/ffmpeg.exe not found)", () => {
  const dir = path.join(os.tmpdir(), `ps-audio-${process.pid}-${Date.now()}`)
  const tone = path.join(dir, "tone.wav")
  const still = path.join(dir, "still.png")

  beforeAll(async () => {
    process.env.FFMPEG_PATH = FFMPEG
    fs.mkdirSync(dir, { recursive: true })
    await ffmpeg(["-f", "lavfi", "-i", "sine=frequency=440:duration=6:sample_rate=48000", "-y", tone])
    await ffmpeg(["-f", "lavfi", "-i", "color=c=red:s=64x64:d=1", "-frames:v", "1", "-y", still])
  }, 60_000)
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

  it("probes a generated tone as audio", async () => {
    const s = await probeStreams(tone)
    expect(s.hasAudio).toBe(true)
    expect(s.hasVideo).toBe(false)
    expect(Math.abs((s.duration ?? 0) - 6)).toBeLessThan(0.05)
    expect(kindFromProbe("tone.wav", s)).toMatchObject({ kind: "audio", hasAudio: true })
    // A still has a picture and no length.
    expect(kindFromProbe("still.png", await probeStreams(still))).toEqual({ kind: "image" })
  }, 30_000)

  it("probes an mp3 and an m4a when the encoders exist", async () => {
    for (const [name, codec] of [["tone.mp3", "libmp3lame"], ["tone.m4a", "aac"]] as const) {
      const out = path.join(dir, name)
      const { stderr } = await ffmpeg(["-i", tone, "-c:a", codec, "-y", out])
      if (!fs.existsSync(out)) {
        console.warn(`Skipped ${name}: the ${codec} encoder isn't in this ffmpeg (${stderr.split("\n").pop()})`)
        continue
      }
      const s = await probeStreams(out)
      expect(kindFromProbe(name, s)).toMatchObject({ kind: "audio" })
      expect(Math.abs((s.duration ?? 0) - 6)).toBeLessThan(0.1)
    }
  }, 30_000)

  it("refuses a text file named like a video", async () => {
    const fake = path.join(dir, "fake.mp4")
    fs.writeFileSync(fake, "not a video at all")
    expect(kindFromProbe("fake.mp4", await probeStreams(fake))).toEqual({ error: "fake.mp4 couldn't be read as a video." })
  }, 30_000)

  it("exports an image clip with an audio clip: the tone in its window, silence outside", async () => {
    // The audio clip plays the tone's 1-3 s from 1.5 s to 3.5 s.
    const p: Project = {
      ...newProject("Tone"),
      assets: { i: { file: "still.png", duration: 5, hasAudio: false, kind: "image" }, t: { file: "tone.wav", duration: 6, hasAudio: true, kind: "audio" } },
      tracks: [{ id: "t1", clips: [{ id: "c1", asset: "i", in: 0, out: 5, start: 0 }] }],
      audioTrack: { id: "audio", clips: [{ id: "a1", asset: "t", in: 1, out: 3, start: 1.5 }] },
    }
    const out = path.join(dir, "tone.mp4")
    const script = path.join(dir, "tone.graph.txt")
    const fileMap = { i: still, t: tone }
    fs.writeFileSync(script, buildExportGraph(p, fileMap).graph)
    await runExport(buildExportArgs(p, fileMap, out, script), out, totalLength(p), () => {})
    expect(Math.abs((await probeMedia(out)).duration - 5)).toBeLessThan(0.15)
    // lavfi's sine is at 1/8 amplitude: about -18 dBFS.
    const inside = await peakDb(out, 1.8, 3.2)
    expect(inside).toBeGreaterThan(-24)
    expect(inside).toBeLessThan(-12)
    expect(await peakDb(out, 0, 1.3)).toBeLessThan(-60)
    expect(await peakDb(out, 3.8, 5)).toBeLessThan(-60)
  }, 120_000)
})
