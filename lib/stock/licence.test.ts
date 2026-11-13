import { describe, expect, it } from "vitest"
import { isOpenLicence } from "./licence"

describe("isOpenLicence", () => {
  it.each(["cc0", "CC0", " pdm ", "PDM"])("accepts %j", (v) => expect(isOpenLicence(v)).toBe(true))
  it.each(["by", "by-sa", "by-nc", "cc0-1.0x", "", "  ", undefined, null, 0, {}])("rejects %j", (v) =>
    expect(isOpenLicence(v)).toBe(false),
  )
})
