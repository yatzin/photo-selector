import { describe, expect, it } from "vitest"
import { contentSecurityPolicy, securityHeaderRules } from "./security-headers"

const header = (rules: ReturnType<typeof securityHeaderRules>, source: string, key: string) =>
  rules.find((r) => r.source === source)?.headers.find((h) => h.key === key)?.value

describe("contentSecurityPolicy", () => {
  it("forbids being framed by another site", () => {
    expect(contentSecurityPolicy(false)).toContain("frame-ancestors 'none'")
  })

  it("keeps scripts, connections and forms on this site", () => {
    const csp = contentSecurityPolicy(false)
    expect(csp).toContain("default-src 'self'")
    expect(csp).toContain("connect-src 'self'")
    expect(csp).toContain("form-action 'self'")
    expect(csp).toContain("object-src 'none'")
  })

  it("allows eval only in development, where React needs it", () => {
    expect(contentSecurityPolicy(false)).not.toContain("unsafe-eval")
    expect(contentSecurityPolicy(true)).toContain("'unsafe-eval'")
  })
})

describe("securityHeaderRules", () => {
  const rules = securityHeaderRules(false)

  it("sends the hardening headers on every response", () => {
    expect(header(rules, "/:path*", "Strict-Transport-Security")).toMatch(/max-age=\d+/)
    expect(header(rules, "/:path*", "X-Frame-Options")).toBe("DENY")
    expect(header(rules, "/:path*", "X-Content-Type-Options")).toBe("nosniff")
    expect(header(rules, "/:path*", "Referrer-Policy")).toBe("strict-origin-when-cross-origin")
  })

  it("applies the content policy everywhere", () => {
    expect(header(rules, "/:path*", "Content-Security-Policy")).toBe(contentSecurityPolicy(false))
  })
})
