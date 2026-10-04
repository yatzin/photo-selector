import "server-only"
import fs from "fs/promises"
import path from "path"
import { fileVersion, mediaKind } from "@/lib/media"
import { dayFolderNames } from "@/lib/ai/month-scan"

export async function readEntries(dir: string) {
  return fs.readdir(dir, { withFileTypes: true }).catch(() => [])
}

/**
 * Every image directly in `dir` with its current version — and, for a month
 * scan, every image in its day folders too, keyed "18/IMG_1.jpg".
 */
export async function listImageVersions(dir: string, includeDays = false): Promise<Map<string, string>> {
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    throw new Error("The folder no longer exists.")
  }
  const out = new Map<string, string>()
  const add = async (rel: string) => {
    try {
      out.set(rel, fileVersion(await fs.stat(path.join(dir, rel))))
    } catch {
      // removed between readdir and stat
    }
  }
  for (const e of entries) if (e.isFile() && mediaKind(e.name) === "image") await add(e.name)
  if (includeDays) {
    for (const day of dayFolderNames(entries)) {
      for (const e of await readEntries(path.join(dir, day))) if (e.isFile() && mediaKind(e.name) === "image") await add(`${day}/${e.name}`)
    }
  }
  return out
}
