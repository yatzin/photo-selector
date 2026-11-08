import { spawnSync } from "child_process"
import fsSync from "fs"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { afterAll, beforeEach, describe, expect, it } from "vitest"
import { newProject, type Project } from "./project"
import { MAX_QUEUE, MAX_RENDERS, previewArgs, previewFile, previewRoot, prunePreviews, renderAudioPreview, type PreviewRunner } from "./audio-preview-server"
import { createProject, writeProject } from "./projects-server"

const tmp = path.join(os.tmpdir(), `ps-apreview-${process.pid}-${Date.now()}`)
process.env.PHOTOS_VIDEO_PROJECTS_DIR = path.join(tmp, "projects")
process.env.PHOTOS_VIDEO_INBOX_DIR = path.join(tmp, "inbox")
process.env.PHOTOS_CACHE_DIR = path.join(tmp, "cache")
const assets = path.join(tmp, "projects", "mike", "P", "assets")

// The project's own ffmpeg when it's there, else one on the PATH; the real render test skips (and says so) without either.
const LOCAL = path.resolve(".data/ffmpeg.exe")
const FFMPEG = fsSync.existsSync(LOCAL) ? LOCAL : spawnSync("ffmpeg", ["-version"], { windowsHide: true }).status === 0 ? "ffmpeg" : null
if (!FFMPEG) console.warn(`Real ffmpeg audio preview test skipped: no ${LOCAL} and no ffmpeg on the PATH`)

afterAll(() => fs.rm(tmp, { recursive: true, force: true }))

beforeEach(async () => {
  process.env.FFMPEG_PATH = FFMPEG ?? "ffmpeg"
  await fs.rm(tmp, { recursive: true, force: true })
  await createProject("mike", "P")
})

async function project(assetsOf: Project["assets"]) {
  await writeProject("mike", "P", { ...newProject("P"), assets: assetsOf })
}

const never = new AbortController().signal
const chipmunk = { fx: [{ type: "chipmunk" as const }] }

/** A runner that waits to be released (then writes the file) and rejects when its signal aborts. */
function gated() {
  const calls: { args: string[]; out: string; signal: AbortSignal; release: () => void; fail: () => void }[] = []
  const runner: PreviewRunner = (args, out, _seconds, signal) =>
    new Promise((resolve, reject) => {
      calls.push({ args, out, signal, release: () => void fs.writeFile(out, "m4a").then(() => resolve()), fail: () => reject(new Error("C:\\secret\\path: boom")) })
      signal.addEventListener("abort", () => reject(new Error("Cancelled.")), { once: true })
    })
  return { runner, calls }
}

async function until(check: () => boolean) {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 5))
  expect(check()).toBe(true)
}

/** Assets a, b, c, ... (40 s with sound) for distinct renders. */
async function many(n: number) {
  const list: Project["assets"] = {}
  for (let i = 0; i < n; i++) {
    const id = String.fromCharCode(97 + i)
    await fs.writeFile(path.join(assets, `${id}.wav`), "x")
    list[id] = { file: `${id}.wav`, duration: 40, hasAudio: true }
  }
  await project(list)
}

const req = (assetId: string, from = 1, to = 30) => ({ assetId, in: from, out: to, audio: chipmunk })

describe("previewFile and previewArgs", () => {
  it("names only a 32-hex file in a plain user and project folder", () => {
    expect(previewFile("mike", "P", "a".repeat(32))).toBe(path.join(previewRoot(), "mike", "P", `${"a".repeat(32)}.m4a`))
    expect(previewFile("mike", "P", "../x")).toBeNull()
    expect(previewFile("mike", "P", "A".repeat(32))).toBeNull()
    expect(previewFile("..", "P", "a".repeat(32))).toBeNull()
    expect(previewFile("mike", "a/b", "a".repeat(32))).toBeNull()
  })

  it("seeks to the window and runs the export's chain over its length, no shell, AAC out", () => {
    const args = previewArgs("in.wav", { in: 1.5, out: 13.5 }, chipmunk, "out.tmp")
    expect(args.slice(args.indexOf("-ss"), args.indexOf("-ss") + 2)).toEqual(["-ss", "1.5"])
    const af = args[args.indexOf("-af") + 1]
    expect(af).toMatch(/^atrim=0:12,asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo,asetrate=\d+,aresample=48000,atempo=[\d.]+,atrim=end=12$/)
    expect(args.at(-1)).toBe("out.tmp")
    expect(args).toContain("aac")
  })
})

describe("renderAudioPreview: what resolves", () => {
  it("is not-found for a missing project, an unknown asset, an image, a silent file, a file that's gone and a start past the end", async () => {
    await fs.writeFile(path.join(assets, "still.jpg"), "x")
    await fs.writeFile(path.join(assets, "quiet.mp4"), "x")
    await fs.writeFile(path.join(assets, "s.wav"), "x")
    await project({
      img: { file: "still.jpg", duration: 5, hasAudio: false, kind: "image" },
      quiet: { file: "quiet.mp4", duration: 2, hasAudio: false },
      gone: { file: "gone.wav", duration: 2, hasAudio: true },
      s: { file: "s.wav", duration: 2, hasAudio: true },
    })
    const { runner, calls } = gated()
    const tries: [string, string, string, number?][] = [["mike", "Nope", "s"], ["mike", "P", "nope"], ["mike", "P", "__proto__"], ["mike", "P", "img"], ["mike", "P", "quiet"], ["mike", "P", "gone"], ["..", "P", "s"], ["mike", "P", "../s"], ["mike", "P", "s", 3]]
    for (const [user, folder, asset, from] of tries) {
      await expect(renderAudioPreview(user, folder, req(asset, from ?? 0, 5), never, { runner })).rejects.toMatchObject({ code: "not-found" })
    }
    expect(calls).toHaveLength(0)
  })

  it("renders the first 12 s of the window (or to the file's end), then serves the cache without running again", async () => {
    await many(1)
    const { runner, calls } = gated()
    const first = renderAudioPreview("mike", "P", req("a"), never, { runner })
    await until(() => calls.length === 1)
    calls[0].release()
    const r = await first
    expect(r).toMatchObject({ durationSec: 12, cached: false })
    expect(fsSync.existsSync(previewFile("mike", "P", r.id)!)).toBe(true)
    expect(await renderAudioPreview("mike", "P", req("a"), never, { runner })).toEqual({ ...r, cached: true })
    expect(calls).toHaveLength(1)
    // Short of the cap at the file's end (40 s).
    const end = renderAudioPreview("mike", "P", req("a", 35, 50), never, { runner })
    await until(() => calls.length === 2)
    calls[1].release()
    expect((await end).durationSec).toBe(5)
  })

  it("shares one render between identical requests", async () => {
    await many(1)
    const { runner, calls } = gated()
    const both = [renderAudioPreview("mike", "P", req("a"), never, { runner }), renderAudioPreview("mike", "P", req("a"), never, { runner })]
    await until(() => calls.length === 1)
    await new Promise((r) => setTimeout(r, 30))
    expect(calls).toHaveLength(1)
    calls[0].release()
    const [x, y] = await Promise.all(both)
    expect(x.id).toBe(y.id)
  })

  it(`runs at most ${MAX_RENDERS} at once, queues ${MAX_QUEUE} more and refuses the next as busy`, async () => {
    await many(MAX_RENDERS + MAX_QUEUE + 1)
    const { runner, calls } = gated()
    const ids = "abcdefghijklmnop".slice(0, MAX_RENDERS + MAX_QUEUE).split("")
    const jobs = ids.map((id) => renderAudioPreview("mike", "P", req(id), never, { runner }))
    await until(() => calls.length === MAX_RENDERS)
    await new Promise((r) => setTimeout(r, 30))
    expect(calls).toHaveLength(MAX_RENDERS)
    const extra = String.fromCharCode(97 + MAX_RENDERS + MAX_QUEUE)
    await expect(renderAudioPreview("mike", "P", req(extra), never, { runner })).rejects.toMatchObject({ code: "busy" })
    // Each finished render lets the next one in.
    for (let i = 0; i < ids.length; i++) {
      await until(() => calls.length > i)
      calls[i].release()
    }
    await Promise.all(jobs)
    expect(calls).toHaveLength(ids.length)
  })

  it("kills the render when its only request is aborted, but not while another identical one still waits", async () => {
    await many(1)
    const { runner, calls } = gated()
    const a = new AbortController()
    const b = new AbortController()
    const first = renderAudioPreview("mike", "P", req("a"), a.signal, { runner })
    const second = renderAudioPreview("mike", "P", req("a"), b.signal, { runner })
    await until(() => calls.length === 1)
    a.abort()
    await expect(first).rejects.toMatchObject({ code: "cancelled" })
    expect(calls[0].signal.aborted).toBe(false)
    b.abort()
    await expect(second).rejects.toMatchObject({ code: "cancelled" })
    expect(calls[0].signal.aborted).toBe(true)
    await new Promise((r) => setTimeout(r, 30))
    expect((await fs.readdir(path.join(previewRoot(), "mike", "P"))).filter((f) => f.includes(".tmp"))).toEqual([])
  })

  it("reports a timeout and a failure without paths", async () => {
    await many(2)
    const { runner, calls } = gated()
    await expect(renderAudioPreview("mike", "P", req("a"), never, { runner, timeoutMs: 40 })).rejects.toMatchObject({ code: "timeout" })
    const failing = renderAudioPreview("mike", "P", req("b"), never, { runner })
    await until(() => calls.length === 2)
    calls[1].fail()
    const error = await failing.catch((e: Error) => e)
    expect(error).toMatchObject({ code: "failed" })
    expect((error as Error).message).not.toMatch(/secret|C:/)
  })
})

describe("prunePreviews", () => {
  it("removes previews older than an hour and all but the newest ones", async () => {
    const dir = path.join(previewRoot(), "mike", "P")
    await fs.mkdir(dir, { recursive: true })
    const now = Date.now()
    const at = async (name: string, ageMs: number) => {
      const file = path.join(dir, name)
      await fs.writeFile(file, "x")
      const t = new Date(now - ageMs)
      await fs.utimes(file, t, t)
    }
    await at(`${"0".repeat(32)}.m4a`, 2 * 60 * 60 * 1000)
    await at(`${"1".repeat(32)}.m4a.abc.tmp`, 2 * 60 * 60 * 1000)
    await at(`${"2".repeat(32)}.m4a`, 3000)
    await at(`${"3".repeat(32)}.m4a`, 2000)
    await at(`${"4".repeat(32)}.m4a`, 1000)
    await prunePreviews(previewRoot(), now, 2)
    expect((await fs.readdir(dir)).sort()).toEqual([`${"3".repeat(32)}.m4a`, `${"4".repeat(32)}.m4a`])
  })
})

;(FFMPEG ? describe : describe.skip)(FFMPEG ? "renderAudioPreview with real ffmpeg" : "renderAudioPreview with real ffmpeg (SKIPPED: no ffmpeg found)", () => {
  /** The dominant frequency (Hz) of a stretch of a file's sound, from its zero crossings (fine for one tone). */
  function frequency(file: string, from: number, length: number): number {
    const r = spawnSync(FFMPEG!, ["-hide_banner", "-v", "error", "-ss", String(from), "-t", String(length), "-i", file, "-ac", "1", "-ar", "48000", "-f", "s16le", "-"], { windowsHide: true, maxBuffer: 64 * 1024 * 1024 })
    if (r.status !== 0) throw new Error(String(r.stderr))
    const pcm = new Int16Array(r.stdout.buffer, r.stdout.byteOffset, Math.floor(r.stdout.length / 2))
    let crossings = 0
    for (let i = 1; i < pcm.length; i++) if (pcm[i - 1] < 0 !== pcm[i] < 0) crossings++
    return crossings / 2 / (pcm.length / 48000)
  }

  function duration(file: string): number {
    const r = spawnSync(FFMPEG!, ["-hide_banner", "-i", file], { windowsHide: true })
    const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(String(r.stderr))
    return Number(m![1]) * 3600 + Number(m![2]) * 60 + Number(m![3])
  }

  it("renders Chipmunk over the capped window, five semitones up", async () => {
    const file = path.join(assets, "tone.wav")
    const r = spawnSync(FFMPEG!, ["-hide_banner", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=20", "-y", file], { windowsHide: true })
    if (r.status !== 0) throw new Error(String(r.stderr))
    await project({ t: { file: "tone.wav", duration: 20, hasAudio: true } })
    const out = await renderAudioPreview("mike", "P", { assetId: "t", in: 2, out: 19, audio: chipmunk }, never)
    expect(out.durationSec).toBe(12)
    const rendered = previewFile("mike", "P", out.id)!
    expect(duration(rendered)).toBeCloseTo(12, 1)
    const f = frequency(rendered, 3, 4)
    expect(f).toBeGreaterThan(440 * 2 ** (4.5 / 12))
    expect(f).toBeLessThan(440 * 2 ** (5.5 / 12))
  }, 60_000)
})
