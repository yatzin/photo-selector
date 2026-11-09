import fsSync from "fs"
import fs from "fs/promises"
import os from "os"
import path from "path"
import sharp from "sharp"
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest"

const runExport = vi.fn()
vi.mock("./ffmpeg-server", async () => {
  const actual = await vi.importActual<typeof import("./ffmpeg-server")>("./ffmpeg-server")
  return { ...actual, probeMedia: vi.fn(async () => ({ duration: 5, hasAudio: true })), runExport: (...a: unknown[]) => runExport(...a) }
})

import { exportRunning, exportStatus, sanitizeError, startExport } from "./export-jobs-server"
import { EXPORT_STATE_FILE, exportFingerprint } from "./export-state"
import { writeExportState } from "./export-state-server"
import { createProject, readProject, writeProject } from "./projects-server"

const tmp = path.join(os.tmpdir(), `ps-export-${process.pid}-${Date.now()}`)
process.env.PHOTOS_VIDEO_PROJECTS_DIR = path.join(tmp, "projects")
process.env.PHOTOS_TEMP_DIR = path.join(tmp, "inbox")
process.env.PHOTOS_CACHE_DIR = path.join(tmp, "cache")

afterAll(() => fs.rm(tmp, { recursive: true, force: true }))

const outDir = (folder: string, user = "mike") => path.join(tmp, "projects", user, folder, "output")
const tick = () => new Promise((r) => setTimeout(r, 20))

async function waitDone(user: string, jobId: string) {
  for (let i = 0; i < 200; i++) {
    const s = exportStatus(user, jobId)
    if (s.state !== "running") return s
    await tick()
  }
  throw new Error("job never finished")
}

/** A job reports done or failed before its best-effort cleanup has finished, so wait for that. */
async function eventually(check: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 100 && !(await check()); i++) await tick()
}

let n = 0
async function makeProject(withClips = true, withFile = true): Promise<string> {
  const name = `Proj${n++}`
  const r = await createProject("mike", name)
  if ("error" in r) throw new Error(r.error)
  const p = (await readProject("mike", r.folder))!
  if (withFile) await fs.writeFile(path.join(tmp, "projects", "mike", r.folder, "assets", "a.mp4"), "x")
  await writeProject("mike", r.folder, {
    ...p,
    assets: { a: { file: "a.mp4", duration: 5, hasAudio: true } },
    tracks: [{ id: "t1", clips: withClips ? [{ id: "c1", asset: "a", in: 0, out: 4, start: 0 }] : [] }],
  })
  return r.folder
}

/** Sets the first clip's out point, an edit that changes the export. */
async function trim(folder: string, out: number) {
  const p = (await readProject("mike", folder))!
  await writeProject("mike", folder, { ...p, tracks: [{ ...p.tracks[0], clips: [{ ...p.tracks[0].clips[0], out }] }] })
}

async function exportAndWait(folder: string) {
  const r = await startExport("mike", folder)
  if ("error" in r) throw new Error(r.error)
  return { started: r, status: await waitDone("mike", r.jobId) }
}

beforeEach(() => {
  runExport.mockReset()
  runExport.mockImplementation(async (_args: string[], outFile: string, _total: number, onProgress: (f: number) => void) => {
    onProgress(0.5)
    await fs.writeFile(outFile, "video")
  })
})

describe("startExport", () => {
  it("refuses a project with no clips", async () => {
    const folder = await makeProject(false)
    expect(await startExport("mike", folder)).toEqual({ error: "Nothing to export" })
    expect(runExport).not.toHaveBeenCalled()
  })

  it("exports clips on overlay tracks too, for the length of the latest clip end", async () => {
    const folder = await makeProject(false)
    const p = (await readProject("mike", folder))!
    await writeProject("mike", folder, { ...p, tracks: [{ id: "t1", clips: [] }, { id: "t2", clips: [{ id: "o", asset: "a", in: 0, out: 2, start: 3 }] }] })
    const r = await startExport("mike", folder)
    if ("error" in r) throw new Error(r.error)
    expect(await waitDone("mike", r.jobId)).toMatchObject({ state: "done" })
    const [args, , total] = runExport.mock.calls[0] as [string[], string, number]
    expect(total).toBe(5)
    expect(args.filter((a) => a === "-i")).toHaveLength(1)
  })

  it("reports a missing asset file before spawning", async () => {
    const folder = await makeProject(true, false)
    expect(await startExport("mike", folder)).toEqual({ error: "a.mp4 is missing from the project's assets." })
    expect(runExport).not.toHaveBeenCalled()
  })

  it("writes a .tmp file, renames it on success without overwriting, then keeps only the new copy", async () => {
    const folder = await makeProject()
    const seen: string[] = []
    runExport.mockImplementation(async (_a: string[], outFile: string) => {
      seen.push(outFile)
      await fs.writeFile(outFile, "video")
    })
    const first = await startExport("mike", folder)
    if ("error" in first) throw new Error(first.error)
    const a = await waitDone("mike", first.jobId)
    await trim(folder, 3)
    const second = await startExport("mike", folder)
    if ("error" in second) throw new Error(second.error)
    const b = await waitDone("mike", second.jobId)

    expect(a.state).toBe("done")
    expect(b.state).toBe("done")
    expect(a.output).toMatch(/^.+ \d{4}-\d{2}-\d{2} \d{2}-\d{2}\.mp4$/)
    expect(b.output).not.toBe(a.output)
    expect(seen.every((f) => f.endsWith(".tmp"))).toBe(true)
    expect((await fs.readdir(outDir(folder))).sort()).toEqual([b.output, EXPORT_STATE_FILE].sort())
  })

  it("passes the project size and total length to ffmpeg, with the filtergraph in a script file", async () => {
    const folder = await makeProject()
    let graph = ""
    runExport.mockImplementation(async (args: string[], outFile: string) => {
      graph = fsSync.readFileSync(args[args.indexOf("-/filter_complex") + 1], "utf8")
      await fs.writeFile(outFile, "v")
    })
    const r = await startExport("mike", folder)
    if ("error" in r) throw new Error(r.error)
    await waitDone("mike", r.jobId)
    const [args, , total] = runExport.mock.calls[0]
    expect(args).not.toContain("-filter_complex")
    expect(graph).toContain("scale=1920:1080")
    expect(total).toBe(4)
  })

  it("rejects a second export while one is running, then allows one", async () => {
    const folder = await makeProject()
    let release: () => void = () => {}
    runExport.mockImplementation((_a: string[], outFile: string) => new Promise<void>((resolve) => (release = () => void fs.writeFile(outFile, "v").then(() => resolve()))))
    const first = await startExport("mike", folder)
    if ("error" in first) throw new Error(first.error)
    expect(await startExport("mike", folder)).toEqual({ error: "An export is already running for this project." })
    expect(exportStatus("mike", first.jobId).state).toBe("running")
    release()
    await waitDone("mike", first.jobId)
    expect("jobId" in (await startExport("mike", folder))).toBe(true)
  })

  it("exportRunning is true only while that user's export of that project runs", async () => {
    const folder = await makeProject()
    let release: () => void = () => {}
    runExport.mockImplementation((_a: string[], outFile: string) => new Promise<void>((resolve) => (release = () => void fs.writeFile(outFile, "v").then(() => resolve()))))
    expect(exportRunning("mike", folder)).toBe(false)
    const r = await startExport("mike", folder)
    if ("error" in r) throw new Error(r.error)
    expect(exportRunning("mike", folder)).toBe(true)
    expect(exportRunning("someone", folder)).toBe(false)
    expect(exportRunning("mike", "other")).toBe(false)
    release()
    await waitDone("mike", r.jobId)
    expect(exportRunning("mike", folder)).toBe(false)
  })

  it("reports progress while running", async () => {
    const folder = await makeProject()
    let finish: () => void = () => {}
    runExport.mockImplementation(async (_a: string[], outFile: string, _t: number, onProgress: (f: number) => void) => {
      onProgress(0.4)
      await new Promise<void>((resolve) => (finish = resolve))
      await fs.writeFile(outFile, "v")
    })
    const r = await startExport("mike", folder)
    if ("error" in r) throw new Error(r.error)
    await tick()
    expect(exportStatus("mike", r.jobId)).toMatchObject({ state: "running", progress: 0.4 })
    finish()
    expect(await waitDone("mike", r.jobId)).toMatchObject({ state: "done", progress: 1 })
  })

  it("marks the job failed with ffmpeg's message and removes the partial .tmp and the script file", async () => {
    const folder = await makeProject()
    let script = ""
    runExport.mockImplementation(async (args: string[], outFile: string) => {
      script = args[args.indexOf("-/filter_complex") + 1]
      expect(fsSync.existsSync(script)).toBe(true)
      await fs.writeFile(outFile, "partial")
      throw new Error("Invalid argument")
    })
    const r = await startExport("mike", folder)
    if ("error" in r) throw new Error(r.error)
    const s = await waitDone("mike", r.jobId)
    expect(s).toMatchObject({ state: "failed", error: "Invalid argument" })
    expect(s.output).toBeUndefined()
    await eventually(async () => (await fs.readdir(outDir(folder))).length === 0 && !fsSync.existsSync(script))
    expect(await fs.readdir(outDir(folder))).toEqual([])
    expect(fsSync.existsSync(script)).toBe(false)
  })

  it("removes the script file after a successful export too", async () => {
    const folder = await makeProject()
    let script = ""
    runExport.mockImplementation(async (args: string[], outFile: string) => {
      script = args[args.indexOf("-/filter_complex") + 1]
      await fs.writeFile(outFile, "v")
    })
    const r = await startExport("mike", folder)
    if ("error" in r) throw new Error(r.error)
    await waitDone("mike", r.jobId)
    expect(script).not.toBe("")
    await eventually(() => !fsSync.existsSync(script))
    expect(fsSync.existsSync(script)).toBe(false)
  })

  it("still fails the job when the .tmp can't be removed", async () => {
    const folder = await makeProject()
    runExport.mockImplementation(async (_a: string[], outFile: string) => {
      await fs.mkdir(outFile) // a plain rm of a directory rejects
      throw new Error("Invalid argument")
    })
    const r = await startExport("mike", folder)
    if ("error" in r) throw new Error(r.error)
    expect(await waitDone("mike", r.jobId)).toMatchObject({ state: "failed", error: "Invalid argument" })
  })

  it("keeps file system paths out of the error", async () => {
    const folder = await makeProject()
    runExport.mockRejectedValue(new Error("C:\\Users\\bob\\Projects\\mike\\x\\assets\\a.mp4: No such file or directory"))
    const r = await startExport("mike", folder)
    if ("error" in r) throw new Error(r.error)
    const s = await waitDone("mike", r.jobId)
    expect(s.error).toBe("file: No such file or directory")
  })
})

describe("startExport keeps one copy", () => {
  const stateOf = async (folder: string) => JSON.parse(await fs.readFile(path.join(outDir(folder), EXPORT_STATE_FILE), "utf8"))

  it("writes the state file and deletes earlier outputs but not folders on the first export", async () => {
    const folder = await makeProject()
    await fs.writeFile(path.join(outDir(folder), "old.mp4"), "old")
    await fs.mkdir(path.join(outDir(folder), "keep"))
    await fs.writeFile(path.join(outDir(folder), "keep", "inner.mp4"), "x")
    const { started, status } = await exportAndWait(folder)
    expect(started).not.toHaveProperty("reused")
    expect(status).toMatchObject({ state: "done", progress: 1 })
    expect(status.reused).toBeUndefined()
    expect((await fs.readdir(outDir(folder))).sort()).toEqual([status.output, EXPORT_STATE_FILE, "keep"].sort())
    expect(await fs.readdir(path.join(outDir(folder), "keep"))).toEqual(["inner.mp4"])
    const state = await stateOf(folder)
    expect(state).toMatchObject({ file: status.output, fingerprint: exportFingerprint((await readProject("mike", folder))!) })
    expect(typeof state.createdAt).toBe("number")
  })

  it("reuses the copy for an unchanged project without running ffmpeg, done at once", async () => {
    const folder = await makeProject()
    const first = await exportAndWait(folder)
    runExport.mockClear()
    const again = await startExport("mike", folder)
    if ("error" in again) throw new Error(again.error)
    expect(again).toMatchObject({ reused: true, output: first.status.output })
    expect(exportStatus("mike", again.jobId)).toEqual({ state: "done", progress: 1, output: first.status.output, reused: true })
    expect(exportRunning("mike", folder)).toBe(false)
    expect(runExport).not.toHaveBeenCalled()
    expect((await fs.readdir(outDir(folder))).sort()).toEqual([first.status.output, EXPORT_STATE_FILE].sort())
  })

  it("renaming the project or importing an unused asset still reuses", async () => {
    const folder = await makeProject()
    await exportAndWait(folder)
    const p = (await readProject("mike", folder))!
    await writeProject("mike", folder, { ...p, name: "Other", assets: { ...p.assets, z: { file: "z.mp4", duration: 2, hasAudio: false } } })
    runExport.mockClear()
    expect(await startExport("mike", folder)).toMatchObject({ reused: true })
    expect(runExport).not.toHaveBeenCalled()
  })

  it("exports again after an edit and removes the previous copy", async () => {
    const folder = await makeProject()
    runExport.mockImplementation(async (_a: string[], outFile: string) => fs.writeFile(outFile, `video ${runExport.mock.calls.length}`))
    const first = await exportAndWait(folder)
    await fs.rename(path.join(outDir(folder), first.status.output!), path.join(outDir(folder), "first.mp4"))
    const p = (await readProject("mike", folder))!
    await writeExportState(outDir(folder), { file: "first.mp4", fingerprint: exportFingerprint(p), createdAt: 1 })
    await trim(folder, 2)
    const second = await exportAndWait(folder)
    expect(second.started).not.toHaveProperty("reused")
    expect(runExport).toHaveBeenCalledTimes(2)
    expect((await fs.readdir(outDir(folder))).sort()).toEqual([second.status.output, EXPORT_STATE_FILE].sort())
    expect(await stateOf(folder)).toMatchObject({ file: second.status.output, fingerprint: exportFingerprint((await readProject("mike", folder))!) })
  })

  it("exports again when the kept copy is gone", async () => {
    const folder = await makeProject()
    const first = await exportAndWait(folder)
    await fs.rm(path.join(outDir(folder), first.status.output!))
    const second = await exportAndWait(folder)
    expect(second.started).not.toHaveProperty("reused")
    expect(runExport).toHaveBeenCalledTimes(2)
  })

  it("leaves the previous copy and state alone when an export fails", async () => {
    const folder = await makeProject()
    const first = await exportAndWait(folder)
    const before = await stateOf(folder)
    await trim(folder, 2)
    runExport.mockImplementation(async (_a: string[], outFile: string) => {
      await fs.writeFile(outFile, "partial")
      throw new Error("Invalid argument")
    })
    const second = await exportAndWait(folder)
    expect(second.status).toMatchObject({ state: "failed" })
    await eventually(async () => (await fs.readdir(outDir(folder))).length === 2)
    expect((await fs.readdir(outDir(folder))).sort()).toEqual([first.status.output, EXPORT_STATE_FILE].sort())
    expect(await stateOf(folder)).toEqual(before)
  })
})

describe("startExport with images", () => {
  async function imageProject(image: Buffer | string): Promise<string> {
    const folder = await makeProject()
    await fs.writeFile(path.join(tmp, "projects", "mike", folder, "assets", "photo.png"), image)
    const p = (await readProject("mike", folder))!
    await writeProject("mike", folder, {
      ...p,
      assets: { ...p.assets, i: { file: "photo.png", duration: 5, hasAudio: false, kind: "image" } },
      tracks: [{ id: "t1", clips: [...p.tracks[0].clips, { id: "p", asset: "i", in: 0, out: 2, start: 4 }] }],
    })
    return folder
  }

  it("feeds ffmpeg the cached preview of an image, looped for the clip's length", async () => {
    const png = await sharp({ create: { width: 64, height: 48, channels: 3, background: "#09f" } }).png().toBuffer()
    const folder = await imageProject(png)
    const r = await startExport("mike", folder)
    if ("error" in r) throw new Error(r.error)
    expect(await waitDone("mike", r.jobId)).toMatchObject({ state: "done" })
    const [args, , total] = runExport.mock.calls[0] as [string[], string, number]
    const loop = args.indexOf("-loop")
    expect(args.slice(loop, loop + 7)).toEqual(["-loop", "1", "-framerate", "30", "-t", "2", "-i"])
    const still = args[loop + 7]
    expect(still.startsWith(path.join(tmp, "cache", "preview"))).toBe(true)
    expect(still.endsWith(".webp")).toBe(true)
    expect(fsSync.existsSync(still)).toBe(true)
    expect(total).toBe(6)
  })

  it("refuses with the file's name when the image can't be converted", async () => {
    const folder = await imageProject("not an image")
    expect(await startExport("mike", folder)).toEqual({ error: "photo.png couldn't be prepared for export." })
    expect(runExport).not.toHaveBeenCalled()
    expect(exportRunning("mike", folder)).toBe(false)
  })

  it("still reports a missing image file as missing", async () => {
    const folder = await imageProject("x")
    await fs.rm(path.join(tmp, "projects", "mike", folder, "assets", "photo.png"))
    expect(await startExport("mike", folder)).toEqual({ error: "photo.png is missing from the project's assets." })
  })
})

const FFMPEG = path.resolve(".data/ffmpeg.exe")
const hasFfmpeg = fsSync.existsSync(FFMPEG)

;(hasFfmpeg ? describe : describe.skip)(hasFfmpeg ? "startExport with text" : "startExport with text (SKIPPED: .data/ffmpeg.exe not found)", () => {
  it("draws each distinct text once into a PNG fed in like a still, and removes the PNGs with the job", async () => {
    process.env.FFMPEG_PATH = FFMPEG
    const folder = await makeProject()
    const p = (await readProject("mike", folder))!
    const text = { content: "Hi", color: "#ffcc00", orientation: "horizontal" as const }
    await writeProject("mike", folder, {
      ...p,
      tracks: [
        p.tracks[0],
        { id: "t2", clips: [{ id: "x", asset: "", in: 0, out: 1, start: 0, text }, { id: "y", asset: "", in: 0, out: 1, start: 2, text }] },
      ],
    })
    let pngs: string[] = []
    runExport.mockImplementation(async (args: string[], outFile: string) => {
      pngs = args.filter((a) => a.endsWith(".png"))
      // Drawn while ffmpeg runs: a real PNG with transparency.
      for (const png of pngs) expect((await sharp(png).metadata()).hasAlpha).toBe(true)
      await fs.writeFile(outFile, "video")
    })
    const r = await startExport("mike", folder)
    if ("error" in r) throw new Error(r.error)
    expect(await waitDone("mike", r.jobId)).toMatchObject({ state: "done" })
    // Two clips with the same text and size share one PNG.
    expect(pngs).toHaveLength(2)
    expect(pngs[0]).toBe(pngs[1])
    await eventually(() => !fsSync.existsSync(pngs[0]))
    expect(fsSync.existsSync(path.dirname(pngs[0]))).toBe(false)
  }, 60_000)
})

describe("sanitizeError", () => {
  it("strips drive, UNC, rooted and relative paths", () => {
    expect(sanitizeError("C:\\a\\b.mp4: bad")).toBe("file: bad")
    expect(sanitizeError("\\\\srv\\share\\b.mp4: bad")).toBe("file: bad")
    expect(sanitizeError("/home/u/b.mp4: Permission denied")).toBe("file: Permission denied")
    expect(sanitizeError("EBUSY: resource busy, rename '/tmp/x.tmp' -> '/data/y.mp4'")).toBe("EBUSY: resource busy, rename 'file' -> 'file'")
    expect(sanitizeError("spawn ./.data/ffmpeg.exe ENOENT")).toBe("spawn file ENOENT")
  })
  it("falls back when nothing readable is left", () => {
    expect(sanitizeError("")).toBe("The export failed.")
    expect(sanitizeError("/only/a/path")).toBe("The export failed.")
  })
  it("leaves ordinary messages alone", () => {
    expect(sanitizeError("a.mp4 is missing from the project's assets.")).toBe("a.mp4 is missing from the project's assets.")
    expect(sanitizeError("The export timed out.")).toBe("The export timed out.")
  })
})

describe("exportStatus", () => {
  it("treats an unknown job and another user's job alike", async () => {
    const folder = await makeProject()
    const r = await startExport("mike", folder)
    if ("error" in r) throw new Error(r.error)
    await waitDone("mike", r.jobId)
    const unknown = { state: "failed", progress: 0, error: "Unknown export." }
    expect(exportStatus("mike", "nope")).toEqual(unknown)
    expect(exportStatus("someone-else", r.jobId)).toEqual(unknown)
  })
})
