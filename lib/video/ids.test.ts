import { describe, expect, it } from "vitest"
import { newId } from "./ids"

describe("newId", () => {
  it("is 32 hex characters and differs between calls", () => {
    const a = newId()
    expect(a).toMatch(/^[0-9a-f]{32}$/)
    expect(newId()).not.toBe(a)
  })
})
