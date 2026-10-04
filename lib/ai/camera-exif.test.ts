import fs from "fs/promises"
import os from "os"
import path from "path"
import sharp from "sharp"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { photoInfo } from "./camera-exif"

const tmp = path.join(os.tmpdir(), `ps-camera-${process.pid}-${Date.now()}`)
const img = () => sharp({ create: { width: 32, height: 32, channels: 3, background: "#3a7bd5" } })

beforeAll(async () => {
  await fs.mkdir(tmp, { recursive: true })
  await img().withExif({ IFD0: { Make: "Google", Model: "Pixel 8", DateTime: "2025:07:04 10:00:00" } }).jpeg().toFile(path.join(tmp, "camera.jpg"))
  await img().withExif({ IFD0: { Software: "Android" } }).jpeg().toFile(path.join(tmp, "edited.jpg"))
  await img().png().toFile(path.join(tmp, "screenshot.png"))
  await fs.writeFile(path.join(tmp, "IMG_1.HEIC"), "not decoded")
})
afterAll(() => fs.rm(tmp, { recursive: true, force: true }))

describe("photoInfo", () => {
  it("knows a camera photo by its EXIF, and reads when it was taken", async () => {
    expect(await photoInfo(path.join(tmp, "camera.jpg"), 0)).toEqual({ camera: true, takenAt: Date.UTC(2025, 6, 4, 10) })
  })

  it("treats HEIC as a camera photo without reading it", async () => {
    expect(await photoInfo(path.join(tmp, "IMG_1.HEIC"), 5)).toEqual({ camera: true, takenAt: 5 })
  })

  it("sends images without camera details to the AI", async () => {
    expect((await photoInfo(path.join(tmp, "screenshot.png"), 7)).camera).toBe(false)
    expect((await photoInfo(path.join(tmp, "edited.jpg"), 7)).camera).toBe(false)
    expect(await photoInfo(path.join(tmp, "missing.png"), 9)).toEqual({ camera: false, takenAt: 9 })
  })
})
