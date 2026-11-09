import fs from "fs"
import { Readable } from "stream"
import { auth } from "@/auth"
import { isPlainName, tempFolderName } from "@/lib/media"
import { prisma } from "@/lib/prisma"
import { resolveDownload } from "@/lib/video/export-state-server"

// GET /api/video-projects/<project>/download
// The project's kept export, as a download. The user's folder comes from the
// session, never from the URL, so only the signed-in user's projects resolve.

function notFound() {
  return new Response("Not found", { status: 404 })
}

/** RFC 5987 value: encodeURIComponent leaves ' ( ) * as they are, which a header parameter can't. */
function encodeRfc5987(name: string): string {
  return encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
}

export async function GET(_request: Request, { params }: { params: Promise<{ project: string }> }) {
  const session = await auth()
  if (!session) return new Response("Unauthorized", { status: 401 })
  const user = await prisma.user.findUnique({ where: { id: session.user.id }, select: { name: true, email: true } })
  if (!user) return new Response("Unauthorized", { status: 401 })

  const { project } = await params
  let folder
  try {
    folder = decodeURIComponent(project) // as the media route does
  } catch {
    return notFound()
  }
  if (!isPlainName(folder)) return notFound()
  const copy = await resolveDownload(tempFolderName(user.name, user.email), folder)
  if (!copy) return notFound()

  let stat
  try {
    stat = await fs.promises.stat(copy.path)
  } catch {
    return notFound()
  }
  const ascii = copy.name.replace(/[^\x20-\x7e]|["\\]/g, "_")
  const stream = fs.createReadStream(copy.path)
  return new Response(Readable.toWeb(stream) as ReadableStream, {
    headers: {
      "Content-Type": "video/mp4",
      "Content-Length": String(stat.size),
      "Content-Disposition": `attachment; filename="${ascii}"; filename*=UTF-8''${encodeRfc5987(copy.name)}`,
      "Cache-Control": "private, no-store",
    },
  })
}
