import http from "http"
import type { AddressInfo } from "net"
import { afterEach, describe, expect, it } from "vitest"
import { createPexels } from "./pexels"

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

const KEY = "PEXELSSECRET99"
const photo = (o: Record<string, unknown> = {}) => ({
  id: 2014422,
  width: 3024,
  height: 3024,
  url: "https://www.pexels.com/photo/x-2014422/",
  alt: "Brown rocks",
  src: {
    original: "https://images.pexels.com/photos/2014422/o.jpeg",
    large2x: "https://images.pexels.com/photos/2014422/l2.jpeg",
    large: "https://images.pexels.com/photos/2014422/l.jpeg",
    medium: "https://images.pexels.com/photos/2014422/m.jpeg",
    small: "https://images.pexels.com/photos/2014422/s.jpeg",
    tiny: "https://images.pexels.com/photos/2014422/t.jpeg",
  },
  ...o,
})
const video = (o: Record<string, unknown> = {}) => ({
  id: 3571264,
  width: 3840,
  height: 2160,
  duration: 15,
  url: "https://www.pexels.com/video/x-3571264/",
  image: "https://images.pexels.com/videos/3571264/pic.jpeg",
  video_files: [
    { id: 1, quality: "hd", file_type: "video/mp4", width: 3840, height: 2160, link: "https://v/uhd.mp4" },
    { id: 2, quality: "hd", file_type: "video/mp4", width: 1920, height: 1080, link: "https://v/hd.mp4" },
    { id: 3, quality: "sd", file_type: "video/mp4", width: 640, height: 360, link: "https://v/sd.mp4" },
  ],
  ...o,
})

describe("pexels", () => {
  it("configured() reflects the key", () => {
    expect(createPexels({ key: null }).configured()).toBe(false)
    expect(createPexels({ key: "" }).configured()).toBe(false)
    expect(createPexels({ key: KEY }).configured()).toBe(true)
  })

  it("searches photos with Authorization header and maps results", async () => {
    const base = await start((_q, res) => json(res, { total_results: 50, next_page: "x", photos: [photo()] }))
    const c = createPexels({ baseUrl: base, key: KEY })
    const page = await c.search({ query: "rocks", kind: "image", cursor: null })
    const u = new URL(seen[0].url, "http://x")
    expect(u.pathname).toBe("/v1/search")
    expect(seen[0].auth).toBe(KEY)
    expect(u.searchParams.get("query")).toBe("rocks")
    expect(u.searchParams.get("page")).toBe("1")
    expect(u.searchParams.get("per_page")).toBe("20")
    expect(u.search).not.toContain(KEY)
    expect(page.results).toEqual([
      {
        source: "pexels",
        id: "2014422",
        kind: "image",
        title: "Brown rocks",
        thumbUrl: "https://images.pexels.com/photos/2014422/m.jpeg",
        previewUrl: "https://images.pexels.com/photos/2014422/l.jpeg",
        width: 3024,
        height: 3024,
        pageUrl: "https://www.pexels.com/photo/x-2014422/",
      },
    ])
    expect(page.next).toBe("2")
  })

  it("next is null without next_page", async () => {
    const base = await start((_q, res) => json(res, { photos: [photo()] }))
    const c = createPexels({ baseUrl: base, key: KEY })
    expect((await c.search({ query: "a", kind: "image", cursor: null })).next).toBeNull()
  })

  it("searches videos", async () => {
    const base = await start((_q, res) => json(res, { next_page: "x", videos: [video()] }))
    const c = createPexels({ baseUrl: base, key: KEY })
    const page = await c.search({ query: "sea", kind: "video", cursor: "2" })
    const u = new URL(seen[0].url, "http://x")
    expect(u.pathname).toBe("/v1/videos/search")
    expect(u.searchParams.get("page")).toBe("2")
    expect(page.results[0]).toMatchObject({
      source: "pexels",
      id: "3571264",
      kind: "video",
      duration: 15,
      thumbUrl: "https://images.pexels.com/videos/3571264/pic.jpeg",
      pageUrl: "https://www.pexels.com/video/x-3571264/",
    })
    expect(page.next).toBe("3")
  })

  it("gif kind returns empty with no request", async () => {
    const base = await start((_q, res) => json(res, {}))
    const c = createPexels({ baseUrl: base, key: KEY })
    expect(await c.search({ query: "x", kind: "gif", cursor: null })).toEqual({ results: [], next: null })
    expect(await c.search({ query: "x", kind: "audio", cursor: null })).toEqual({ results: [], next: null })
    expect(seen).toHaveLength(0)
  })

  it("kind all: partial failure ok, total failure throws", async () => {
    let base = await start((_q, res, url) =>
      url.pathname === "/v1/videos/search" ? json(res, {}, 500) : json(res, { photos: [photo()] }),
    )
    let c = createPexels({ baseUrl: base, key: KEY })
    expect((await c.search({ query: "x", kind: "all", cursor: null })).results).toHaveLength(1)
    await new Promise((r) => server!.close(r))
    base = await start((_q, res) => json(res, {}, 500))
    c = createPexels({ baseUrl: base, key: KEY })
    await expect(c.search({ query: "x", kind: "all", cursor: null })).rejects.toThrow(/HTTP 500/)
  })

  it("429 and 500 give clear errors without the key", async () => {
    const base = await start((_q, res, url) => json(res, {}, url.searchParams.get("query") === "a" ? 429 : 500))
    const c = createPexels({ baseUrl: base, key: KEY })
    const e1 = (await c.search({ query: "a", kind: "image", cursor: null }).catch((e) => e)) as Error
    expect(e1.message).toMatch(/rate limit/i)
    const e2 = (await c.search({ query: "b", kind: "image", cursor: null }).catch((e) => e)) as Error
    expect(e2.message).toMatch(/HTTP 500/)
    expect(e1.message + e2.message).not.toContain(KEY)
  })

  it("network failure error does not contain the key", async () => {
    const c = createPexels({ baseUrl: "http://127.0.0.1:1", key: KEY })
    const e = (await c.search({ query: "a", kind: "image", cursor: null }).catch((x) => x)) as Error
    expect(e.message).toMatch(/Pexels request failed/)
    expect(e.message).not.toContain(KEY)
  })

  it("resolve photo uses large2x", async () => {
    const base = await start((_q, res) => json(res, photo()))
    const c = createPexels({ baseUrl: base, key: KEY })
    const d = await c.resolve({ source: "pexels", id: "2014422", kind: "image" })
    expect(new URL(seen[0].url, "http://x").pathname).toBe("/v1/photos/2014422")
    expect(seen[0].auth).toBe(KEY)
    expect(d).toMatchObject({ url: "https://images.pexels.com/photos/2014422/l2.jpeg", fileName: "pexels-2014422.jpeg", gif: false })
  })

  it("resolve video picks the 1080p file", async () => {
    const base = await start((_q, res) => json(res, video()))
    const c = createPexels({ baseUrl: base, key: KEY })
    const d = await c.resolve({ source: "pexels", id: "3571264", kind: "video" })
    expect(new URL(seen[0].url, "http://x").pathname).toBe("/v1/videos/videos/3571264")
    expect(d).toMatchObject({ url: "https://v/hd.mp4", fileName: "pexels-3571264.mp4", gif: false })
  })

  it("invalid ids throw with no request; unsupported kind throws", async () => {
    const base = await start((_q, res) => json(res, photo()))
    const c = createPexels({ baseUrl: base, key: KEY })
    for (const id of ["../x", "12a", "", "1234567890123", "1/2"]) {
      await expect(c.resolve({ source: "pexels", id, kind: "image" })).rejects.toThrow("Invalid Pexels id")
    }
    await expect(c.resolve({ source: "pexels", id: "1", kind: "gif" })).rejects.toThrow()
    expect(seen).toHaveLength(0)
  })

  it("resolve rejects a response whose id differs", async () => {
    const base = await start((_q, res) => json(res, photo({ id: 1 })))
    const c = createPexels({ baseUrl: base, key: KEY })
    await expect(c.resolve({ source: "pexels", id: "2", kind: "image" })).rejects.toThrow(/not found/i)
  })
})
