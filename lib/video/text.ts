// Text clips: a clip with no media whose picture is a block of text. The
// content box (the text's natural, un-scaled size on the canvas) comes from
// the text alone, so the preview and the export agree without measuring
// anything:
//
// - One font, bundled: Geist Mono Bold (public/fonts/GeistMono-Bold.ttf, SIL
//   Open Font License 1.1, public/fonts/GeistMono-OFL.txt). The preview loads it
//   with @font-face, the export hands the same file to ffmpeg's drawtext, so no
//   system font is involved. It's monospaced: every character is the same
//   width (0.6 of the font size), which is what makes the box computable.
// - The base font size is a tenth of the canvas height (108 px on 1080p); the
//   clip's Transform scale multiplies it like any picture's.
// - Lines: horizontal text breaks at its newlines only (no wrapping); vertical
//   text puts every character on its own line (letters stacked), and a space or
//   newline there leaves an empty line, a gap.
// - The box is the longest line's characters x 0.6 wide and the lines x 1.3
//   tall, in font sizes, plus a padding of 0.25 all round. Each line is centred
//   across the box; its baseline sits 1.005 (the font's ascent) below the top
//   of its 1.3 tall slot.
//
// Characters the font lacks (emoji, CJK) are drawn by whatever fallback font
// the browser or ffmpeg has, at their own widths, still centred on the line;
// those may not match between preview and export.

export type TextOrientation = "horizontal" | "vertical"
/** A text clip's text: `color` is #rrggbb (lower case). */
export type ClipText = { content: string; color: string; orientation: TextOrientation }

/** Longest content, in UTF-16 code units (string length). */
export const MAX_TEXT = 500
export const DEFAULT_TEXT: ClipText = { content: "Text", color: "#ffffff", orientation: "horizontal" }

/** The CSS font family the preview's @font-face (app/globals.css) gives the bundled font. */
export const TEXT_FONT_FAMILY = "PS Video Text"
/** The bundled font, under public/ (the browser) and the app's folder (the export). */
export const TEXT_FONT_FILE = "fonts/GeistMono-Bold.ttf"

/** Geist Mono's metrics as fractions of the font size (1000 units per em: advance 600, ascender 1005, descender 295). */
export const TEXT_ADVANCE = 0.6
export const TEXT_ASCENT = 1.005
export const TEXT_LINE = 1.3
export const TEXT_PAD = 0.25
/** The base font size as a fraction of the canvas height. */
export const TEXT_BASE = 0.1

const HEX = /^#[0-9a-fA-F]{6}$/

/** True for a valid text: 1 to MAX_TEXT characters and not only spaces, a #rrggbb colour, an orientation. */
export function isValidText(v: unknown): v is ClipText {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false
  const { content, color, orientation } = v as Record<string, unknown>
  return (
    typeof content === "string" && content.trim().length > 0 && content.length <= MAX_TEXT &&
    typeof color === "string" && HEX.test(color) && (orientation === "horizontal" || orientation === "vertical")
  )
}

/** Only the text's own fields, the colour in lower case and the line ends as \n; null when it isn't valid. */
export function normalizeText(v: unknown): ClipText | null {
  if (typeof v !== "object" || v === null) return null
  const r = v as Record<string, unknown>
  const t = { content: typeof r.content === "string" ? r.content.replace(/\r\n?/g, "\n") : r.content, color: r.color, orientation: r.orientation }
  if (!isValidText(t)) return null
  return { content: t.content, color: t.color.toLowerCase(), orientation: t.orientation }
}

export const sameText = (a: ClipText | undefined, b: ClipText | undefined) =>
  a === b || (a !== undefined && b !== undefined && a.content === b.content && a.color === b.color && a.orientation === b.orientation)

/** The lines drawn, top to bottom: tabs show as a space; vertical text has one character a line, a blank one for a space or newline. */
export function textLines(text: Pick<ClipText, "content" | "orientation">): string[] {
  const content = text.content.replace(/\r\n?/g, "\n").replace(/\t/g, " ")
  if (text.orientation === "horizontal") return content.split("\n")
  return Array.from(content).map((ch) => (/\s/.test(ch) ? "" : ch))
}

export type TextLine = { text: string; /** Its centre across the box. */ cx: number; baseline: number }

/** The content box (`w` x `h`) for font size `fontPx` and where each line goes in it (px from its top left). */
export function textLayout(text: Pick<ClipText, "content" | "orientation">, fontPx: number): { w: number; h: number; lines: TextLine[] } {
  const lines = textLines(text)
  const cols = Math.max(1, ...lines.map((l) => Array.from(l).length))
  const pad = TEXT_PAD * fontPx
  const w = cols * TEXT_ADVANCE * fontPx + 2 * pad
  const h = lines.length * TEXT_LINE * fontPx + 2 * pad
  return { w, h, lines: lines.map((l, i) => ({ text: l, cx: w / 2, baseline: pad + (i * TEXT_LINE + TEXT_ASCENT) * fontPx })) }
}

/** The base font size (px) on a canvas `canvasH` tall. */
export const baseFontPx = (canvasH: number) => canvasH * TEXT_BASE

/** A text's natural (scale 1) content box on a canvas `canvasH` tall, in canvas px. */
export function textSize(text: Pick<ClipText, "content" | "orientation">, canvasH: number): { w: number; h: number } {
  const { w, h } = textLayout(text, baseFontPx(canvasH))
  return { w, h }
}
