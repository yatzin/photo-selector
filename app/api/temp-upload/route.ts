import { auth } from "@/auth"
import { safeSegments } from "@/lib/media"
import { cancelTempUpload, finishTempUpload, startTempUpload, writeTempChunk } from "@/lib/temp-upload-server"
import { isSameOrigin, isUploadId, MAX_IMPORT_CHUNK_BYTES, sanitizeImportName } from "@/lib/video/import"
import { clearRootCounts } from "@/lib/library-server"

// POST /api/temp-upload?folder=<user/sub>&name=&size=&offset=[&upload=]
// One piece of a photo or video uploaded into a Personal Storage folder (the
// raw bytes are the body; see lib/temp-upload-server). The first piece
// (offset 0, no upload id) starts the upload; every answer says how many
// bytes are in ({ upload, received }) and the one that completes the file
// answers { done, id: <stored name> }. DELETE with ?upload=&name= cancels one.
//
// Mutating, so: a session, a same-origin request, and nothing from the URL
// trusted beyond the folder path, which is kept inside Personal Storage. Left
// out of the proxy (proxy.ts) like the project Import route.

export const runtime = "nodejs"

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } })

async function authorise(request: Request): Promise<Response | null> {
  if (!isSameOrigin(request.headers.get("origin"), request.headers.get("x-forwarded-host") ?? request.headers.get("host"))) return json({ error: "Forbidden." }, 403)
  const session = await auth()
  if (!session) return json({ error: "Sign in again to upload." }, 401)
  if (session.user.mustResetPassword) return json({ error: "Change your password first." }, 403)
  return null
}

export async function POST(request: Request) {
  const denied = await authorise(request)
  if (denied) return denied
  const q = new URL(request.url).searchParams
  const parent = safeSegments([q.get("folder") ?? ""])
  const rawName = q.get("name") ?? ""
  const size = Number(q.get("size"))
  const offset = Number(q.get("offset") ?? "0")
  let upload = q.get("upload")
  if (!parent || parent.length === 0 || !Number.isSafeInteger(size) || !Number.isSafeInteger(offset)) return json({ error: "Invalid upload." }, 400)
  if (Number(request.headers.get("content-length") ?? 0) > MAX_IMPORT_CHUNK_BYTES) return json({ error: "That piece is too large." }, 413)

  let name = rawName
  const first = !upload
  if (!upload) {
    if (offset !== 0) return json({ error: "Invalid upload." }, 400)
    const started = await startTempUpload(parent, rawName, size)
    if ("error" in started) return json({ error: started.error }, started.status)
    upload = started.id
    name = started.name
  } else {
    if (!isUploadId(upload)) return json({ error: "Invalid upload." }, 400)
    name = sanitizeImportName(rawName)
  }

  const written = await writeTempChunk(upload, name, size, offset, request.body)
  if ("error" in written) {
    if (first) await cancelTempUpload(upload, name)
    return json({ error: written.error, ...(first ? {} : { upload }) }, written.status)
  }
  if (written.received < size) return json({ upload, received: written.received })

  const finished = await finishTempUpload(parent, upload, name, size)
  if ("error" in finished) return json({ error: finished.error }, finished.status)
  clearRootCounts()
  return json({ done: true, id: finished.name })
}

export async function DELETE(request: Request) {
  const denied = await authorise(request)
  if (denied) return denied
  const q = new URL(request.url).searchParams
  const upload = q.get("upload") ?? ""
  if (!isUploadId(upload)) return json({ error: "Invalid upload." }, 400)
  await cancelTempUpload(upload, q.get("name") ?? "")
  return json({ ok: true })
}
