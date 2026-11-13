import { auth } from "@/auth"
import { isPlainName, tempFolderName } from "@/lib/media"
import { prisma } from "@/lib/prisma"
import { assetFilmFrame, assetFilmInfo } from "@/lib/video/film-server"

// GET /api/video-projects/<project>/film/<asset>/info
//   { interval, count }: how the asset's filmstrip snapshots are spaced (s) and how many there are.
// GET /api/video-projects/<project>/film/<asset>/<n>
//   Snapshot n (from 0) as a small JPEG.
// The snapshots (lib/video/film) are all made on the first request of either
// and kept beside the asset, so that request can take a while. The user's folder
// comes from the session, never from the URL. An asset id is never reused, so
// the browser may keep the answers.

const KEEP = "private, max-age=31536000, immutable"

function notFound() {
  return new Response("Not found", { status: 404 })
}

export async function GET(_request: Request, { params }: { params: Promise<{ project: string; asset: string; frame: string }> }) {
  const session = await auth()
  if (!session) return new Response("Unauthorized", { status: 401 })
  const user = await prisma.user.findUnique({ where: { id: session.user.id }, select: { name: true, email: true } })
  if (!user) return new Response("Unauthorized", { status: 401 })

  const { project, asset, frame } = await params
  let folder
  let assetId
  try {
    folder = decodeURIComponent(project)
    assetId = decodeURIComponent(asset)
  } catch {
    return notFound()
  }
  if (!isPlainName(folder) || !isPlainName(assetId)) return notFound()
  const userFolder = tempFolderName(user.name, user.email)

  try {
    if (frame === "info") {
      const info = await assetFilmInfo(userFolder, folder, assetId)
      return info ? Response.json(info, { headers: { "Cache-Control": KEEP } }) : notFound()
    }
    if (!/^\d{1,6}$/.test(frame)) return notFound()
    const bytes = await assetFilmFrame(userFolder, folder, assetId, Number(frame))
    if (!bytes) return notFound()
    return new Response(new Uint8Array(bytes), { headers: { "Content-Type": "image/jpeg", "Content-Length": String(bytes.length), "Cache-Control": KEEP } })
  } catch {
    return new Response("Couldn't make the snapshots", { status: 500 })
  }
}
