import fs from "fs/promises"
import os from "os"
import path from "path"
import sharp from "sharp"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

const tmp = path.join(os.tmpdir(), `ps-thumbs-${process.pid}-${Date.now()}`)
const photo = path.join(tmp, "photo.jpg")
let thumbs: typeof import("./thumbs-server")

beforeAll(async () => {
  await fs.mkdir(tmp, { recursive: true })
  process.env.PHOTOS_CACHE_DIR = path.join(tmp, "cache")
  await sharp({ create: { width: 64, height: 48, channels: 3, background: "#3a7bd5" } }).jpeg().toFile(photo)
  thumbs = await import("./thumbs-server")
})

afterAll(() => fs.rm(tmp, { recursive: true, force: true }))

const failMarker = async (contents: string) => {
  const key = thumbs.cacheKey("upload", "photo.jpg", await fs.stat(photo))
  const marker = path.join(thumbs.cacheRoot(), "failed", key.slice(0, 2), key)
  await fs.mkdir(path.dirname(marker), { recursive: true })
  await fs.writeFile(marker, contents)
}

describe("ensureVariant", () => {
  it("retries a photo that failed with an older decoder", async () => {
    // Markers from before the decoder upgrade hold just the error message.
    await failMarker("Command failed: heif-convert -q 92 photo.jpg")
    expect(await thumbs.ensureVariant("upload", "photo.jpg", photo, "thumb")).toEqual({ path: expect.stringMatching(/\.webp$/) })
  })

  it("doesn't retry a photo the current decoders already failed on", async () => {
    await failMarker(`${thumbs.DECODERS}\nheif-dec: unsupported`)
    expect(await thumbs.ensureVariant("upload", "photo.jpg", photo, "preview")).toEqual({ failed: true })
  })
})
