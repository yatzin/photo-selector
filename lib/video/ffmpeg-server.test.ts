import { execFile } from "child_process"
import fs from "fs"
import os from "os"
import path from "path"
import sharp from "sharp"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { buildExportArgs, buildExportGraph, overlayPosition, parseProbe, parseProgressLine, probeMedia, runExport, textRaster } from "./ffmpeg-server"
import { endToEnd, newProject, setBaseMagnetic, totalLength, type Clip, type Project } from "./project"
import { textSize, type ClipText } from "./text"
import { animationState } from "./text-animation"
import { rasteriseText } from "./text-raster-server"
import { clipRect, contentCentre, cropLeftOf, cropRightOf, IDENTITY, rotatedCorners, type Transform } from "./transform"

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

/** One base track holding `clips` end to end from 0. */
const base = (clips: Omit<Clip, "start">[]) => [{ id: "t1", clips: endToEnd(clips) }]

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

  it("uses silence for every muted clip of a single track", () => {
    const g = graph(buildExportArgs({ ...twoClips(), tracks: [{ ...base([])[0], clips: twoClips().tracks[0].clips.map((c) => ({ ...c, muted: true })) }] }, files, "o"))
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
        { id: "t1", clips: [{ id: "c1", asset: "a", in: 0, out: 4, start: 0 }] },
        { id: "t2", clips: [{ id: "p", asset: "i", in: 0, out: 2, start: 1 }] },
        { id: "t3", clips: [{ id: "m", asset: "b", in: 1, out: 2, start: 2.5, muted: true }] },
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

  it("mixes the base audio with silence for the whole length, leaving out images and muted clips", () => {
    const g = graph(buildExportArgs(layered(), layerFiles, "o"))
    expect(g).toContain("[0:a]atrim=0:4")
    expect(g).not.toContain("[1:a]")
    expect(g).not.toContain("[2:a]")
    expect(g).toContain("anullsrc=r=48000:cl=stereo,atrim=0:4[asil]")
    expect(g).toContain("[asil][ba]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[a]")
  })

  it("delays an unmuted overlay's audio to its start", () => {
    const p = layered()
    p.tracks[2] = { id: "t3", clips: p.tracks[2].clips.map((c) => ({ ...c, muted: false })) }
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

describe("buildExportArgs with gaps on the base track", () => {
  const frame = "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30"
  const project = (clips: Clip[]): Project => ({ ...twoClips(), tracks: [{ id: "t1", clips }] })

  it("puts a base clip with a gap before it on the black canvas from its start, its audio delayed", () => {
    const g = graph(buildExportArgs(project([{ id: "c1", asset: "a", in: 1, out: 3, start: 2 }]), files, "o"))
    expect(g).not.toContain("concat")
    expect(g).toContain("color=c=black:s=1920x1080:r=30:d=4,format=yuv420p[bg]")
    expect(g).toContain(`[0:v]trim=1:3,setpts=PTS-STARTPTS,${frame},setpts=PTS+2/TB[v0]`)
    expect(g).toContain("[bg][v0]overlay=x=(W-w)/2+0*W:y=(H-h/1)/2+0*H+0*h/1:eval=init:enable='between(t,2,4)':eof_action=pass[v]")
    expect(g).toContain("adelay=delays=96000S:all=1[a0]")
    expect(g).toContain("anullsrc=r=48000:cl=stereo,atrim=0:4[asil]")
  })

  it("leaves black between two base clips with a gap, each enabled for its own span", () => {
    const g = graph(buildExportArgs(project([{ id: "c1", asset: "a", in: 1, out: 3, start: 0 }, { id: "c2", asset: "s", in: 0, out: 1.5, start: 3 }]), files, "o"))
    expect(g).not.toContain("concat")
    expect(g).toContain("d=4.5,format=yuv420p[bg]")
    expect(g).toContain("enable='between(t,0,2)'")
    expect(g).toContain("enable='between(t,3,4.5)'")
  })

  it("keeps the old concat graph for base clips back to back from 0", () => {
    const g = graph(buildExportArgs(project([{ id: "c1", asset: "a", in: 1, out: 3, start: 0 }, { id: "c2", asset: "s", in: 0, out: 1.5, start: 2 }]), files, "o"))
    expect(g).toContain("concat=n=2:v=1:a=1[v][a]")
  })

  it("uses the concat graph for a snapped base that had gaps", () => {
    const gapped = project([{ id: "c1", asset: "a", in: 1, out: 3, start: 2 }, { id: "c2", asset: "s", in: 0, out: 1.5, start: 6 }])
    const g = graph(buildExportArgs(setBaseMagnetic(gapped, true), files, "o"))
    expect(g).toContain("concat=n=2:v=1:a=1[v][a]")
    expect(g).not.toContain("color=c=black")
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
    const p = project([{ id: "t1", clips: [{ id: "c1", asset: "a", in: 1, out: 4, start: 0, transform: half }, { id: "c2", asset: "s", in: 0, out: 2, start: 3 }] }])
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
      { id: "t1", clips: [{ id: "c1", asset: "a", in: 0, out: 4, start: 0, muted: true }] },
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

  it("crops left and right as well as top and bottom, with even sizes and offsets", () => {
    const t: Transform = { ...IDENTITY, scale: 0.5, cropLeft: 0.2, cropRight: 0.1 }
    const p = project([{ id: "t1", clips: [{ id: "c1", asset: "a", in: 0, out: 2, start: 0, transform: t }] }])
    const g = graph(buildExportArgs(p, tFiles, "o"))
    expect(g).toContain("crop=round(iw*0.7/2)*2:ih:round(iw*0.2/2)*2:0,setsar=1")
    expect(g).toContain("overlay=x=(W-w/0.7)/2+0*W+0.2*w/0.7:y=(H-h/1)/2+0*H+0*h/1:eval=init")
    const both = project([{ id: "t1", clips: [{ id: "c1", asset: "a", in: 0, out: 2, start: 0, transform: { ...t, cropTop: 0.1, cropBottom: 0.2 } }] }])
    expect(graph(buildExportArgs(both, tFiles, "o"))).toContain("crop=round(iw*0.7/2)*2:round(ih*0.7/2)*2:round(iw*0.2/2)*2:round(ih*0.1/2)*2")
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

  it("flips after the scale and before the crop, placed as an unflipped clip is", () => {
    const t: Transform = { ...IDENTITY, scale: 0.5, cropLeft: 0.2, flipH: true, flipV: true }
    const g = graph(buildExportArgs(project([{ id: "t1", clips: [{ id: "c1", asset: "a", in: 0, out: 2, start: 0, transform: t }] }]), tFiles, "o"))
    expect(g).toContain(`${fit},scale=trunc(iw*0.5/2)*2:trunc(ih*0.5/2)*2,hflip,vflip,crop=round(iw*0.8/2)*2:ih:round(iw*0.2/2)*2:0,setsar=1,setpts=PTS+0/TB[v0]`)
    expect(g).toContain("overlay=x=(W-w/0.8)/2+0*W+0.2*w/0.8:y=(H-h/1)/2+0*H+0*h/1:eval=init")
    expect(g).not.toContain("rotate")
    const h = graph(buildExportArgs(project([{ id: "t1", clips: [{ id: "c1", asset: "a", in: 0, out: 2, start: 0, transform: { ...IDENTITY, flipH: true } }] }]), tFiles, "o"))
    expect(h).toContain(`${fit},scale=trunc(iw*1/2)*2:trunc(ih*1/2)*2,hflip,setsar=1,setpts`)
    expect(h).not.toContain("vflip")
  })

  it("rotates a clip on RGBA about its content centre into a frame that holds it, transparent corners", () => {
    const t: Transform = { ...IDENTITY, x: 0.1, y: -0.2, scale: 0.5, rotation: 90 }
    const p = project([
      { id: "t1", clips: [{ id: "c1", asset: "a", in: 0, out: 2, start: 0, transform: t }] },
      { id: "t2", clips: [{ id: "p", asset: "i", in: 0, out: 2, start: 0, transform: { ...IDENTITY, rotation: -45 } }] },
    ])
    const g = graph(buildExportArgs(p, tFiles, "o"))
    expect(g).toContain(`[0:v]trim=0:2,setpts=PTS-STARTPTS,${fit},scale=trunc(iw*0.5/2)*2:trunc(ih*0.5/2)*2,format=rgba,rotate=1.570796:ow=rotw(1.570796):oh=roth(1.570796):c=black@0,setsar=1,format=yuva420p,setpts=PTS+0/TB[v0]`)
    expect(g).toContain("[bg][v0]overlay=x=(W-w)/2+0.1*W:y=(H-h)/2-0.2*H:eval=init")
    // A turned still keeps its alpha.
    expect(g).toContain("rotate=-0.785398:ow=rotw(-0.785398):oh=roth(-0.785398):c=black@0,setsar=1,format=yuva420p,format=yuva420p,setpts=PTS+0/TB[v1]")
  })

  it("flips, crops (transparent, full size) and rotates, in that order", () => {
    const t: Transform = { x: 0, y: 0, scale: 0.8, cropTop: 0.1, cropBottom: 0.2, cropLeft: 0.25, cropRight: 0.05, rotation: 30, flipH: true }
    const g = graph(buildExportArgs(project([{ id: "t1", clips: [{ id: "c1", asset: "a", in: 0, out: 2, start: 0, transform: t }] }]), tFiles, "o"))
    const box = (x: string, y: string, w: string, h: string) => `drawbox=x=${x}:y=${y}:w=${w}:h=${h}:color=black@0:t=fill:replace=1`
    expect(g).toContain(
      [
        "scale=trunc(iw*0.8/2)*2:trunc(ih*0.8/2)*2,hflip,format=rgba",
        box("0", "0", "iw", "round(ih*0.1)"),
        box("0", "ih-round(ih*0.2)", "iw", "round(ih*0.2)"),
        box("0", "0", "round(iw*0.25)", "ih"),
        box("iw-round(iw*0.05)", "0", "round(iw*0.05)", "ih"),
        "rotate=0.523599:ow=rotw(0.523599):oh=roth(0.523599):c=black@0,setsar=1,format=yuva420p",
      ].join(",")
    )
    expect(g).not.toContain("crop=")
    expect(g).toContain("overlay=x=(W-w)/2+0*W:y=(H-h)/2+0*H:eval=init")
  })

  it("keeps a turned picture's content centre and visible corners where the preview has them", () => {
    const evaluate = (expr: string, v: Record<string, number>) => new Function(...Object.keys(v), `return ${expr}`)(...Object.values(v)) as number
    const transforms: Transform[] = [
      { ...IDENTITY, rotation: 90 },
      { x: 0.25, y: -0.1, scale: 0.5, cropTop: 0.1, cropBottom: 0.2, rotation: 45, flipH: true },
      { x: -0.3, y: 0.2, scale: 1.4, cropTop: 0, cropBottom: 0.3, cropLeft: 0.4, cropRight: 0.1, rotation: -120, flipV: true },
      { x: 0.1, y: 0.1, scale: 0.7, cropTop: 0, cropBottom: 0, rotation: 180 },
    ]
    for (const [W, H] of [[1920, 1080], [1080, 1920]]) for (const a of [16 / 9, 9 / 16, 1]) for (const t of transforms) {
      const r = clipRect(a, W, H, t)
      const rad = ((t.rotation ?? 0) * Math.PI) / 180
      // rotate's output: the whole scaled frame (crop transparent) turned, rotw x roth.
      const w = Math.abs(r.w * Math.cos(rad)) + Math.abs(r.h * Math.sin(rad))
      const h = Math.abs(r.w * Math.sin(rad)) + Math.abs(r.h * Math.cos(rad))
      const { x, y } = overlayPosition(t)
      const ox = evaluate(x, { W, H, w, h })
      const oy = evaluate(y, { W, H, w, h })
      const c = contentCentre(W, H, t)
      expect(ox + w / 2).toBeCloseTo(c.x, 6)
      expect(oy + h / 2).toBeCloseTo(c.y, 6)
      // Each visible corner, taken through ffmpeg's frame (offset from the frame centre, turned), lands where the preview draws it.
      const shown = rotatedCorners(r.visible, c, t.rotation ?? 0)
      const vs = [[r.visible.x, r.visible.y], [r.visible.x + r.visible.w, r.visible.y], [r.visible.x + r.visible.w, r.visible.y + r.visible.h], [r.visible.x, r.visible.y + r.visible.h]]
      vs.forEach(([vx, vy], k) => {
        const fx = vx - (r.x + r.w / 2)
        const fy = vy - (r.y + r.h / 2)
        expect(ox + w / 2 + fx * Math.cos(rad) - fy * Math.sin(rad)).toBeCloseTo(shown[k].x, 6)
        expect(oy + h / 2 + fx * Math.sin(rad) + fy * Math.cos(rad)).toBeCloseTo(shown[k].y, 6)
      })
    }
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
      { x: 0.1, y: 0.2, scale: 0.8, cropTop: 0, cropBottom: 0, cropLeft: 0.25, cropRight: 0.1 },
      { x: -0.4, y: 0.05, scale: 1.7, cropTop: 0.15, cropBottom: 0.2, cropLeft: 0.05, cropRight: 0.4 },
      { x: 0.3, y: -0.3, scale: 0.4, cropTop: 0.1, cropBottom: 0, cropRight: 0.33 },
      { x: 0, y: 0, scale: 2, cropTop: 0, cropBottom: 0, cropLeft: 0.9, cropRight: 0.05 },
    ]
    for (const [W, H] of canvases) for (const a of aspects) for (const t of transforms) {
      const r = clipRect(a, W, H, t)
      const { x, y } = overlayPosition(t)
      const keep = 1 - t.cropTop - t.cropBottom
      const keepW = 1 - cropLeftOf(t) - cropRightOf(t)
      // Exact sizes: the formulas match clipRect to the float.
      expect(evaluate(x, { W, H, w: r.w * keepW, h: r.h * keep })).toBeCloseTo(r.visible.x, 3)
      expect(evaluate(y, { W, H, w: r.w * keepW, h: r.h * keep })).toBeCloseTo(r.visible.y, 3)
      // ffmpeg's whole-pixel sizes (fit rounded, even scale, even crop) land within 3 px of the
      // preview while at least half the width and height is kept (the crop's rounding grows as 1/keep).
      if (keep < 0.5 || keepW < 0.5) continue
      const fit = clipRect(a, W, H, IDENTITY)
      const sw = Math.floor((Math.round(fit.w) * t.scale) / 2) * 2
      const sh = Math.floor((Math.round(fit.h) * t.scale) / 2) * 2
      const ch = keep < 1 ? Math.round((sh * keep) / 2) * 2 : sh
      const cw = keepW < 1 ? Math.round((sw * keepW) / 2) * 2 : sw
      expect(Math.abs(evaluate(x, { W, H, w: cw, h: ch }) - r.visible.x)).toBeLessThanOrEqual(3)
      expect(Math.abs(evaluate(y, { W, H, w: cw, h: ch }) - r.visible.y)).toBeLessThanOrEqual(3)
    }
  })
})

describe("buildExportArgs with text clips", () => {
  const text = (over: Partial<ClipText> = {}): ClipText => ({ content: "Hi", color: "#ffffff", orientation: "horizontal", ...over })
  function project(clip: Partial<Clip>): Project {
    return {
      ...newProject("Text"),
      assets: { a: { file: "a.mp4", duration: 5, hasAudio: true } },
      tracks: [
        { id: "t1", clips: [{ id: "c1", asset: "a", in: 0, out: 4, start: 0 }] },
        { id: "t2", clips: [{ id: "x", asset: "", in: 0, out: 2, start: 1, text: text(), ...clip }] },
      ],
    }
  }
  const tFiles = { a: "/x/a.mp4", "text:x": "/x/text.png" }

  it("sizes the frame from the content box at the clip's scale (even px), drawn at a font size step above it", () => {
    // "Hi" at 108 px: 2 x 0.6 + 0.5 = 1.7 font sizes wide (183.6), 1.3 + 0.5 = 1.8 tall (194.4).
    expect(textRaster(project({}), { ...project({}).tracks[1].clips[0], text: text() })).toEqual({ fontPx: 120, w: 184, h: 194 })
    const big = project({ transform: { ...IDENTITY, scale: 2 } }).tracks[1].clips[0]
    expect(textRaster(project({}), { ...big, text: text() })).toEqual({ fontPx: 220, w: 368, h: 388 })
  })

  it("feeds the text's PNG in like a still and overlays it, transparent, centred, over the layers below (always the uniform graph)", () => {
    const args = buildExportArgs(project({}), tFiles, "o")
    expect(args.slice(args.indexOf("/x/text.png") - 7, args.indexOf("/x/text.png") + 1)).toEqual(["-loop", "1", "-framerate", "30", "-t", "2", "-i", "/x/text.png"])
    const g = graph(args)
    expect(g).toContain("color=c=black:s=1920x1080:r=30:d=4,format=yuv420p[bg]")
    expect(g).toContain("[1:v]setpts=PTS-STARTPTS,scale=184:194,setsar=1,fps=30,format=rgba,setsar=1,format=yuva420p,setpts=PTS+1/TB[v1]")
    expect(g).toContain("[l1][v1]overlay=x=(W-w)/2+0*W:y=(H-h/1)/2+0*H+0*h/1:eval=init:enable='between(t,1,3)':eof_action=pass[v]")
    // No sound from it.
    expect(g).not.toContain("[1:a]")
  })

  it("flips, crops and turns the text's frame like a picture's", () => {
    const g = graph(buildExportArgs(project({ transform: { ...IDENTITY, scale: 2, rotation: 90, flipH: true, cropTop: 0.1 } }), tFiles, "o"))
    expect(g).toContain(
      "[1:v]setpts=PTS-STARTPTS,scale=368:388,setsar=1,fps=30,format=rgba,hflip,format=rgba,drawbox=x=0:y=0:w=iw:h=round(ih*0.1):color=black@0:t=fill:replace=1," +
        "rotate=1.570796:ow=rotw(1.570796):oh=roth(1.570796):c=black@0,setsar=1,format=yuva420p,format=yuva420p,setpts=PTS+1/TB[v1]"
    )
    expect(g).toContain("[l1][v1]overlay=x=(W-w)/2+0*W:y=(H-h)/2+0*H:eval=init")
  })

  it("gives vertical text a tall frame", () => {
    // "Hey" stacked: 0.6 + 0.5 = 1.1 font sizes wide (118.8), 3 x 1.3 + 0.5 = 4.4 tall (475.2).
    const g = graph(buildExportArgs(project({ text: text({ content: "Hey", orientation: "vertical" }) }), tFiles, "o"))
    expect(g).toContain("scale=118:476,setsar=1,fps=30,format=rgba,setsar=1,format=yuva420p")
  })

  it("sizes each font's frame from its own box; Mono, named or not, builds the graph it always did", () => {
    const frame = (font?: string) => textRaster(project({}), { ...project({}).tracks[1].clips[0], text: text({ content: "Boo!", font }) })
    const sizes = ["anton", "pacifico", "press-start"].map((f) => frame(f))
    expect(new Set(sizes.map((s) => `${s.w}x${s.h}`)).size).toBe(3)
    for (const s of sizes) expect(s.fontPx).toBe(120)
    const g = (font?: string) => graph(buildExportArgs(project({ text: text({ font }) }), tFiles, "o"))
    expect(g("anton")).not.toBe(g("pacifico"))
    expect(g(undefined)).toBe(graph(buildExportArgs(project({}), tFiles, "o")))
    expect(g(undefined)).toContain("scale=184:194,")
  })

  it("refuses a text clip with no PNG", () => {
    expect(() => buildExportArgs(project({}), { a: "/x/a.mp4" }, "o")).toThrow("Missing text picture")
  })

  describe("animated", () => {
    const g = (over: Partial<ClipText>, transform?: Transform) => graph(buildExportArgs(project({ text: text(over), ...(transform ? { transform } : {}) }), tFiles, "o"))

    it("fades in with a geq on the alpha while the in animation runs, placed once", () => {
      const s = g({ animIn: { type: "fade", duration: 1 } })
      expect(s).toContain(
        "[1:v]setpts=PTS-STARTPTS,scale=184:194,setsar=1,fps=30,format=rgba," +
          "geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='alpha(X,Y)*if(lt(T,1),(1-pow((1-clip((T/1),0,1)),3)),1)':enable='lt(t,1)'," +
          "setsar=1,format=yuva420p,setpts=PTS+1/TB[v1]"
      )
      expect(s).toContain("overlay=x=(W-w)/2+0*W:y=(H-h/1)/2+0*H+0*h/1:eval=init:enable='between(t,1,3)'")
    })

    it("slides out with an x on the timeline's time from the clip's start, placed every frame, no geq", () => {
      const s = g({ animOut: { type: "slide-left", duration: 0.5 } })
      expect(s).not.toContain("geq=")
      // The box rests 868.2-1051.8 px across: it ends 1051.8 / 1920 = 0.547813 canvas widths left.
      expect(s).toContain("overlay=x='(W-w)/2+0*W+if(gt((t-1),1.5),((1-(1-pow((1-clip(((2-(t-1))/0.5),0,1)),3)))*(-0.547813)),0)*W':y='(H-h/1)/2+0*H+0*h/1':eval=frame")
    })

    it("plays a sweep in and a fade out of different lengths in one geq, enabled for both", () => {
      const s = g({ animIn: { type: "sweep-left", duration: 0.5 }, animOut: { type: "fade", duration: 1 } })
      expect(s).toContain(
        "geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='alpha(X,Y)*(if(gt(T,1),(1-pow((1-clip(((2-T)/1),0,1)),3)),1)*" +
          "if(lt(T,0.5),lt((X+0.5),(W*(1-pow((1-clip((T/0.5),0,1)),3)))),1))':enable='lt(t,0.5)+gt(t,1)'"
      )
    })

    it("spins a turned text on top of its rotation into a square frame, scaling it about its centre", () => {
      const s = g({ animIn: { type: "spin", duration: 1 } }, { ...IDENTITY, rotation: 30, flipH: true })
      expect(s).toContain("hflip,format=rgba,rotate=a='0.523599+if(lt(t,1),((-360)*(1-(1-pow((1-clip((t/1),0,1)),3)))),0)*PI/180':ow='hypot(iw,ih)':oh='hypot(iw,ih)':c=black@0,setsar=1,format=yuva420p,")
      expect(s).toContain("scale=w='max(2,trunc(iw*if(lt(t,1),(1-pow((1-clip((t/1),0,1)),3)),1)/2)*2)':h='max(2,trunc(ih*if(lt(t,1),(1-pow((1-clip((t/1),0,1)),3)),1)/2)*2)':eval=frame")
      expect(s).toContain("overlay=x='(W-w)/2+0*W':y='(H-h)/2+0*H':eval=frame")
    })

    it("turns an unturned text for a spin, and types with drawboxes before the flips", () => {
      expect(g({ animIn: { type: "spin", duration: 1 } })).toContain("rotate=a='0+if(lt(t,1)")
      const s = g({ animIn: { type: "typewriter", duration: 1 } }, { ...IDENTITY, flipV: true })
      expect(s).toContain("format=rgba,drawbox=x=round(iw*0):y=round(ih*0):w=iw-round(iw*0):h=ih-round(ih*0):color=black@0:t=fill:replace=1:enable='lt(t,0.5)',drawbox=")
      expect(s.indexOf("enable='lt(t,1)',vflip")).toBeGreaterThan(0)
    })
  })
})

describe("buildExportArgs with transitions", () => {
  const assets: Project["assets"] = {
    v: { file: "v.mp4", duration: 10, hasAudio: true },
    w: { file: "w.mp4", duration: 10, hasAudio: true },
    i: { file: "i.jpg", duration: 5, hasAudio: false, kind: "image" },
    j: { file: "j.jpg", duration: 5, hasAudio: false, kind: "image" },
  }
  const xFiles = { v: "/x/v.mp4", w: "/x/w.mp4", i: "/x/i.jpg", j: "/x/j.jpg", "text:t": "/x/t.png" }
  const fade = (duration = 1, type: "fade" | "wipeleft" | "slideup" = "fade") => ({ type, duration })
  const project = (...tracks: Clip[][]): Project => ({ ...newProject("X"), assets, tracks: tracks.map((clips, k) => ({ id: `t${k + 1}`, clips })) })

  it("joins two images with xfade at the start of the transition, each held half of it past its cut", () => {
    const g = graph(buildExportArgs(project([{ id: "a", asset: "i", in: 0, out: 4, start: 0 }, { id: "b", asset: "j", in: 0, out: 4, start: 4, transition: fade() }]), xFiles, "o"))
    expect(g).toContain("format=yuv420p,tpad=start_duration=0:stop_duration=0.5:start_mode=clone:stop_mode=clone,setpts=PTS+0/TB[v0]")
    expect(g).toContain("format=yuv420p,tpad=start_duration=0.5:stop_duration=0:start_mode=clone:stop_mode=clone,setpts=PTS+3.5/TB[v1]")
    expect(g).toContain("color=c=black@0:s=1920x1080:r=30:d=4.5,format=yuva420p,setpts=PTS+0/TB[tc0]")
    expect(g).toContain("color=c=black@0:s=1920x1080:r=30:d=4.5,format=yuva420p,setpts=PTS+3.5/TB[tc1]")
    expect(g).toContain("[tc0][v0]overlay=x=(W-w)/2+0*W:y=(H-h/1)/2+0*H+0*h/1:eval=init:eof_action=pass:format=auto,setpts=PTS-STARTPTS[ts0]")
    expect(g).toContain("[ts0][ts1]xfade=transition=fade:duration=1:offset=3.5[tx1]")
    expect(g).toContain("[tx1]setpts=PTS+0/TB[u0];[bg][u0]overlay=x=0:y=0:enable='between(t,0,8)':eof_action=pass[v]")
    // The timeline keeps its length.
    expect(g).toContain("color=c=black:s=1920x1080:r=30:d=8,format=yuv420p[bg]")
  })

  it("plays two videos' footage beyond the cut and crossfades their sound (equal power)", () => {
    const g = graph(buildExportArgs(project([{ id: "a", asset: "v", in: 1, out: 4, start: 0 }, { id: "b", asset: "w", in: 2, out: 5, start: 3, transition: fade(2, "wipeleft") }]), xFiles, "o"))
    expect(g).toContain("[0:v]trim=1:5,setpts=PTS-STARTPTS,")
    expect(g).toContain("[1:v]trim=1:5,setpts=PTS-STARTPTS,")
    expect(g).toContain("[0:a]atrim=1:5,asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo,afade=t=out:st=2:d=2:curve=qsin,adelay=delays=0S:all=1[a0]")
    expect(g).toContain("[1:a]atrim=1:5,asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo,afade=t=in:st=0:d=2:curve=qsin,adelay=delays=96000S:all=1[a1]")
    expect(g).toContain("[ts0][ts1]xfade=transition=wipeleft:duration=2:offset=2[tx1]")
    expect(g).toContain("amix=inputs=3")
  })

  it("goes from an image to a text clip", () => {
    const text = { content: "Hi", color: "#ffffff", orientation: "horizontal" as const }
    const g = graph(buildExportArgs(project([{ id: "a", asset: "i", in: 0, out: 3, start: 0 }, { id: "t", asset: "", in: 0, out: 3, start: 3, text, transition: fade(1, "slideup") }]), xFiles, "o"))
    expect(g).toContain("format=yuva420p,tpad=start_duration=0.5:stop_duration=0:start_mode=clone:stop_mode=clone,setpts=PTS+2.5/TB[v1]")
    expect(g).toContain("[ts0][ts1]xfade=transition=slideup:duration=1:offset=2.5[tx1]")
  })

  it("chains three clips, the middle one extended on both sides", () => {
    const g = graph(buildExportArgs(project([
      { id: "a", asset: "v", in: 1, out: 4, start: 0 },
      { id: "b", asset: "w", in: 2, out: 5, start: 3, transition: fade(1) },
      { id: "c", asset: "v", in: 6, out: 8, start: 6, transition: fade(2, "wipeleft") },
    ]), xFiles, "o"))
    expect(g).toContain("[1:v]trim=1.5:6,")
    expect(g).toContain("[2:v]trim=5:8,")
    expect(g).toContain("[1:a]atrim=1.5:6,asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo,afade=t=in:st=0:d=1:curve=qsin,afade=t=out:st=2.5:d=2:curve=qsin,adelay=delays=120000S:all=1[a1]")
    expect(g).toContain("[ts0][ts1]xfade=transition=fade:duration=1:offset=2.5[tx1]")
    expect(g).toContain("[tx1][ts2]xfade=transition=wipeleft:duration=2:offset=5[tx2]")
    expect(g).toContain("[tx2]setpts=PTS+0/TB[u0];[bg][u0]overlay=x=0:y=0:enable='between(t,0,8)':eof_action=pass[v]")
  })

  it("places a moved, scaled and turned clip on its canvas where it would be without the transition", () => {
    const t: Transform = { ...IDENTITY, x: 0.1, scale: 0.5, rotation: 45 }
    const g = graph(buildExportArgs(project([{ id: "a", asset: "v", in: 1, out: 4, start: 0, transform: t }, { id: "b", asset: "w", in: 2, out: 5, start: 3, transition: fade() }]), xFiles, "o"))
    expect(g).toContain("rotate=0.785398:ow=rotw(0.785398):oh=roth(0.785398):c=black@0,setsar=1,format=yuva420p,setpts=PTS+0/TB[v0]")
    expect(g).toContain(`[tc0][v0]overlay=x=${overlayPosition(t).x}:y=${overlayPosition(t).y}:eval=init:eof_action=pass:format=auto`)
  })

  it("keeps a muted clip silent through its transition, and leaves other layers' clips as they were", () => {
    const plain = [{ id: "o", asset: "v", in: 0, out: 2, start: 1 }]
    const p = project([{ id: "a", asset: "v", in: 1, out: 4, start: 0, muted: true }, { id: "b", asset: "w", in: 2, out: 5, start: 3, transition: fade() }], plain)
    const g = graph(buildExportArgs(p, xFiles, "o"))
    expect(g).not.toContain("[0:a]")
    expect(g).toContain("[0:v]trim=1:4.5,")
    expect(g).toContain("[1:a]atrim=1.5:5,")
    expect(g).toContain("[2:v]trim=0:2,setpts=PTS-STARTPTS,")
    expect(g).toContain("[l1][v2]overlay=x=(W-w)/2+0*W:y=(H-h/1)/2+0*H+0*h/1:eval=init:enable='between(t,1,3)':eof_action=pass[v]")
  })

  it("builds the same graph as before once the transition is gone", () => {
    const clips: Clip[] = [{ id: "a", asset: "i", in: 0, out: 4, start: 0 }, { id: "b", asset: "j", in: 0, out: 4, start: 4 }]
    // No transition and no transform: the old concat graph, untouched.
    expect(graph(buildExportArgs(project(clips), xFiles, "o"))).toMatch(/concat=n=2:v=1:a=1\[v\]\[a\]$/)
  })
})

describe("buildExportArgs with audio overlaps (J- and L-cuts)", () => {
  const assets: Project["assets"] = {
    v: { file: "v.mp4", duration: 10, hasAudio: true },
    w: { file: "w.mp4", duration: 10, hasAudio: true },
    n: { file: "n.mp4", duration: 10, hasAudio: false },
  }
  const xFiles = { v: "/x/v.mp4", w: "/x/w.mp4", n: "/x/n.mp4" }
  const project = (clips: Clip[]): Project => ({ ...newProject("X"), assets, tracks: [{ id: "t1", clips }] })
  const a: Clip = { id: "a", asset: "v", in: 1, out: 4, start: 0 }
  const b: Clip = { id: "b", asset: "w", in: 2, out: 5, start: 3 }
  const sound = (i: number, rest: string) => `[${i}:a]${rest}`

  it("J-cut: the incoming sound starts early with a short linear fade; the pictures don't move", () => {
    const g = graph(buildExportArgs(project([a, { ...b, cutAudio: { mode: "j", duration: 1 } }]), xFiles, "o"))
    expect(g).toContain(sound(0, "atrim=1:4,asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo,adelay=delays=0S:all=1[a0]"))
    expect(g).toContain(sound(1, "atrim=1:5,asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo,afade=t=in:st=0:d=0.15:curve=tri,adelay=delays=96000S:all=1[a1]"))
    expect(g).toContain("[0:v]trim=1:4,setpts=PTS-STARTPTS,")
    expect(g).toContain("[1:v]trim=2:5,setpts=PTS-STARTPTS,")
    expect(g).not.toContain("xfade")
    expect(g).toContain("[asil][a0][a1]amix=inputs=3")
  })

  it("L-cut: the outgoing sound runs on past the cut and fades out at its new end", () => {
    const g = graph(buildExportArgs(project([a, { ...b, cutAudio: { mode: "l", duration: 1 } }]), xFiles, "o"))
    expect(g).toContain(sound(0, "atrim=1:5,asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo,afade=t=out:st=3.85:d=0.15:curve=tri,adelay=delays=0S:all=1[a0]"))
    expect(g).toContain(sound(1, "atrim=2:5,asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo,adelay=delays=144000S:all=1[a1]"))
    expect(g).toContain("[0:v]trim=1:4,setpts=PTS-STARTPTS,")
  })

  it("J with a transition: the pictures blend, the sound follows the J instead of the crossfade", () => {
    const g = graph(buildExportArgs(project([a, { ...b, transition: { type: "fade", duration: 2 }, cutAudio: { mode: "j", duration: 0.5 } }]), xFiles, "o"))
    expect(g).toContain("[0:v]trim=1:5,")
    expect(g).toContain("[1:v]trim=1:5,")
    expect(g).toContain("[ts0][ts1]xfade=transition=fade:duration=2:offset=2[tx1]")
    expect(g).toContain(sound(0, "atrim=1:4,asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo,adelay=delays=0S:all=1[a0]"))
    expect(g).toContain(sound(1, "atrim=1.5:5,asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo,afade=t=in:st=0:d=0.15:curve=tri,adelay=delays=120000S:all=1[a1]"))
    expect(g).not.toContain("qsin")
  })

  it("chains a J and an L on one clip's two cuts", () => {
    const c: Clip = { id: "c", asset: "v", in: 6, out: 8, start: 6, cutAudio: { mode: "l", duration: 0.5 } }
    const g = graph(buildExportArgs(project([a, { ...b, cutAudio: { mode: "j", duration: 1 } }, c]), xFiles, "o"))
    expect(g).toContain(
      sound(1, "atrim=1:5.5,asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo,afade=t=in:st=0:d=0.15:curve=tri,afade=t=out:st=4.35:d=0.15:curve=tri,adelay=delays=96000S:all=1[a1]")
    )
    expect(g).toContain(sound(2, "atrim=6:8,asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo,adelay=delays=288000S:all=1[a2]"))
    expect(g).toContain("amix=inputs=4")
  })

  it("a muted clip or one with no sound stays silent; its neighbour's overlap still plays", () => {
    const muted = graph(buildExportArgs(project([a, { ...b, muted: true, cutAudio: { mode: "j", duration: 1 } }]), xFiles, "o"))
    expect(muted).not.toContain("[1:a]")
    expect(muted).toContain(sound(0, "atrim=1:4,"))
    const silent = graph(buildExportArgs(project([{ ...a, asset: "n" }, { ...b, cutAudio: { mode: "j", duration: 1 } }]), { ...xFiles }, "o"))
    expect(silent).not.toContain("[0:a]")
    expect(silent).toContain(sound(1, "atrim=1:5,"))
  })

  it("never delays by a negative time or reads before the source's start", () => {
    // Forged: a 3 s J into a clip that starts at 0.5 s.
    const g = graph(buildExportArgs(project([{ ...a, in: 0, out: 0.5 }, { ...b, in: 5, out: 8, start: 0.5, cutAudio: { mode: "j", duration: 3 } }]), xFiles, "o"))
    expect(g).toContain(sound(1, "atrim=4.5:8,asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo,afade=t=in:st=0:d=0.15:curve=tri,adelay=delays=0S:all=1[a1]"))
    expect(g).not.toMatch(/delays=-/)
  })

  it("builds the old graph once the overlap is gone", () => {
    expect(graph(buildExportArgs(project([a, b]), xFiles, "o"))).toMatch(/concat=n=2:v=1:a=1\[v\]\[a\]$/)
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
        { id: "t1", clips: [{ id: "1", asset: "v", in: 0, out: 4, start: 0 }] },
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
        { id: "t1", clips: [{ id: "1", asset: "v", in: 0, out: 2, start: 0 }] },
        { id: "t2", clips: [{ id: "2", asset: "i", in: 0, out: 1, start: 3 }] },
      ],
    }
    const r = await exportProject(p, { v: blue, i: red }, "past.mp4")
    expect(Math.abs(r.duration - 4)).toBeLessThan(0.3)
    expect(Math.max(...(await centre(r.out, 2.5)))).toBeLessThan(40)
    expect((await centre(r.out, 3.5))[0]).toBeGreaterThan(150)
    expect(r.info).toMatch(/Stream #[^\n]*Audio:/)
  }, 60_000)

  it("makes a muted clip silent and keeps an unmuted overlay clip heard", async () => {
    const volume = async (file: string, from: number, to: number) => {
      const r = await ffmpeg(["-ss", String(from), "-to", String(to), "-i", file, "-map", "0:a", "-af", "volumedetect", "-f", "null", "-"])
      const m = /max_volume:\s*(-?[\d.]+|-inf) dB/.exec(r.stderr)
      return m ? (m[1] === "-inf" ? -Infinity : Number(m[1])) : NaN
    }
    const p: Project = {
      ...newProject("Muted"),
      assets: { v: { file: "v", duration: 2, hasAudio: true } },
      tracks: [
        { id: "t1", clips: [{ id: "1", asset: "v", in: 0, out: 1.5, start: 0, muted: true }] },
        { id: "t2", clips: [{ id: "2", asset: "v", in: 0, out: 1, start: 2 }] },
      ],
    }
    const r = await exportProject(p, { v: portrait }, "muted.mp4")
    expect(Math.abs(r.duration - 3)).toBeLessThan(0.3)
    expect(await volume(r.out, 0.2, 1.3)).toBeLessThan(-60)
    expect(await volume(r.out, 2.2, 2.8)).toBeGreaterThan(-30)
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

  it("crops a base clip's left and right, leaving black where the picture was cut", async () => {
    const { blue } = await blueAndRed()
    const p: Project = {
      ...newProject("SideCrop"),
      assets: { v: { file: "v", duration: 5, hasAudio: true } },
      // Full size with a quarter cut off the left and a quarter off the right: the strip is x 480-1440.
      tracks: base([{ id: "1", asset: "v", in: 0, out: 2, transform: { ...IDENTITY, cropLeft: 0.25, cropRight: 0.25 } }]),
    }
    const r = await exportProject(p, { v: blue }, "sidecrop.mp4")
    const at = async (x: number, y: number) => {
      const px = await ffmpeg(["-ss", "1", "-i", r.out, "-frames:v", "1", "-vf", `crop=2:2:${x}:${y},format=rgb24`, "-f", "rawvideo", "-"])
      return [px.stdout[0], px.stdout[1], px.stdout[2]]
    }
    for (const [x, y] of [[500, 540], [960, 100], [1420, 900]]) expect((await at(x, y))[2]).toBeGreaterThan(150)
    for (const [x, y] of [[100, 540], [460, 540], [1460, 540], [1800, 540]]) expect(Math.max(...(await at(x, y)))).toBeLessThan(40)
  }, 60_000)

  /** RGB of a 2x2 patch at canvas x, y one second into `file`. */
  async function pixel(file: string, x: number, y: number): Promise<number[]> {
    const px = await ffmpeg(["-ss", "1", "-i", file, "-frames:v", "1", "-vf", `crop=2:2:${x}:${y},format=rgb24`, "-f", "rawvideo", "-"])
    return [px.stdout[0], px.stdout[1], px.stdout[2]]
  }

  it("turns a clip 90 degrees: its visible shape swaps width and height, black around it", async () => {
    const { blue } = await blueAndRed()
    const p: Project = {
      ...newProject("Rotate"),
      assets: { v: { file: "v", duration: 5, hasAudio: true } },
      // Half size (960 x 540) turned a quarter: x 690-1230, y 60-1020.
      tracks: base([{ id: "1", asset: "v", in: 0, out: 2, transform: { ...IDENTITY, scale: 0.5, rotation: 90 } }]),
    }
    const r = await exportProject(p, { v: blue }, "rotate.mp4")
    expect(r.info).toMatch(/Video: h264[^\n]*1920x1080/)
    for (const [x, y] of [[960, 100], [960, 980], [720, 540], [1200, 540]]) expect((await pixel(r.out, x, y))[2]).toBeGreaterThan(150)
    for (const [x, y] of [[600, 540], [1320, 540], [500, 300], [960, 30]]) expect(Math.max(...(await pixel(r.out, x, y)))).toBeLessThan(40)
  }, 60_000)

  it("mirrors a flipped clip: its left and right colours swap", async () => {
    const split = path.join(dir, "split.mp4")
    await ffmpeg(["-f", "lavfi", "-i", "color=c=red:s=320x360:r=25:d=3", "-f", "lavfi", "-i", "color=c=blue:s=320x360:r=25:d=3", "-filter_complex", "[0:v][1:v]hstack", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-y", split])
    const p: Project = {
      ...newProject("Flip"),
      assets: { v: { file: "v", duration: 3, hasAudio: false } },
      tracks: base([{ id: "1", asset: "v", in: 0, out: 2, transform: { ...IDENTITY, flipH: true } }]),
    }
    const r = await exportProject(p, { v: split }, "flip.mp4")
    const left = await pixel(r.out, 300, 540)
    const right = await pixel(r.out, 1600, 540)
    expect(left[2]).toBeGreaterThan(150)
    expect(left[0]).toBeLessThan(100)
    expect(right[0]).toBeGreaterThan(150)
    expect(right[2]).toBeLessThan(100)
  }, 60_000)

  it("shows the lower layer through the transparent corners of a 45 degree clip", async () => {
    const { blue, red } = await blueAndRed()
    const p: Project = {
      ...newProject("Rotate45"),
      assets: { v: { file: "v", duration: 5, hasAudio: true }, r: { file: "r", duration: 5, hasAudio: false, kind: "image" } },
      tracks: [
        // A red still under the whole canvas, black beside it where it's letterboxed (4:3).
        { id: "t1", clips: [{ id: "1", asset: "r", in: 0, out: 2, start: 0 }] },
        { id: "t2", clips: [{ id: "2", asset: "v", in: 0, out: 2, start: 0, transform: { ...IDENTITY, scale: 0.5, rotation: 45 } }] },
      ],
    }
    const r = await exportProject(p, { v: blue, r: red }, "rotate45.mp4")
    expect((await pixel(r.out, 960, 540))[2]).toBeGreaterThan(150)
    // Inside the turned frame's bounding box but outside the picture: the red layer below.
    for (const [x, y] of [[500, 80], [1420, 80], [500, 1000], [1420, 1000]]) {
      const c = await pixel(r.out, x, y)
      expect(c[0]).toBeGreaterThan(150)
      expect(c[2]).toBeLessThan(100)
    }
  }, 60_000)

  it("leaves black and silence in a gap between two base clips, with the full length", async () => {
    const { blue } = await blueAndRed()
    const p: Project = {
      ...newProject("Gap"),
      assets: { v: { file: "v", duration: 5, hasAudio: true } },
      tracks: [{ id: "t1", clips: [{ id: "1", asset: "v", in: 0, out: 1, start: 0 }, { id: "2", asset: "v", in: 1, out: 2, start: 2.5 }] }],
    }
    const r = await exportProject(p, { v: blue }, "gap.mp4")
    expect(Math.abs(r.duration - 3.5)).toBeLessThan(0.3)
    expect((await centre(r.out, 0.5))[2]).toBeGreaterThan(150)
    expect(Math.max(...(await centre(r.out, 1.75)))).toBeLessThan(40)
    expect((await centre(r.out, 3))[2]).toBeGreaterThan(150)
    // The sine is heard in the clips and not in the gap.
    const level = async (from: number, length: number) => {
      const stats = (await ffmpeg(["-ss", String(from), "-t", String(length), "-i", r.out, "-map", "0:a", "-af", "volumedetect", "-f", "null", "-"])).stderr
      const m = /max_volume:\s*(-inf|-?[\d.]+) dB/.exec(stats)
      return m ? (m[1] === "-inf" ? -Infinity : Number(m[1])) : NaN
    }
    expect(await level(1.3, 0.9)).toBeLessThan(-60)
    expect(await level(0.2, 0.6)).toBeGreaterThan(-40)
    expect(await level(2.7, 0.6)).toBeGreaterThan(-40)
  }, 60_000)

  /** The brightest luma in canvas rect x, y, w, h one second into `file`. */
  async function brightest(file: string, x: number, y: number, w: number, h: number): Promise<number> {
    const px = await ffmpeg(["-ss", "1", "-i", file, "-frames:v", "1", "-vf", `crop=${w}:${h}:${x}:${y},format=gray`, "-f", "rawvideo", "-"])
    return px.stdout.reduce((m, v) => Math.max(m, v), 0)
  }

  /** A blue base video 0-2 s and a white text clip over it, its PNG drawn by rasteriseText. */
  async function textExport(text: ClipText, transform: Transform, name: string) {
    const { blue } = await blueAndRed()
    const p: Project = {
      ...newProject("Text"),
      assets: { v: { file: "v", duration: 5, hasAudio: true } },
      tracks: [
        { id: "t1", clips: [{ id: "1", asset: "v", in: 0, out: 2, start: 0 }] },
        { id: "t2", clips: [{ id: "x", asset: "", in: 0, out: 2, start: 0, text, transform }] },
      ],
    }
    const png = path.join(dir, `${name}.png`)
    await rasteriseText(text, textRaster(p, { ...p.tracks[1].clips[0], text }).fontPx, png, dir)
    return exportProject(p, { v: blue, "text:x": png }, `${name}.mp4`)
  }

  it("draws horizontal text where the preview has it: inside its box, the lower layer through its padding", async () => {
    const t: Transform = { ...IDENTITY, x: -0.25, scale: 2 }
    const r = await textExport({ content: "HI", color: "#ffffff", orientation: "horizontal" }, t, "text-h")
    // The box at scale 2: 1.7 x 216 = 367 wide, 1.8 x 216 = 389 tall, centred at 480, 540.
    const v = clipRect({ w: 1.7 * 108, h: 1.8 * 108 }, 1920, 1080, t).visible
    expect(await brightest(r.out, Math.round(v.x + 60), Math.round(v.y + 60), Math.round(v.w - 120), Math.round(v.h - 120))).toBeGreaterThan(200)
    // The top padding (a quarter font size, 54 px) shows the blue base; so does the rest of the canvas.
    expect(await brightest(r.out, Math.round(v.x), Math.round(v.y + 4), Math.round(v.w), 40)).toBeLessThan(100)
    expect(await brightest(r.out, 1100, 100, 700, 800)).toBeLessThan(100)
  }, 60_000)

  it("draws a proportional font (Pacifico) in its own box, centred where the preview puts it", async () => {
    const text: ClipText = { content: "Boo!", color: "#ffffff", orientation: "horizontal", font: "pacifico" }
    const t: Transform = { ...IDENTITY, x: 0.2, y: -0.1, scale: 2 }
    const r = await textExport(text, t, "text-p")
    const v = clipRect(textSize(text, 1080), 1920, 1080, t).visible
    // The white ink's bounds in the frame one second in.
    const px = await ffmpeg(["-ss", "1", "-i", r.out, "-frames:v", "1", "-vf", "format=gray", "-f", "rawvideo", "-"])
    let left = Infinity, right = -Infinity, top = Infinity, bottom = -Infinity
    for (let i = 0; i < px.stdout.length; i++) {
      if (px.stdout[i] < 200) continue
      const x = i % 1920
      const y = Math.floor(i / 1920)
      left = Math.min(left, x)
      right = Math.max(right, x + 1)
      top = Math.min(top, y)
      bottom = Math.max(bottom, y + 1)
    }
    // Inside the box, inside its padding (half a font size at scale 2 is 54 px, so ink stays a few px in), centred across it.
    expect(left).toBeGreaterThan(v.x)
    expect(right).toBeLessThan(v.x + v.w)
    expect(top).toBeGreaterThan(v.y)
    expect(bottom).toBeLessThan(v.y + v.h)
    expect(Math.abs((left + right) / 2 - (v.x + v.w / 2))).toBeLessThan(6)
    // A script font's box is not Mono's: four Pacifico letters are narrower than four Mono ones.
    expect(v.w).toBeLessThan(clipRect(textSize({ ...text, font: undefined }, 1080), 1920, 1080, t).visible.w)
  }, 60_000)

  it("draws vertical text turned 90 degrees across the canvas", async () => {
    const t: Transform = { ...IDENTITY, scale: 2, rotation: 90 }
    const r = await textExport({ content: "HI", color: "#ffffff", orientation: "vertical" }, t, "text-v")
    // Stacked, the box is 1.1 x 216 = 238 wide and 3.1 x 216 = 670 tall; turned, it lies across the centre.
    expect(await brightest(r.out, 680, 480, 560, 120)).toBeGreaterThan(200)
    // Above and below that band (where it would be unturned) is the blue base.
    expect(await brightest(r.out, 900, 120, 120, 280)).toBeLessThan(100)
    expect(await brightest(r.out, 900, 700, 120, 280)).toBeLessThan(100)
  }, 60_000)

  /** Frame `n` of `file` (30 fps: n / 30 seconds in): the brightest luma and the bounds of the pixels at least `threshold` (the white text's ink over the blue base). */
  async function ink(file: string, n: number, threshold = 150) {
    const px = await ffmpeg(["-i", file, "-vf", `select='eq(n,${n})',format=gray`, "-frames:v", "1", "-f", "rawvideo", "-"])
    let left = Infinity, right = -Infinity, top = Infinity, bottom = -Infinity, max = 0
    for (let i = 0; i < px.stdout.length; i++) {
      max = Math.max(max, px.stdout[i])
      if (px.stdout[i] < threshold) continue
      const x = i % 1920
      const y = Math.floor(i / 1920)
      left = Math.min(left, x)
      right = Math.max(right, x + 1)
      top = Math.min(top, y)
      bottom = Math.max(bottom, y + 1)
    }
    return { left, right, top, bottom, max, cx: (left + right) / 2, w: right - left }
  }

  describe("text animations", () => {
    const hi = (over: Partial<ClipText>): ClipText => ({ content: "HHHH", color: "#ffffff", orientation: "horizontal", ...over })
    const t2: Transform = { ...IDENTITY, scale: 2 }
    // The blue base's luma, and white's (full range, as format=gray reads them).
    const BLUE = 29, WHITE = 255

    it("fades in: the text's ink brightens over the in time as the preview's opacity says", async () => {
      const text = hi({ animIn: { type: "fade", duration: 1 } })
      const r = await textExport(text, t2, "anim-fade")
      const v = clipRect(textSize(text, 1080), 1920, 1080, t2).visible
      // How much the box is brighter than the blue base, summed (the encoder's ringing averages out).
      const lift = async (n: number) => {
        const px = await ffmpeg(["-i", r.out, "-vf", `select='eq(n,${n})',crop=${Math.round(v.w)}:${Math.round(v.h)}:${Math.round(v.x)}:${Math.round(v.y)},format=gray`, "-frames:v", "1", "-f", "rawvideo", "-"])
        return px.stdout.reduce((sum, y) => sum + Math.max(0, y - BLUE), 0)
      }
      const [a0, a5, a15, a45] = [await lift(0), await lift(5), await lift(15), await lift(45)]
      expect(a0).toBeLessThan(a5)
      expect(a5).toBeLessThan(a15)
      expect(a0 / a45).toBeLessThan(0.02)
      for (const [n, a] of [[5, a5], [15, a15]]) expect(Math.abs(a / a45 - animationState(text, n / 30, 2).opacity)).toBeLessThan(0.04)
    }, 60_000)
    it("slides in from beyond the left edge, where the preview has it halfway, at rest after", async () => {
      const text = hi({ animIn: { type: "slide-left", duration: 1 } })
      const r = await textExport(text, t2, "anim-slide")
      expect((await ink(r.out, 0)).max).toBeLessThan(100)
      const rest = await ink(r.out, 45)
      const v = clipRect(textSize(text, 1080), 1920, 1080, t2).visible
      expect(Math.abs(rest.cx - (v.x + v.w / 2))).toBeLessThan(6)
      const s = animationState(text, 0.5, 2, { bounds: { x: v.x / 1920, y: v.y / 1080, w: v.w / 1920, h: v.h / 1080 }, units: 4 })
      expect(Math.abs((await ink(r.out, 15)).cx - (rest.cx + s.offsetX * 1920))).toBeLessThan(4)
    }, 60_000)

    it("sweeps in from the left inside its box: partly shown at the midpoint", async () => {
      const text = hi({ animIn: { type: "sweep-left", duration: 1 } })
      const r = await textExport(text, t2, "anim-sweep")
      const v = clipRect(textSize(text, 1080), 1920, 1080, t2).visible
      const f = animationState(text, 0.2, 2).reveal!.fraction
      const mid = await ink(r.out, 6)
      const full = await ink(r.out, 45)
      expect(mid.max).toBeGreaterThan(200)
      expect(mid.left).toBe(full.left)
      expect(mid.right).toBeLessThanOrEqual(Math.ceil(v.x + f * v.w) + 1)
      expect(full.right - mid.right).toBeGreaterThan(100)
    }, 60_000)

    it("pops and explodes about the centre at the size the preview gives", async () => {
      for (const type of ["pop", "explode"] as const) {
        const text = hi({ animIn: { type, duration: 1 } })
        const r = await textExport(text, t2, `anim-${type}`)
        const s = animationState(text, 0.5, 2)
        const mid = await ink(r.out, 15, 120)
        const rest = await ink(r.out, 45, 120)
        expect(Math.abs(mid.w / rest.w - s.scale)).toBeLessThan(0.03)
        expect(Math.abs(mid.cx - rest.cx)).toBeLessThan(4)
      }
    }, 60_000)

    it("plays in and out on one clip: shown in the middle, gone at the end", async () => {
      const text = hi({ animIn: { type: "sweep-left", duration: 0.5 }, animOut: { type: "fade", duration: 0.5 } })
      const r = await textExport(text, t2, "anim-both")
      expect((await ink(r.out, 30)).max).toBeGreaterThan(225)
      // The last frame (59, 1.967 s): the fade has 0.033 s to go.
      const o = animationState(text, 59 / 30, 2).opacity
      const last = (await ink(r.out, 59)).max
      expect(last).toBeLessThan(100)
      expect(Math.abs(last - (o * WHITE + (1 - o) * BLUE))).toBeLessThan(15)
    }, 60_000)
  })

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

// Transitions with real ffmpeg: only .data/ffmpeg.exe is needed (the clips are generated).
const hasFfmpeg = fs.existsSync(FFMPEG)
;(hasFfmpeg ? describe : describe.skip)(hasFfmpeg ? "transitions with real ffmpeg" : "transitions with real ffmpeg (SKIPPED: .data/ffmpeg.exe not found)", () => {
  const dir = path.join(os.tmpdir(), `ps-xfade-${process.pid}-${Date.now()}`)
  const red = path.join(dir, "red.mp4")
  const blue = path.join(dir, "blue.mp4")

  beforeAll(async () => {
    process.env.FFMPEG_PATH = FFMPEG
    fs.mkdirSync(dir, { recursive: true })
    for (const [file, colour, hz] of [[red, "red", 440], [blue, "blue", 660]] as const) {
      await ffmpeg(["-f", "lavfi", "-i", `color=c=${colour}:s=320x180:r=30:d=6`, "-f", "lavfi", "-i", `sine=frequency=${hz}:duration=6`, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-y", file])
    }
  }, 60_000)
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

  // Red from source 1 to 4 at 0-3 s, blue from 1 to 4 at 3-6 s: a 1 s transition runs from 2.5 to 3.5 s.
  async function render(type: "fade" | "wipeleft" | "slideleft") {
    const p: Project = {
      ...newProject("X"),
      assets: { r: { file: "r", duration: 6, hasAudio: true }, b: { file: "b", duration: 6, hasAudio: true } },
      tracks: [{ id: "t1", clips: [{ id: "1", asset: "r", in: 1, out: 4, start: 0 }, { id: "2", asset: "b", in: 1, out: 4, start: 3, transition: { type, duration: 1 } }] }],
    }
    const out = path.join(dir, `${type}.mp4`)
    const script = path.join(dir, `${type}.graph.txt`)
    const files = { r: red, b: blue }
    fs.writeFileSync(script, buildExportGraph(p, files).graph)
    await runExport(buildExportArgs(p, files, out, script), out, totalLength(p), () => {})
    return out
  }
  /** RGB at x, y (1920x1080) of the frame at `t` seconds. */
  async function pixel(file: string, t: number, x = 960, y = 540): Promise<number[]> {
    const px = await ffmpeg(["-ss", String(t), "-i", file, "-frames:v", "1", "-vf", `crop=2:2:${x}:${y},format=rgb24`, "-f", "rawvideo", "-"])
    return [px.stdout[0], px.stdout[1], px.stdout[2]]
  }
  const isRed = ([r, , b]: number[]) => r > 200 && b < 60
  const isBlue = ([r, , b]: number[]) => b > 200 && r < 60

  it("crossfades: red before, a mix in the middle, blue after, the same length, sound across the cut", async () => {
    const out = await render("fade")
    expect(isRed(await pixel(out, 2))).toBe(true)
    const mid = await pixel(out, 3)
    expect(mid[0]).toBeGreaterThan(70)
    expect(mid[0]).toBeLessThan(190)
    expect(mid[2]).toBeGreaterThan(70)
    expect(mid[2]).toBeLessThan(190)
    expect(isBlue(await pixel(out, 4))).toBe(true)
    expect(Math.abs((await probeMedia(out)).duration - 6)).toBeLessThan(0.15)
    // Sound at the cut: the loudest sample from 2.9 to 3.1 s is well above silence.
    const pcm = (await ffmpeg(["-ss", "2.9", "-t", "0.2", "-i", out, "-map", "0:a", "-ac", "1", "-f", "s16le", "-"])).stdout
    let peak = 0
    for (let k = 0; k + 1 < pcm.length; k += 2) peak = Math.max(peak, Math.abs(pcm.readInt16LE(k)))
    expect(peak).toBeGreaterThan(3000)
  }, 60_000)

  it("wipes left: half and half at the middle, blue coming in on the right", async () => {
    const out = await render("wipeleft")
    expect(isRed(await pixel(out, 2, 1440))).toBe(true)
    expect(isRed(await pixel(out, 3, 480))).toBe(true)
    expect(isBlue(await pixel(out, 3, 1440))).toBe(true)
    expect(isBlue(await pixel(out, 4, 480))).toBe(true)
  }, 60_000)

  it("chains three clips (a turned, muted video, an image, a video) over a lower layer and keeps the length", async () => {
    const image = path.join(dir, "green.png")
    await sharp({ create: { width: 400, height: 300, channels: 3, background: "#0c0" } }).png().toFile(image)
    const p: Project = {
      ...newProject("Chain"),
      assets: { r: { file: "r", duration: 6, hasAudio: true }, b: { file: "b", duration: 6, hasAudio: true }, g: { file: "g", duration: 5, hasAudio: false, kind: "image" } },
      tracks: [
        { id: "t1", clips: [{ id: "base", asset: "b", in: 0, out: 6, start: 0 }] },
        {
          id: "t2",
          clips: [
            { id: "1", asset: "r", in: 1, out: 3, start: 0, muted: true, transform: { ...IDENTITY, scale: 0.5, rotation: 30 } },
            { id: "2", asset: "g", in: 0, out: 2, start: 2, transition: { type: "circleopen", duration: 1 } },
            { id: "3", asset: "r", in: 2, out: 4, start: 4, transition: { type: "dissolve", duration: 1 } },
          ],
        },
      ],
    }
    const out = path.join(dir, "chain.mp4")
    const files = { r: red, b: blue, g: image }
    await runExport(buildExportArgs(p, files, out), out, totalLength(p), () => {})
    expect(Math.abs((await probeMedia(out)).duration - 6)).toBeLessThan(0.15)
    // Mid-image the picture is the green still, and the turned red clip's corner shows the blue base around it before.
    const g = await pixel(out, 3)
    expect(g[1]).toBeGreaterThan(150)
    expect(isBlue(await pixel(out, 0.5, 40, 40))).toBe(true)
  }, 60_000)

  /** Red's 440 Hz and blue's 660 Hz tone amplitude (Goertzel; ffmpeg's sine source is 1/8 of full scale) in the export's sound from `from` to `to` s. */
  async function tones(file: string, from: number, to: number): Promise<{ red: number; blue: number }> {
    const pcm = (await ffmpeg(["-ss", String(from), "-t", String(to - from), "-i", file, "-map", "0:a", "-ac", "1", "-ar", "48000", "-f", "s16le", "-"])).stdout
    const n = Math.floor(pcm.length / 2)
    const power = (hz: number) => {
      const w = (2 * Math.PI * hz) / 48000
      let s1 = 0
      let s2 = 0
      for (let k = 0; k < n; k++) {
        const s0 = pcm.readInt16LE(2 * k) / 32768 + 2 * Math.cos(w) * s1 - s2
        s2 = s1
        s1 = s0
      }
      return Math.sqrt(s1 * s1 + s2 * s2 - 2 * Math.cos(w) * s1 * s2) / (n / 2)
    }
    return { red: power(440), blue: power(660) }
  }
  async function renderOverlap(name: string, cutAudio?: Clip["cutAudio"]) {
    const p: Project = {
      ...newProject("X"),
      assets: { r: { file: "r", duration: 6, hasAudio: true }, b: { file: "b", duration: 6, hasAudio: true } },
      tracks: [{ id: "t1", clips: [{ id: "1", asset: "r", in: 1, out: 4, start: 0 }, { id: "2", asset: "b", in: 2, out: 5, start: 3, ...(cutAudio ? { cutAudio } : {}) }] }],
    }
    const out = path.join(dir, `${name}.mp4`)
    await runExport(buildExportArgs(p, { r: red, b: blue }, out), out, totalLength(p), () => {})
    return out
  }

  it("J-cut: blue's tone is heard before the cut over red's picture; the picture cut and the length stay", async () => {
    const plain = await tones(await renderOverlap("plain"), 2.3, 2.9)
    const out = await renderOverlap("jcut", { mode: "j", duration: 1 })
    const before = await tones(out, 2.3, 2.9)
    expect(plain.blue).toBeLessThan(0.02)
    expect(before.blue).toBeGreaterThan(0.05)
    // Red's own sound plays on under it, mixed (no ducking).
    expect(before.red).toBeGreaterThan(0.05)
    // After the cut only blue's.
    const after = await tones(out, 3.2, 3.8)
    expect(after.red).toBeLessThan(0.02)
    expect(isRed(await pixel(out, 2.8))).toBe(true)
    expect(isBlue(await pixel(out, 3.2))).toBe(true)
    expect(Math.abs((await probeMedia(out)).duration - 6)).toBeLessThan(0.15)
  }, 60_000)

  it("L-cut: red's tone carries on after the cut over blue's picture", async () => {
    const plain = await tones(await renderOverlap("plain-l"), 3.2, 3.8)
    const out = await renderOverlap("lcut", { mode: "l", duration: 1 })
    const after = await tones(out, 3.2, 3.8)
    expect(plain.red).toBeLessThan(0.02)
    expect(after.red).toBeGreaterThan(0.05)
    expect(after.blue).toBeGreaterThan(0.05)
    // Past the L, red is gone.
    expect((await tones(out, 4.3, 4.9)).red).toBeLessThan(0.02)
    expect(isRed(await pixel(out, 2.8))).toBe(true)
    expect(isBlue(await pixel(out, 3.2))).toBe(true)
    expect(Math.abs((await probeMedia(out)).duration - 6)).toBeLessThan(0.15)
  }, 60_000)

  it("slides left: red pushed out on the left, blue in on the right", async () => {
    const out = await render("slideleft")
    expect(isRed(await pixel(out, 2.4, 1800))).toBe(true)
    expect(isRed(await pixel(out, 3, 480))).toBe(true)
    expect(isBlue(await pixel(out, 3, 1440))).toBe(true)
    expect(isBlue(await pixel(out, 3.6, 100))).toBe(true)
  }, 60_000)
})