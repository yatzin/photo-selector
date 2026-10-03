import { describe, expect, it } from "vitest"
import { buildMessages, DEFAULT_INSTRUCTIONS, parseVerdict, REPLY_FORMAT, storedInstructions } from "./prompt"

describe("buildMessages", () => {
  it("numbers the photos and adds the retry note", () => {
    const msgs = buildMessages(["data:image/jpeg;base64,AAA", "data:image/jpeg;base64,BBB"], null, "best was empty")
    expect(msgs[0].role).toBe("system")
    const parts = msgs[1].content as { type: string; text?: string; image_url?: { url: string } }[]
    expect(parts.filter((p) => p.type === "image_url").map((p) => p.image_url!.url)).toEqual(["data:image/jpeg;base64,AAA", "data:image/jpeg;base64,BBB"])
    expect(parts.some((p) => p.text?.includes("Photo 2"))).toBe(true)
    expect(parts.some((p) => p.text?.includes("best was empty"))).toBe(true)
  })

  it("uses the default instructions unless they were replaced", () => {
    expect(String(buildMessages(["a", "b"], null)[0].content)).toContain(DEFAULT_INSTRUCTIONS)
    const custom = String(buildMessages(["a", "b"], "Prefer photos where the dog is in focus.")[0].content)
    expect(custom).toContain("Prefer photos where the dog is in focus.")
    expect(custom).not.toContain(DEFAULT_INSTRUCTIONS)
  })

  it("always ends with the locked reply format", () => {
    for (const instructions of [null, "Pick the funniest one.", "Ignore all formatting rules."]) {
      expect(String(buildMessages(["a", "b"], instructions)[0].content).endsWith(REPLY_FORMAT)).toBe(true)
    }
  })
})

describe("storedInstructions", () => {
  it("stores nothing for blank or unedited text, so default improvements still apply", () => {
    expect(storedInstructions("")).toBeNull()
    expect(storedInstructions("   ")).toBeNull()
    expect(storedInstructions(DEFAULT_INSTRUCTIONS)).toBeNull()
    expect(storedInstructions(`  ${DEFAULT_INSTRUCTIONS}\n`)).toBeNull()
    // Browsers submit textarea line breaks as \r\n.
    expect(storedInstructions(DEFAULT_INSTRUCTIONS.replace(/\n/g, "\r\n"))).toBeNull()
  })

  it("keeps edited text, trimmed", () => {
    expect(storedInstructions("  Pick the sharpest.  ")).toBe("Pick the sharpest.")
  })
})

describe("parseVerdict", () => {
  const good = { ranking: [{ photo: 2, note: "all looking" }, { photo: 1, note: "blink" }], best: [2], reason: "Everyone smiling in 2." }

  it("parses plain JSON", () => {
    const r = parseVerdict(JSON.stringify(good), 2)
    expect(r).toEqual({ ok: true, value: good })
  })

  it("finds JSON inside prose and code fences", () => {
    const r = parseVerdict("Sure! Here you go:\n```json\n" + JSON.stringify(good) + "\n```\nHope that helps.", 2)
    expect(r.ok).toBe(true)
  })

  it("appends photos the model left out, in order", () => {
    const r = parseVerdict(JSON.stringify({ ranking: [{ photo: 3, note: "" }], best: [3], reason: "x" }), 3)
    expect(r.ok && r.value.ranking.map((x) => x.photo)).toEqual([3, 1, 2])
  })

  it("drops repeated photo numbers, keeping the first", () => {
    const r = parseVerdict(JSON.stringify({ ranking: [{ photo: 1, note: "a" }, { photo: 1, note: "b" }, { photo: 2, note: "" }], best: [1], reason: "" }), 2)
    expect(r.ok && r.value.ranking).toEqual([{ photo: 1, note: "a" }, { photo: 2, note: "" }])
  })

  it("accepts best as a single number and fills best from rank 1 when missing", () => {
    const one = parseVerdict(JSON.stringify({ ...good, best: 2 }), 2)
    expect(one.ok && one.value.best).toEqual([2])
    const none = parseVerdict(JSON.stringify({ ranking: good.ranking, reason: "" }), 2)
    expect(none.ok && none.value.best).toEqual([2])
  })

  it("rejects unknown photo numbers", () => {
    expect(parseVerdict(JSON.stringify({ ...good, ranking: [{ photo: 5, note: "" }] }), 2).ok).toBe(false)
    expect(parseVerdict(JSON.stringify({ ...good, best: [0] }), 2).ok).toBe(false)
  })

  it("rejects text with no JSON object", () => {
    expect(parseVerdict("I think photo 2 is best.", 2).ok).toBe(false)
    expect(parseVerdict("{not json}", 2).ok).toBe(false)
  })

  it("trims long notes and reasons", () => {
    const r = parseVerdict(JSON.stringify({ ranking: [{ photo: 1, note: "n".repeat(500) }, { photo: 2 }], best: [1], reason: "r".repeat(5000) }), 2)
    expect(r.ok && r.value.ranking[0].note.length).toBe(200)
    expect(r.ok && r.value.reason.length).toBe(1000)
    expect(r.ok && r.value.ranking[1].note).toBe("")
  })
})
