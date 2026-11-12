import "server-only"
import { createHash } from "crypto"
import fs from "fs/promises"
import path from "path"
import sharp from "sharp"
import { ensureVariant } from "@/lib/thumbs-server"
import { removeBackground, type KeyOptions } from "./chroma"
import { projectDir } from "./projects-server"

// An image clip's background-cleared picture (Clip.key). The project image is
// never changed: the picture is made from the same converted preview the
// editor and the export already use, with the colour keyed out
// (lib/video/chroma), and kept as a PNG in the project's keyed/ folder under a
// name made from the source and the settings. The same settings reuse the
// file; changed ones make another (the project's deletion takes them all).

const MAX_PIXELS = 20_000_000 // the preview rendition is at most 2048 px on a side

/** The path of the keyed PNG for project image `file` with `key`, made if it isn't there yet; null when the image can't be read. */
export async function keyedStillPath(userFolder: string, folder: string, file: string, source: string, key: KeyOptions): Promise<string | null> {
  const dir = projectDir(userFolder, folder)
  if (!dir) return null
  const still = await ensureVariant("video-projects", [userFolder, folder, "assets", file].join("/"), source, "preview", "high").catch(() => null)
  if (!still || "failed" in still) return null
  const stat = await fs.stat(still.path).catch(() => null)
  if (!stat) return null
  const name = createHash("sha256").update(JSON.stringify([still.path, stat.size, stat.mtimeMs, key.key, key.tolerance, key.contiguous])).digest("hex").slice(0, 40)
  const out = path.join(dir, "keyed", `${name}.png`)
  if (await fs.stat(out).then(() => true, () => false)) return out
  try {
    const { data, info } = await sharp(still.path, { failOn: "none", limitInputPixels: MAX_PIXELS }).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
    const cleared = removeBackground(data, info.width, info.height, key)
    const png = await sharp(Buffer.from(cleared.buffer, cleared.byteOffset, cleared.length), { raw: { width: info.width, height: info.height, channels: 4 } }).png().toBuffer()
    await fs.mkdir(path.dirname(out), { recursive: true })
    const tmp = `${out}.${process.pid}.${Date.now()}.tmp`
    await fs.writeFile(tmp, png)
    await fs.rename(tmp, out)
    return out
  } catch {
    return null
  }
}
