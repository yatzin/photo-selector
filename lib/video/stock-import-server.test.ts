import fs from "fs/promises"
import os from "os"
import path from "path"
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("./ffmpeg-server", () => ({
  probeStreams: vi.fn(async () => ({ duration: 6, hasVideo: true, hasAudio: false })),
  probePictureSize: vi.fn(async () => null),
}))
// readProject is the real one unless a test makes it throw.
vi.mock("./projects-server", async (importOriginal) => {
  const real = await importOriginal<typeof import("./projects-server")>()
  return { ...real, readProject: vi.fn(real.readProject) }
})
// The real config reads the database; every test injects its own client.
vi.mock("@/lib/stock/config", () => ({ loadStockConfig: vi.fn(async () => { throw new Error("no database in tests") }) }))

import type { StockClient, StockDownload, StockRef } from "@/lib/stock/types"
import { probePictureSize, probeStreams } from "./ffmpeg-server"
import { createProject, readProject, writeProject } from "./projects-server"
import { importStock, stockSourceKey, type StockImportDeps } from "./stock-import-server"

const tmp = path.join(os.tmpdir(), `ps-stock-import-${process.pid}-${Date.now()}`)
process.env.PHOTOS_VIDEO_PROJECTS_DIR = path.join(tmp, "projects")
process.env.PHOTOS_TEMP_DIR = path.join(tmp, "inbox")
const dir = path.join(tmp, "projects", "mike", "Trip")
const assets = path.join(dir, "assets")

afterAll(() => fs.rm(tmp, { recursive: true, force: true }))
beforeEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true })
  await createProject("mike", "Trip")
  vi.mocked(probeStreams).mockResolvedValue({ duration: 6, hasVideo: true, hasAudio: false })
  vi.mocked(probePictureSize).mockReset().mockResolvedValue({ width: 320, height: 240 })
})

const staging = async () => (await fs.readdir(dir)).filter((n) => n.startsWith("."))
const video: StockRef = { source: "pexels", id: "42", kind: "video" }

/** A client whose resolve answers `answer` (or throws it), and a download that writes `bytes` to the staging file; both counted. */
function setup(answer: StockDownload | Error = { url: "https://cdn.example/v.mp4", fileName: "pexels-42.mp4", gif: false }, bytes = "video bytes") {
  const resolve = vi.fn(async () => {
    await new Promise((r) => setTimeout(r, 5))
    if (answer instanceof Error) throw answer
    return answer
  })
  const client: StockClient = { source: "pexels", kinds: ["image", "video"], configured: () => true, search: async () => ({ results: [], next: null }), resolve }
  const clientFor = vi.fn(async () => client)
  const download = vi.fn(async (_url: string, dest: string) => {
    await new Promise((r) => setTimeout(r, 10))
    await fs.writeFile(dest, bytes)
  })
  const convertGif = vi.fn(async (input: string, output: string) => {
    expect(path.extname(input)).toBe(".gif")
    await fs.writeFile(output, "mp4 from gif")
  })
  const deps: StockImportDeps = { client: clientFor, download, convertGif }
  return { resolve, clientFor, download, convertGif, deps }
}

describe("stockSourceKey", () => {
  it("is stock:<source>:<id>", () => {
    expect(stockSourceKey({ source: "pexels", id: "42", kind: "video" })).toBe("stock:pexels:42")
  })
})

describe("importStock", () => {
  it("downloads a video into assets/ with the stock key as its source, and leaves no staging file", async () => {
    const s = setup()
    const r = await importStock("mike", "Trip", video, s.deps)
    expect(r).toMatchObject({ asset: { file: "pexels-42.mp4", duration: 6, hasAudio: false, source: "stock:pexels:42" } })
    expect(r).not.toHaveProperty("reused")
    expect(s.download).toHaveBeenCalledWith("https://cdn.example/v.mp4", expect.stringMatching(/[\\/]\.import-[0-9a-f]{16}\.mp4$/))
    expect(await fs.readFile(path.join(assets, "pexels-42.mp4"), "utf8")).toBe("video bytes")
    expect(await staging()).toEqual([])
    const p = await readProject("mike", "Trip")
    expect(Object.values(p!.assets)).toEqual([expect.objectContaining({ source: "stock:pexels:42" })])
  })

  it("reuses the first asset for the same result, without downloading again", async () => {
    const s = setup()
    const first = await importStock("mike", "Trip", video, s.deps)
    const second = await importStock("mike", "Trip", video, s.deps)
    if ("error" in first || "error" in second) throw new Error("import failed")
    expect(second).toMatchObject({ id: first.id, reused: true })
    expect(s.download).toHaveBeenCalledTimes(1)
    expect(s.resolve).toHaveBeenCalledTimes(1)
    expect(await fs.readdir(assets)).toEqual(["pexels-42.mp4"])
    expect(Object.keys((await readProject("mike", "Trip"))!.assets)).toHaveLength(1)
  })

  it("saves the resolved title on the asset, and a reuse keeps it", async () => {
    vi.mocked(probeStreams).mockResolvedValue({ duration: 6, hasVideo: false, hasAudio: true })
    const s = setup({ url: "https://cdn.example/a.mp3", fileName: "uuid-1.mp3", gif: false, title: "Soft rain" })
    const first = await importStock("mike", "Trip", { source: "pexels", id: "42", kind: "audio" }, s.deps)
    if ("error" in first) throw new Error(first.error)
    expect(first.asset.title).toBe("Soft rain")
    expect(Object.values((await readProject("mike", "Trip"))!.assets)[0].title).toBe("Soft rain")
    const second = await importStock("mike", "Trip", { source: "pexels", id: "42", kind: "audio" }, s.deps)
    expect(second).toMatchObject({ id: first.id, reused: true, asset: { title: "Soft rain" } })
  })

  it("makes one asset when the same result is imported twice at once", async () => {
    const s = setup()
    const [a, b] = await Promise.all([importStock("mike", "Trip", video, s.deps), importStock("mike", "Trip", video, s.deps)])
    if ("error" in a || "error" in b) throw new Error("import failed")
    expect(a.id).toBe(b.id)
    expect([a.reused, b.reused].filter(Boolean)).toHaveLength(1)
    expect(s.download).toHaveBeenCalledTimes(1)
    expect(await fs.readdir(assets)).toEqual(["pexels-42.mp4"])
    expect(Object.keys((await readProject("mike", "Trip"))!.assets)).toHaveLength(1)
    expect(await staging()).toEqual([])
  })

  it("returns the licence refusal and leaves nothing in assets/ or staging", async () => {
    const s = setup(new Error("Not CC0 / public domain"))
    expect(await importStock("mike", "Trip", { source: "openverse", id: "0b0e4c4e-1111-2222-3333-444455556666", kind: "image" }, s.deps)).toEqual({ error: "Not CC0 / public domain" })
    expect(s.download).not.toHaveBeenCalled()
    expect(await fs.readdir(assets)).toEqual([])
    expect(await staging()).toEqual([])
    expect((await readProject("mike", "Trip"))!.assets).toEqual({})
  })

  it("returns a download failure and removes the staging file", async () => {
    const s = setup()
    s.download.mockImplementation(async (_url: string, dest: string) => {
      await fs.writeFile(dest, "partial")
      throw new Error("Download too large")
    })
    expect(await importStock("mike", "Trip", video, s.deps)).toEqual({ error: "Download too large" })
    expect(await fs.readdir(assets)).toEqual([])
    expect(await staging()).toEqual([])
  })

  it("never passes a provider message carrying a URL through", async () => {
    const s = setup(new Error("Pexels request failed: https://api.pexels.com/videos/42?key=secret"))
    const r = await importStock("mike", "Trip", video, s.deps)
    expect(r).toHaveProperty("error")
    expect(JSON.stringify(r)).not.toMatch(/https?:|secret/)
  })

  it("converts a GIF to an mp4 video that loops by default", async () => {
    const s = setup({ url: "https://cdn.example/g.gif", fileName: "pixabay-7.gif", gif: true }, "GIF89a")
    const r = await importStock("mike", "Trip", { source: "pixabay", id: "7", kind: "gif" }, s.deps)
    expect(r).toMatchObject({ asset: { file: "pixabay-7.mp4", loopByDefault: true, source: "stock:pixabay:7", duration: 6 } })
    if ("error" in r) throw new Error(r.error)
    expect(r.asset.kind).not.toBe("image")
    expect(r.asset.kind).not.toBe("audio")
    expect(s.convertGif).toHaveBeenCalledTimes(1)
    expect(await fs.readdir(assets)).toEqual(["pixabay-7.mp4"])
    expect(await fs.readFile(path.join(assets, "pixabay-7.mp4"), "utf8")).toBe("mp4 from gif")
    expect(await staging()).toEqual([])
    expect(Object.values((await readProject("mike", "Trip"))!.assets)[0]).toMatchObject({ loopByDefault: true })
  })

  it("refuses a GIF that declares too large a picture, before converting, and leaves nothing behind", async () => {
    const gifRef: StockRef = { source: "pixabay", id: "7", kind: "gif" }
    const gif: StockDownload = { url: "https://cdn.example/g.gif", fileName: "pixabay-7.gif", gif: true }
    for (const size of [{ width: 16000, height: 16000 }, { width: 4097, height: 100 }, { width: 4096, height: 4097 }, null]) {
      vi.mocked(probePictureSize).mockResolvedValue(size)
      const s = setup(gif, "GIF89a")
      expect(await importStock("mike", "Trip", gifRef, s.deps)).toEqual({ error: "That GIF is too large." })
      expect(s.convertGif).not.toHaveBeenCalled()
      expect(await fs.readdir(assets)).toEqual([])
      expect(await staging()).toEqual([])
    }
    expect(vi.mocked(probePictureSize).mock.calls.every(([f]) => /[\\/]\.import-[0-9a-f]{16}\.gif$/.test(f))).toBe(true)
  })

  it("re-checks under the lock after the download: an asset of the same result added meanwhile is reused", async () => {
    const s = setup()
    s.download.mockImplementation(async (_url: string, dest: string) => {
      await fs.writeFile(dest, "video bytes")
      // Another tab or process finished the same import while this download ran.
      const p = await readProject("mike", "Trip")
      await fs.writeFile(path.join(assets, "earlier.mp4"), "earlier")
      await writeProject("mike", "Trip", { ...p!, assets: { aearlier00000000: { file: "earlier.mp4", duration: 6, hasAudio: false, source: "stock:pexels:42" } } })
    })
    expect(await importStock("mike", "Trip", video, s.deps)).toMatchObject({ id: "aearlier00000000", reused: true })
    expect(Object.keys((await readProject("mike", "Trip"))!.assets)).toEqual(["aearlier00000000"])
    expect(await fs.readdir(assets)).toEqual(["earlier.mp4"])
    expect(await staging()).toEqual([])
  })

  it("forgets a failed import, so trying again downloads again and succeeds", async () => {
    const s = setup()
    s.download.mockRejectedValueOnce(new Error("Download timed out"))
    expect(await importStock("mike", "Trip", video, s.deps)).toEqual({ error: "Download timed out" })
    const again = await importStock("mike", "Trip", video, s.deps)
    expect(again).toMatchObject({ asset: { source: "stock:pexels:42" } })
    expect(again).not.toHaveProperty("reused")
    expect(s.download).toHaveBeenCalledTimes(2)
    expect(await fs.readdir(assets)).toEqual(["pexels-42.mp4"])
  })

  it("never passes a server path from a failure reading the project through", async () => {
    const s = setup()
    vi.mocked(readProject).mockRejectedValueOnce(new Error("EACCES: permission denied, open 'C:\\data\\projects\\mike\\Trip\\project.json'"))
    const r = await importStock("mike", "Trip", video, s.deps)
    expect(r).toEqual({ error: "Couldn't read the project." })
    expect(s.clientFor).not.toHaveBeenCalled()
  })

  it("never passes a server path from a later failure through", async () => {
    const s = setup()
    s.download.mockRejectedValueOnce(new Error("EPERM: operation not permitted, open '/srv/photos/projects/mike/Trip/.import-0123456789abcdef.mp4'"))
    const r = await importStock("mike", "Trip", video, s.deps)
    expect(r).toHaveProperty("error")
    expect(JSON.stringify(r)).not.toMatch(/srv|projects|import-/)
  })

  it("returns a conversion failure and leaves nothing behind", async () => {
    const s = setup({ url: "https://cdn.example/g.gif", fileName: "pixabay-7.gif", gif: true }, "GIF89a")
    s.convertGif.mockImplementation(async (_i: string, output: string) => {
      await fs.writeFile(output, "half")
      throw new Error("Couldn't convert the GIF.")
    })
    expect(await importStock("mike", "Trip", { source: "pixabay", id: "7", kind: "gif" }, s.deps)).toEqual({ error: "Couldn't convert the GIF." })
    expect(await fs.readdir(assets)).toEqual([])
    expect(await staging()).toEqual([])
  })

  it("rejects what ffmpeg can't read and leaves nothing behind", async () => {
    vi.mocked(probeStreams).mockResolvedValue({ duration: null, hasVideo: false, hasAudio: false })
    const s = setup()
    expect(await importStock("mike", "Trip", video, s.deps)).toEqual({ error: "pexels-42.mp4 couldn't be read as a video." })
    expect(await fs.readdir(assets)).toEqual([])
    expect(await staging()).toEqual([])
  })

  it("refuses a malformed ref without calling any client", async () => {
    const s = setup()
    const bad: unknown[] = [
      null,
      "pexels:42",
      { source: "flickr", id: "1", kind: "image" },
      { source: "pexels", id: "1", kind: "document" },
      { source: "pexels", id: 42, kind: "video" },
      { source: "pexels", id: "", kind: "video" },
      { source: "pexels", id: "../../x", kind: "video" },
      { source: "pexels", id: "1", kind: "video", url: "https://evil.example/x.mp4" },
    ]
    for (const ref of bad) expect(await importStock("mike", "Trip", ref, s.deps)).toEqual({ error: "Invalid request." })
    expect(s.clientFor).not.toHaveBeenCalled()
    expect(s.download).not.toHaveBeenCalled()
  })

  it("refuses an unknown project without calling any client", async () => {
    const s = setup()
    expect(await importStock("mike", "Nope", video, s.deps)).toEqual({ error: "Project not found." })
    expect(await importStock("mike", "..", video, s.deps)).toEqual({ error: "Project not found." })
    expect(s.clientFor).not.toHaveBeenCalled()
  })

  it("refuses a download name Import doesn't take", async () => {
    const s = setup({ url: "https://cdn.example/x", fileName: "pexels-42.exe", gif: false })
    expect(await importStock("mike", "Trip", video, s.deps)).toHaveProperty("error")
    expect(s.download).not.toHaveBeenCalled()
    expect(await staging()).toEqual([])
  })
})
