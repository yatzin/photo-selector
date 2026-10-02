import fs from "fs"
import path from "path"
import { Readable } from "stream"
import { auth } from "@/auth"
import { isRootKey, mediaKind, resolveInside, safeSegments } from "@/lib/media"
import { rootPath } from "@/lib/library-server"
import { ensureVariant, type Variant } from "@/lib/thumbs-server"

// GET /api/media/<root>/<path>?v=thumb|preview|original
// Thumbnails and previews come from the cache (made on demand). The original
// streams with Range support so videos can seek.

const CONTENT_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".gif": "image/gif", ".bmp": "image/bmp",
  ".webp": "image/webp", ".heic": "image/heic", ".heif": "image/heif", ".tif": "image/tiff", ".tiff": "image/tiff",
  ".dng": "image/x-adobe-dng", ".mp4": "video/mp4", ".m4v": "video/mp4", ".mov": "video/quicktime",
  ".avi": "video/x-msvideo", ".wmv": "video/x-ms-wmv", ".mkv": "video/x-matroska", ".flv": "video/x-flv",
  ".3gp": "video/3gpp", ".webm": "video/webm",
}

// URLs carry the file's version (?k=), so a cached response never goes stale.
const IMMUTABLE = "private, max-age=31536000, immutable"

function notFound() {
  return new Response("Not found", { status: 404 })
}

export async function GET(request: Request, { params }: { params: Promise<{ root: string; path: string[] }> }) {
  const session = await auth()
  if (!session) return new Response("Unauthorized", { status: 401 })

  const { root, path: rawSegments } = await params
  if (!isRootKey(root)) return notFound()
  const segments = safeSegments(rawSegments.map((s) => decodeURIComponent(s)))
  if (!segments || segments.length === 0) return notFound()
  const file = resolveInside(rootPath(root), segments)
  if (!file || !mediaKind(file)) return notFound()

  const variant = new URL(request.url).searchParams.get("v") ?? "thumb"

  if (variant === "thumb" || variant === "preview") {
    let result
    try {
      result = await ensureVariant(root, segments.join("/"), file, variant as Variant)
    } catch {
      return notFound() // file vanished
    }
    if ("failed" in result) return new Response("Could not make a preview", { status: 422 })
    const body = await fs.promises.readFile(result.path)
    return new Response(body, { headers: { "Content-Type": "image/webp", "Cache-Control": IMMUTABLE } })
  }

  if (variant !== "original") return new Response("Unknown variant", { status: 400 })

  let stat
  try {
    stat = await fs.promises.stat(file)
  } catch {
    return notFound()
  }
  const type = CONTENT_TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream"
  const headers: Record<string, string> = {
    "Content-Type": type,
    "Accept-Ranges": "bytes",
    "Cache-Control": IMMUTABLE,
    // Shown inline, saved under its real name.
    "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(path.basename(file))}`,
  }

  const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get("range") ?? "")
  if (range && (range[1] || range[2])) {
    let start = range[1] ? Number(range[1]) : stat.size - Number(range[2])
    let end = range[1] && range[2] ? Number(range[2]) : stat.size - 1
    start = Math.max(0, start)
    end = Math.min(end, stat.size - 1)
    if (start > end) {
      return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${stat.size}` } })
    }
    const stream = fs.createReadStream(file, { start, end })
    return new Response(Readable.toWeb(stream) as ReadableStream, {
      status: 206,
      headers: { ...headers, "Content-Range": `bytes ${start}-${end}/${stat.size}`, "Content-Length": String(end - start + 1) },
    })
  }

  const stream = fs.createReadStream(file)
  return new Response(Readable.toWeb(stream) as ReadableStream, {
    headers: { ...headers, "Content-Length": String(stat.size) },
  })
}
