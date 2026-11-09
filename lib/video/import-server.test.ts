import fs from "fs/promises"
import os from "os"
import path from "path"
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("./ffmpeg-server", () => ({ probeStreams: vi.fn(async () => ({ duration: 6, hasVideo: false, hasAudio: true })) }))

import { probeStreams } from "./ffmpeg-server"
import { cancelUpload, finishUpload, startUpload, writeChunk } from "./import-server"
import { MAX_IMPORT_BYTES } from "./import"
import { createProject } from "./projects-server"

const tmp = path.join(os.tmpdir(), `ps-import-${process.pid}-${Date.now()}`)
process.env.PHOTOS_VIDEO_PROJECTS_DIR = path.join(tmp, "projects")
process.env.PHOTOS_TEMP_DIR = path.join(tmp, "inbox")
const dir = path.join(tmp, "projects", "mike", "Trip")
const assets = path.join(dir, "assets")

afterAll(() => fs.rm(tmp, { recursive: true, force: true }))
beforeEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true })
  await createProject("mike", "Trip")
  vi.mocked(probeStreams).mockResolvedValue({ duration: 6, hasVideo: false, hasAudio: true })
})

const body = (text: string) => new Blob([text]).stream()

/** Uploads `text` as `name` in pieces of `piece` bytes; what finishUpload says. */
async function upload(name: string, text: string, piece = text.length) {
  const started = await startUpload("mike", "Trip", name, text.length)
  if ("error" in started) return started
  for (let at = 0; at < text.length; at += piece) {
    const r = await writeChunk("mike", "Trip", started.id, started.name, text.length, at, body(text.slice(at, at + piece)))
    if ("error" in r) return r
  }
  return finishUpload("mike", "Trip", started.id, started.name, text.length)
}

const hidden = async () => (await fs.readdir(dir)).filter((n) => n.startsWith(".import-"))

describe("startUpload", () => {
  it("refuses unknown types, empty files, files over 4 GB and unknown projects", async () => {
    expect(await startUpload("mike", "Trip", "notes.txt", 10)).toMatchObject({ status: 415 })
    expect(await startUpload("mike", "Trip", "a.mp4", 0)).toEqual({ error: "a.mp4 is empty.", status: 415 })
    expect(await startUpload("mike", "Trip", "a.mp4", MAX_IMPORT_BYTES + 1)).toMatchObject({ status: 413 })
    expect(await startUpload("mike", "Nope", "a.mp4", 10)).toMatchObject({ status: 404 })
    expect(await startUpload("mike", "..", "a.mp4", 10)).toMatchObject({ status: 400 })
  })

  it("makes a hidden part file in the project's folder, named from the cleaned name", async () => {
    const r = await startUpload("mike", "Trip", "../../evil/.song.MP3", 10)
    expect(r).toMatchObject({ name: "song.MP3" })
    expect(await hidden()).toEqual([`.import-${"id" in r ? r.id : ""}.mp3`])
  })

  it("removes part files left for over a day", async () => {
    const old = path.join(dir, ".import-0123456789abcdef.mp4")
    await fs.writeFile(old, "x")
    await fs.utimes(old, new Date(Date.now() - 2 * 86400_000), new Date(Date.now() - 2 * 86400_000))
    await startUpload("mike", "Trip", "a.mp4", 10)
    expect(await hidden()).not.toContain(".import-0123456789abcdef.mp4")
  })
})

describe("writeChunk", () => {
  it("takes pieces in order and refuses one at the wrong offset", async () => {
    const s = await startUpload("mike", "Trip", "a.wav", 6)
    if ("error" in s) throw new Error(s.error)
    expect(await writeChunk("mike", "Trip", s.id, s.name, 6, 0, body("abc"))).toEqual({ received: 3 })
    expect(await writeChunk("mike", "Trip", s.id, s.name, 6, 0, body("abc"))).toMatchObject({ status: 409 })
    expect(await writeChunk("mike", "Trip", s.id, s.name, 6, 3, body("def"))).toEqual({ received: 6 })
  })

  it("refuses more bytes than the size said, and cuts the piece off again", async () => {
    const s = await startUpload("mike", "Trip", "a.wav", 4)
    if ("error" in s) throw new Error(s.error)
    expect(await writeChunk("mike", "Trip", s.id, s.name, 4, 0, body("abcdef"))).toMatchObject({ status: 413 })
    expect((await fs.stat(path.join(dir, `.import-${s.id}.wav`))).size).toBe(0)
  })

  it("refuses a forged id", async () => {
    expect(await writeChunk("mike", "Trip", "../../x", "a.wav", 4, 0, body("ab"))).toMatchObject({ status: 400 })
  })
})

describe("finishUpload", () => {
  it("puts an audio file into assets/ with its probed length, never through the Inbox", async () => {
    const r = await upload("Song.mp3", "mp3 bytes", 4)
    expect(r).toMatchObject({ asset: { file: "Song.mp3", duration: 6, hasAudio: true, kind: "audio", source: "Song.mp3" } })
    expect(await fs.readFile(path.join(assets, "Song.mp3"), "utf8")).toBe("mp3 bytes")
    expect(await hidden()).toEqual([])
    expect(await fs.readdir(path.join(tmp, "inbox")).catch(() => [])).toEqual([])
  })

  it("numbers a name that's taken, as the Inbox copy does", async () => {
    await upload("Song.mp3", "one")
    const r = await upload("Song.mp3", "two")
    expect(r).toMatchObject({ asset: { file: "Song (1).mp3" } })
    expect(await fs.readFile(path.join(assets, "Song.mp3"), "utf8")).toBe("one")
  })

  it("takes a video, and an image with the default length", async () => {
    vi.mocked(probeStreams).mockResolvedValue({ duration: 3, hasVideo: true, hasAudio: false })
    expect(await upload("clip.mp4", "v")).toMatchObject({ asset: { file: "clip.mp4", duration: 3, hasAudio: false } })
    vi.mocked(probeStreams).mockResolvedValue({ duration: null, hasVideo: true, hasAudio: false })
    expect(await upload("photo.png", "p")).toMatchObject({ asset: { file: "photo.png", duration: 5, hasAudio: false, kind: "image" } })
  })

  it("rejects what ffmpeg can't read as the type the name claims, and leaves nothing behind", async () => {
    vi.mocked(probeStreams).mockResolvedValue({ duration: null, hasVideo: false, hasAudio: false })
    expect(await upload("fake.mp4", "text")).toEqual({ error: "fake.mp4 couldn't be read as a video.", status: 415 })
    expect(await fs.readdir(assets)).toEqual([])
    expect(await hidden()).toEqual([])
  })

  it("refuses an upload that isn't complete", async () => {
    const s = await startUpload("mike", "Trip", "a.wav", 6)
    if ("error" in s) throw new Error(s.error)
    await writeChunk("mike", "Trip", s.id, s.name, 6, 0, body("abc"))
    expect(await finishUpload("mike", "Trip", s.id, s.name, 6)).toMatchObject({ status: 409 })
  })
})

describe("cancelUpload", () => {
  it("removes the part file", async () => {
    const s = await startUpload("mike", "Trip", "a.wav", 6)
    if ("error" in s) throw new Error(s.error)
    await cancelUpload("mike", "Trip", s.id, "a.wav")
    expect(await hidden()).toEqual([])
  })
})
