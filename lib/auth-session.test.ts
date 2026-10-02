import { describe, expect, it } from "vitest"
import { refreshClaims } from "./auth-session"

const token = { id: "u1", role: "ADMIN", mustResetPassword: false, sessionVersion: 2 }

describe("refreshClaims", () => {
  it("ends the session when the account no longer exists", () => {
    expect(refreshClaims(token, null)).toBeNull()
  })

  it("ends the session when the account's sessions were revoked since sign-in", () => {
    expect(refreshClaims(token, { role: "ADMIN", mustResetPassword: false, sessionVersion: 3 })).toBeNull()
  })

  it("takes the role from the account, not the token", () => {
    expect(refreshClaims(token, { role: "USER", mustResetPassword: false, sessionVersion: 2 })?.role).toBe("USER")
  })

  it("takes the forced-reset flag from the account", () => {
    expect(refreshClaims(token, { role: "ADMIN", mustResetPassword: true, sessionVersion: 2 })?.mustResetPassword).toBe(true)
  })

  it("keeps tokens issued before versions existed valid while the account is still on version 0", () => {
    const old = { id: "u1", role: "ADMIN", mustResetPassword: false }
    expect(refreshClaims(old, { role: "ADMIN", mustResetPassword: false, sessionVersion: 0 })).not.toBeNull()
    expect(refreshClaims(old, { role: "ADMIN", mustResetPassword: false, sessionVersion: 1 })).toBeNull()
  })
})
