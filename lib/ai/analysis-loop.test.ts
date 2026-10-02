import { describe, expect, it } from "vitest"
import { AiError } from "./client"
import { analyzeGroups, type LoopDeps } from "./analysis-loop"

const verdict = (best = 1) => JSON.stringify({ ranking: [{ photo: 1, note: "" }, { photo: 2, note: "" }], best: [best], reason: "ok" })
const groups = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `g${i}`, photoCount: 2 }))

function deps(replies: (string | Error)[], extra: Partial<LoopDeps> = {}) {
  const analyzed: string[] = []
  const failed: { id: string; error: string }[] = []
  let call = 0
  const d: LoopDeps = {
    prepareImages: async () => ["data:a", "data:b"],
    callAi: async () => {
      const r = replies[Math.min(call++, replies.length - 1)]
      if (r instanceof Error) throw r
      return r
    },
    onAnalyzed: async (id) => void analyzed.push(id),
    onFailed: async (id, error) => void failed.push({ id, error }),
    isCancelled: async () => false,
    checkFolder: async () => null,
    customPrompt: null,
    ...extra,
  }
  return { d, analyzed, failed, calls: () => call }
}

describe("analyzeGroups", () => {
  it("analyzes every group", async () => {
    const { d, analyzed } = deps([verdict()])
    expect(await analyzeGroups(groups(3), d)).toEqual({ status: "done" })
    expect(analyzed).toEqual(["g0", "g1", "g2"])
  })

  it("asks again once after an unusable reply", async () => {
    const { d, analyzed, calls } = deps(["no json here", verdict()])
    await analyzeGroups(groups(1), d)
    expect(analyzed).toEqual(["g0"])
    expect(calls()).toBe(2)
  })

  it("fails the group after two unusable replies and moves on", async () => {
    const { d, analyzed, failed } = deps(["nope", "still nope", verdict()])
    expect(await analyzeGroups(groups(2), d)).toEqual({ status: "done" })
    expect(failed.map((f) => f.id)).toEqual(["g0"])
    expect(analyzed).toEqual(["g1"])
  })

  it("stops the run after 3 groups in a row can't reach the server", async () => {
    const { d, failed } = deps([new AiError("network", "down")])
    const out = await analyzeGroups(groups(5), d)
    expect(out.status).toBe("failed")
    expect(out.status === "failed" && out.error).toMatch(/unreachable/i)
    expect(failed).toHaveLength(3)
  })

  it("resets the unreachable count after a success", async () => {
    const down = new AiError("timeout", "slow")
    const { d } = deps([down, down, verdict(), down, down, verdict()])
    expect((await analyzeGroups(groups(4), d)).status).toBe("done")
  })

  it("stops at once on a bad key or unknown model", async () => {
    const { d, failed } = deps([new AiError("auth", "bad key")])
    expect(await analyzeGroups(groups(3), d)).toEqual({ status: "failed", error: "bad key" })
    expect(failed).toHaveLength(0)
  })

  it("fails only the group when the model rejects images, and keeps going", async () => {
    const { d, failed, analyzed } = deps([new AiError("bad-request", "images not supported"), verdict(), verdict()])
    expect((await analyzeGroups(groups(3), d)).status).toBe("done")
    expect(failed.map((f) => f.id)).toEqual(["g0"])
    expect(analyzed).toEqual(["g1", "g2"])
  })

  it("fails a group whose photos can't be prepared, without counting it as unreachable", async () => {
    let n = 0
    const { d, failed } = deps([verdict()], { prepareImages: async () => { if (n++ === 0) throw new Error("photo gone"); return ["a", "b"] } })
    expect((await analyzeGroups(groups(2), d)).status).toBe("done")
    expect(failed[0]).toEqual({ id: "g0", error: "photo gone" })
  })

  it("stops between groups when cancelled", async () => {
    let checks = 0
    const { d, analyzed } = deps([verdict()], { isCancelled: async () => ++checks > 1 })
    expect(await analyzeGroups(groups(3), d)).toEqual({ status: "cancelled" })
    expect(analyzed).toEqual(["g0"])
  })

  it("treats an aborted request as cancelled", async () => {
    const { d } = deps([new AiError("cancelled", "Cancelled.")])
    expect(await analyzeGroups(groups(2), d)).toEqual({ status: "cancelled" })
  })

  it("stops before the next group when the folder changed underneath it", async () => {
    let checks = 0
    const { d, analyzed } = deps([verdict()], { checkFolder: async () => (++checks > 1 ? "The folder changed outside the app" : null) })
    expect(await analyzeGroups(groups(3), d)).toEqual({ status: "failed", error: "The folder changed outside the app" })
    expect(analyzed).toEqual(["g0"])
  })
})
