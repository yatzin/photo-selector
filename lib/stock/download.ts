import "server-only"
import { createWriteStream } from "fs"
import fs from "fs/promises"
import http from "http"
import https from "https"
import dns from "dns"
import { isIP, type LookupFunction } from "net"
import { Transform } from "stream"
import { pipeline } from "stream/promises"

// Downloads a stock file (a URL that a provider API response gave the server,
// never one from the browser) to disk. There is no host allow-list, because
// Openverse results point at many upstream hosts, so the guards are:
//   - https only (http only when a test passes allowHttp; allowHttp, lookup
//     and testOnlyConnectMap are ignored unless VITEST is set: honouredOptions);
//   - the host is resolved once, every address must be public
//     (isPublicAddress), and the socket connects to exactly the address that
//     was checked (custom connection `lookup`, so no second DNS answer can
//     slip in between check and connect: no DNS rebinding);
//   - redirects are followed by hand, at most 5, each hop checked again;
//   - a byte cap (Content-Length up front, and a count of what actually
//     arrives) and one timer over the whole transfer;
//   - on any failure the socket is destroyed and the partial file deleted.
// Error messages never include the URL, host or query string, which can carry
// provider keys.

export const DEFAULT_MAX_BYTES = 1024 ** 3
export const DEFAULT_TIMEOUT_MS = 600_000
const MAX_REDIRECTS = 5
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

export type DownloadOptions = {
  maxBytes?: number
  timeoutMs?: number
  /** Tests only (ignored outside vitest): allow http:// URLs. */
  allowHttp?: boolean
  /** Tests only (ignored outside vitest): replaces DNS resolution. Its answers still have to pass isPublicAddress. */
  lookup?: (host: string) => Promise<string[]>
  /**
   * TEST-ONLY SEAM (ignored outside vitest). Never pass this from application code. Maps an address
   * that has already passed isPublicAddress to the host/port the socket
   * really connects to, so tests can point "8.8.8.8" at a fake server on
   * 127.0.0.1. The public-address check itself is not skipped.
   */
  testOnlyConnectMap?: Record<string, { host: string; port: number }>
}

/**
 * The options downloadToFile acts on: all of them under vitest (which sets
 * VITEST), and outside it only maxBytes and timeoutMs, so no production caller
 * can turn on allowHttp, lookup or testOnlyConnectMap, even by accident.
 */
export function honouredOptions(opts: DownloadOptions): DownloadOptions {
  if (process.env.VITEST) return opts
  const { maxBytes, timeoutMs } = opts
  return { ...(maxBytes === undefined ? {} : { maxBytes }), ...(timeoutMs === undefined ? {} : { timeoutMs }) }
}

// ---------------------------------------------------------------------------
// Address classification
// ---------------------------------------------------------------------------

function parseIPv4(ip: string): number[] | null {
  if (isIP(ip) !== 4) return null
  const parts = ip.split(".").map(Number)
  return parts.length === 4 && parts.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) ? parts : null
}

function isPublicIPv4([a, b, c]: number[]): boolean {
  if (a === 0) return false // 0.0.0.0/8
  if (a === 10) return false // 10/8
  if (a === 100 && b >= 64 && b <= 127) return false // 100.64/10 CGNAT
  if (a === 127) return false // loopback
  if (a === 169 && b === 254) return false // link-local (cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return false // 172.16/12
  if (a === 192 && b === 0 && c === 0) return false // 192.0.0/24
  if (a === 192 && b === 0 && c === 2) return false // TEST-NET-1
  if (a === 192 && b === 88 && c === 99) return false // 6to4 relay anycast
  if (a === 192 && b === 168) return false // 192.168/16
  if (a === 198 && (b === 18 || b === 19)) return false // 198.18/15 benchmarking
  if (a === 198 && b === 51 && c === 100) return false // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return false // TEST-NET-3
  if (a >= 224) return false // 224/4 multicast, 240/4 reserved, broadcast
  return true
}

/** The eight 16-bit groups of an IPv6 address (no zone id), or null. */
function parseIPv6(ip: string): number[] | null {
  if (isIP(ip) !== 6) return null
  let text = ip
  let tail: number[] = []
  const lastColon = text.lastIndexOf(":")
  if (text.slice(lastColon + 1).includes(".")) {
    const v4 = parseIPv4(text.slice(lastColon + 1))
    if (!v4) return null
    tail = [(v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]]
    text = text.slice(0, lastColon + 1) + "0" // placeholder, removed below
  }
  const halves = text.split("::")
  if (halves.length > 2) return null
  const toGroups = (s: string) => (s === "" ? [] : s.split(":").map((g) => (/^[0-9a-f]{1,4}$/i.test(g) ? parseInt(g, 16) : NaN)))
  let head = toGroups(halves[0])
  let rest = halves.length === 2 ? toGroups(halves[1]) : []
  if (tail.length) {
    // drop the placeholder group
    if (halves.length === 2) rest = rest.slice(0, -1)
    else head = head.slice(0, -1)
  }
  const fixed = head.length + rest.length + tail.length
  if (halves.length === 1 && fixed !== 8) return null
  if (halves.length === 2 && fixed > 7) return null
  const groups = [...head, ...Array(8 - fixed).fill(0), ...rest, ...tail]
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null
}

const embeddedV4 = (g: number[]): number[] => [g[6] >> 8, g[6] & 0xff, g[7] >> 8, g[7] & 0xff]

function isPublicIPv6(g: number[]): boolean {
  const zeroPrefix = (n: number) => g.slice(0, n).every((x) => x === 0)
  // ::/96 covers ::, ::1 and IPv4-compatible ::a.b.c.d
  if (zeroPrefix(6)) {
    if (g[6] === 0 && (g[7] === 0 || g[7] === 1)) return false
    return isPublicIPv4(embeddedV4(g))
  }
  // ::ffff:a.b.c.d (IPv4-mapped)
  if (zeroPrefix(5) && g[5] === 0xffff) return isPublicIPv4(embeddedV4(g))
  // ::ffff:0:a.b.c.d (IPv4-translated)
  if (zeroPrefix(4) && g[4] === 0xffff && g[5] === 0) return isPublicIPv4(embeddedV4(g))
  // 64:ff9b::/96 NAT64 well-known prefix
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return isPublicIPv4(embeddedV4(g))
  // 2002::/16 6to4: the IPv4 address is groups 1-2
  if (g[0] === 0x2002) return isPublicIPv4([g[1] >> 8, g[1] & 0xff, g[2] >> 8, g[2] & 0xff])
  // Only global unicast 2000::/3 is public. This excludes fc00::/7, fe80::/10,
  // fec0::/10, ff00::/8, 64:ff9b:1::/48, 100::/64 and everything unassigned.
  if ((g[0] & 0xe000) !== 0x2000) return false
  if (g[0] === 0x2001 && g[1] === 0x0db8) return false // documentation
  if (g[0] === 0x2001 && g[1] === 0x0000) return false // Teredo (embeds an obfuscated IPv4)
  if (g[0] === 0x2001 && g[1] < 0x0200) return false // 2001::/23 IETF protocol assignments
  return true
}

/** True only for a syntactically valid IP address that is publicly routable. Anything else (hostnames, junk) is false. */
export function isPublicAddress(ip: string): boolean {
  if (typeof ip !== "string") return false
  const v4 = parseIPv4(ip)
  if (v4) return isPublicIPv4(v4)
  const zone = ip.indexOf("%")
  const v6 = parseIPv6(zone === -1 ? ip : ip.slice(0, zone))
  if (v6) return isPublicIPv6(v6)
  return false
}

// ---------------------------------------------------------------------------
// Download
// ---------------------------------------------------------------------------

const TIMED_OUT = "Download timed out"

async function systemLookup(host: string): Promise<string[]> {
  const answers = await dns.promises.lookup(host, { all: true, verbatim: true })
  return answers.map((a) => a.address)
}

function parseUrl(raw: string | URL, base?: URL): URL {
  try {
    const u = new URL(raw, base)
    if (u.username || u.password) throw new Error()
    return u
  } catch {
    throw new Error("Bad download URL")
  }
}

/** Resolves `promise`, or rejects with the timeout error as soon as `signal` aborts. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error(TIMED_OUT))
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error(TIMED_OUT))
    signal.addEventListener("abort", onAbort, { once: true })
    promise.then(
      (v) => {
        signal.removeEventListener("abort", onAbort)
        resolve(v)
      },
      (e) => {
        signal.removeEventListener("abort", onAbort)
        reject(e)
      },
    )
  })
}

/** Checks one hop's URL and sends a GET to the validated address. Resolves with the response (headers read, body not). */
async function requestHop(u: URL, opts: DownloadOptions, signal: AbortSignal): Promise<http.IncomingMessage> {
  const isHttps = u.protocol === "https:"
  if (!isHttps && !(opts.allowHttp && u.protocol === "http:")) throw new Error("Only https downloads are allowed")
  const host = u.hostname.startsWith("[") ? u.hostname.slice(1, -1) : u.hostname
  if (!host) throw new Error("Bad download URL")

  let address: string
  if (isIP(host)) {
    if (!isPublicAddress(host)) throw new Error("Blocked address")
    address = host
  } else {
    let answers: string[]
    try {
      answers = await untilAborted((opts.lookup ?? systemLookup)(host), signal)
    } catch (e) {
      if (e instanceof Error && e.message === TIMED_OUT) throw e
      throw new Error("Could not resolve host")
    }
    if (!Array.isArray(answers) || answers.length === 0) throw new Error("Could not resolve host")
    if (!answers.every((a) => isPublicAddress(a))) throw new Error("Blocked address")
    address = answers[0]
  }

  let connectHost = address
  let port = u.port ? Number(u.port) : isHttps ? 443 : 80
  const mapped = opts.testOnlyConnectMap?.[address]
  if (mapped) {
    connectHost = mapped.host
    port = mapped.port
  }
  const family = isIP(connectHost)
  // The socket goes to connectHost and nowhere else: no second resolution.
  const pinnedLookup = ((_hostname: string, options: { all?: boolean } | undefined, callback: (...args: unknown[]) => void) => {
    if (options?.all) callback(null, [{ address: connectHost, family }])
    else callback(null, connectHost, family)
  }) as unknown as LookupFunction

  if (signal.aborted) throw new Error(TIMED_OUT)
  return new Promise<http.IncomingMessage>((resolve, reject) => {
    const req = (isHttps ? https : http).request(
      {
        protocol: u.protocol,
        // For a hostname, keep it (TLS SNI and certificate check, Host header); the pinned lookup decides the socket address.
        hostname: isIP(host) ? connectHost : host,
        port,
        path: `${u.pathname}${u.search}`,
        method: "GET",
        headers: { "User-Agent": "photo-selector", "Accept-Encoding": "identity", Accept: "*/*" },
        lookup: pinnedLookup,
        agent: false,
        signal,
      },
      resolve,
    )
    req.on("error", reject)
    req.end()
  })
}

function byteCounter(maxBytes: number, counter: { bytes: number }): Transform {
  return new Transform({
    transform(chunk: Buffer, _enc, done) {
      counter.bytes += chunk.length
      if (counter.bytes > maxBytes) done(new Error("Download too large"))
      else done(null, chunk)
    },
  })
}

/** Maps anything thrown during a download to a message that is safe to show (never the URL, host, address or headers). */
function safeError(error: unknown, signal: AbortSignal): Error {
  if (signal.aborted) return new Error(TIMED_OUT)
  if (error instanceof Error && SAFE_MESSAGES.has(error.message)) return error
  if (error instanceof Error && /^Download failed \(HTTP \d{3}\)$/.test(error.message)) return error
  const code = error && typeof error === "object" && "code" in error && typeof error.code === "string" && /^[A-Z0-9_]+$/.test(error.code) ? error.code : null
  return new Error(code ? `Download failed (network error ${code})` : "Download failed")
}

const SAFE_MESSAGES = new Set([
  "Download too large",
  TIMED_OUT,
  "Blocked address",
  "Only https downloads are allowed",
  "Too many redirects",
  "Bad download URL",
  "Bad redirect",
  "Could not resolve host",
])

/**
 * Downloads `url` to `destPath` (created or overwritten). Resolves with the
 * number of bytes written; on any failure rejects with a safe message and
 * leaves no file at `destPath` if this call created it.
 */
export async function downloadToFile(url: string, destPath: string, options: DownloadOptions = {}): Promise<{ bytes: number }> {
  const opts = honouredOptions(options)
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const { signal } = controller
  let wroteFile = false
  let response: http.IncomingMessage | null = null
  try {
    let current = parseUrl(url)
    for (let redirects = 0; ; redirects++) {
      response = await requestHop(current, opts, signal)
      const status = response.statusCode ?? 0
      if (REDIRECT_STATUSES.has(status)) {
        const location = response.headers.location
        response.destroy()
        response = null
        if (redirects >= MAX_REDIRECTS) throw new Error("Too many redirects")
        if (!location) throw new Error("Bad redirect")
        try {
          current = parseUrl(location, current)
        } catch {
          throw new Error("Bad redirect")
        }
        continue
      }
      if (status !== 200) throw new Error(`Download failed (HTTP ${status})`)
      const declared = response.headers["content-length"]
      if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) {
        throw new Error(/^\d+$/.test(declared) ? "Download too large" : "Download failed")
      }
      const counter = { bytes: 0 }
      wroteFile = true
      await pipeline(response, byteCounter(maxBytes, counter), createWriteStream(destPath), { signal })
      return { bytes: counter.bytes }
    }
  } catch (error) {
    response?.destroy()
    if (wroteFile) await fs.rm(destPath, { force: true }).catch(() => {})
    throw safeError(error, signal)
  } finally {
    clearTimeout(timer)
  }
}
