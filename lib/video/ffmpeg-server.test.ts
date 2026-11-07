import { execFile } from "child_process"
import fs from "fs"
import os from "os"
import path from "path"
import sharp from "sharp"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { buildExportArgs, buildExportGraph, overlayPosition, parseProbe, parseProgressLine, probeMedia, runExport } from "./ffmpeg-server"
import { newProject, totalLength, type Clip, type Project } from "./project"
import { clipRect, IDENTITY, type Transform } from "./transform"

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

/** One base track holding `clips`. */
const base = (clips: Clip[]) => [{ id: "t1", clips }]

function twoClips(): Project {
  return {
    ...newProject("P"),
    assets: { a: { file: "a.mp4", duration: 5, hasAudio: true }, s: { file: "s.mp4", duration: 4, hasAudio: false } },
    tracks: base([
      { id: "c1", asset: "a", in: 1, out: 3 },
      { id: "c2", asset: "s", in: 0, out: 1.5 },
    ]),
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

  it("reads the graph from a script file, so 150 clips don't make a long command line", () => {
    const clips = Array.from({ length: 150 }, (_, i) => ({ id: `c${i}`, asset: i % 2 ? "s" : "a", in: 0, out: 1 }))
    const p = { ...twoClips(), tracks: base(clips) }
    const args = buildExportArgs(p, files, "/out/x.mp4.tmp", "/tmp/graph.txt")
    expect(args).toContain("-/filter_complex")
    expect(args).not.toContain("-filter_complex")
    expect(args.every((a) => a.length < 1000)).toBe(true)
    expect(args.filter((a) => a === "-i")).toHaveLength(150)
    const { graph } = buildExportGraph(p, files)
    expect(graph).toContain("concat=n=150:v=1:a=1")
    expect(graph.length).toBeGreaterThan(32_767)
  })

  it("loops an image for its length with silence, next to video clips", () => {
    const p: Project = {
      ...twoClips(),
      assets: { ...twoClips().assets, i: { file: "i.jpg", duration: 5, hasAudio: false, kind: "image" } },
      tracks: base([{ id: "c1", asset: "a", in: 1, out: 3 }, { id: "p", asset: "i", in: 0, out: 2.5 }, { id: "c2", asset: "s", in: 0, out: 1.5 }]),
    }
    const args = buildExportArgs(p, { ...files, i: "/cache/i.webp" }, "o")
    const g = graph(args)
    const at = args.indexOf("/cache/i.webp")
    expect(args.slice(at - 7, at + 1)).toEqual(["-loop", "1", "-framerate", "30", "-t", "2.5", "-i", "/cache/i.webp"])
    expect(args.filter((a) => a === "-loop")).toHaveLength(1)
    expect(args.filter((a) => a === "-i")).toHaveLength(3)
    expect(g).toContain("[1:v]setpts=PTS-STARTPTS,scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30,format=yuv420p[v1]")
    expect(g).toContain("anullsrc=r=48000:cl=stereo,atrim=0:2.5,asetpts=PTS-STARTPTS[a1]")
    expect(g).not.toContain("[1:a]")
    expect(g).not.toMatch(/\[1:v\]trim/)
    expect(g).toContain("[0:a]atrim=1:3")
    expect(g).toContain("concat=n=3:v=1:a=1")
  })

  it("throws when there is nothing to export", () => {
    expect(() => buildExportArgs({ ...twoClips(), tracks: base([]) }, files, "o")).toThrow("Nothing to export")
    expect(() => buildExportArgs({ ...twoClips(), tracks: [...base([]), { id: "t2", clips: [] }] }, files, "o")).toThrow("Nothing to export")
  })

  it("uses silence for every clip of a muted single track", () => {
    const g = graph(buildExportArgs({ ...twoClips(), tracks: [{ ...base([])[0], muted: true, clips: twoClips().tracks[0].clips }] }, files, "o"))
    expect(g).not.toContain(":a]")
    expect(g).toContain("anullsrc=r=48000:cl=stereo,atrim=0:2,asetpts=PTS-STARTPTS[a0]")
    expect(g).toContain("concat=n=2:v=1:a=1[v][a]")
  })
})

describe("buildExportArgs with layers", () => {
  function layered(): Project {
    return {
      ...newProject("L"),
      assets: {
        a: { file: "a.mp4", duration: 5, hasAudio: true },
        i: { file: "i.jpg", duration: 5, hasAudio: false, kind: "image" },
        b: { file: "b.mp4", duration: 5, hasAudio: true },
      },
      tracks: [
        { id: "t1", clips: [{ id: "c1", asset: "a", in: 0, out: 4 }] },
        { id: "t2", clips: [{ id: "p", asset: "i", in: 0, out: 2, start: 1 }] },
        { id: "t3", muted: true, clips: [{ id: "m", asset: "b", in: 1, out: 2, start: 2.5 }] },
      ],
    }
  }
  const layerFiles = { a: "/x/a.mp4", i: "/x/i.webp", b: "/x/b.mp4" }
  const scale = "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30"

  it("overlays each track's clips, lower tracks first, over a black canvas the length of the timeline", () => {
    const args = buildExportArgs(layered(), layerFiles, "o")
    const g = graph(args)
    expect(args.filter((a) => a === "-i")).toHaveLength(3)
    expect(args.slice(args.indexOf("/x/i.webp") - 7, args.indexOf("/x/i.webp") + 1)).toEqual(["-loop", "1", "-framerate", "30", "-t", "2", "-i", "/x/i.webp"])
    expect(g).toContain("color=c=black:s=1920x1080:r=30:d=4,format=yuv420p[bg]")
    expect(g).toContain(`[0:v]trim=0:4,setpts=PTS-STARTPTS,${scale}[v0]`)
    expect(g).toContain("[v0][a0]concat=n=1:v=1:a=1[bv][ba]")
    expect(g).toContain("[bg][bv]overlay=eof_action=pass[l0]")
    expect(g).toContain(`[1:v]setpts=PTS-STARTPTS,${scale},format=yuv420p,setpts=PTS+1/TB[v1]`)
    expect(g).toContain("[l0][v1]overlay=enable='between(t,1,3)':eof_action=pass[l1]")
    expect(g).toContain(`[2:v]trim=1:2,setpts=PTS-STARTPTS,${scale},setpts=PTS+2.5/TB[v2]`)
    expect(g).toContain("[l1][v2]overlay=enable='between(t,2.5,3.5)':eof_action=pass[v]")
  })

  it("mixes the base audio with silence for the whole length, leaving out images and muted tracks", () => {
    const g = graph(buildExportArgs(layered(), layerFiles, "o"))
    expect(g).toContain("[0:a]atrim=0:4")
    expect(g).not.toContain("[1:a]")
    expect(g).not.toContain("[2:a]")
    expect(g).toContain("anullsrc=r=48000:cl=stereo,atrim=0:4[asil]")
    expect(g).toContain("[asil][ba]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[a]")
  })

  it("delays an unmuted overlay's audio to its start", () => {
    const p = layered()
    p.tracks[2] = { id: "t3", clips: p.tracks[2].clips }
    const g = graph(buildExportArgs(p, layerFiles, "o"))
    expect(g).toContain("[2:a]atrim=1:2,asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo,adelay=delays=120000S:all=1[a2]")
    expect(g).toContain("[asil][ba][a2]amix=inputs=3:duration=first:dropout_transition=0:normalize=0[a]")
  })

  it("starts from the black canvas when the base track is empty, and runs to the last overlay end", () => {
    const p = layered()
    p.tracks[0] = { id: "t1", clips: [] }
    p.tracks[2].clips[0].start = 6
    const args = buildExportArgs(p, { i: "/x/i.webp", b: "/x/b.mp4" }, "o")
    const g = graph(args)
    expect(args.filter((a) => a === "-i")).toHaveLength(2)
    expect(g).toContain("color=c=black:s=1920x1080:r=30:d=7,format=yuv420p[bg]")
    expect(g).toContain("[bg][v0]overlay=enable='between(t,1,3)':eof_action=pass[l1]")
    expect(g).toContain("[l1][v1]overlay=enable='between(t,6,7)':eof_action=pass[v]")
    expect(g).not.toContain("concat")
    expect(g).toContain("[asil]amix=inputs=1:duration=first:dropout_transition=0:normalize=0[a]")
  })
})

describe("buildExportArgs with transforms", () => {
  const half: Transform = { x: 0.25, y: -0.1, scale: 0.5, cropTop: 0.1, cropBottom: 0.2 }
  const fit = "scale=1920:1080:force_original_aspect_ratio=decrease,setsar=1,fps=30"
  const frame = "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30"
  function project(tracks: Project["tracks"]): Project {
    return {
      ...newProject("T"),
      assets: { a: { file: "a.mp4", duration: 5, hasAudio: true }, i: { file: "i.jpg", duration: 5, hasAudio: false, kind: "image" }, s: { file: "s.mp4", duration: 5, hasAudio: false } },
      tracks,
    }
  }
  const tFiles = { a: "/x/a.mp4", i: "/x/i.webp", s: "/x/s.mp4" }

  it("overlays a transformed base clip on the black canvas: fit, scale, crop, then place", () => {
    const p = project([{ id: "t1", clips: [{ id: "c1", asset: "a", in: 1, out: 4, transform: half }, { id: "c2", asset: "s", in: 0, out: 2 }] }])
    const g = graph(buildExportArgs(p, tFiles, "o"))
    expect(g).toContain("color=c=black:s=1920x1080:r=30:d=5,format=yuv420p[bg]")
    expect(g).toContain(`[0:v]trim=1:4,setpts=PTS-STARTPTS,${fit},scale=trunc(iw*0.5/2)*2:trunc(ih*0.5/2)*2,crop=iw:round(ih*0.7/2)*2:0:round(ih*0.1/2)*2,setsar=1,setpts=PTS+0/TB[v0]`)
    expect(g).toContain("[bg][v0]overlay=x=(W-w)/2+0.25*W:y=(H-h/0.7)/2-0.1*H+0.1*h/0.7:eval=init:enable='between(t,0,3)':eof_action=pass[l1]")
    // The untransformed base clip after it fills the canvas letterboxed, as always, from its own start.
    expect(g).toContain(`[1:v]trim=0:2,setpts=PTS-STARTPTS,${frame},setpts=PTS+3/TB[v1]`)
    expect(g).toContain("[l1][v1]overlay=x=(W-w)/2+0*W:y=(H-h/1)/2+0*H+0*h/1:eval=init:enable='between(t,3,5)':eof_action=pass[v]")
    expect(g).not.toContain("concat")
    // Audio: the clip's own, delayed to its start, over silence; the silent asset adds none.
    expect(g).toContain("[0:a]atrim=1:4,asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo,adelay=delays=0S:all=1[a0]")
    expect(g).not.toContain("[1:a]")
    expect(g).toContain("anullsrc=r=48000:cl=stereo,atrim=0:5[asil]")
    expect(g).toContain("[asil][a0]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[a]")
  })

  it("puts every clip on the canvas in track order when only an overlay is transformed", () => {
    const p = project([
      { id: "t1", muted: true, clips: [{ id: "c1", asset: "a", in: 0, out: 4 }] },
      { id: "t2", clips: [{ id: "p", asset: "i", in: 0, out: 2, start: 1, transform: { ...IDENTITY, scale: 0.3, x: -0.3 } }] },
      { id: "t3", clips: [{ id: "v", asset: "a", in: 2, out: 3, start: 2.5 }] },
    ])
    const args = buildExportArgs(p, tFiles, "o")
    const g = graph(args)
    expect(args.slice(args.indexOf("/x/i.webp") - 7, args.indexOf("/x/i.webp") + 1)).toEqual(["-loop", "1", "-framerate", "30", "-t", "2", "-i", "/x/i.webp"])
    expect(g).toContain("color=c=black:s=1920x1080:r=30:d=4,format=yuv420p[bg]")
    expect(g).toContain(`[0:v]trim=0:4,setpts=PTS-STARTPTS,${frame},setpts=PTS+0/TB[v0]`)
    expect(g).toContain("[bg][v0]overlay=x=(W-w)/2+0*W:y=(H-h/1)/2+0*H+0*h/1:eval=init:enable='between(t,0,4)':eof_action=pass[l1]")
    expect(g).toContain(`[1:v]setpts=PTS-STARTPTS,${fit},scale=trunc(iw*0.3/2)*2:trunc(ih*0.3/2)*2,setsar=1,format=yuv420p,setpts=PTS+1/TB[v1]`)
    expect(g).toContain("[l1][v1]overlay=x=(W-w)/2-0.3*W:y=(H-h/1)/2+0*H+0*h/1:eval=init:enable='between(t,1,3)':eof_action=pass[l2]")
    expect(g).toContain("[l2][v2]overlay=x=(W-w)/2+0*W:y=(H-h/1)/2+0*H+0*h/1:eval=init:enable='between(t,2.5,3.5)':eof_action=pass[v]")
    // The muted base is silent; the unmuted overlay video is heard from its start.
    expect(g).not.toContain("[0:a]")
    expect(g).toContain("[2:a]atrim=2:3,asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo,adelay=delays=120000S:all=1[a2]")
    expect(g).toContain("[asil][a2]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[a]")
  })

  it("builds exactly the old graph when every transform is the identity", () => {
    const plain = twoClips()
    const identity = { ...plain, tracks: [{ ...plain.tracks[0], clips: plain.tracks[0].clips.map((c) => ({ ...c, transform: { ...IDENTITY } })) }] }
    expect(buildExportGraph(identity, files)).toEqual(buildExportGraph(plain, files))
    const layers: Project = {
      ...plain,
      tracks: [plain.tracks[0], { id: "t2", clips: [{ id: "o", asset: "a", in: 0, out: 1, start: 1, transform: { ...IDENTITY } }] }],
    }
    const bare: Project = { ...layers, tracks: [plain.tracks[0], { id: "t2", clips: [{ id: "o", asset: "a", in: 0, out: 1, start: 1 }] }] }
    expect(buildExportGraph(layers, files)).toEqual(buildExportGraph(bare, files))
  })

  it("places the picture where the preview does (overlay x/y against clipRect)", () => {
    const evaluate = (expr: string, v: Record<string, number>) => new Function(...Object.keys(v), `return ${expr}`)(...Object.values(v)) as number
    const canvases = [[1920, 1080], [1080, 1920], [1280, 720], [1000, 1000]]
    const aspects = [16 / 9, 9 / 16, 4 / 3, 1, 2.39]
    const transforms: Transform[] = [
      IDENTITY,
      { x: 0.25, y: -0.1, scale: 0.5, cropTop: 0.1, cropBottom: 0.2 },
      { x: -1.3, y: 0.7, scale: 2.5, cropTop: 0, cropBottom: 0.45 },
      { x: 0.123456, y: -0.654321, scale: 0.1234, cropTop: 0.333, cropBottom: 0.5 },
      { x: 0, y: 0, scale: 5, cropTop: 0.9, cropBottom: 0.05 },
    ]
    for (const [W, H] of canvases) for (const a of aspects) for (const t of transforms) {
      const r = clipRect(a, W, H, t)
      const { x, y } = overlayPosition(t)
      const keep = 1 - t.cropTop - t.cropBottom
      // Exact sizes: the formulas match clipRect to the float.
      expect(evaluate(x, { W, H, w: r.w, h: r.h * keep })).toBeCloseTo(r.visible.x, 3)
      expect(evaluate(y, { W, H, w: r.w, h: r.h * keep })).toBeCloseTo(r.visible.y, 3)
      // ffmpeg's whole-pixel sizes (fit rounded, even scale, even crop) land within 3 px of the
      // preview while at least half the height is kept (the crop's rounding grows as 1/keep).
      if (keep < 0.5) continue
      const fit = clipRect(a, W, H, IDENTITY)
      const sw = Math.floor((Math.round(fit.w) * t.scale) / 2) * 2
      const sh = Math.floor((Math.round(fit.h) * t.scale) / 2) * 2
      const ch = keep < 1 ? Math.round((sh * keep) / 2) * 2 : sh
      expect(Math.abs(evaluate(x, { W, H, w: sw, h: ch }) - r.visible.x)).toBeLessThanOrEqual(3)
      expect(Math.abs(evaluate(y, { W, H, w: sw, h: ch }) - r.visible.y)).toBeLessThanOrEqual(3)
    }
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

// Real ffmpeg: the project's .data/ffmpeg.exe and the dev sample videos. The suite's name says why when it's skipped.
const FFMPEG = path.resolve(".data/ffmpeg.exe")
const SAMPLES = path.resolve("dev-photos/upload/mjdazzo")
const sample = (n: number) => path.join(SAMPLES, `VID_200${n}.mp4`)
const canRun = fs.existsSync(FFMPEG) && fs.existsSync(sample(1)) && fs.existsSync(sample(2))

function ffmpeg(args: string[]): Promise<{ stdout: Buffer; stderr: string }> {
  return new Promise((resolve) => {
    execFile(FFMPEG, ["-hide_banner", ...args], { encoding: "buffer", maxBuffer: 64 * 1024 * 1024 }, (_e, stdout, stderr) => resolve({ stdout, stderr: stderr.toString() }))
  })
}

if (!canRun) console.warn(`Real ffmpeg export tests skipped: need ${FFMPEG} and ${SAMPLES}${path.sep}VID_2001.mp4 and VID_2002.mp4`)

;(canRun ? describe : describe.skip)(canRun ? "runExport with real ffmpeg" : "runExport with real ffmpeg (SKIPPED: .data/ffmpeg.exe or dev-photos samples not found)", () => {
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
    const total = totalLength(p)
    // The filtergraph goes through a script file, as the app does.
    const script = path.join(dir, `${name}.graph.txt`)
    fs.writeFileSync(script, buildExportGraph(p, files).graph)
    await runExport(buildExportArgs(p, files, out, script), out, total, (f) => progress.push(f))
    const info = (await ffmpeg(["-i", out])).stderr
    return { out, info, duration: (await probeMedia(out)).duration, progress, total }
  }

  it("exports two trimmed sample clips with audio and the summed length", async () => {
    const p: Project = {
      ...newProject("E2E"),
      assets: { a: { file: "a", duration: 3, hasAudio: true }, b: { file: "b", duration: 3, hasAudio: true } },
      tracks: base([{ id: "1", asset: "a", in: 1, out: 2.5 }, { id: "2", asset: "b", in: 0, out: 1.5 }]),
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
      tracks: base([{ id: "1", asset: "a", in: 0, out: 1 }, { id: "2", asset: "s", in: 0, out: 1.5 }, { id: "3", asset: "a", in: 1, out: 2 }]),
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
      tracks: base([{ id: "1", asset: "v", in: 0, out: 1.5 }]),
    }
    const r = await exportProject(p, { v: portrait }, "portrait-out.mp4")
    expect(r.info).toMatch(/Video: h264[^\n]*1920x1080/)
    // A pixel near the left edge is pad (black, luma 16), not picture.
    const px = await ffmpeg(["-ss", "0.5", "-i", r.out, "-frames:v", "1", "-vf", "crop=1:1:5:540,format=gray", "-f", "rawvideo", "-"])
    expect(px.stdout[0]).toBeLessThanOrEqual(20)
  }, 60_000)

  it("exports video, a 2 s image and video with audio and the summed length", async () => {
    const image = path.join(dir, "still.webp")
    await sharp({ create: { width: 800, height: 600, channels: 3, background: "#c33" } }).webp().toFile(image)
    const p: Project = {
      ...newProject("Image"),
      assets: { a: { file: "a", duration: 3, hasAudio: true }, i: { file: "i", duration: 5, hasAudio: false, kind: "image" } },
      tracks: base([{ id: "1", asset: "a", in: 0, out: 1 }, { id: "2", asset: "i", in: 0, out: 2 }, { id: "3", asset: "a", in: 1, out: 2 }]),
    }
    const r = await exportProject(p, { a: sample(1), i: image }, "image.mp4")
    expect(Math.abs(r.duration - 4)).toBeLessThan(0.4)
    expect(r.info).toMatch(/Stream #[^\n]*Audio:/)
    expect(r.info).toMatch(/Video: h264[^\n]*1920x1080/)
    // The picture itself runs the whole length (a single frame would leave only the audio).
    const video = (await ffmpeg(["-i", r.out, "-map", "0:v", "-f", "null", "-"])).stderr
    let last = 0
    for (const m of video.matchAll(/time=(\d+):(\d+):(\d+\.\d+)/g)) last = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])
    expect(Math.abs(last - 4)).toBeLessThan(0.4)
    // Mid-image the frame is the red still.
    const px = await ffmpeg(["-ss", "2", "-i", r.out, "-frames:v", "1", "-vf", "crop=2:2:960:540,format=rgb24", "-f", "rawvideo", "-"])
    expect(px.stdout[0]).toBeGreaterThan(150)
    expect(px.stdout[1]).toBeLessThan(100)
  }, 60_000)

  /** RGB of a 2x2 patch in the middle of the frame at `t` seconds. */
  async function centre(file: string, t: number): Promise<number[]> {
    const px = await ffmpeg(["-ss", String(t), "-i", file, "-frames:v", "1", "-vf", "crop=2:2:960:540,format=rgb24", "-f", "rawvideo", "-"])
    return [px.stdout[0], px.stdout[1], px.stdout[2]]
  }

  async function blueAndRed() {
    const blue = path.join(dir, "blue.mp4")
    const red = path.join(dir, "red.webp")
    if (!fs.existsSync(blue)) {
      await ffmpeg(["-f", "lavfi", "-i", "color=c=blue:s=640x360:r=25:d=5", "-f", "lavfi", "-i", "sine=duration=5", "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-y", blue])
      await sharp({ create: { width: 800, height: 600, channels: 3, background: "#c33" } }).webp().toFile(red)
    }
    return { blue, red }
  }

  it("draws an overlay image over the base video and keeps the base audio", async () => {
    const { blue, red } = await blueAndRed()
    const p: Project = {
      ...newProject("Layers"),
      assets: { v: { file: "v", duration: 5, hasAudio: true }, i: { file: "i", duration: 5, hasAudio: false, kind: "image" } },
      tracks: [
        { id: "t1", clips: [{ id: "1", asset: "v", in: 0, out: 4 }] },
        { id: "t2", clips: [{ id: "2", asset: "i", in: 0, out: 2, start: 1 }] },
      ],
    }
    const r = await exportProject(p, { v: blue, i: red }, "layers.mp4")
    expect(Math.abs(r.duration - 4)).toBeLessThan(0.3)
    expect(r.info).toMatch(/Stream #[^\n]*Audio:/)
    expect(r.info).toMatch(/Video: h264[^\n]*1920x1080/)
    const [r0, , b0] = await centre(r.out, 0.5)
    expect(b0).toBeGreaterThan(150)
    expect(r0).toBeLessThan(100)
    const [r2, , b2] = await centre(r.out, 2)
    expect(r2).toBeGreaterThan(150)
    expect(b2).toBeLessThan(100)
    // Back to the base after the overlay ends.
    expect((await centre(r.out, 3.5))[2]).toBeGreaterThan(150)
  }, 60_000)

  it("runs past the base track's end to the last overlay, over black", async () => {
    const { blue, red } = await blueAndRed()
    const p: Project = {
      ...newProject("Past"),
      assets: { v: { file: "v", duration: 5, hasAudio: true }, i: { file: "i", duration: 5, hasAudio: false, kind: "image" } },
      tracks: [
        { id: "t1", clips: [{ id: "1", asset: "v", in: 0, out: 2 }] },
        { id: "t2", clips: [{ id: "2", asset: "i", in: 0, out: 1, start: 3 }] },
      ],
    }
    const r = await exportProject(p, { v: blue, i: red }, "past.mp4")
    expect(Math.abs(r.duration - 4)).toBeLessThan(0.3)
    expect(Math.max(...(await centre(r.out, 2.5)))).toBeLessThan(40)
    expect((await centre(r.out, 3.5))[0]).toBeGreaterThan(150)
    expect(r.info).toMatch(/Stream #[^\n]*Audio:/)
  }, 60_000)

  it("scales, moves and crops a base clip over black, keeping its length and audio", async () => {
    const { blue } = await blueAndRed()
    const p: Project = {
      ...newProject("Transform"),
      assets: { v: { file: "v", duration: 5, hasAudio: true } },
      // Half size, moved right a quarter of the width, bottom half cut: the strip is x 960-1920, y 270-540.
      tracks: base([{ id: "1", asset: "v", in: 0, out: 3, transform: { x: 0.25, y: 0, scale: 0.5, cropTop: 0, cropBottom: 0.5 } }]),
    }
    const r = await exportProject(p, { v: blue }, "transform.mp4")
    expect(Math.abs(r.duration - 3)).toBeLessThan(0.3)
    expect(r.info).toMatch(/Video: h264[^\n]*1920x1080/)
    const at = async (x: number, y: number) => {
      const px = await ffmpeg(["-ss", "1", "-i", r.out, "-frames:v", "1", "-vf", `crop=2:2:${x}:${y},format=rgb24`, "-f", "rawvideo", "-"])
      return [px.stdout[0], px.stdout[1], px.stdout[2]]
    }
    const inside = await at(1440, 400)
    expect(inside[2]).toBeGreaterThan(150)
    expect(inside[0]).toBeLessThan(100)
    // Left of it, below the strip (cropped away) and above it: the black canvas.
    for (const [x, y] of [[300, 540], [1440, 700], [1440, 200], [940, 400]]) expect(Math.max(...(await at(x, y)))).toBeLessThan(40)
    // The sound runs the whole length.
    const audio = (await ffmpeg(["-i", r.out, "-map", "0:a", "-f", "null", "-"])).stderr
    let last = 0
    for (const m of audio.matchAll(/time=(\d+):(\d+):(\d+\.\d+)/g)) last = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])
    expect(Math.abs(last - 3)).toBeLessThan(0.3)
  }, 60_000)

  it("removes a partial output and rejects with ffmpeg's last line when ffmpeg fails", async () => {
    const p: Project = {
      ...newProject("Bad"),
      assets: { a: { file: "a", duration: 3, hasAudio: true } },
      tracks: base([{ id: "1", asset: "a", in: 0, out: 1 }]),
    }
    const out = path.join(dir, "bad.mp4.tmp")
    fs.writeFileSync(out, "partial") // would survive if runExport didn't clean up
    await expect(runExport(buildExportArgs(p, { a: path.join(dir, "nope.mp4") }, out), out, 1, () => {})).rejects.toThrow(/No such file/)
    expect(fs.existsSync(out)).toBe(false)
  }, 60_000)

  it("kills a hung export on timeout and removes the output ffmpeg had started", async () => {
    const out = path.join(dir, "slow.mp4.tmp")
    let existedWhileRunning = false
    const args = ["-hide_banner", "-y", "-nostats", "-progress", "pipe:1", "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30:duration=600", "-c:v", "libx264", "-f", "mp4", out]
    await expect(
      runExport(args, out, 600, () => {
        existedWhileRunning ||= fs.existsSync(out)
      }, 3000)
    ).rejects.toThrow("The export timed out.")
    expect(existedWhileRunning).toBe(true)
    expect(fs.existsSync(out)).toBe(false)
  }, 60_000)
})
