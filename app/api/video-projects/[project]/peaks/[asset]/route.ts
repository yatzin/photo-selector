import { auth } from "@/auth"
import { isPlainName, tempFolderName } from "@/lib/media"
import { prisma } from "@/lib/prisma"
import { PEAKS_RATE } from "@/lib/video/peaks"
import { assetPeaks } from "@/lib/video/peaks-server"

// GET /api/video-projects/<project>/peaks/<asset>
// The waveform peaks of a video asset with sound (lib/video/peaks: a small
// header, then 100 peaks a second), made on the first request and cached
// beside the asset. The user's folder comes from the session, never from the
// URL. An asset id is never reused, so the browser may keep the answer.

function notFound() {
  return new Response("Not found", { status: 404 })
}

export async function GET(_request: Request, { params }: { params: Promise<{ project: string; asset: string }> }) {
  const session = await auth()
  if (!session) return new Response("Unauthorized", { status: 401 })
  const user = await prisma.user.findUnique({ where: { id: session.user.id }, select: { name: true, email: true } })
  if (!user) return new Response("Unauthorized", { status: 401 })

  const { project, asset } = await params
  let folder
  let assetId
  try {
    folder = decodeURIComponent(project)
    assetId = decodeURIComponent(asset)
  } catch {
    return notFound()
  }
  if (!isPlainName(folder) || !isPlainName(assetId)) return notFound()

  let bytes
  try {
    bytes = await assetPeaks(tempFolderName(user.name, user.email), folder, assetId)
  } catch {
    return new Response("Couldn't read the sound", { status: 500 })
  }
  if (!bytes) return notFound()
  return new Response(new Uint8Array(bytes), {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(bytes.length),
      "Cache-Control": "private, max-age=31536000, immutable",
      "X-Peaks-Rate": String(PEAKS_RATE),
    },
  })
}
