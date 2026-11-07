import { DEFAULT_FONT, fontById, isFontId, lineWidth } from "./fonts"

// Text clips: a clip with no media whose picture is a block of text. The
// content box (the text's natural, un-scaled size on the canvas) comes from
// the text and its font's numbers alone, so the preview and the export agree
// on it without measuring anything:
//
// - Fonts are bundled (lib/video/fonts: a dozen OFL or Apache fonts in
//   public/fonts, each licence beside it). The preview loads them with
//   @font-face, the export hands the same file to ffmpeg's drawtext, so no
//   system font is involved. A text with no `font` uses Mono, Geist Mono Bold,
//   the one font text had before fonts could be chosen; picking Mono stores no
//   `font` either, so such a text is exactly the text it always was.
// - Each font carries its advance widths (read from the font file when it was
//   added) and line metrics. A line's width is its characters' advances added
//   up; for Mono that's 0.6 of the font size a character, as before.
// - The base font size is a tenth of the canvas height (108 px on 1080p); the
//   clip's Transform scale multiplies it like any picture's.
// - Lines: horizontal text breaks at its newlines only (no wrapping); vertical
//   text puts every character on its own line (letters stacked), and a space or
//   newline there leaves an empty line, a gap.
// - The box is the longest line's width, rounded up to a twentieth of the font
//   size, wide and the lines x the font's `line` tall, plus the font's `pad`
//   all round (Mono: 0.6 a character, 1.3, 0.25). Each line is centred across
//   the box; its baseline sits the font's `ascent` (Mono 1.005) below the top
//   of its slot. Twentieths make the box whole pixels at a multiple of 20 px.
// - The browser and drawtext both shape a line with HarfBuzz (kerning,
//   ligatures, a script font's joins), so a drawn line can be a little narrower
//   or wider than its advances add up to (within about 2%). Each renderer
//   centres the line it drew on the line's centre, so they still agree (within
//   a pixel or two at 100 px), and the padding takes up the difference; a
//   very long line that outgrows it is cut at the box's edge in both.
//
// Characters outside the font's table (lib/video/fonts CHARSET: ASCII,
// Latin-1 and common typographic marks) count as the font's average letter.
// Ones the font lacks (emoji, CJK) are drawn by whatever fallback font the
// browser has, or as the font's missing-glyph box by ffmpeg; those may not
// match between preview and export.

export type TextOrientation = "horizontal" | "vertical"
/** A text clip's text: `color` is #rrggbb (lower case); `font` an id from lib/video/fonts, absent for Mono. */
export type ClipText = { content: string; color: string; orientation: TextOrientation; font?: string }

/** Longest content, in UTF-16 code units (string length). */
export const MAX_TEXT = 500
export const DEFAULT_TEXT: ClipText = { content: "Text", color: "#ffffff", orientation: "horizontal" }

/** The base font size as a fraction of the canvas height. */
export const TEXT_BASE = 0.1

const HEX = /^#[0-9a-fA-F]{6}$/

/** True for a valid text: 1 to MAX_TEXT characters and not only spaces, a #rrggbb colour, an orientation, no font or a known one. */
export function isValidText(v: unknown): v is ClipText {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false
  const { content, color, orientation, font } = v as Record<string, unknown>
  return (
    typeof content === "string" && content.trim().length > 0 && content.length <= MAX_TEXT &&
    typeof color === "string" && HEX.test(color) && (orientation === "horizontal" || orientation === "vertical") &&
    (font === undefined || isFontId(font))
  )
}

/** Only the text's own fields, the colour in lower case, the line ends as \n and no font for Mono; null when it isn't valid. */
export function normalizeText(v: unknown): ClipText | null {
  if (typeof v !== "object" || v === null) return null
  const r = v as Record<string, unknown>
  const t = { content: typeof r.content === "string" ? r.content.replace(/\r\n?/g, "\n") : r.content, color: r.color, orientation: r.orientation, font: r.font }
  if (!isValidText(t)) return null
  const text: ClipText = { content: t.content, color: t.color.toLowerCase(), orientation: t.orientation }
  if (t.font !== undefined && t.font !== DEFAULT_FONT) text.font = t.font
  return text
}

export const sameText = (a: ClipText | undefined, b: ClipText | undefined) =>
  a === b ||
  (a !== undefined && b !== undefined && a.content === b.content && a.color === b.color && a.orientation === b.orientation &&
    (a.font ?? DEFAULT_FONT) === (b.font ?? DEFAULT_FONT))

/** The lines drawn, top to bottom: tabs show as a space; vertical text has one character a line, a blank one for a space or newline. */
export function textLines(text: Pick<ClipText, "content" | "orientation">): string[] {
  const content = text.content.replace(/\r\n?/g, "\n").replace(/\t/g, " ")
  if (text.orientation === "horizontal") return content.split("\n")
  return Array.from(content).map((ch) => (/\s/.test(ch) ? "" : ch))
}

export type TextLine = { text: string; /** Its centre across the box. */ cx: number; baseline: number }

/** The content box (`w` x `h`) for font size `fontPx` and where each line goes in it (px from its top left). */
export function textLayout(text: Pick<ClipText, "content" | "orientation" | "font">, fontPx: number): { w: number; h: number; lines: TextLine[] } {
  const font = fontById(text.font)
  const lines = textLines(text)
  const widest = Math.max(font.other / font.upm, ...lines.map((l) => lineWidth(font, l)))
  const pad = font.pad * fontPx
  const w = (Math.ceil(widest * 20 - 1e-9) / 20) * fontPx + 2 * pad
  const h = lines.length * font.line * fontPx + 2 * pad
  return { w, h, lines: lines.map((l, i) => ({ text: l, cx: w / 2, baseline: pad + (i * font.line + font.ascent) * fontPx })) }
}

/** The base font size (px) on a canvas `canvasH` tall. */
export const baseFontPx = (canvasH: number) => canvasH * TEXT_BASE

/** A text's natural (scale 1) content box on a canvas `canvasH` tall, in canvas px. */
export function textSize(text: Pick<ClipText, "content" | "orientation" | "font">, canvasH: number): { w: number; h: number } {
  const { w, h } = textLayout(text, baseFontPx(canvasH))
  return { w, h }
}
