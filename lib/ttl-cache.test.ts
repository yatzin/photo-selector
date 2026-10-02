import { describe, expect, it } from "vitest"
import { createTtlCache } from "./ttl-cache"

describe("createTtlCache", () => {
  it("reuses a value until it expires", async () => {
    let now = 0
    let calls = 0
    const cache = createTtlCache(1000, () => now)
    const load = async () => ++calls
    expect(await cache.get("k", load)).toBe(1)
    now = 999
    expect(await cache.get("k", load)).toBe(1)
    now = 1001
    expect(await cache.get("k", load)).toBe(2)
  })

  it("shares one in-flight load and forgets failures", async () => {
    const cache = createTtlCache(1000, () => 0)
    let calls = 0
    const slow = () => new Promise<number>((r) => setTimeout(() => r(++calls), 10))
    expect(await Promise.all([cache.get("k", slow), cache.get("k", slow)])).toEqual([1, 1])
    const failing = createTtlCache(1000, () => 0)
    await expect(failing.get("x", async () => { throw new Error("boom") })).rejects.toThrow("boom")
    expect(await failing.get("x", async () => 7)).toBe(7)
  })
})
