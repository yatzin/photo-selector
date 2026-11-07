import "server-only"
import { execFile } from "child_process"
import fs from "fs/promises"
import path from "path"
import { TEXT_FONT_FILE, textLayout, type ClipText } from "./text"

// A text clip's picture for the export: its text drawn by ffmpeg's drawtext
// (FreeType, with the bundled font file, so no system font is involved) into a
// transparent PNG exactly its content box at `fontPx` (lib/video/text), each
// line centred across the box on the baseline textLayout gives, as the preview
// draws it. The export then treats the PNG like an image clip's still.

const ffmpeg = () => process.env.FFMPEG_PATH || "ffmpeg"

/** The bundled font file, under public/ in the app's folder (the server's working directory, in development, tests and the container). */
export const textFontPath = () => path.join(process.cwd(), "public", TEXT_FONT_FILE)

/**
 * Draws `text` at `fontPx` into a transparent PNG at `outFile`, its content
 * box rounded up to whole pixels. `workDir` (an existing folder) holds the
 * font and each line's text file while ffmpeg runs (they are named relative
 * to it, so no path needs escaping inside the filtergraph); they're removed
 * after.
 */
export async function rasteriseText(text: ClipText, fontPx: number, outFile: string, workDir: string): Promise<void> {
  const layout = textLayout(text, fontPx)
  const w = Math.max(2, Math.ceil(layout.w - 1e-6))
  const h = Math.max(2, Math.ceil(layout.h - 1e-6))
  const dir = await fs.mkdtemp(path.join(workDir, "text-"))
  try {
    await fs.copyFile(textFontPath(), path.join(dir, "font.ttf"))
    const filters = [`color=c=black@0:s=${w}x${h}:r=1:d=1`, "format=rgba"]
    let n = 0
    for (const line of layout.lines) {
      if (line.text.trim() === "") continue
      const file = `l${n++}.txt`
      await fs.writeFile(path.join(dir, file), line.text)
      // expansion=none: the text is drawn as it is (no %{...} sequences).
      filters.push(
        `drawtext=fontfile=font.ttf:textfile=${file}:expansion=none:fontsize=${fontPx}:fontcolor=0x${text.color.slice(1)}:x=(w-text_w)/2:y=${Number(line.baseline.toFixed(3))}:y_align=baseline`
      )
    }
    // Through a file: a long vertical text makes hundreds of filters, past Windows' command line limit.
    await fs.writeFile(path.join(dir, "graph.txt"), `${filters.join(",")}[out]`)
    await new Promise<void>((resolve, reject) => {
      execFile(
        ffmpeg(),
        ["-hide_banner", "-y", "-/filter_complex", "graph.txt", "-map", "[out]", "-frames:v", "1", "-update", "1", "-f", "image2", "-c:v", "png", path.resolve(outFile)],
        { cwd: dir, timeout: 60_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
        (err, _stdout, stderr) => {
          if (!err) return resolve()
          const last = String(stderr ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean).pop()
          reject(new Error(last || err.message))
        }
      )
    })
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}
