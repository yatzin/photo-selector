import { describe, expect, it } from "vitest"
import { checkPasswordChange } from "./password-change"

const compare = async (pw: string, hash: string) => hash === `hash:${pw}`
const account = { mustResetPassword: false, passwordHash: "hash:old-password-123" }
const good = "a-long-new-password"

describe("checkPasswordChange", () => {
  it("accepts a long new password with the right current one", async () => {
    expect(await checkPasswordChange({ current: "old-password-123", next: good, confirm: good }, account, compare)).toBeNull()
  })

  it("requires the current password", async () => {
    expect(await checkPasswordChange({ current: "", next: good, confirm: good }, account, compare)).toBe("wrong-current")
  })

  it("rejects a wrong current password", async () => {
    expect(await checkPasswordChange({ current: "guess", next: good, confirm: good }, account, compare)).toBe("wrong-current")
  })

  it("skips the current password on a forced reset, where the temporary one was just used", async () => {
    const forced = { ...account, mustResetPassword: true }
    expect(await checkPasswordChange({ current: "", next: good, confirm: good }, forced, compare)).toBeNull()
  })

  it("accepts a short password: there are no length rules", async () => {
    expect(await checkPasswordChange({ current: "old-password-123", next: "abc", confirm: "abc" }, account, compare)).toBeNull()
  })

  it("rejects a blank password", async () => {
    expect(await checkPasswordChange({ current: "old-password-123", next: "", confirm: "" }, account, compare)).toBe("empty")
  })

  it("rejects a confirmation that doesn't match", async () => {
    expect(await checkPasswordChange({ current: "old-password-123", next: good, confirm: `${good}!` }, account, compare)).toBe("mismatch")
  })
})
