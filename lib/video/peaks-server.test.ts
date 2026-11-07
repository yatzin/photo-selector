import { spawnSync } from "child_process"
import fsSync from "fs"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { afterAll, beforeEach, describe, expect, it } from "vitest"
import { newProject, type Project } from "./project"
import { decodePeaks, PEAKS_RATE } from "./peaks"
import { assetPeaks } from "./peaks-server"
import { createProject, writeProject } from "./projects-server"

const tmp = path.join(os.tmpdir(), `ps-peaks-${process.pid}-${Date.now()}`)
process.env.PHOTOS_VIDEO_PROJECTS_DIR = path.join(tmp, "projects")
process.env.PHOTOS_VIDEO_INBOX_DIR = path.join(tmp, "inbox")
process.env.PHOTOS_CACHE_DIR = path.join(tmp, "cache")
const assets = path.join(tmp, "projects", "mike", "P", "assets")

// The project's own ffmpeg when it's there, else one on the PATH; the real decode tests skip (and say so) without either.
const LOCAL = path.resolve(".data/ffmpeg.exe")
const FFMPEG = fsSync.existsSync(LOCAL) ? LOCAL : spawnSync("ffmpeg", ["-version"], { windowsHide: true }).status === 0 ? "ffmpeg" : null
if (!FFMPEG) console.warn(`Real ffmpeg peaks tests skipped: no ${LOCAL} and no ffmpeg on the PATH`)

afterAll(() => fs.rm(tmp, { recursive: true, force: true }))

beforeEach(async () => {
  process.env.FFMPEG_PATH = FFMPEG ?? "ffmpeg"
  await fs.rm(tmp, { recursive: true, force: true })
  await createProject("mike", "P")
})

async function project(assetsOf: Project["assets"]) {
  await writeProject("mike", "P", { ...newProject("P"), assets: assetsOf })
}

describe("assetPeaks: what resolves", () => {
  it("is null for a missing project, an unknown asset, an image, a silent video and a file that's gone", async () => {
    await fs.writeFile(path.join(assets, "still.jpg"), "x")
    await fs.writeFile(path.join(assets, "quiet.mp4"), "x")
    await project({
      img: { file: "still.jpg", duration: 5, hasAudio: false, kind: "image" },
      quiet: { file: "quiet.mp4", duration: 2, hasAudio: false },
      gone: { file: "gone.mp4", duration: 2, hasAudio: true },
    })
    expect(await assetPeaks("mike", "Nope", "img")).toBeNull()
    expect(await assetPeaks("mike", "P", "nope")).toBeNull()
    expect(await assetPeaks("mike", "P", "__proto__")).toBeNull()
    expect(await assetPeaks("mike", "P", "img")).toBeNull()
    expect(await assetPeaks("mike", "P", "quiet")).toBeNull()
    expect(await assetPeaks("mike", "P", "gone")).toBeNull()
    expect(await assetPeaks("..", "P", "gone")).toBeNull()
  })

  it("serves a cache file already there without running ffmpeg", async () => {
    await fs.writeFile(path.join(assets, "v.mp4"), "x")
    await fs.writeFile(path.join(assets, ".v.mp4.peaks"), Uint8Array.from([1, 100, 0, 7, 8]))
    await project({ v: { file: "v.mp4", duration: 1, hasAudio: true } })
    process.env.FFMPEG_PATH = path.join(tmp, "no-such-ffmpeg")
    expect(Array.from((await assetPeaks("mike", "P", "v"))!)).toEqual([1, 100, 0, 7, 8])
  })

  it("throws when ffmpeg can't run, and leaves no cache file", async () => {
    await fs.writeFile(path.join(assets, "v.mp4"), "x")
    await project({ v: { file: "v.mp4", duration: 1, hasAudio: true } })
    process.env.FFMPEG_PATH = path.join(tmp, "no-such-ffmpeg")
    await expect(assetPeaks("mike", "P", "v")).rejects.toThrow()
    expect(await fs.readdir(assets)).toEqual(["v.mp4"])
  })
})

;(FFMPEG ? describe : describe.skip)(FFMPEG ? "assetPeaks with real ffmpeg" : "assetPeaks with real ffmpeg (SKIPPED: no ffmpeg found)", () => {
  /** A 2 s file: a loud 440 Hz tone for the first second, silence for the second. */
  async function tone() {
    const file = path.join(assets, "tone.wav")
    const r = spawnSync(FFMPEG!, ["-hide_banner", "-v", "error", "-f", "lavfi", "-i", "aevalsrc=if(lt(t\\,1)\\,0.8*sin(2*PI*440*t)\\,0):s=44100:d=2", "-y", file], { windowsHide: true })
    if (r.status !== 0) throw new Error(String(r.stderr))
    await project({ t: { file: "tone.wav", duration: 2, hasAudio: true } })
  }

  it("gives 100 peaks a second, loud where the tone is and near zero where it's silent, and caches them", async () => {
    await tone()
    const bytes = await assetPeaks("mike", "P", "t")
    const decoded = decodePeaks(bytes!)
    expect(decoded?.rate).toBe(PEAKS_RATE)
    const peaks = decoded!.peaks
    expect(Math.abs(peaks.length - 200)).toBeLessThanOrEqual(2)
    const mean = (a: Uint8Array) => a.reduce((s, v) => s + v, 0) / a.length
    const loud = mean(peaks.subarray(10, 90))
    const quiet = mean(peaks.subarray(110, 190))
    expect(loud).toBeGreaterThan(150)
    expect(quiet).toBeLessThan(5)
    expect(await fs.readFile(path.join(assets, ".tone.wav.peaks"))).toEqual(Buffer.from(bytes!))
    // The cache serves the next request, even with ffmpeg gone.
    process.env.FFMPEG_PATH = path.join(tmp, "no-such-ffmpeg")
    expect(await assetPeaks("mike", "P", "t")).toEqual(bytes)
  }, 60_000)

  it("decodes once for requests that arrive together", async () => {
    await tone()
    const all = await Promise.all([1, 2, 3, 4].map(() => assetPeaks("mike", "P", "t")))
    for (const b of all) expect(b).toBe(all[0])
    expect((await fs.readdir(assets)).sort()).toEqual([".tone.wav.peaks", "tone.wav"])
  }, 60_000)
})
