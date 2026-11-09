import { DEFAULT_FONT, fontById, isFontId, lineWidth } from "./fonts"

// Text clips: a clip with no media whose picture is a block of text. The
// content box (the text's natural, un-scaled size on the canvas) comes from
// the text and its font's numbers alone, so the preview and the export agree
// on it without measuring anything:
//
// - Fonts are bundled (lib/video/fonts: 50 OFL or Apache fonts in
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

/**
 * How a text comes in (at the clip's start) or goes out (at its end); the
 * maths is lib/video/text-animation. An out animation plays its in
 * animation backwards. Slide and sweep name a side: in, from that side; out,
 * towards it ("up" is the top).
 */
export const ANIM_TYPES = [
  "fade",
  "slide-left", "slide-right", "slide-up", "slide-down",
  "sweep-left", "sweep-right", "sweep-up", "sweep-down",
  "explode", "implode", "pop", "spin", "bounce", "typewriter",
] as const
export type AnimType = (typeof ANIM_TYPES)[number]
/** `duration` in seconds, MIN_ANIM up to the clip's length (fitAnims). */
export type TextAnim = { type: AnimType; duration: number }
export const MIN_ANIM = 0.1
/** Longest an animation may be stored as (a text clip's longest length, MAX_IMAGE). */
const MAX_ANIM = 600

/**
 * A text clip's text: `color` is #rrggbb (lower case); `font` an id from
 * lib/video/fonts, absent for Mono; `animIn` and `animOut` absent for none.
 */
export type ClipText = { content: string; color: string; orientation: TextOrientation; font?: string; animIn?: TextAnim; animOut?: TextAnim }

const isAnimType = (v: unknown): v is AnimType => typeof v === "string" && (ANIM_TYPES as readonly string[]).includes(v)

/** True for an animation with a known type and a finite duration from MIN_ANIM to MAX_ANIM seconds. */
export function isValidAnim(v: unknown): v is TextAnim {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false
  const { type, duration } = v as Record<string, unknown>
  return isAnimType(type) && typeof duration === "number" && Number.isFinite(duration) && duration >= MIN_ANIM && duration <= MAX_ANIM
}

const sameAnim = (a: TextAnim | undefined, b: TextAnim | undefined) => a === b || (a !== undefined && b !== undefined && a.type === b.type && a.duration === b.duration)

/** Seconds down to the millisecond, so durations scaled to fit still add up to no more than the clip. */
const floorMs = (s: number) => Math.floor(s * 1000 + 1e-6) / 1000

/**
 * `text` with its animations fitted to a clip `length` seconds long: each at
 * most the clip, and when in and out together run longer than the clip both
 * shrink in proportion (to whole milliseconds), neither below MIN_ANIM (the
 * other gives way; a clip is at least MIN_CLIP, two MIN_ANIMs). The same text
 * when they already fit.
 */
export function fitAnims(text: ClipText, length: number): ClipText {
  const a = text.animIn?.duration ?? 0
  const b = text.animOut?.duration ?? 0
  if (a + b <= length + 1e-9) return text
  let da = a
  let db = b
  if (a > 0 && b > 0) {
    const k = length / (a + b)
    da = Math.max(MIN_ANIM, floorMs(a * k))
    db = Math.max(MIN_ANIM, floorMs(b * k))
    if (da + db > length + 1e-9) {
      if (da > db) da = floorMs(length - db)
      else db = floorMs(length - da)
    }
  } else {
    da = a > 0 ? Math.max(MIN_ANIM, floorMs(length)) : 0
    db = b > 0 ? Math.max(MIN_ANIM, floorMs(length)) : 0
  }
  const next: ClipText = { ...text }
  if (text.animIn) next.animIn = { ...text.animIn, duration: da }
  if (text.animOut) next.animOut = { ...text.animOut, duration: db }
  return next
}

/** The first piece of a split text keeps its in animation, the second its out one; each fitted to its new length. */
export function splitAnims(text: ClipText, firstLength: number, secondLength: number): [ClipText, ClipText] {
  const first: ClipText = { ...text }
  const second: ClipText = { ...text }
  delete first.animOut
  delete second.animIn
  return [fitAnims(first, firstLength), fitAnims(second, secondLength)]
}

/** Longest content, in UTF-16 code units (string length). */
export const MAX_TEXT = 500
export const DEFAULT_TEXT: ClipText = { content: "Text", color: "#ffffff", orientation: "horizontal" }

/** The base font size as a fraction of the canvas height. */
export const TEXT_BASE = 0.1

const HEX = /^#[0-9a-fA-F]{6}$/

/** True for a valid text: 1 to MAX_TEXT characters and not only spaces, a #rrggbb colour, an orientation, no font or a known one, no animations or valid ones. */
export function isValidText(v: unknown): v is ClipText {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false
  const { content, color, orientation, font, animIn, animOut } = v as Record<string, unknown>
  return (
    typeof content === "string" && content.trim().length > 0 && content.length <= MAX_TEXT &&
    typeof color === "string" && HEX.test(color) && (orientation === "horizontal" || orientation === "vertical") &&
    (font === undefined || isFontId(font)) && (animIn === undefined || isValidAnim(animIn)) && (animOut === undefined || isValidAnim(animOut))
  )
}

/**
 * Only the text's own fields (an animation's too), the colour in lower case,
 * the line ends as \n and no font for Mono; null when it isn't valid. Its
 * animations aren't fitted to a clip here (fitAnims does that).
 */
export function normalizeText(v: unknown): ClipText | null {
  if (typeof v !== "object" || v === null) return null
  const r = v as Record<string, unknown>
  const t = {
    content: typeof r.content === "string" ? r.content.replace(/\r\n?/g, "\n") : r.content, color: r.color, orientation: r.orientation, font: r.font,
    animIn: r.animIn, animOut: r.animOut,
  }
  if (!isValidText(t)) return null
  const text: ClipText = { content: t.content, color: t.color.toLowerCase(), orientation: t.orientation }
  if (t.font !== undefined && t.font !== DEFAULT_FONT) text.font = t.font
  if (t.animIn) text.animIn = { type: t.animIn.type, duration: t.animIn.duration }
  if (t.animOut) text.animOut = { type: t.animOut.type, duration: t.animOut.duration }
  return text
}

export const sameText = (a: ClipText | undefined, b: ClipText | undefined) =>
  a === b ||
  (a !== undefined && b !== undefined && a.content === b.content && a.color === b.color && a.orientation === b.orientation &&
    (a.font ?? DEFAULT_FONT) === (b.font ?? DEFAULT_FONT) && sameAnim(a.animIn, b.animIn) && sameAnim(a.animOut, b.animOut))

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
