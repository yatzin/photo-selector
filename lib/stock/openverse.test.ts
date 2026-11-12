import http from "http"
import type { AddressInfo } from "net"
import { afterEach, describe, expect, it } from "vitest"
import { createOpenverse } from "./openverse"

let server: http.Server | null = null
type Seen = { url: string; method: string; auth?: string; body: string }
let seen: Seen[] = []

async function start(handler: (req: http.IncomingMessage, res: http.ServerResponse, url: URL) => void) {
  seen = []
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on("data", (c) => chunks.push(c))
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://x")
      seen.push({
        url: req.url ?? "",
        method: req.method ?? "",
        auth: req.headers.authorization,
        body: Buffer.concat(chunks).toString(),
      })
      handler(req, res, url)
    })
  })
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
}
function json(res: http.ServerResponse, body: unknown, status = 200) {
  res.writeHead(status, { "content-type": "application/json" })
  res.end(JSON.stringify(body))
}
afterEach(async () => {
  if (server) await new Promise((r) => server!.close(r))
  server = null
})

const img = (o: Record<string, unknown> = {}) => ({
  id: "i1",
  title: "A cat",
  url: "https://cdn.example/a.jpg",
  thumbnail: "https://api/thumb/i1",
  license: "cc0",
  filetype: "jpg",
  foreign_landing_url: "https://example/page/i1",
  width: 800,
  height: 600,
  ...o,
})

describe("openverse search", () => {
  it("sends license=cc0,pdm and page_size=20 and maps results", async () => {
    const base = await start((_q, res) =>
      json(res, { page: 1, page_count: 3, results: [img()] }),
    )
    const c = createOpenverse({ baseUrl: base })
    expect(c.configured()).toBe(true)
    const page = await c.search({ query: "cat", kind: "image", cursor: null })
    const u = new URL(seen[0].url, "http://x")
    expect(u.pathname).toBe("/v1/images/")
    expect(u.searchParams.get("license")).toBe("cc0,pdm")
    expect(u.searchParams.get("page_size")).toBe("20")
    expect(u.searchParams.get("q")).toBe("cat")
    expect(u.searchParams.get("page")).toBe("1")
    expect(seen[0].auth).toBeUndefined()
    expect(page.results).toEqual([
      {
        source: "openverse",
        id: "i1",
        kind: "image",
        title: "A cat",
        thumbUrl: "https://api/thumb/i1",
        previewUrl: "https://cdn.example/a.jpg",
        width: 800,
        height: 600,
        pageUrl: "https://example/page/i1",
      },
    ])
    expect(page.next).toBe("2")
  })

  it("drops attribution-licence results and results with missing licence", async () => {
    const base = await start((_q, res) =>
      json(res, {
        page: 1,
        page_count: 1,
        results: [
          img({ id: "ok", license: "PDM" }),
          img({ id: "bad", license: "by" }),
          img({ id: "none", license: undefined }),
          img({ id: "empty", license: "" }),
        ],
      }),
    )
    const page = await createOpenverse({ baseUrl: base }).search({ query: "x", kind: "image", cursor: null })
    expect(page.results.map((r) => r.id)).toEqual(["ok"])
  })

  it("never offers GIFs: Openverse can't thumbnail or reliably serve them", async () => {
    const mixed = [
      img({ id: "j", filetype: "jpg" }),
      img({ id: "g", filetype: "gif", url: "https://cdn.example/g.gif" }),
    ]
    const base = await start((_q, res) => json(res, { page: 1, page_count: 1, results: mixed }))
    const c = createOpenverse({ baseUrl: base })
    const imgs = await c.search({ query: "x", kind: "image", cursor: null })
    expect(imgs.results.map((r) => r.id)).toEqual(["j"])
    expect(new URL(seen[0].url, "http://x").searchParams.get("extension")).toBeNull()
    // The GIF filter is skipped altogether: no request, an empty page.
    const before = seen.length
    const gifs = await c.search({ query: "x", kind: "gif", cursor: null })
    expect(gifs).toEqual({ results: [], next: null })
    expect(seen.length).toBe(before)
  })

  it("audio: hits /audio/, converts milliseconds to seconds", async () => {
    const base = await start((_q, res) =>
      json(res, {
        page: 2,
        page_count: 2,
        results: [
          {
            id: "a1",
            title: "Song",
            url: "https://cdn.example/a.mp3",
            thumbnail: "https://api/audio/a1/thumb/",
            license: "cc0",
            filetype: "mp3",
            duration: 270000,
            foreign_landing_url: "https://example/a1",
          },
        ],
      }),
    )
    const page = await createOpenverse({ baseUrl: base }).search({ query: "x", kind: "audio", cursor: "2" })
    const u = new URL(seen[0].url, "http://x")
    expect(u.pathname).toBe("/v1/audio/")
    expect(u.searchParams.get("page")).toBe("2")
    expect(page.results[0]).toMatchObject({ kind: "audio", duration: 270 })
    expect(page.next).toBeNull()
  })

  it("kind all searches images and audio; video is not supported", async () => {
    const base = await start((_q, res, url) =>
      json(res, {
        page: 1,
        page_count: 1,
        results: url.pathname.endsWith("/audio/")
          ? [{ id: "a", title: "t", url: "u", license: "cc0", filetype: "mp3", duration: 1000, foreign_landing_url: "p" }]
          : [img()],
      }),
    )
    const c = createOpenverse({ baseUrl: base })
    expect(c.kinds).toEqual(["image", "audio"])
    const page = await c.search({ query: "x", kind: "all", cursor: null })
    expect(page.results.map((r) => r.kind).sort()).toEqual(["audio", "image"])
    const none = await c.search({ query: "x", kind: "video", cursor: null })
    expect(none).toEqual({ results: [], next: null })
  })

  it("uses a cached bearer token when client id and secret are set", async () => {
    const base = await start((_q, res, url) => {
      if (url.pathname === "/v1/auth_tokens/token/") return json(res, { access_token: "tok", expires_in: 36000 })
      json(res, { page: 1, page_count: 1, results: [] })
    })
    const c = createOpenverse({ baseUrl: base, clientId: "id", clientSecret: "sec" })
    await c.search({ query: "a", kind: "image", cursor: null })
    await c.search({ query: "b", kind: "image", cursor: null })
    const tokenCalls = seen.filter((s) => s.url.includes("auth_tokens"))
    expect(tokenCalls).toHaveLength(1)
    expect(tokenCalls[0].method).toBe("POST")
    const form = new URLSearchParams(tokenCalls[0].body)
    expect(form.get("grant_type")).toBe("client_credentials")
    expect(form.get("client_id")).toBe("id")
    expect(form.get("client_secret")).toBe("sec")
    expect(seen.filter((s) => s.url.includes("/images/")).every((s) => s.auth === "Bearer tok")).toBe(true)
  })

  it("drops a by-licensed audio result from an audio search", async () => {
    const a = (id: string, license: string) => ({ id, title: "t", url: "u", thumbnail: "th", license, filetype: "mp3", duration: 1000, foreign_landing_url: "p" })
    const base = await start((_q, res) => json(res, { page: 1, page_count: 1, results: [a("ok", "cc0"), a("bad", "by")] }))
    const page = await createOpenverse({ baseUrl: base }).search({ query: "x", kind: "audio", cursor: null })
    expect(page.results.map((r) => r.id)).toEqual(["ok"])
  })

  it("kind all: drops by-licensed audio and GIFs", async () => {
    const a = (id: string, license: string) => ({ id, title: "t", url: "u", thumbnail: "th", license, filetype: "mp3", duration: 1000, foreign_landing_url: "p" })
    const base = await start((_q, res, url) =>
      json(res, {
        page: 1,
        page_count: 1,
        results: url.pathname.endsWith("/audio/")
          ? [a("a-ok", "cc0"), a("a-bad", "by")]
          : [img({ id: "j" }), img({ id: "g", filetype: "gif", url: "https://c/g.gif" })],
      }),
    )
    const page = await createOpenverse({ baseUrl: base }).search({ query: "x", kind: "all", cursor: null })
    expect(page.results.map((r) => [r.id, r.kind]).sort()).toEqual([
      ["a-ok", "audio"],
      ["j", "image"],
    ])
  })

  it("kind all: one failing endpoint still returns the other's results and cursor", async () => {
    const base = await start((_q, res, url) =>
      url.pathname.endsWith("/audio/")
        ? json(res, { detail: "boom" }, 500)
        : json(res, { page: 1, page_count: 4, results: [img()] }),
    )
    const page = await createOpenverse({ baseUrl: base }).search({ query: "x", kind: "all", cursor: null })
    expect(page.results.map((r) => r.id)).toEqual(["i1"])
    expect(page.next).toBe("2")
  })

  it("kind all: both endpoints failing rejects", async () => {
    const base = await start((_q, res) => json(res, { detail: "boom" }, 500))
    await expect(
      createOpenverse({ baseUrl: base }).search({ query: "x", kind: "all", cursor: null }),
    ).rejects.toThrow(/Openverse.*500/)
  })

  it.each([500, 429])("rejects with a clear error on HTTP %i", async (status) => {
    const base = await start((_q, res) => json(res, { detail: "no" }, status))
    await expect(
      createOpenverse({ baseUrl: base }).search({ query: "x", kind: "image", cursor: null }),
    ).rejects.toThrow(new RegExp(`Openverse.*${status}`))
  })
})

const U1 = "11111111-1111-1111-1111-111111111111"
const U2 = "22222222-2222-2222-2222-222222222222"
const U3 = "33333333-3333-3333-3333-333333333333"

describe("openverse resolve", () => {
  it.each(["../x", "..", ".", "abc?license=by", ""])("rejects invalid id %j without any request", async (id) => {
    const base = await start((_q, res) => json(res, img()))
    await expect(
      createOpenverse({ baseUrl: base }).resolve({ source: "openverse", id, kind: "image" }),
    ).rejects.toThrow("Invalid Openverse id")
    expect(seen).toHaveLength(0)
  })

  it("rejects a detail response with an invalid id", async () => {
    const base = await start((_q, res) => json(res, img({ id: "../x" })))
    await expect(
      createOpenverse({ baseUrl: base }).resolve({ source: "openverse", id: U1, kind: "image" }),
    ).rejects.toThrow("Invalid Openverse id")
  })

  it("builds a safe extension and uses the detail id for the file name", async () => {
    const base = await start((_q, res) =>
      json(res, img({ id: U2, filetype: "a/../b", url: "https://c/x.PNG" })),
    )
    const d = await createOpenverse({ baseUrl: base }).resolve({ source: "openverse", id: U1, kind: "image" })
    expect(d.fileName).toBe(`${U2}.png`)
  })

  it("falls back to a default extension when nothing is safe", async () => {
    const base = await start((_q, res) => json(res, img({ id: U1, filetype: "a/../b", url: "https://c/noext" })))
    const d = await createOpenverse({ baseUrl: base }).resolve({ source: "openverse", id: U1, kind: "image" })
    expect(d.fileName).toBe(`${U1}.jpg`)
  })

  it("rejects a by-licensed audio item", async () => {
    const base = await start((_q, res) => json(res, { id: U3, url: "https://c/a.mp3", license: "by", filetype: "mp3" }))
    await expect(
      createOpenverse({ baseUrl: base }).resolve({ source: "openverse", id: U3, kind: "audio" }),
    ).rejects.toThrow("Not CC0 / public domain")
  })

  it("returns the download for a cc0 image", async () => {
    const base = await start((_q, res) => json(res, img({ id: U1 })))
    const d = await createOpenverse({ baseUrl: base }).resolve({ source: "openverse", id: U1, kind: "image" })
    expect(new URL(seen[0].url, "http://x").pathname).toBe(`/v1/images/${U1}/`)
    expect(d).toEqual({ url: "https://cdn.example/a.jpg", fileName: `${U1}.jpg`, gif: false, title: "A cat" })
  })

  it("returns the detail record's title, sanitised, and omits it when missing or blank", async () => {
    const titled = await start((_q, res) => json(res, { id: U3, url: "https://c/a.mp3", license: "cc0", filetype: "mp3", title: "  Soft \n rain   at\tnight " }))
    const d = await createOpenverse({ baseUrl: titled }).resolve({ source: "openverse", id: U3, kind: "audio" })
    expect(d).toEqual({ url: "https://c/a.mp3", fileName: `${U3}.mp3`, gif: false, title: "Soft rain at night" })
    const long = await start((_q, res) => json(res, { id: U3, url: "https://c/a.mp3", license: "cc0", filetype: "mp3", title: "y".repeat(500) }))
    expect((await createOpenverse({ baseUrl: long }).resolve({ source: "openverse", id: U3, kind: "audio" })).title).toBe("y".repeat(120))
    for (const title of [undefined, "  ", 7]) {
      const b = await start((_q, res) => json(res, { id: U3, url: "https://c/a.mp3", license: "cc0", filetype: "mp3", title }))
      expect(await createOpenverse({ baseUrl: b }).resolve({ source: "openverse", id: U3, kind: "audio" })).not.toHaveProperty("title")
    }
  })

  it("refuses GIF downloads, whatever the ref says", async () => {
    const base = await start((_q, res) => json(res, img({ id: U2, filetype: "gif", url: "https://c/x.gif" })))
    const c = createOpenverse({ baseUrl: base })
    await expect(c.resolve({ source: "openverse", id: U2, kind: "gif" })).rejects.toThrow("Openverse GIFs aren't supported")
    const before = seen.length
    // Labelled as an image but the record says GIF: refused after the licence check.
    await expect(c.resolve({ source: "openverse", id: U2, kind: "image" })).rejects.toThrow("Openverse GIFs aren't supported")
    expect(seen.length).toBe(before + 1)
  })

  it("uses /audio/{id}/ for audio", async () => {
    const base = await start((_q, res) =>
      json(res, { id: U3, url: "https://c/a.mp3", license: "pdm", filetype: "mp3" }),
    )
    const d = await createOpenverse({ baseUrl: base }).resolve({ source: "openverse", id: U3, kind: "audio" })
    expect(new URL(seen[0].url, "http://x").pathname).toBe(`/v1/audio/${U3}/`)
    expect(d.fileName).toBe(`${U3}.mp3`)
  })

  it("rejects a by-licensed item", async () => {
    const base = await start((_q, res) => json(res, img({ license: "by" })))
    await expect(
      createOpenverse({ baseUrl: base }).resolve({ source: "openverse", id: U1, kind: "image" }),
    ).rejects.toThrow("Not CC0 / public domain")
  })

  it("rejects when licence is missing", async () => {
    const base = await start((_q, res) => json(res, img({ license: undefined })))
    await expect(
      createOpenverse({ baseUrl: base }).resolve({ source: "openverse", id: U1, kind: "image" }),
    ).rejects.toThrow("Not CC0 / public domain")
  })
})
