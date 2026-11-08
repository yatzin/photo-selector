import fs from "fs"
import { Readable } from "stream"
import { auth } from "@/auth"
import { tempFolderName } from "@/lib/media"
import { prisma } from "@/lib/prisma"
import { previewFile } from "@/lib/video/audio-preview-server"

// GET /api/video-projects/<project>/audio-preview/<id>
// A rendered audio preview (see ../route.ts) from the user's own cache
// folder: the folder comes from the session, so another user's id is just
// not found. The id hashes everything heard, so the file never changes.
// Range requests are served, so the dialog's player can seek.

function notFound() {
  return new Response("Not found", { status: 404 })
}

export async function GET(request: Request, { params }: { params: Promise<{ project: string; id: string }> }) {
  const session = await auth()
  if (!session) return new Response("Unauthorized", { status: 401 })
  const user = await prisma.user.findUnique({ where: { id: session.user.id }, select: { name: true, email: true } })
  if (!user) return new Response("Unauthorized", { status: 401 })

  const { project, id } = await params
  let folder
  try {
    folder = decodeURIComponent(project)
  } catch {
    return notFound()
  }
  const file = previewFile(tempFolderName(user.name, user.email), folder, id)
  if (!file) return notFound()
  let size
  try {
    size = (await fs.promises.stat(file)).size
  } catch {
    return notFound()
  }
  const headers: Record<string, string> = { "Content-Type": "audio/mp4", "Accept-Ranges": "bytes", "Cache-Control": "private, max-age=31536000, immutable" }

  const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get("range") ?? "")
  if (range && (range[1] || range[2])) {
    const start = Math.max(0, range[1] ? Number(range[1]) : size - Number(range[2]))
    const end = Math.min(range[1] && range[2] ? Number(range[2]) : size - 1, size - 1)
    if (start > end) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } })
    return new Response(Readable.toWeb(fs.createReadStream(file, { start, end })) as ReadableStream, {
      status: 206,
      headers: { ...headers, "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": String(end - start + 1) },
    })
  }
  return new Response(Readable.toWeb(fs.createReadStream(file)) as ReadableStream, { headers: { ...headers, "Content-Length": String(size) } })
}
