import { describe, expect, it } from "vitest"
import { formatTimecode } from "./time"

describe("formatTimecode", () => {
  it("formats minutes, seconds and tenths", () => {
    expect(formatTimecode(0)).toBe("0:00.0")
    expect(formatTimecode(5)).toBe("0:05.0")
    expect(formatTimecode(83.4)).toBe("1:23.4")
  })
  it("treats negative and non-finite input as zero", () => {
    expect(formatTimecode(-3)).toBe("0:00.0")
    expect(formatTimecode(NaN)).toBe("0:00.0")
  })
})
