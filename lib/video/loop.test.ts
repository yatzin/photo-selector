import { describe, expect, it } from "vitest"
import { endAction } from "./loop"

describe("endAction", () => {
  it("continues before the end", () => {
    expect(endAction(3, 10, 0.04, false)).toBe("continue")
    expect(endAction(3, 10, 0.04, true)).toBe("continue")
  })
  it("stops at the end without loop", () => {
    expect(endAction(9.97, 10, 0.04, false)).toBe("stop")
    expect(endAction(12, 10, 0.04, false)).toBe("stop")
  })
  it("restarts at the end with loop", () => {
    expect(endAction(9.97, 10, 0.04, true)).toBe("restart")
    expect(endAction(10, 10, 0.04, true)).toBe("restart")
  })
  it("never restarts an empty timeline", () => {
    expect(endAction(0, 0, 0.04, true)).toBe("stop")
  })
})
