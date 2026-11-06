import { execFile } from "child_process"
import fs from "fs"
import os from "os"
import path from "path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { buildExportArgs, parseProbe, parseProgressLine, probeMedia, runExport } from "./ffmpeg-server"
import { newProject, type Project } from "./project"

describe("parseProbe", () => {
  it("reads duration and audio", () => {
    const err = "  Duration: 00:01:02.50, start: 0.0, bitrate: 1000 kb/s\n  Stream #0:0: Video: h264\n  Stream #0:1(und): Audio: aac, 48000 Hz\n"
    expect(parseProbe(err)).toEqual({ duration: 62.5, hasAudio: true })
  })

  it("reports a silent video", () => {
    expect(parseProbe("  Duration: 01:00:00.00, start: 0\n  Stream #0:0: Video: h264\n")).toEqual({ duration: 3600, hasAudio: false })
  })

  it("throws when there is no duration", () => {
    expect(() => parseProbe("Invalid data found when processing input")).toThrow()
  })
})

function twoClips(): Project {
  return {
    ...newProject("P"),
    assets: { a: { file: "a.mp4", duration: 5, hasAudio: true }, s: { file: "s.mp4", duration: 4, hasAudio: false } },
    clips: [
      { id: "c1", asset: "a", in: 1, out: 3 },
      { id: "c2", asset: "s", in: 0, out: 1.5 },
    ],
  }
}
const files = { a: "/x/a.mp4", s: "/x/s.mp4" }
const graph = (args: string[]) => args[args.indexOf("-filter_complex") + 1]

describe("buildExportArgs", () => {
  it("concats the clips, trims and letterboxes to the project size", () => {
    const args = buildExportArgs(twoClips(), files, "/out/x.mp4.tmp")
    const g = graph(args)
    expect(g).toContain("concat=n=2:v=1:a=1")
    expect(g).toContain("trim=1:3")
    expect(g).toContain("scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30")
    expect(args).toContain("libx264")
    expect(args[args.length - 1]).toBe("/out/x.mp4.tmp")
  })

  it("uses silence for a clip without audio and never references its audio stream", () => {
    const g = graph(buildExportArgs(twoClips(), files, "o"))
    expect(g).toContain("[0:a]atrim=1:3")
    expect(g).toContain("anullsrc=r=48000:cl=stereo,atrim=0:1.5")
    expect(g).not.toContain("[1:a]")
  })

  it("follows the project's size and fps", () => {
    const g = graph(buildExportArgs({ ...twoClips(), width: 1280, height: 720, fps: 24 }, files, "o"))
    expect(g).toContain("scale=1280:720")
    expect(g).toContain("fps=24")
  })

  it("throws when there is nothing to export", () => {
    expect(() => buildExportArgs({ ...twoClips(), clips: [] }, files, "o")).toThrow("Nothing to export")
  })
})

describe("parseProgressLine", () => {
  it("reads out_time_ms and out_time_us (both microseconds) as a fraction", () => {
    expect(parseProgressLine("out_time_ms=2500000", 10)).toBe(0.25)
    expect(parseProgressLine("out_time_us=5000000", 10)).toBe(0.5)
  })
  it("clamps and ignores other lines", () => {
    expect(parseProgressLine("out_time_ms=99000000", 10)).toBe(1)
    expect(parseProgressLine("out_time_ms=-5", 10)).toBe(0)
    expect(parseProgressLine("frame=12", 10)).toBeNull()
    expect(parseProgressLine("out_time_ms=N/A", 10)).toBeNull()
  })
})

// Real ffmpeg: the project's .data/ffmpeg.exe and the dev sample videos; skipped when they aren't there.
const FFMPEG = path.resolve(".data/ffmpeg.exe")
const SAMPLES = path.resolve("dev-photos/upload/mjdazzo")
const sample = (n: number) => path.join(SAMPLES, `VID_200${n}.mp4`)
const canRun = fs.existsSync(FFMPEG) && fs.existsSync(sample(1)) && fs.existsSync(sample(2))

function ffmpeg(args: string[]): Promise<{ stdout: Buffer; stderr: string }> {
  return new Promise((resolve) => {
    execFile(FFMPEG, ["-hide_banner", ...args], { encoding: "buffer", maxBuffer: 64 * 1024 * 1024 }, (_e, stdout, stderr) => resolve({ stdout, stderr: stderr.toString() }))
  })
}

describe.skipIf(!canRun)("runExport with real ffmpeg", () => {
  const dir = path.join(os.tmpdir(), `ps-ffmpeg-${process.pid}-${Date.now()}`)
  const silent = path.join(dir, "silent.mp4")
  const portrait = path.join(dir, "portrait.mp4")

  beforeAll(async () => {
    process.env.FFMPEG_PATH = FFMPEG
    fs.mkdirSync(dir, { recursive: true })
    await ffmpeg(["-f", "lavfi", "-i", "testsrc2=size=640x360:rate=24:duration=2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-y", silent])
    await ffmpeg(["-f", "lavfi", "-i", "testsrc2=size=360x640:rate=25:duration=2", "-f", "lavfi", "-i", "sine=duration=2", "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-y", portrait])
  }, 60_000)
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

  async function exportProject(p: Project, files: Record<string, string>, name: string) {
    const out = path.join(dir, name)
    const progress: number[] = []
    const total = p.clips.reduce((t, c) => t + c.out - c.in, 0)
    await runExport(buildExportArgs(p, files, out), out, total, (f) => progress.push(f))
    const info = (await ffmpeg(["-i", out])).stderr
    return { out, info, duration: (await probeMedia(out)).duration, progress, total }
  }

  it("exports two trimmed sample clips with audio and the summed length", async () => {
    const p: Project = {
      ...newProject("E2E"),
      assets: { a: { file: "a", duration: 3, hasAudio: true }, b: { file: "b", duration: 3, hasAudio: true } },
      clips: [{ id: "1", asset: "a", in: 1, out: 2.5 }, { id: "2", asset: "b", in: 0, out: 1.5 }],
    }
    const r = await exportProject(p, { a: sample(1), b: sample(2) }, "two.mp4")
    expect(Math.abs(r.duration - r.total)).toBeLessThan(0.3)
    expect(r.info).toMatch(/Stream #[^\n]*Audio:/)
    expect(r.info).toMatch(/Video: h264[^\n]*1920x1080/)
    expect(r.progress.length).toBeGreaterThan(0)
    expect(Math.max(...r.progress)).toBeLessThanOrEqual(1)
    expect(fs.existsSync(path.join(dir, "two.mp4"))).toBe(true)
  }, 60_000)

  it("keeps audio continuous when a clip has no audio stream", async () => {
    const p: Project = {
      ...newProject("Mixed"),
      assets: { a: { file: "a", duration: 3, hasAudio: true }, s: { file: "s", duration: 2, hasAudio: false } },
      clips: [{ id: "1", asset: "a", in: 0, out: 1 }, { id: "2", asset: "s", in: 0, out: 1.5 }, { id: "3", asset: "a", in: 1, out: 2 }],
    }
    const r = await exportProject(p, { a: sample(1), s: silent }, "mixed.mp4")
    expect(Math.abs(r.duration - 3.5)).toBeLessThan(0.3)
    expect(r.info).toMatch(/Stream #[^\n]*Audio:/)
    // The audio stream runs the whole length, not just the first clip.
    const audio = (await ffmpeg(["-i", r.out, "-map", "0:a", "-f", "null", "-"])).stderr
    const t = /time=(\d+):(\d+):(\d+\.\d+)/g
    let last = 0
    for (const m of audio.matchAll(t)) last = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])
    expect(Math.abs(last - 3.5)).toBeLessThan(0.3)
  }, 60_000)

  it("letterboxes a portrait clip at the project size instead of stretching it", async () => {
    const p: Project = {
      ...newProject("Portrait"),
      assets: { v: { file: "v", duration: 2, hasAudio: true } },
      clips: [{ id: "1", asset: "v", in: 0, out: 1.5 }],
    }
    const r = await exportProject(p, { v: portrait }, "portrait-out.mp4")
    expect(r.info).toMatch(/Video: h264[^\n]*1920x1080/)
    // A pixel near the left edge is pad (black, luma 16), not picture.
    const px = await ffmpeg(["-ss", "0.5", "-i", r.out, "-frames:v", "1", "-vf", "crop=1:1:5:540,format=gray", "-f", "rawvideo", "-"])
    expect(px.stdout[0]).toBeLessThanOrEqual(20)
  }, 60_000)

  it("removes the output and rejects with ffmpeg's last line on failure", async () => {
    const p: Project = {
      ...newProject("Bad"),
      assets: { a: { file: "a", duration: 3, hasAudio: true } },
      clips: [{ id: "1", asset: "a", in: 0, out: 1 }],
    }
    const out = path.join(dir, "bad.mp4.tmp")
    await expect(runExport(buildExportArgs(p, { a: path.join(dir, "nope.mp4") }, out), out, 1, () => {})).rejects.toThrow()
    expect(fs.existsSync(out)).toBe(false)
  }, 60_000)
})
