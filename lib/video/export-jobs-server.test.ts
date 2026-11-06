import fsSync from "fs"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest"

const runExport = vi.fn()
vi.mock("./ffmpeg-server", async () => {
  const actual = await vi.importActual<typeof import("./ffmpeg-server")>("./ffmpeg-server")
  return { ...actual, probeMedia: vi.fn(async () => ({ duration: 5, hasAudio: true })), runExport: (...a: unknown[]) => runExport(...a) }
})

import { exportRunning, exportStatus, sanitizeError, startExport } from "./export-jobs-server"
import { createProject, readProject, writeProject } from "./projects-server"

const tmp = path.join(os.tmpdir(), `ps-export-${process.pid}-${Date.now()}`)
process.env.PHOTOS_VIDEO_PROJECTS_DIR = path.join(tmp, "projects")
process.env.PHOTOS_VIDEO_INBOX_DIR = path.join(tmp, "inbox")
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
    clips: withClips ? [{ id: "c1", asset: "a", in: 0, out: 4 }] : [],
  })
  return r.folder
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

  it("reports a missing asset file before spawning", async () => {
    const folder = await makeProject(true, false)
    expect(await startExport("mike", folder)).toEqual({ error: "a.mp4 is missing from the project's assets." })
    expect(runExport).not.toHaveBeenCalled()
  })

  it("writes a .tmp file, renames it on success and never overwrites an earlier output", async () => {
    const folder = await makeProject()
    const seen: string[] = []
    runExport.mockImplementation(async (_a: string[], outFile: string) => {
      seen.push(outFile)
      await fs.writeFile(outFile, "video")
    })
    const first = await startExport("mike", folder)
    if ("error" in first) throw new Error(first.error)
    const a = await waitDone("mike", first.jobId)
    const second = await startExport("mike", folder)
    if ("error" in second) throw new Error(second.error)
    const b = await waitDone("mike", second.jobId)

    expect(a.state).toBe("done")
    expect(b.state).toBe("done")
    expect(a.output).toMatch(/^.+ \d{4}-\d{2}-\d{2} \d{2}-\d{2}\.mp4$/)
    expect(b.output).not.toBe(a.output)
    expect(b.output).toMatch(/ \(1\)\.mp4$/)
    expect(seen.every((f) => f.endsWith(".tmp"))).toBe(true)
    expect((await fs.readdir(outDir(folder))).sort()).toEqual([a.output, b.output].sort())
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
