import { describe, expect, it } from "vitest"
import { resolveSection, settingsHref, visibleSections } from "./settings-sections"

describe("settings sections", () => {
  it("shows only personal settings to non-admins", () => {
    expect(visibleSections(false).map((s) => s.id)).toEqual(["account"])
    expect(visibleSections(true).map((s) => s.id)).toEqual(["account", "storage", "users"])
  })

  it("opens the requested section, falling back to the first", () => {
    expect(resolveSection("storage", true).id).toBe("storage")
    expect(resolveSection(["users", "storage"], true).id).toBe("users")
    expect(resolveSection(undefined, true).id).toBe("account")
    expect(resolveSection("nonsense", true).id).toBe("account")
  })

  it("never opens an admin section for a non-admin", () => {
    expect(resolveSection("users", false).id).toBe("account")
  })

  it("builds links", () => {
    expect(settingsHref("storage")).toBe("/settings?tab=storage")
  })
})
