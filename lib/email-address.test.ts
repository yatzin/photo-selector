import { describe, expect, it } from "vitest"
import { emailAddress, isEmailAddress } from "./email-address"

describe("emailAddress", () => {
  it("accepts an ordinary address and trims spaces around it", () => {
    expect(emailAddress.parse("  mike@example.com ")).toBe("mike@example.com")
  })

  it("keeps the case as typed, since sign-in matches the stored address exactly", () => {
    expect(emailAddress.parse("Mike@Example.com")).toBe("Mike@Example.com")
  })

  it("rejects an address that smuggles in another recipient", () => {
    expect(emailAddress.safeParse("victim@x.com>\r\nBcc: attacker@evil.com").success).toBe(false)
    expect(emailAddress.safeParse("a@x.com, attacker@evil.com").success).toBe(false)
    expect(emailAddress.safeParse("Group: attacker@evil.com;").success).toBe(false)
  })

  it("rejects text that isn't an address", () => {
    expect(emailAddress.safeParse("").success).toBe(false)
    expect(emailAddress.safeParse("admin").success).toBe(false)
  })

  it("rejects an address longer than mail allows", () => {
    expect(emailAddress.safeParse(`${"a".repeat(250)}@x.com`).success).toBe(false)
  })
})

describe("isEmailAddress", () => {
  it("is the same rule, for checking a stored address before sending", () => {
    expect(isEmailAddress("mike@example.com")).toBe(true)
    expect(isEmailAddress("a@x.com>\r\nBcc: e@f.g")).toBe(false)
  })
})
