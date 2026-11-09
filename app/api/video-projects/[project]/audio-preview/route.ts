import { auth } from "@/auth"
import { isPlainName, tempFolderName } from "@/lib/media"
import { prisma } from "@/lib/prisma"
import { parsePreviewRequest } from "@/lib/video/audio-preview"
import { PreviewError, renderAudioPreview, type PreviewErrorCode } from "@/lib/video/audio-preview-server"
import { isSameOrigin } from "@/lib/video/import"

// POST /api/video-projects/<project>/audio-preview
// { assetId, in, out, gainDb, fx } -> { url, durationSec }
// Renders the first 12 s of a clip's source window through the export's own
// audio chain (lib/video/audio-preview-server), for the Audio levels dialog's
// Generate preview, and answers with the cached file's URL (served by
// ./[id]). The levels are checked like a stored clip's; the user's folder
// comes from the session, never from the URL. Closing the request (the
// dialog's Cancel) stops the render once nobody else waits on it.

export const runtime = "nodejs"

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } })

const STATUS: Record<PreviewErrorCode, number> = { "not-found": 404, busy: 429, timeout: 504, failed: 500, cancelled: 499 }

export async function POST(request: Request, { params }: { params: Promise<{ project: string }> }) {
  if (!isSameOrigin(request.headers.get("origin"), request.headers.get("x-forwarded-host") ?? request.headers.get("host"))) return json({ error: "Forbidden." }, 403)
  const session = await auth()
  if (!session) return json({ error: "Sign in again." }, 401)
  const user = await prisma.user.findUnique({ where: { id: session.user.id }, select: { name: true, email: true } })
  if (!user) return json({ error: "Sign in again." }, 401)

  let folder
  try {
    folder = decodeURIComponent((await params).project)
  } catch {
    return json({ error: "Project not found." }, 404)
  }
  if (!isPlainName(folder)) return json({ error: "Project not found." }, 404)

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return json({ error: "Invalid request." }, 400)
  }
  const req = parsePreviewRequest(body)
  if ("error" in req) return json({ error: req.error }, 400)

  try {
    const { id, durationSec } = await renderAudioPreview(tempFolderName(user.name, user.email), folder, req, request.signal)
    return json({ url: `/api/video-projects/${encodeURIComponent(folder)}/audio-preview/${id}`, durationSec })
  } catch (error) {
    if (error instanceof PreviewError) return json({ error: error.message }, STATUS[error.code])
    return json({ error: "The preview couldn't be rendered." }, 500)
  }
}
