import { describe, expect, it } from "vitest"
import { buildScreenshotMessages, DEFAULT_SCREENSHOT_INSTRUCTIONS, parseShotVerdict, SCREENSHOT_REPLY_FORMAT } from "./screenshot-prompt"

describe("buildScreenshotMessages", () => {
  it("numbers the images and always appends the reply format", () => {
    const [system, user] = buildScreenshotMessages(["data:a", "data:b"], "Only chats count.")
    expect(system.content).toBe(`Only chats count.\n\n${SCREENSHOT_REPLY_FORMAT}`)
    const parts = user.content as { type: string; text?: string }[]
    expect(parts.filter((p) => p.type === "image_url")).toHaveLength(2)
    expect(parts.map((p) => p.text).filter(Boolean)).toContain("Image 2:")
  })

  it("uses the default instructions when none are saved", () => {
    expect(buildScreenshotMessages(["data:a"], null)[0].content).toContain(DEFAULT_SCREENSHOT_INSTRUCTIONS)
  })
})

describe("parseShotVerdict", () => {
  it("returns one answer per image, in order", () => {
    const text = 'Sure! {"results":[{"photo":2,"screenshot":false,"note":"beach"},{"photo":1,"screenshot":true,"note":"chat"}]}'
    expect(parseShotVerdict(text, 2)).toEqual({
      ok: true,
      value: [{ photo: 1, screenshot: true, note: "chat" }, { photo: 2, screenshot: false, note: "beach" }],
    })
  })

  it("accepts yes/no strings and a missing note", () => {
    const r = parseShotVerdict('{"results":[{"photo":"1","screenshot":"yes"},{"photo":2,"screenshot":"no"}]}', 2)
    expect(r.ok && r.value.map((v) => v.screenshot)).toEqual([true, false])
  })

  it("rejects replies that skip an image or name one that doesn't exist", () => {
    expect(parseShotVerdict('{"results":[{"photo":1,"screenshot":true}]}', 2)).toEqual({ ok: false, error: "no answer for image 2" })
    expect(parseShotVerdict('{"results":[{"photo":3,"screenshot":true}]}', 2).ok).toBe(false)
    expect(parseShotVerdict("no idea", 1).ok).toBe(false)
  })
})
