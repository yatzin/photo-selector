import "server-only"
import fs from "fs/promises"
import path from "path"
import { cacheKey, cacheRoot } from "@/lib/thumbs-server"
import { rootPath } from "@/lib/library-server"
import { mediaKind, resolveInside, safeSegments, type RootKey } from "@/lib/media"
import { probeMedia } from "@/lib/video/ffmpeg-server"

// The length of videos in a library folder, for the badge on their thumbnails.
// Read with ffmpeg and remembered in the cache folder next to the thumbnails,
// under the same key (root, path and the file's version), so an edited or
// replaced video is measured again and an unchanged one never is.

const WORKERS = 3

const durationPath = (key: string) => path.join(cacheRoot(), "duration", key.slice(0, 2), key)

async function lengthOf(root: RootKey, folder: string[], name: string): Promise<number | null> {
  // `name` may include a subfolder ("18/IMG_1.mp4", from a month scan).
  const segments = safeSegments([...folder, ...name.split("/")])
  if (!segments || segments.length === 0) return null
  const file = resolveInside(rootPath(root), segments)
  if (!file || mediaKind(file) !== "video") return null
  const st = await fs.stat(file)
  const key = cacheKey(root, segments.join("/"), st)
  const cached = Number(await fs.readFile(durationPath(key), "utf8").catch(() => ""))
  if (Number.isFinite(cached) && cached > 0) return cached
  const { duration } = await probeMedia(file)
  if (!Number.isFinite(duration) || duration <= 0) return null
  const dest = durationPath(key)
  await fs.mkdir(path.dirname(dest), { recursive: true }).then(() => fs.writeFile(dest, String(duration))).catch(() => {})
  return duration
}

/** Seconds for each of `names` (videos in `folder`) that could be measured; a file that can't be read is left out. */
export async function videoDurations(root: RootKey, folder: string[], names: string[]): Promise<Record<string, number>> {
  const out: Record<string, number> = {}
  let next = 0
  async function worker() {
    while (next < names.length) {
      const name = names[next++]
      const seconds = await lengthOf(root, folder, name).catch(() => null)
      if (seconds !== null) out[name] = seconds
    }
  }
  await Promise.all(Array.from({ length: Math.min(WORKERS, names.length) }, worker))
  return out
}
