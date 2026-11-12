import "server-only"
import fs from "fs/promises"
import path from "path"
import sharp from "sharp"
import { z } from "zod"
import { MAX_TOLERANCE, removeBackground } from "./chroma"
import { assetKind, type Asset } from "./project"
import { withLock } from "./project-lock-server"
import { assetPath, newAssetId, placeInAssets, projectDir, readProject, writeProject } from "./projects-server"

// "Make background transparent": reads a project image, clears the background
// the picked colour names (lib/video/chroma, the same maths the dialog's live
// preview runs), and stores the result as a new PNG asset beside the original,
// which stays in the project. The browser sends only the asset id and the
// options; paths come from the project.

const MAX_PIXELS = 60_000_000

export const transparentOptions = z.object({
  key: z.tuple([z.number().int().min(0).max(255), z.number().int().min(0).max(255), z.number().int().min(0).max(255)]),
  tolerance: z.number().min(0).max(MAX_TOLERANCE),
  contiguous: z.boolean(),
})

export type TransparentResult = { id: string; asset: Asset } | { error: string }

export async function makeTransparent(userFolder: string, folder: string, assetId: string, rawOptions: unknown): Promise<TransparentResult> {
  const options = transparentOptions.safeParse(rawOptions)
  if (!options.success) return { error: "Invalid request." }
  const dir = projectDir(userFolder, folder)
  if (!dir) return { error: "Invalid request." }
  return withLock(`${userFolder}/${folder}`, async (): Promise<TransparentResult> => {
    const project = await readProject(userFolder, folder)
    if (!project) return { error: "Project not found." }
    const source = Object.hasOwn(project.assets, assetId) ? project.assets[assetId] : undefined
    if (!source || assetKind(source) !== "image") return { error: "That isn't an image in this project." }
    const file = assetPath(userFolder, folder, source.file)
    if (!file) return { error: "Invalid request." }
    let png: Buffer
    try {
      // .rotate() applies the file's orientation, as the preview shows it.
      const { data, info } = await sharp(file, { failOn: "none", limitInputPixels: MAX_PIXELS }).rotate().ensureAlpha().raw().toBuffer({ resolveWithObject: true })
      const out = removeBackground(data, info.width, info.height, options.data)
      png = await sharp(Buffer.from(out.buffer, out.byteOffset, out.length), { raw: { width: info.width, height: info.height, channels: 4 } }).png().toBuffer()
    } catch {
      return { error: "That image couldn't be processed (it may be too large)." }
    }
    const stem = path.parse(source.file).name.replace(/ \(transparent\)$/, "")
    const placed = await placeInAssets(path.join(dir, "assets"), `${stem} (transparent).png`, (target) => fs.writeFile(target, png, { flag: "wx" }))
    if ("error" in placed) return placed
    const asset: Asset = { file: placed.file, duration: source.duration, hasAudio: false, kind: "image", alpha: true, ...(source.title ? { title: `${source.title} (transparent)` } : {}) }
    const id = newAssetId()
    try {
      await writeProject(userFolder, folder, { ...project, assets: { ...project.assets, [id]: asset } })
    } catch {
      await fs.rm(placed.dest, { force: true }).catch(() => {})
      return { error: "Couldn't save the project." }
    }
    return { id, asset }
  })
}

