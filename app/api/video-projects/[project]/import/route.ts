import { auth } from "@/auth"
import { isPlainName, tempFolderName } from "@/lib/media"
import { prisma } from "@/lib/prisma"
import { isSameOrigin, isUploadId, MAX_IMPORT_CHUNK_BYTES, sanitizeImportName } from "@/lib/video/import"
import { cancelUpload, finishUpload, startUpload, writeChunk } from "@/lib/video/import-server"
import { withLock } from "@/lib/video/project-lock-server"
import { readProject, writeProject } from "@/lib/video/projects-server"

// POST /api/video-projects/<project>/import?name=&size=&offset=[&upload=]
// One piece of a file uploaded with Import (the raw bytes are the body; see
// lib/video/import-server). The first piece (offset 0, no upload id) starts
// the upload; every answer says how many bytes are in ({ upload, received }),
// and the one that completes the file adds it to the project's media and
// answers { done, id, asset }. DELETE with ?upload=&name= cancels one.
//
// Mutating, so: a session (the user's folder comes from it, never from the
// URL), a same-origin request (as server actions require), and the project's
// lock only while the finished file goes into assets/ and project.json. This
// route is left out of the proxy (proxy.ts), which would otherwise hold a
// copy of every request body in memory; it checks the session itself.

export const runtime = "nodejs"

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } })

async function authorise(request: Request, project: string): Promise<{ userFolder: string; folder: string } | Response> {
  if (!isSameOrigin(request.headers.get("origin"), request.headers.get("x-forwarded-host") ?? request.headers.get("host"))) return json({ error: "Forbidden." }, 403)
  const session = await auth()
  if (!session) return json({ error: "Sign in again to import." }, 401)
  if (session.user.mustResetPassword) return json({ error: "Change your password first." }, 403)
  const user = await prisma.user.findUnique({ where: { id: session.user.id }, select: { name: true, email: true } })
  if (!user) return json({ error: "Sign in again to import." }, 401)
  let folder
  try {
    folder = decodeURIComponent(project)
  } catch {
    return json({ error: "Project not found." }, 404)
  }
  if (!isPlainName(folder)) return json({ error: "Project not found." }, 404)
  return { userFolder: tempFolderName(user.name, user.email), folder }
}

export async function POST(request: Request, { params }: { params: Promise<{ project: string }> }) {
  const who = await authorise(request, (await params).project)
  if (who instanceof Response) return who
  const { userFolder, folder } = who
  const q = new URL(request.url).searchParams
  const rawName = q.get("name") ?? ""
  const size = Number(q.get("size"))
  const offset = Number(q.get("offset") ?? "0")
  let upload = q.get("upload")
  if (!Number.isSafeInteger(size) || !Number.isSafeInteger(offset)) return json({ error: "Invalid upload." }, 400)
  if (Number(request.headers.get("content-length") ?? 0) > MAX_IMPORT_CHUNK_BYTES) return json({ error: "That piece is too large." }, 413)

  let name = rawName
  const first = !upload
  if (!upload) {
    if (offset !== 0) return json({ error: "Invalid upload." }, 400)
    const started = await startUpload(userFolder, folder, rawName, size)
    if ("error" in started) return json({ error: started.error }, started.status)
    upload = started.id
    name = started.name
  } else {
    if (!isUploadId(upload)) return json({ error: "Invalid upload." }, 400)
    // The name the first piece was stored under.
    name = sanitizeImportName(rawName)
  }

  const written = await writeChunk(userFolder, folder, upload, name, size, offset, request.body)
  if ("error" in written) {
    // A first piece that didn't arrive (a cancel before the browser knew the upload's id): nothing to resume, so nothing is kept.
    if (first) await cancelUpload(userFolder, folder, upload, name)
    return json({ error: written.error, ...(first ? {} : { upload }) }, written.status)
  }
  if (written.received < size) return json({ upload, received: written.received })

  const id = upload
  const result = await withLock(`${userFolder}/${folder}`, async () => {
    const project = await readProject(userFolder, folder)
    if (!project) {
      await cancelUpload(userFolder, folder, id, name)
      return { error: "Project not found.", status: 404 }
    }
    const finished = await finishUpload(userFolder, folder, id, name, size)
    if ("error" in finished) return finished
    await writeProject(userFolder, folder, { ...project, assets: { ...project.assets, [finished.id]: finished.asset } })
    return finished
  })
  if ("error" in result) return json({ error: result.error }, result.status)
  return json({ done: true, id: result.id, asset: result.asset })
}

export async function DELETE(request: Request, { params }: { params: Promise<{ project: string }> }) {
  const who = await authorise(request, (await params).project)
  if (who instanceof Response) return who
  const q = new URL(request.url).searchParams
  const upload = q.get("upload") ?? ""
  if (!isUploadId(upload)) return json({ error: "Invalid upload." }, 400)
  await cancelUpload(who.userFolder, who.folder, upload, q.get("name") ?? "")
  return json({ ok: true })
}
