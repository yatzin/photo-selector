import { describe, expect, it } from "vitest"
import { clientIp, createLoginThrottle } from "./login-throttle"

function clock(start = 0) {
  let t = start
  return { now: () => t, advance: (ms: number) => (t += ms) }
}

describe("createLoginThrottle", () => {
  const opts = { perEmail: 3, perIp: 5, windowMs: 1000 }

  it("allows attempts below the email limit", () => {
    const c = clock()
    const t = createLoginThrottle({ ...opts, now: c.now })
    t.recordFailure("a@x.com", "1.1.1.1")
    t.recordFailure("a@x.com", "1.1.1.1")
    expect(t.isBlocked("a@x.com", "1.1.1.1")).toBe(false)
  })

  it("blocks an email after too many failures, from any address", () => {
    const c = clock()
    const t = createLoginThrottle({ ...opts, now: c.now })
    for (const ip of ["1.1.1.1", "2.2.2.2", "3.3.3.3"]) t.recordFailure("a@x.com", ip)
    expect(t.isBlocked("a@x.com", "9.9.9.9")).toBe(true)
    expect(t.isBlocked("b@x.com", "9.9.9.9")).toBe(false)
  })

  it("treats email case and spacing as the same account", () => {
    const c = clock()
    const t = createLoginThrottle({ ...opts, now: c.now })
    t.recordFailure("A@x.com", "1.1.1.1")
    t.recordFailure(" a@X.com ", "2.2.2.2")
    t.recordFailure("a@x.com", "3.3.3.3")
    expect(t.isBlocked("a@x.com", "4.4.4.4")).toBe(true)
  })

  it("blocks an address that tries many different emails", () => {
    const c = clock()
    const t = createLoginThrottle({ ...opts, now: c.now })
    for (let i = 0; i < 5; i++) t.recordFailure(`u${i}@x.com`, "1.1.1.1")
    expect(t.isBlocked("new@x.com", "1.1.1.1")).toBe(true)
    expect(t.isBlocked("new@x.com", "2.2.2.2")).toBe(false)
  })

  it("lets attempts through again once the window has passed", () => {
    const c = clock()
    const t = createLoginThrottle({ ...opts, now: c.now })
    for (let i = 0; i < 3; i++) t.recordFailure("a@x.com", "1.1.1.1")
    c.advance(1001)
    expect(t.isBlocked("a@x.com", "1.1.1.1")).toBe(false)
  })

  it("clears an email's failures after a successful sign-in", () => {
    const c = clock()
    const t = createLoginThrottle({ ...opts, now: c.now })
    t.recordFailure("a@x.com", "1.1.1.1")
    t.recordFailure("a@x.com", "1.1.1.1")
    t.recordSuccess("a@x.com")
    t.recordFailure("a@x.com", "1.1.1.1")
    expect(t.isBlocked("a@x.com", "1.1.1.1")).toBe(false)
  })
})

describe("clientIp", () => {
  it("takes the address the proxy appended last to X-Forwarded-For", () => {
    // A client can put anything in the header; only the last hop is the proxy's own.
    expect(clientIp(new Headers({ "x-forwarded-for": "6.6.6.6, 203.0.113.9" }))).toBe("203.0.113.9")
  })

  it("falls back to X-Real-IP", () => {
    expect(clientIp(new Headers({ "x-real-ip": "203.0.113.9" }))).toBe("203.0.113.9")
  })

  it("returns a fixed key when no address is known", () => {
    expect(clientIp(new Headers())).toBe("unknown")
  })
})
