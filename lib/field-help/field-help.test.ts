import { describe, expect, it } from "vitest"
import { readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"
import { FIELD_HELP } from "./index"
import { HELP_LIMITS } from "./types"

const root = path.resolve(__dirname, "../..")

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) return name === "generated" || name === "node_modules" || name === "field-help" ? [] : sourceFiles(full)
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [full] : []
  })
}

/** Every literal id used as help="…", help: "…" or <FieldHelp id="…"> in app code. */
function usedIds(): Map<string, string[]> {
  const found = new Map<string, string[]>()
  for (const dir of ["app", "components", "lib"]) {
    for (const file of sourceFiles(path.join(root, dir))) {
      const src = readFileSync(file, "utf8")
      for (const m of src.matchAll(/(?:\bhelp(?:=|:)|<FieldHelp\s+id=)\s*\{?\s*["']([a-z0-9.-]+)["']/g)) {
        found.set(m[1], [...(found.get(m[1]) ?? []), path.relative(root, file)])
      }
    }
  }
  return found
}

// The copy rules from types.ts and the project's voice rules, as checks.
const BANNED = [
  "delve", "leverage", "robust", "seamless", "comprehensive", "holistic", "pivotal", "foster", "bolster", "harness", "unpack",
  "innovative", "transformative", "cutting-edge", "game-changing", "multifaceted", "vibrant", "intricate", "testament", "realm", "landscape",
  "allows you to", "helps you", "lets you", "ensures", "it's important", "it's worth noting", "in order to", "utilize", "streamline",
]

describe("field help", () => {
  const entries = Object.entries(FIELD_HELP)

  it("ids look like area.field", () => {
    for (const [id] of entries) expect(id, id).toMatch(/^[a-z0-9]+(\.[a-z0-9-]+)+$/)
  })

  it("every entry is complete and short enough to read quickly", () => {
    for (const [id, e] of entries) {
      expect(e.title.trim().length, `${id} title`).toBeGreaterThan(0)
      expect(e.title.length, `${id} title`).toBeLessThanOrEqual(HELP_LIMITS.title)
      expect(e.what.trim().length, `${id} what`).toBeGreaterThan(0)
      expect(e.what.length, `${id} what`).toBeLessThanOrEqual(HELP_LIMITS.what)
      if (e.use !== undefined) {
        expect(e.use.trim().length, `${id} use`).toBeGreaterThan(0)
        expect(e.use.length, `${id} use`).toBeLessThanOrEqual(HELP_LIMITS.use)
      }
      if (e.values) {
        expect(e.values.length, `${id} values`).toBeGreaterThan(1)
        expect(e.values.length, `${id} values`).toBeLessThanOrEqual(HELP_LIMITS.values)
        for (const v of e.values) {
          expect(v.label.length, `${id} value label`).toBeLessThanOrEqual(HELP_LIMITS.valueLabel)
          expect(v.effect.trim().length, `${id} ${v.label}`).toBeGreaterThan(0)
          expect(v.effect.length, `${id} ${v.label}`).toBeLessThanOrEqual(HELP_LIMITS.valueEffect)
        }
      }
    }
  })

  it("reads like plain talk: no banned words, no em dashes", () => {
    for (const [id, e] of entries) {
      const text = [e.title, e.what, e.use ?? "", ...(e.values ?? []).flatMap((v) => [v.label, v.effect])].join(" \n ").toLowerCase()
      expect(text.includes("—"), `${id} has an em dash`).toBe(false)
      for (const word of BANNED) expect(text.includes(word), `${id} uses "${word}"`).toBe(false)
    }
  })

  it("every id used in a form has an entry, and every entry is used", () => {
    const used = usedIds()
    const missing = [...used.keys()].filter((id) => !(id in FIELD_HELP))
    expect(missing, `help ids with no entry: ${missing.join(", ")}`).toEqual([])
    const orphans = Object.keys(FIELD_HELP).filter((id) => !used.has(id))
    expect(orphans, `entries no form uses: ${orphans.join(", ")}`).toEqual([])
  })
})
