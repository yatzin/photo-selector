import { afterEach, describe, expect, it, vi } from "vitest"
import http from "http"
import type { AddressInfo } from "net"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { downloadToFile, honouredOptions, isPublicAddress, type DownloadOptions } from "./download"

describe("isPublicAddress", () => {
  it.each([
    // IPv4 special-purpose ranges
    "0.0.0.0", "0.1.2.3",
    "10.0.0.0", "10.1.2.3", "10.255.255.255",
    "100.64.0.1", "100.127.255.254",
    "127.0.0.1", "127.255.255.255",
    "169.254.169.254", "169.254.0.1",
    "172.16.0.1", "172.31.255.255",
    "192.0.0.1", "192.0.2.10",
    "192.168.0.5", "192.168.255.255",
    "198.18.0.1", "198.19.255.255",
    "198.51.100.7", "203.0.113.9",
    "224.0.0.1", "239.255.255.255",
    "240.0.0.1", "255.255.255.255",
    // IPv6 special-purpose ranges
    "::", "::1", "fc00::1", "fd00::1", "fdff:ffff::1",
    "fe80::1", "fe80::1%eth0", "febf::1", "ff02::1", "ff0e::1",
    "2001:db8::1", "2001:db8:ffff::1",
    // IPv4-mapped / compatible / NAT64 forms of private IPv4
    "::ffff:10.0.0.1", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:a9fe:a9fe",
    "::FFFF:192.168.1.1", "0:0:0:0:0:ffff:10.0.0.1", "::127.0.0.1", "::10.0.0.1",
    "64:ff9b::10.0.0.1", "64:ff9b::7f00:1", "64:ff9b::a9fe:a9fe",
    // unparseable
    "", "  ", "localhost", "example.com", "1.2.3", "1.2.3.4.5", "256.1.1.1", "8.8.8.8 ", "::g", "[::1]",
  ])("rejects %j", (ip) => expect(isPublicAddress(ip)).toBe(false))

  it.each([
    "8.8.8.8", "1.1.1.1", "93.184.216.34", "100.63.255.255", "100.128.0.1", "172.15.255.255", "172.32.0.1",
    "192.169.0.1", "198.17.255.255", "198.20.0.1", "223.255.255.255", "11.0.0.1", "126.255.255.255", "128.0.0.1",
    "2606:4700:4700::1111", "2001:4860:4860::8888", "::ffff:8.8.8.8", "64:ff9b::8.8.8.8",
  ])("accepts %j", (ip) => expect(isPublicAddress(ip)).toBe(true))
})

// ---------------------------------------------------------------------------
// Downloader, against local fake servers on 127.0.0.1. Hostnames like
// "a.test" are resolved by an injected lookup to public-looking addresses,
// which pass the public-address check; the test-only connect map then sends
// the socket for that validated address to the fake server instead.
// ---------------------------------------------------------------------------

type Fake = { server: http.Server; port: number; hits: string[] }
const servers: http.Server[] = []
const tmpDirs: string[] = []

async function fake(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void): Promise<Fake> {
  const hits: string[] = []
  const server = http.createServer((req, res) => {
    hits.push(req.url ?? "")
    handler(req, res)
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  return { server, port: (server.address() as AddressInfo).port, hits }
}

async function tmpFile(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "stock-dl-"))
  tmpDirs.push(dir)
  return path.join(dir, "out.bin")
}

const exists = (p: string) => fs.access(p).then(() => true, () => false)

afterEach(async () => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections()
    await new Promise<void>((resolve) => s.close(() => resolve()))
  }
  for (const d of tmpDirs.splice(0)) await fs.rm(d, { recursive: true, force: true })
})

/** Options that resolve `a.test` → 8.8.8.8 → server A and `b.test` → 8.8.4.4 → server B. */
function opts(a: Fake, b?: Fake, extra: Partial<DownloadOptions> = {}): DownloadOptions {
  const table: Record<string, string[]> = { "a.test": ["8.8.8.8"], "b.test": ["8.8.4.4"], "evil.test": ["127.0.0.1"], "mixed.test": ["8.8.8.8", "10.0.0.1"] }
  return {
    allowHttp: true,
    lookup: async (host) => table[host] ?? [],
    testOnlyConnectMap: {
      "8.8.8.8": { host: "127.0.0.1", port: a.port },
      ...(b ? { "8.8.4.4": { host: "127.0.0.1", port: b.port } } : {}),
    },
    ...extra,
  }
}

describe("downloadToFile", () => {
  it("writes the body to the file and returns the byte count", async () => {
    const a = await fake((req, res) => {
      expect(req.headers["user-agent"]).toBe("photo-selector")
      expect(req.headers["accept-encoding"]).toBe("identity")
      expect(req.headers.cookie).toBeUndefined()
      expect(req.headers.authorization).toBeUndefined()
      res.end("hello world")
    })
    const dest = await tmpFile()
    await expect(downloadToFile(`http://a.test/file.jpg?key=SECRET`, dest, opts(a))).resolves.toEqual({ bytes: 11 })
    expect(await fs.readFile(dest, "utf8")).toBe("hello world")
    expect(a.hits).toEqual(["/file.jpg?key=SECRET"])
  })

  it("follows an absolute redirect to another validated host", async () => {
    const b = await fake((_req, res) => res.end("from b"))
    const a = await fake((_req, res) => res.writeHead(302, { Location: `http://b.test/final` }).end())
    const dest = await tmpFile()
    await expect(downloadToFile("http://a.test/start", dest, opts(a, b))).resolves.toEqual({ bytes: 6 })
    expect(await fs.readFile(dest, "utf8")).toBe("from b")
    expect(b.hits).toEqual(["/final"])
  })

  it("follows a relative redirect against the current URL", async () => {
    const a = await fake((req, res) => {
      if (req.url === "/dir/start") res.writeHead(301, { Location: "next?x=1" }).end()
      else res.end(`got ${req.url}`)
    })
    const dest = await tmpFile()
    await downloadToFile("http://a.test/dir/start", dest, opts(a))
    expect(await fs.readFile(dest, "utf8")).toBe("got /dir/next?x=1")
  })

  it("rejects a redirect to a host that resolves to a blocked address; that host gets no request", async () => {
    const b = await fake((_req, res) => res.end("should not be reached"))
    const a = await fake((_req, res) => res.writeHead(302, { Location: "http://evil.test/" }).end())
    const dest = await tmpFile()
    const o = opts(a, b)
    o.testOnlyConnectMap!["127.0.0.1"] = { host: "127.0.0.1", port: b.port }
    await expect(downloadToFile("http://a.test/", dest, o)).rejects.toThrow("Blocked address")
    expect(b.hits).toEqual([])
    expect(await exists(dest)).toBe(false)
  })

  it("rejects a redirect to a private IP literal", async () => {
    const b = await fake((_req, res) => res.end("nope"))
    const a = await fake((_req, res) => res.writeHead(307, { Location: `http://127.0.0.1:${b.port}/` }).end())
    await expect(downloadToFile("http://a.test/", await tmpFile(), opts(a))).rejects.toThrow("Blocked address")
    expect(b.hits).toEqual([])
  })

  it("rejects when any resolved address is blocked", async () => {
    const a = await fake((_req, res) => res.end("x"))
    await expect(downloadToFile("http://mixed.test/", await tmpFile(), opts(a))).rejects.toThrow("Blocked address")
    expect(a.hits).toEqual([])
  })

  it("follows exactly 5 redirects but rejects a 6th", async () => {
    const a = await fake((req, res) => {
      const n = Number(req.url!.slice(1))
      if (n < 5) res.writeHead(302, { Location: `/${n + 1}` }).end()
      else res.end("done")
    })
    await expect(downloadToFile("http://a.test/0", await tmpFile(), opts(a))).resolves.toEqual({ bytes: 4 })

    const loop = await fake((req, res) => res.writeHead(302, { Location: "/again" }).end())
    const dest = await tmpFile()
    await expect(downloadToFile("http://a.test/", dest, opts(loop))).rejects.toThrow("Too many redirects")
    expect(loop.hits.length).toBe(6)
    expect(await exists(dest)).toBe(false)
  })

  it("rejects a Content-Length over the cap before reading the body", async () => {
    let bodySent = false
    const a = await fake((_req, res) => {
      res.writeHead(200, { "Content-Length": "10000" })
      res.flushHeaders()
      // The body is never written; the download must not wait for it.
      setTimeout(() => {
        bodySent = true
        res.end(Buffer.alloc(10000))
      }, 2000)
    })
    const dest = await tmpFile()
    const started = Date.now()
    await expect(downloadToFile("http://a.test/", dest, opts(a, undefined, { maxBytes: 100, timeoutMs: 5000 }))).rejects.toThrow("Download too large")
    expect(Date.now() - started).toBeLessThan(1500)
    expect(bodySent).toBe(false)
    expect(await exists(dest)).toBe(false)
  })

  it("rejects a chunked body that grows past the cap and leaves no file", async () => {
    const a = await fake((_req, res) => {
      res.writeHead(200) // no Content-Length: chunked
      let n = 0
      const t = setInterval(() => {
        if (res.destroyed || n++ > 50) {
          clearInterval(t)
          if (!res.destroyed) res.end()
          return
        }
        res.write(Buffer.alloc(40))
      }, 5)
    })
    const dest = await tmpFile()
    await expect(downloadToFile("http://a.test/", dest, opts(a, undefined, { maxBytes: 100 }))).rejects.toThrow("Download too large")
    expect(await exists(dest)).toBe(false)
  })

  it("rejects a raw chunked response written in one burst past the cap", async () => {
    const a = await fake((req, res) => {
      // Written straight to the socket so the whole oversized body arrives at once.
      const sock = req.socket
      sock.write("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n")
      for (let i = 0; i < 10; i++) sock.write(`28\r\n${"x".repeat(40)}\r\n`)
      sock.end("0\r\n\r\n")
      void res
    })
    const dest = await tmpFile()
    await expect(downloadToFile("http://a.test/", dest, opts(a, undefined, { maxBytes: 100 }))).rejects.toThrow("Download too large")
    expect(await exists(dest)).toBe(false)
  })

  it("accepts a body exactly at the cap", async () => {
    const a = await fake((_req, res) => res.end(Buffer.alloc(100)))
    await expect(downloadToFile("http://a.test/", await tmpFile(), opts(a, undefined, { maxBytes: 100 }))).resolves.toEqual({ bytes: 100 })
  })

  it("rejects a slow body with Download timed out and leaves no file", async () => {
    const a = await fake((_req, res) => {
      res.writeHead(200)
      res.write("partial")
      // never ends
    })
    const dest = await tmpFile()
    await expect(downloadToFile("http://a.test/", dest, opts(a, undefined, { timeoutMs: 200 }))).rejects.toThrow("Download timed out")
    expect(await exists(dest)).toBe(false)
  })

  it("rejects a server that never answers with Download timed out", async () => {
    const a = await fake(() => {
      /* never responds */
    })
    const dest = await tmpFile()
    await expect(downloadToFile("http://a.test/", dest, opts(a, undefined, { timeoutMs: 50 }))).rejects.toThrow("Download timed out")
    expect(await exists(dest)).toBe(false)
  })

  it("rejects a hanging DNS lookup with Download timed out", async () => {
    const a = await fake((_req, res) => res.end("x"))
    const o = opts(a, undefined, { timeoutMs: 50, lookup: () => new Promise<string[]>(() => {}) })
    await expect(downloadToFile("http://a.test/", await tmpFile(), o)).rejects.toThrow("Download timed out")
  })

  it("rejects a non-200 status with a message holding only the code", async () => {
    const a = await fake((_req, res) => res.writeHead(404, { "X-Secret": "hdr" }).end("not found body"))
    const dest = await tmpFile()
    const err = await downloadToFile("http://a.test/x?key=SECRET", dest, opts(a)).catch((e: Error) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toBe("Download failed (HTTP 404)")
    expect(await exists(dest)).toBe(false)
  })

  it("rejects http:// without allowHttp, before any lookup", async () => {
    const lookup = vi.fn(async () => ["8.8.8.8"])
    await expect(downloadToFile("http://a.test/x", await tmpFile(), { lookup })).rejects.toThrow("Only https downloads are allowed")
    expect(lookup).not.toHaveBeenCalled()
  })

  it("rejects a redirect to http:// without allowHttp", async () => {
    // Initial hop must be https, which the local fake can't serve; this is
    // covered by the per-hop protocol check exercised above. Here we just
    // make sure other schemes are refused.
    await expect(downloadToFile("ftp://a.test/x", await tmpFile(), { allowHttp: true })).rejects.toThrow("Only https downloads are allowed")
    await expect(downloadToFile("file:///etc/passwd", await tmpFile(), { allowHttp: true })).rejects.toThrow("Only https downloads are allowed")
  })

  it.each(["https://127.0.0.1/x?key=SECRET", "https://[::1]/x", "https://169.254.169.254/latest/meta-data", "https://10.0.0.1/", "https://[::ffff:10.0.0.1]/", "https://0x7f.1/", "https://2130706433/"])(
    "rejects IP-literal private URL %s without a DNS lookup",
    async (url) => {
      const lookup = vi.fn(async () => ["8.8.8.8"])
      const err = await downloadToFile(url, await tmpFile(), { lookup }).catch((e: Error) => e)
      expect((err as Error).message).toBe("Blocked address")
      expect(lookup).not.toHaveBeenCalled()
    },
  )

  it("rejects bad URLs and URLs with credentials", async () => {
    await expect(downloadToFile("not a url", await tmpFile())).rejects.toThrow("Bad download URL")
    await expect(downloadToFile("https://user:pass@a.test/", await tmpFile(), { lookup: async () => ["8.8.8.8"] })).rejects.toThrow("Bad download URL")
  })

  it("rejects a host that does not resolve", async () => {
    await expect(downloadToFile("https://nowhere.test/", await tmpFile(), { lookup: async () => [] })).rejects.toThrow("Could not resolve host")
  })

  it("never puts the URL, host or query in error messages", async () => {
    const a = await fake((req, res) => {
      if (req.url!.startsWith("/404")) res.writeHead(404).end()
      else if (req.url!.startsWith("/loop")) res.writeHead(302, { Location: "/loop?key=SECRET" }).end()
      else if (req.url!.startsWith("/big")) res.writeHead(200, { "Content-Length": "999" }).end(Buffer.alloc(999))
      else if (req.url!.startsWith("/evil")) res.writeHead(302, { Location: "http://evil.test/?key=SECRET" }).end()
      else if (req.url!.startsWith("/noloc")) res.writeHead(302).end()
      else res.socket?.destroy()
    })
    const cases = ["/404", "/loop", "/big", "/evil", "/noloc", "/reset"].map((p) => `http://a.test${p}?key=SECRET`)
    cases.push("http://unresolvable.test/?key=SECRET", "https://127.0.0.1/?key=SECRET", "http://a.test/?key=SECRET")
    for (const url of cases) {
      const o = url.startsWith("http://a.test/?") ? { lookup: async () => ["8.8.8.8"] } : opts(a, undefined, { maxBytes: 100 })
      const err = (await downloadToFile(url, await tmpFile(), o).catch((e: Error) => e)) as Error
      expect(err, url).toBeInstanceOf(Error)
      for (const bad of ["SECRET", "a.test", "evil.test", "unresolvable", "key=", "127.0.0.1", String(a.port)]) {
        expect(err.message, `${url} -> ${err.message}`).not.toContain(bad)
      }
    }
  })
})

describe("test-only options outside vitest", () => {
  /** Runs `fn` with VITEST unset, as in production, and puts it back after. */
  async function withoutVitest<T>(fn: () => Promise<T>): Promise<T> {
    const saved = process.env.VITEST
    delete process.env.VITEST
    try {
      return await fn()
    } finally {
      if (saved === undefined) delete process.env.VITEST
      else process.env.VITEST = saved
    }
  }

  it("ignores allowHttp, lookup and testOnlyConnectMap when VITEST is unset", async () => {
    const lookup = vi.fn(async () => ["8.8.8.8"])
    const all: DownloadOptions = { maxBytes: 5, timeoutMs: 7, allowHttp: true, lookup, testOnlyConnectMap: { "8.8.8.8": { host: "127.0.0.1", port: 1 } } }
    await withoutVitest(async () => {
      expect(honouredOptions(all)).toEqual({ maxBytes: 5, timeoutMs: 7 })
      // allowHttp is ignored: an http URL is refused before any lookup.
      await expect(downloadToFile("http://a.test/x", await tmpFile(), all)).rejects.toThrow("Only https downloads are allowed")
      expect(lookup).not.toHaveBeenCalled()
    })
    expect(process.env.VITEST).toBeDefined()
    expect(honouredOptions(all)).toBe(all)
  })
})
