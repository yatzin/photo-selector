import fs from "fs/promises"
import { auth } from "@/auth"
import { prisma } from "@/lib/prisma"
import { isPlainName, tempFolderName } from "@/lib/media"
import { isValidKey } from "@/lib/video/chroma"
import { keyedStillPath } from "@/lib/video/keyed-still-server"
import { assetKind } from "@/lib/video/project"
import { assetPath, readProject } from "@/lib/video/projects-server"

// GET /api/video-keyed/<project>?asset=<id>&r=&g=&b=&tol=&c=1|0
// An image clip's picture with its background keyed out (Clip.key), as a PNG:
// what the editor's player shows for a keyed clip. The project and image come
// from the signed-in user's own folder; the settings are validated.

export async function GET(request: Request, { params }: { params: Promise<{ folder: string }> }) {
  const session = await auth()
  if (!session) return new Response("Unauthorized", { status: 401 })
  const { folder } = await params
  if (!isPlainName(folder)) return new Response("Not found", { status: 404 })
  const q = new URL(request.url).searchParams
  const key = { key: [Number(q.get("r")), Number(q.get("g")), Number(q.get("b"))], tolerance: Number(q.get("tol")), contiguous: q.get("c") === "1" }
  const id = q.get("asset") ?? ""
  if (!isValidKey(key) || !id) return new Response("Bad request", { status: 400 })
  const user = await prisma.user.findUnique({ where: { id: session.user.id }, select: { name: true, email: true } })
  if (!user) return new Response("Unauthorized", { status: 401 })
  const userFolder = tempFolderName(user.name, user.email)
  const project = await readProject(userFolder, folder)
  const asset = project && Object.hasOwn(project.assets, id) ? project.assets[id] : undefined
  const source = asset && assetKind(asset) === "image" ? assetPath(userFolder, folder, asset.file) : null
  if (!asset || !source) return new Response("Not found", { status: 404 })
  const out = await keyedStillPath(userFolder, folder, asset.file, source, key)
  if (!out) return new Response("Could not make the picture", { status: 422 })
  return new Response(await fs.readFile(out), { headers: { "Content-Type": "image/png", "Cache-Control": "private, max-age=31536000, immutable" } })
}
