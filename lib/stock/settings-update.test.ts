import { describe, expect, it } from "vitest"
import { resolveStockUpdate } from "./settings-update"

const enc = (s: string) => `enc(${s})`

describe("resolveStockUpdate", () => {
  it("keeps everything when nothing is supplied", () => {
    expect(resolveStockUpdate({}, enc)).toEqual({})
  })

  it("encrypts a supplied key and leaves the others alone", () => {
    expect(resolveStockUpdate({ pixabayKey: "abc" }, enc)).toEqual({ pixabayKeyEnc: "enc(abc)" })
  })

  it("clears a key, and the clear flag wins over a supplied key", () => {
    expect(resolveStockUpdate({ pexelsKey: "x", clearPexelsKey: true }, enc)).toEqual({ pexelsKeyEnc: null })
  })

  it("stores a plain client ID", () => {
    expect(resolveStockUpdate({ openverseClientId: "id1" }, enc)).toEqual({ openverseClientId: "id1" })
  })

  it("clearing the Openverse secret also clears the client ID", () => {
    expect(resolveStockUpdate({ clearOpenverseSecret: true, openverseClientId: "id1" }, enc)).toEqual({
      openverseClientSecretEnc: null,
      openverseClientId: null,
    })
    expect(resolveStockUpdate({ clearOpenverseSecret: true }, enc)).toEqual({
      openverseClientSecretEnc: null,
      openverseClientId: null,
    })
  })
})
