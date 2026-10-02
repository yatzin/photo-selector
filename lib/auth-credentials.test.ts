import { describe, expect, it, vi } from "vitest"
import { DUMMY_HASH, verifyLogin, type LoginDeps } from "./auth-credentials"
import { createLoginThrottle } from "./login-throttle"

const user = { id: "u1", name: "Mike", email: "a@x.com", role: "ADMIN", mustResetPassword: false, sessionVersion: 4, passwordHash: "$2b$12$real" }

function deps(over: Partial<LoginDeps> = {}): LoginDeps {
  return {
    findUser: vi.fn(async (email: string) => (email === user.email ? user : null)),
    compare: vi.fn(async (pw: string, hash: string) => pw === "right" && hash === user.passwordHash),
    throttle: createLoginThrottle({ perEmail: 2, perIp: 10, windowMs: 60_000 }),
    ...over,
  }
}

describe("verifyLogin", () => {
  it("signs in with the right password", async () => {
    const r = await verifyLogin({ email: "a@x.com", password: "right" }, "1.1.1.1", deps())
    expect(r).toEqual({ status: "ok", user: { id: "u1", name: "Mike", email: "a@x.com", role: "ADMIN", mustResetPassword: false, sessionVersion: 4 } })
  })

  it("rejects a wrong password", async () => {
    const r = await verifyLogin({ email: "a@x.com", password: "wrong" }, "1.1.1.1", deps())
    expect(r.status).toBe("invalid")
  })

  it("still checks a password when the email has no account, so both take as long", async () => {
    const d = deps()
    const r = await verifyLogin({ email: "nobody@x.com", password: "x" }, "1.1.1.1", d)
    expect(r.status).toBe("invalid")
    expect(d.compare).toHaveBeenCalledWith("x", DUMMY_HASH)
  })

  it("rejects malformed input without looking anything up", async () => {
    const d = deps()
    const r = await verifyLogin({ email: "", password: "" }, "1.1.1.1", d)
    expect(r.status).toBe("invalid")
    expect(d.findUser).not.toHaveBeenCalled()
  })

  it("refuses further attempts once the limit is reached, even with the right password", async () => {
    const d = deps()
    await verifyLogin({ email: "a@x.com", password: "wrong" }, "1.1.1.1", d)
    await verifyLogin({ email: "a@x.com", password: "wrong" }, "1.1.1.1", d)
    const r = await verifyLogin({ email: "a@x.com", password: "right" }, "1.1.1.1", d)
    expect(r.status).toBe("throttled")
  })

  it("does not check the password at all while throttled", async () => {
    const d = deps()
    await verifyLogin({ email: "a@x.com", password: "wrong" }, "1.1.1.1", d)
    await verifyLogin({ email: "a@x.com", password: "wrong" }, "1.1.1.1", d)
    vi.mocked(d.compare).mockClear()
    await verifyLogin({ email: "a@x.com", password: "right" }, "1.1.1.1", d)
    expect(d.compare).not.toHaveBeenCalled()
  })

  it("counts attempts on unknown emails too", async () => {
    const d = deps()
    await verifyLogin({ email: "nobody@x.com", password: "x" }, "1.1.1.1", d)
    await verifyLogin({ email: "nobody@x.com", password: "x" }, "1.1.1.1", d)
    const r = await verifyLogin({ email: "nobody@x.com", password: "x" }, "1.1.1.1", d)
    expect(r.status).toBe("throttled")
  })
})
