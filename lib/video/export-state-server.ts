import "server-only"
import { randomBytes } from "crypto"
import fs from "fs/promises"
import path from "path"
import { isPlainName, mediaKind, resolveInside } from "@/lib/media"
import { EXPORT_STATE_FILE, type ExportState } from "./export-state"
import { outputDir } from "./projects-server"

// The state file and the one kept copy in a project's output/ folder.

/** The state in output/, or null when it's missing, unreadable or malformed. */
export async function readExportState(dir: string): Promise<ExportState | null> {
  try {
    const s = JSON.parse(await fs.readFile(path.join(dir, EXPORT_STATE_FILE), "utf8"))
    if (typeof s?.file !== "string" || typeof s.fingerprint !== "string" || typeof s.createdAt !== "number") return null
    return { file: s.file, fingerprint: s.fingerprint, createdAt: s.createdAt }
  } catch {
    return null
  }
}

/** Writes beside the state file, then renames over it, so a reader never sees half a file. */
export async function writeExportState(dir: string, state: ExportState): Promise<void> {
  const file = path.join(dir, EXPORT_STATE_FILE)
  const tmp = `${file}.${randomBytes(6).toString("hex")}.tmp`
  try {
    await fs.writeFile(tmp, JSON.stringify(state, null, 2))
    await fs.rename(tmp, file)
  } catch (error) {
    await fs.rm(tmp, { force: true }).catch(() => {})
    throw error
  }
}

/** The copy the state names, when it's a plain video file name and a regular file directly in output/. */
async function storedCopy(dir: string): Promise<{ state: ExportState; path: string } | null> {
  const state = await readExportState(dir)
  if (!state || !isPlainName(state.file) || mediaKind(state.file) !== "video") return null
  const file = resolveInside(dir, [state.file])
  if (!file || path.dirname(file) !== path.resolve(dir)) return null
  try {
    if (!(await fs.lstat(file)).isFile()) return null
  } catch {
    return null
  }
  return { state, path: file }
}

/** The kept copy's file name when it was made from a project with this fingerprint and is still there. */
export async function reusableExport(dir: string, fingerprint: string): Promise<string | null> {
  const copy = await storedCopy(dir)
  return copy && copy.state.fingerprint === fingerprint ? copy.state.file : null
}

/** Removes every file in output/ but `keep`; folders stay. Best effort: never throws. */
export async function cleanOutputs(dir: string, keep: string[]): Promise<void> {
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    if (!e.isFile() || keep.includes(e.name)) continue
    await fs.rm(path.join(dir, e.name), { force: true }).catch(() => {})
  }
}

/** The project's kept copy, for the download route; null when there is none. */
export async function resolveDownload(userFolder: string, folder: string): Promise<{ path: string; name: string } | null> {
  const dir = outputDir(userFolder, folder)
  const copy = dir && (await storedCopy(dir))
  return copy ? { path: copy.path, name: copy.state.file } : null
}
