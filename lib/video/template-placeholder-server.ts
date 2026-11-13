import "server-only"
import { createHash } from "crypto"
import { execFile } from "child_process"
import fs from "fs/promises"
import os from "os"
import path from "path"
import sharp from "sharp"
import { probePictureSize } from "./ffmpeg-server"
import { allClips, assetKind, clipLength, DEFAULT_IMAGE, MIN_CLIP, type Asset, type Project } from "./project"
import { assetPath, newAssetId } from "./projects-server"
import { rasteriseText } from "./text-raster-server"
import { textLayout, type ClipText } from "./text"
import { placeholderAsset } from "./template-placeholders"

// The placeholder files a template holds in place of its replaceable media: a
// picture of the slot's shape with its label on it, or a silent sound as long
// as the clip. Planned first (ids, file names, asset entries), written after.

const MAX_SIDE = 1280
const ffmpeg = () => {
  const p = process.env.FFMPEG_PATH || "ffmpeg"
  return /[\\/]/.test(p) ? path.resolve(p) : p
}

export type PlannedPlaceholder = { clipId: string; id: string; asset: Asset; kind: "visual" | "audio"; label: string; width: number; height: number; seconds: number }

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2)

/** The shape (px, the longest side at most MAX_SIDE) of the picture a slot clip shows: its media's own, else the project's canvas. */
async function slotShape(userFolder: string, folder: string, p: Project, assetId: string): Promise<{ width: number; height: number }> {
  const asset = Object.hasOwn(p.assets, assetId) ? p.assets[assetId] : undefined
  const file = asset ? assetPath(userFolder, folder, asset.file) : null
  let size: { width: number; height: number } | null = null
  if (asset && file) {
    try {
      if (assetKind(asset) === "image") {
        const m = await sharp(file, { failOn: "none" }).metadata()
        size = m.width && m.height ? ((m.orientation ?? 1) >= 5 ? { width: m.height, height: m.width } : { width: m.width, height: m.height }) : null
      } else {
        size = await probePictureSize(file)
      }
    } catch {
      size = null
    }
  }
  const { width, height } = size && size.width > 0 && size.height > 0 ? size : { width: p.width, height: p.height }
  const k = Math.min(1, MAX_SIDE / Math.max(width, height))
  return { width: even(width * k), height: even(height * k) }
}

/** What to make for each slot clip in `needs` (see slotsNeedingPlaceholders): a file name from its label and shape, so the same ones are reused. */
export async function planPlaceholders(userFolder: string, folder: string, p: Project, needs: { id: string; kind: "visual" | "audio"; label: string }[]): Promise<PlannedPlaceholder[]> {
  const clips = new Map(allClips(p).map((c) => [c.id, c]))
  const out: PlannedPlaceholder[] = []
  for (const need of needs) {
    const clip = clips.get(need.id)
    if (!clip || clip.asset === "") continue
    const seconds = Math.max(MIN_CLIP, need.kind === "audio" ? clipLength(clip) : DEFAULT_IMAGE)
    const shape = need.kind === "audio" ? { width: 0, height: 0 } : await slotShape(userFolder, folder, p, clip.asset)
    const hash = createHash("sha256").update(JSON.stringify([need.kind, need.label, shape, need.kind === "audio" ? Math.ceil(seconds) : 0])).digest("hex").slice(0, 20)
    const file = `placeholder-${hash}.${need.kind === "audio" ? "m4a" : "png"}`
    const duration = need.kind === "audio" ? Math.ceil(seconds * 10) / 10 : DEFAULT_IMAGE
    out.push({ clipId: need.id, id: newAssetId(), asset: placeholderAsset(need.kind, file, need.label, duration), kind: need.kind, label: need.label, ...shape, seconds: duration })
  }
  return out
}

async function textPng(content: string, color: string, fontPx: number, maxWidth: number, workDir: string, out: string): Promise<{ w: number; h: number }> {
  const text: ClipText = { content, color, orientation: "horizontal" }
  const natural = textLayout(text, fontPx).w
  const px = natural > maxWidth ? Math.max(8, Math.floor((fontPx * maxWidth) / natural)) : fontPx
  await rasteriseText(text, px, out, workDir)
  const meta = await sharp(out).metadata()
  return { w: meta.width ?? 1, h: meta.height ?? 1 }
}

async function renderImage(dest: string, pl: PlannedPlaceholder): Promise<void> {
  const { width: W, height: H } = pl
  const work = await fs.mkdtemp(path.join(os.tmpdir(), "ps-placeholder-"))
  try {
    const strokes = Math.max(2, Math.round(H / 240))
    const bg = Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><defs><pattern id="h" width="28" height="28" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="14" height="28" fill="#ffffff" fill-opacity="0.045"/></pattern></defs><rect width="${W}" height="${H}" fill="url(#h)"/><rect x="${strokes * 3}" y="${strokes * 3}" width="${W - strokes * 6}" height="${H - strokes * 6}" rx="${strokes * 4}" fill="none" stroke="#8fa3c0" stroke-width="${strokes}" stroke-dasharray="${strokes * 6} ${strokes * 4}"/></svg>`
    )
    const label = path.join(work, "label.png")
    const hint = path.join(work, "hint.png")
    const a = await textPng(pl.label, "#ffffff", Math.round(H * 0.1), W * 0.82, work, label)
    const b = await textPng("Replace this with your media", "#b8c4d6", Math.round(H * 0.045), W * 0.82, work, hint)
    const gap = Math.round(H * 0.03)
    const top = Math.round((H - (a.h + gap + b.h)) / 2)
    await sharp({ create: { width: W, height: H, channels: 4, background: "#2b3140" } })
      .composite([
        { input: bg, top: 0, left: 0 },
        { input: label, top, left: Math.round((W - a.w) / 2) },
        { input: hint, top: top + a.h + gap, left: Math.round((W - b.w) / 2) },
      ])
      .png()
      .toFile(dest)
  } finally {
    await fs.rm(work, { recursive: true, force: true }).catch(() => {})
  }
}

function renderSound(dest: string, seconds: number): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(ffmpeg(), ["-hide_banner", "-nostdin", "-y", "-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo", "-t", String(seconds), "-c:a", "aac", "-b:a", "32k", dest], { timeout: 60_000, windowsHide: true }, (err) => (err ? reject(new Error("Couldn't make a placeholder sound.")) : resolve()))
  })
}

/** Writes the planned placeholder files into `assetsDir` (one that already exists is left as it is). */
export async function renderPlaceholders(assetsDir: string, plan: PlannedPlaceholder[]): Promise<void> {
  await fs.mkdir(assetsDir, { recursive: true })
  for (const pl of plan) {
    const dest = path.join(assetsDir, pl.asset.file)
    if (await fs.access(dest).then(() => true, () => false)) continue
    if (pl.kind === "audio") await renderSound(dest, pl.seconds)
    else await renderImage(dest, pl)
  }
}
