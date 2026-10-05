import { describe, expect, it } from "vitest"
import { buildShotMessages, DEFAULT_QUALITY_INSTRUCTIONS, parseShotVerdict, SCREENSHOT_REPLY_FORMAT, SHOT_PROMPTS } from "./shot-prompt"

const shots = SHOT_PROMPTS.screenshots
const quality = SHOT_PROMPTS.quality

describe("buildShotMessages", () => {
  it("numbers the images and always appends the reply format", () => {
    const [system, user] = buildShotMessages(shots, ["data:a", "data:b"], "Only chats count.")
    expect(system.content).toBe(`Only chats count.\n\n${SCREENSHOT_REPLY_FORMAT}`)
    const parts = user.content as { type: string; text?: string }[]
    expect(parts.filter((p) => p.type === "image_url")).toHaveLength(2)
    expect(parts.map((p) => p.text).filter(Boolean)).toContain("Image 2:")
  })

  it("uses the scan's default instructions when none are saved", () => {
    expect(buildShotMessages(quality, ["data:a"], null)[0].content).toContain(DEFAULT_QUALITY_INSTRUCTIONS)
    expect(buildShotMessages(quality, ["data:a"], null)[0].content).toContain('"bad"')
  })
})

describe("parseShotVerdict", () => {
  it("returns one answer per image, in order", () => {
    const text = 'Sure! {"results":[{"photo":2,"screenshot":false,"note":"beach"},{"photo":1,"screenshot":true,"note":"chat"}]}'
    expect(parseShotVerdict(shots, text, 2)).toEqual({
      ok: true,
      value: [{ photo: 1, flagged: true, note: "chat" }, { photo: 2, flagged: false, note: "beach" }],
    })
  })

  it("reads the yes/no field the scan asked for", () => {
    const r = parseShotVerdict(quality, '{"results":[{"photo":1,"bad":true,"note":"motion blur"}]}', 1)
    expect(r).toEqual({ ok: true, value: [{ photo: 1, flagged: true, note: "motion blur" }] })
    expect(parseShotVerdict(quality, '{"results":[{"photo":1,"screenshot":true}]}', 1).ok).toBe(false)
  })

  it("accepts yes/no strings and a missing note", () => {
    const r = parseShotVerdict(shots, '{"results":[{"photo":"1","screenshot":"yes"},{"photo":2,"screenshot":"no"}]}', 2)
    expect(r.ok && r.value.map((v) => v.flagged)).toEqual([true, false])
  })

  it("rejects replies that skip an image or name one that doesn't exist", () => {
    expect(parseShotVerdict(shots, '{"results":[{"photo":1,"screenshot":true}]}', 2)).toEqual({ ok: false, error: "no answer for image 2" })
    expect(parseShotVerdict(shots, '{"results":[{"photo":3,"screenshot":true}]}', 2).ok).toBe(false)
    expect(parseShotVerdict(shots, "no idea", 1).ok).toBe(false)
  })
})
