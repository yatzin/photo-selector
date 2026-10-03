import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { decrypt, encrypt } from "./secret-box"

describe("secret box", () => {
  const original = process.env.AUTH_SECRET
  beforeEach(() => void (process.env.AUTH_SECRET = "test-secret-one"))
  afterEach(() => void (process.env.AUTH_SECRET = original))

  it("round-trips a value", () => {
    const enc = encrypt("sk-abc123")
    expect(enc).not.toContain("sk-abc123")
    expect(decrypt(enc)).toBe("sk-abc123")
  })

  it("returns null when AUTH_SECRET changed", () => {
    const enc = encrypt("sk-abc123")
    process.env.AUTH_SECRET = "a-different-secret"
    expect(decrypt(enc)).toBeNull()
  })

  it("returns null for garbage", () => {
    expect(decrypt("nonsense")).toBeNull()
  })
})
