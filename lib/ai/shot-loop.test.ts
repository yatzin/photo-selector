import { describe, expect, it } from "vitest"
import { AiError } from "./client"
import { analyzeShots, type ShotDeps } from "./shot-loop"
import { SHOT_PROMPTS } from "./shot-prompt"

function deps(over: Partial<ShotDeps> = {}) {
  const log = { results: [] as { id: string; flagged: boolean }[], failed: [] as string[], gone: [] as string[], calls: 0 }
  const d: ShotDeps = {
    batchSize: 2,
    prompt: SHOT_PROMPTS.screenshots,
    instructions: null,
    prepareImage: async (id) => `data:${id}`,
    callAi: async (messages) => {
      log.calls++
      const n = (messages[1].content as { type: string }[]).filter((p) => p.type === "image_url").length
      return JSON.stringify({ results: Array.from({ length: n }, (_, i) => ({ photo: i + 1, screenshot: i === 0 })) })
    },
    onResults: async (r) => void log.results.push(...r.map(({ id, flagged }) => ({ id, flagged }))),
    onFailed: async (ids) => void log.failed.push(...ids),
    onGone: async (ids) => void log.gone.push(...ids),
    isCancelled: async () => false,
    ...over,
  }
  return { d, log }
}

describe("analyzeShots", () => {
  it("sends images in batches and maps each answer back", async () => {
    const { d, log } = deps()
    expect(await analyzeShots(["a", "b", "c"], d)).toEqual({ status: "done" })
    expect(log.calls).toBe(2)
    expect(log.results).toEqual([{ id: "a", flagged: true }, { id: "b", flagged: false }, { id: "c", flagged: true }])
  })

  it("drops gone images and fails unreadable ones alone, keeping the numbering right", async () => {
    const { d, log } = deps({
      prepareImage: async (id) => {
        if (id === "a") return null
        if (id === "b") throw new Error("unreadable")
        return `data:${id}`
      },
    })
    await analyzeShots(["a", "b", "c"], d)
    expect(log).toMatchObject({ gone: ["a"], failed: ["b"], results: [{ id: "c", flagged: true }] })
  })

  it("retries once on a bad reply, then fails the batch", async () => {
    const { d, log } = deps({ callAi: async () => (log.calls++, "nonsense") })
    await analyzeShots(["a", "b"], d)
    expect(log.calls).toBe(2)
    expect(log.failed).toEqual(["a", "b"])
  })

  it("stops on a bad key and after repeated connection failures", async () => {
    expect(await analyzeShots(["a"], deps({ callAi: async () => { throw new AiError("auth", "bad key") } }).d)).toEqual({ status: "failed", error: "bad key" })
    const { d, log } = deps({ batchSize: 1, callAi: async () => { throw new AiError("network", "down") } })
    expect(await analyzeShots(["a", "b", "c", "d"], d)).toEqual({ status: "failed", error: "AI server unreachable: down" })
    expect(log.failed).toEqual(["a", "b", "c"])
  })

  it("honours cancel", async () => {
    expect(await analyzeShots(["a"], deps({ isCancelled: async () => true }).d)).toEqual({ status: "cancelled" })
  })
})
