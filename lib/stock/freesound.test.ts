import http from "http"
import type { AddressInfo } from "net"
import { afterEach, describe, expect, it } from "vitest"
import { createFreesound } from "./freesound"

let server: http.Server | null = null
let seen: { url: string; auth?: string }[] = []

async function start(handler: (req: http.IncomingMessage, res: http.ServerResponse, url: URL) => void) {
  seen = []
  server = http.createServer((req, res) => {
    seen.push({ url: req.url ?? "", auth: req.headers.authorization })
    handler(req, res, new URL(req.url ?? "/", "http://x"))
  })
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}
function json(res: http.ServerResponse, body: unknown, status = 200) {
  res.writeHead(status, { "content-type": "application/json" })
  res.end(JSON.stringify(body))
}
afterEach(async () => {
  if (server) await new Promise((r) => server!.close(r))
  server = null
})

const KEY = "FREESOUNDSECRET99"
const CC0 = "http://creativecommons.org/publicdomain/zero/1.0/"
const sound = (o: Record<string, unknown> = {}) => ({
  id: 4321,
  name: "Calm   piano loop",
  duration: 42.5,
  url: "https://freesound.org/people/x/sounds/4321/",
  license: CC0,
  previews: { "preview-hq-mp3": "https://cdn.freesound.org/previews/4/4321_hq.mp3", "preview-lq-mp3": "https://cdn.freesound.org/previews/4/4321_lq.mp3" },
  ...o,
})

describe("freesound", () => {
  it("configured() reflects the key", () => {
    expect(createFreesound({ key: null }).configured()).toBe(false)
    expect(createFreesound({ key: "" }).configured()).toBe(false)
    expect(createFreesound({ key: KEY }).configured()).toBe(true)
  })

  it("searches CC0 with the key in a header (never the URL) and maps audio results", async () => {
    const base = await start((_q, res) => json(res, { count: 50, next: "https://x/next", results: [sound()] }))
    const c = createFreesound({ baseUrl: base, key: KEY })
    const page = await c.search({ query: "piano", kind: "audio", cursor: null })
    const u = new URL(seen[0].url, "http://x")
    expect(u.pathname).toBe("/apiv2/search/text/")
    expect(u.searchParams.get("query")).toBe("piano")
    expect(u.searchParams.get("filter")).toBe('license:"Creative Commons 0"')
    expect(seen[0].url).not.toContain(KEY)
    expect(seen[0].auth).toBe(`Token ${KEY}`)
    expect(page.next).toBe("2")
    expect(page.results).toEqual([
      { source: "freesound", id: "4321", kind: "audio", title: "Calm   piano loop", thumbUrl: "", pageUrl: "https://freesound.org/people/x/sounds/4321/", duration: 42.5 },
    ])
  })

  it("drops results that are not CC0 or have no preview, and ends paging when there is no next page", async () => {
    const base = await start((_q, res) =>
      json(res, {
        count: 3,
        next: null,
        results: [sound({ id: 1, license: "http://creativecommons.org/licenses/by/4.0/" }), sound({ id: 2, previews: {} }), sound({ id: 3, license: undefined }), sound({ id: 4 })],
      }),
    )
    const c = createFreesound({ baseUrl: base, key: KEY })
    const page = await c.search({ query: "x", kind: "all", cursor: null })
    expect(page.results.map((r) => r.id)).toEqual(["4"])
    expect(page.next).toBeNull()
  })

  it("has nothing for a search limited to another media type", async () => {
    const base = await start((_q, res) => json(res, {}))
    const c = createFreesound({ baseUrl: base, key: KEY })
    expect(await c.search({ query: "x", kind: "image", cursor: null })).toEqual({ results: [], next: null })
    expect(seen).toHaveLength(0)
  })

  it("never puts the key in an error, and maps 429", async () => {
    const base = await start((_q, res) => json(res, {}, 429))
    const c = createFreesound({ baseUrl: base, key: KEY })
    await expect(c.search({ query: "x", kind: "audio", cursor: null })).rejects.toThrow(/rate limit/i)
    const dead = createFreesound({ baseUrl: "http://127.0.0.1:1", key: KEY })
    const e = await dead.search({ query: "x", kind: "audio", cursor: null }).catch((err: Error) => err)
    expect((e as Error).message).toMatch(/Freesound request failed/)
    expect((e as Error).message).not.toContain(KEY)
  })

  it("resolves a CC0 sound to its hq mp3 preview, and refuses anything else", async () => {
    const base = await start((_q, res, url) => json(res, url.pathname.includes("/999/") ? sound({ license: "http://creativecommons.org/licenses/by/4.0/" }) : sound()))
    const c = createFreesound({ baseUrl: base, key: KEY })
    expect(await c.resolve({ source: "freesound", id: "4321", kind: "audio" })).toEqual({
      url: "https://cdn.freesound.org/previews/4/4321_hq.mp3",
      fileName: "freesound-4321.mp3",
      gif: false,
      title: "Calm piano loop",
      pageUrl: "https://freesound.org/people/x/sounds/4321/",
    })
    await expect(c.resolve({ source: "freesound", id: "999", kind: "audio" })).rejects.toThrow("Not CC0 / public domain")
    await expect(c.resolve({ source: "freesound", id: "abc", kind: "audio" })).rejects.toThrow("Invalid Freesound id")
    await expect(c.resolve({ source: "freesound", id: "1", kind: "image" })).rejects.toThrow()
  })
})
