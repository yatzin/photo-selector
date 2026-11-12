import { execFile, spawnSync } from "child_process"
import fs from "fs"
import os from "os"
import path from "path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { probePictureSize } from "@/lib/video/ffmpeg-server"
import { convertGifToMp4, gifTooLarge, gifToMp4Args } from "./gif"

describe("gifToMp4Args", () => {
  it("drops sound, makes a faststart yuv420p mp4 with even sides, and writes the output last", () => {
    const args = gifToMp4Args("in.gif", "out.mp4")
    expect(args[args.indexOf("-i") + 1]).toBe("in.gif")
    expect(args).toContain("-an")
    expect(args[args.indexOf("-pix_fmt") + 1]).toBe("yuv420p")
    expect(args[args.indexOf("-movflags") + 1]).toBe("+faststart")
    expect(args[args.indexOf("-vf") + 1]).toBe("scale=trunc(iw/2)*2:trunc(ih/2)*2")
    expect(args).toContain("-y")
    expect(args.indexOf("-i")).toBeLessThan(args.indexOf("-an"))
    expect(args.at(-1)).toBe("out.mp4")
  })

  it("caps the output at 10 minutes and ffmpeg at two threads, before the output path", () => {
    const args = gifToMp4Args("in.gif", "out.mp4")
    expect(args[args.indexOf("-t") + 1]).toBe("600")
    expect(args[args.indexOf("-threads") + 1]).toBe("2")
    expect(args.indexOf("-t")).toBeGreaterThan(args.indexOf("-i"))
    expect(args.indexOf("-threads")).toBeGreaterThan(args.indexOf("-i"))
    expect(args.at(-1)).toBe("out.mp4")
  })

  it("passes paths as single arguments, never split or quoted", () => {
    const args = gifToMp4Args("C:\\a b\\in put.gif", "C:\\a b\\out put.mp4")
    expect(args).toContain("C:\\a b\\in put.gif")
    expect(args.at(-1)).toBe("C:\\a b\\out put.mp4")
  })
})

describe("gifTooLarge", () => {
  it("refuses over 4096 px on a side, over 16 megapixels, or an unknown size", () => {
    expect(gifTooLarge({ width: 480, height: 270 })).toBe(false)
    expect(gifTooLarge({ width: 4000, height: 4000 })).toBe(false)
    expect(gifTooLarge({ width: 4096, height: 3906 })).toBe(false)
    expect(gifTooLarge({ width: 4096, height: 3907 })).toBe(true)
    expect(gifTooLarge({ width: 4096, height: 4096 })).toBe(true)
    expect(gifTooLarge({ width: 4097, height: 10 })).toBe(true)
    expect(gifTooLarge({ width: 10, height: 4097 })).toBe(true)
    expect(gifTooLarge({ width: 4096, height: 4097 })).toBe(true)
    expect(gifTooLarge(null)).toBe(true)
  })
})

/** A valid one-pixel GIF whose header declares a `width` x `height` canvas. */
function gifWithCanvas(width: number, height: number): Buffer {
  const b = Buffer.from("474946383961010001008000" + "00ffffff000000" + "2c00000000010001000002024401003b", "hex")
  b.writeUInt16LE(width, 6)
  b.writeUInt16LE(height, 8)
  return b
}

// Real ffmpeg: .data/ffmpeg.exe, FFMPEG_PATH or ffmpeg on PATH. The suite's name says why when it's skipped.
const LOCAL = path.resolve(".data/ffmpeg.exe")
const FFMPEG = fs.existsSync(LOCAL) ? LOCAL : process.env.FFMPEG_PATH || "ffmpeg"
const hasFfmpeg = spawnSync(FFMPEG, ["-version"], { windowsHide: true }).status === 0

;(hasFfmpeg ? describe : describe.skip)(hasFfmpeg ? "convertGifToMp4 with real ffmpeg" : "convertGifToMp4 with real ffmpeg (SKIPPED: no ffmpeg found)", () => {
  const dir = path.join(os.tmpdir(), `ps-gif-${process.pid}-${Date.now()}`)
  const gif = path.join(dir, "odd.gif")
  let saved: string | undefined

  beforeAll(async () => {
    saved = process.env.FFMPEG_PATH
    process.env.FFMPEG_PATH = FFMPEG
    fs.mkdirSync(dir, { recursive: true })
    // An odd-sized (33x21) one-second animated GIF: yuv420p needs the scale filter to even it.
    await new Promise<void>((resolve, reject) =>
      execFile(FFMPEG, ["-hide_banner", "-f", "lavfi", "-i", "testsrc=size=33x21:rate=10:duration=1", "-y", gif], { windowsHide: true }, (e) => (e ? reject(e) : resolve()))
    )
  })
  afterAll(() => {
    if (saved === undefined) delete process.env.FFMPEG_PATH
    else process.env.FFMPEG_PATH = saved
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it("turns a GIF into a non-empty mp4 with even sides", async () => {
    const out = path.join(dir, "out.mp4")
    await convertGifToMp4(gif, out)
    expect(fs.statSync(out).size).toBeGreaterThan(0)
    const probe = spawnSync(FFMPEG, ["-hide_banner", "-i", out], { windowsHide: true }).stderr.toString()
    expect(probe).toMatch(/Video: h264/)
    expect(probe).toMatch(/32x20/)
  })

  it("reads a GIF's declared canvas, so a tiny file claiming a huge picture is refused", async () => {
    const big = path.join(dir, "big.gif")
    fs.writeFileSync(big, gifWithCanvas(16000, 16000))
    const size = await probePictureSize(big)
    expect(size).toEqual({ width: 16000, height: 16000 })
    expect(gifTooLarge(size)).toBe(true)
    expect(gifTooLarge(await probePictureSize(gif))).toBe(false)
  })

  it("rejects a file that isn't a GIF with a short message and leaves no output", async () => {
    const bad = path.join(dir, "bad.gif")
    fs.writeFileSync(bad, "not a gif")
    const out = path.join(dir, "bad.mp4")
    await expect(convertGifToMp4(bad, out)).rejects.toThrow("Couldn't convert the GIF.")
    expect(fs.existsSync(out)).toBe(false)
  })
})
