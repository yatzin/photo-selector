import http from "http"
import type { AddressInfo } from "net"
import { afterEach, describe, expect, it } from "vitest"
import { createPixabay } from "./pixabay"

let server: http.Server | null = null
let seen: string[] = []

async function start(handler: (req: http.IncomingMessage, res: http.ServerResponse, url: URL) => void) {
  seen = []
  server = http.createServer((req, res) => {
    seen.push(req.url ?? "")
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

const KEY = "SECRETKEY123"
const hit = (o: Record<string, unknown> = {}) => ({
  id: 195893,
  tags: "cat, pet",
  pageURL: "https://pixabay.com/photos/cat-195893/",
  previewURL: "https://cdn.pixabay.com/p/195893_150.jpg",
  webformatURL: "https://pixabay.com/w/195893_640.jpg",
  largeImageURL: "https://pixabay.com/l/195893_1280.jpg",
  imageWidth: 4000,
  imageHeight: 3000,
  ...o,
})
const vhit = (o: Record<string, unknown> = {}) => ({
  id: 77,
  tags: "sea",
  pageURL: "https://pixabay.com/videos/sea-77/",
  duration: 12,
  videos: {
    large: { url: "https://v/77_2160.mp4", width: 3840, height: 2160 },
    medium: { url: "https://v/77_1080.mp4", width: 1920, height: 1080 },
    small: { url: "https://v/77_720.mp4", width: 1280, height: 720 },
    tiny: { url: "https://v/77_360.mp4", width: 640, height: 360, thumbnail: "https://v/77_t.jpg" },
  },
  ...o,
})

describe("pixabay", () => {
  it("configured() reflects the key", () => {
    expect(createPixabay({ key: null }).configured()).toBe(false)
    expect(createPixabay({ key: "" }).configured()).toBe(false)
    expect(createPixabay({ key: KEY }).configured()).toBe(true)
  })

  it("searches images with the key as a query param and maps results", async () => {
    const base = await start((_q, res) => json(res, { totalHits: 100, hits: [hit()] }))
    const c = createPixabay({ baseUrl: base, key: KEY })
    const page = await c.search({ query: "cat", kind: "image", cursor: null })
    const u = new URL(seen[0], "http://x")
    expect(u.pathname).toBe("/api/")
    expect(u.searchParams.get("key")).toBe(KEY)
    expect(u.searchParams.get("q")).toBe("cat")
    expect(u.searchParams.get("page")).toBe("1")
    expect(u.searchParams.get("per_page")).toBe("20")
    expect(page.results).toEqual([
      {
        source: "pixabay",
        id: "195893",
        kind: "image",
        title: "cat, pet",
        thumbUrl: "https://cdn.pixabay.com/p/195893_150.jpg",
        previewUrl: "https://pixabay.com/w/195893_640.jpg",
        width: 4000,
        height: 3000,
        pageUrl: "https://pixabay.com/photos/cat-195893/",
      },
    ])
    expect(page.next).toBe("2")
  })

  it("next is null on the last page", async () => {
    const base = await start((_q, res) => json(res, { totalHits: 15, hits: [hit()] }))
    const c = createPixabay({ baseUrl: base, key: KEY })
    expect((await c.search({ query: "cat", kind: "image", cursor: null })).next).toBeNull()
  })

  it("classifies .gif hits as gif; image excludes them, all keeps them", async () => {
    const gif = hit({ id: 5, largeImageURL: "https://pixabay.com/l/5.gif" })
    const base = await start((_q, res, url) =>
      json(res, url.pathname === "/api/videos/" ? { totalHits: 0, hits: [] } : { totalHits: 2, hits: [hit(), gif] }),
    )
    const c = createPixabay({ baseUrl: base, key: KEY })
    const img = await c.search({ query: "x", kind: "image", cursor: null })
    expect(img.results.map((r) => r.id)).toEqual(["195893"])
    const gifs = await c.search({ query: "x", kind: "gif", cursor: null })
    expect(gifs.results.map((r) => [r.id, r.kind])).toEqual([["5", "gif"]])
    const all = await c.search({ query: "x", kind: "all", cursor: null })
    expect(all.results.map((r) => [r.id, r.kind])).toEqual([
      ["195893", "image"],
      ["5", "gif"],
    ])
  })

  it("searches videos and maps duration/thumb", async () => {
    const base = await start((_q, res) => json(res, { totalHits: 1, hits: [vhit()] }))
    const c = createPixabay({ baseUrl: base, key: KEY })
    const page = await c.search({ query: "sea", kind: "video", cursor: "3" })
    const u = new URL(seen[0], "http://x")
    expect(u.pathname).toBe("/api/videos/")
    expect(u.searchParams.get("page")).toBe("3")
    expect(page.results[0]).toMatchObject({
      source: "pixabay",
      id: "77",
      kind: "video",
      duration: 12,
      thumbUrl: "https://v/77_t.jpg",
      pageUrl: "https://pixabay.com/videos/sea-77/",
    })
  })

  it("kind all: one failing endpoint returns the other's results; both failing throws", async () => {
    let base = await start((_q, res, url) =>
      url.pathname === "/api/videos/" ? json(res, {}, 500) : json(res, { totalHits: 1, hits: [hit()] }),
    )
    let c = createPixabay({ baseUrl: base, key: KEY })
    expect((await c.search({ query: "x", kind: "all", cursor: null })).results).toHaveLength(1)
    await new Promise((r) => server!.close(r))
    base = await start((_q, res) => json(res, {}, 500))
    c = createPixabay({ baseUrl: base, key: KEY })
    await expect(c.search({ query: "x", kind: "all", cursor: null })).rejects.toThrow(/HTTP 500/)
  })

  it("unsupported kind (audio) returns empty page with no request", async () => {
    const base = await start((_q, res) => json(res, {}))
    const c = createPixabay({ baseUrl: base, key: KEY })
    expect(await c.search({ query: "x", kind: "audio", cursor: null })).toEqual({ results: [], next: null })
    expect(seen).toHaveLength(0)
  })

  it("429 and 500 give clear errors that never contain the key", async () => {
    const base = await start((_q, res, url) => json(res, {}, url.searchParams.get("q") === "a" ? 429 : 500))
    const c = createPixabay({ baseUrl: base, key: KEY })
    const e1 = await c.search({ query: "a", kind: "image", cursor: null }).catch((e) => e as Error)
    expect((e1 as Error).message).toMatch(/rate limit/i)
    expect((e1 as Error).message).not.toContain(KEY)
    const e2 = await c.search({ query: "b", kind: "image", cursor: null }).catch((e) => e as Error)
    expect((e2 as Error).message).toMatch(/HTTP 500/)
    expect((e2 as Error).message).not.toContain(KEY)
  })

  it("network failure error does not contain the key", async () => {
    const c = createPixabay({ baseUrl: "http://127.0.0.1:1", key: KEY })
    const e = await c.search({ query: "a", kind: "image", cursor: null }).catch((x) => x as Error)
    expect((e as Error).message).toMatch(/Pixabay request failed/)
    expect((e as Error).message).not.toContain(KEY)
  })

  it("resolve image uses largeImageURL and builds fileName from id+ext", async () => {
    const base = await start((_q, res) => json(res, { hits: [hit()] }))
    const c = createPixabay({ baseUrl: base, key: KEY })
    const d = await c.resolve({ source: "pixabay", id: "195893", kind: "image" })
    expect(new URL(seen[0], "http://x").searchParams.get("id")).toBe("195893")
    expect(d).toEqual({ url: "https://pixabay.com/l/195893_1280.jpg", fileName: "pixabay-195893.jpg", gif: false })
  })

  it("resolve gif returns gif: true", async () => {
    const base = await start((_q, res) => json(res, { hits: [hit({ largeImageURL: "https://pixabay.com/l/195893.gif" })] }))
    const c = createPixabay({ baseUrl: base, key: KEY })
    const d = await c.resolve({ source: "pixabay", id: "195893", kind: "gif" })
    expect(d).toEqual({ url: "https://pixabay.com/l/195893.gif", fileName: "pixabay-195893.gif", gif: true })
  })

  it("resolve video picks the 1080p file", async () => {
    const base = await start((_q, res) => json(res, { hits: [vhit()] }))
    const c = createPixabay({ baseUrl: base, key: KEY })
    const d = await c.resolve({ source: "pixabay", id: "77", kind: "video" })
    expect(new URL(seen[0], "http://x").pathname).toBe("/api/videos/")
    expect(d).toEqual({ url: "https://v/77_1080.mp4", fileName: "pixabay-77.mp4", gif: false })
  })

  it("invalid ids throw with no request; resolve with no hit throws", async () => {
    const base = await start((_q, res) => json(res, { hits: [] }))
    const c = createPixabay({ baseUrl: base, key: KEY })
    for (const id of ["../x", "12a", "", "1234567890123", "1&key=z"]) {
      await expect(c.resolve({ source: "pixabay", id, kind: "image" })).rejects.toThrow("Invalid Pixabay id")
    }
    expect(seen).toHaveLength(0)
    await expect(c.resolve({ source: "pixabay", id: "9", kind: "image" })).rejects.toThrow(/not found/i)
  })

  it("resolve rejects when the response id differs from the requested id", async () => {
    const base = await start((_q, res) => json(res, { hits: [hit({ id: 1 })] }))
    const c = createPixabay({ baseUrl: base, key: KEY })
    await expect(c.resolve({ source: "pixabay", id: "2", kind: "image" })).rejects.toThrow(/not found/i)
  })
})
