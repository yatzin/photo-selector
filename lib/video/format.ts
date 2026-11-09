// A project's picture format: which way up it is (orientation) and how sharp
// (resolution). The project stores only width and height; everything here
// turns those into the plain-language choices the editor shows, and back.
// Sizes come in the usual 16:9 steps, turned on their side for Vertical, and
// every side is even (H.264 needs that).

export type Orientation = "horizontal" | "vertical"

export const ORIENTATIONS: { id: Orientation; label: string; note: string }[] = [
  { id: "horizontal", label: "Horizontal", note: "Wide, like a TV or YouTube video." },
  { id: "vertical", label: "Vertical", note: "Tall, for phones: YouTube Shorts, TikTok, Instagram Reels." },
]

export type ResolutionId = "uhd" | "fhd" | "hd" | "sd"

/**
 * The resolutions on offer, best first. `short` is the shorter side in pixels
 * (the "1080" of 1080p). The label is what a person would call it; the note
 * says what it is good for in a few plain words.
 */
export const RESOLUTIONS: { id: ResolutionId; label: string; short: number; note: string; badge?: string }[] = [
  { id: "uhd", label: "Ultra HD", short: 2160, note: "Sharpest. Big file, slow to make." },
  { id: "fhd", label: "Full HD", short: 1080, note: "Best for YouTube, TikTok, Instagram and Facebook.", badge: "Recommended" },
  { id: "hd", label: "HD", short: 720, note: "Smaller file. Good for sending in messages." },
  { id: "sd", label: "Standard", short: 480, note: "Smallest and quickest. Lower quality." },
]

/** The longer side for a shorter one at 16:9, kept even. */
const longSide = (short: number) => 2 * Math.round((short * 16) / 9 / 2)

/** Width and height for an orientation at a resolution. */
export function sizeFor(orientation: Orientation, resolution: ResolutionId): { width: number; height: number } {
  const short = RESOLUTIONS.find((r) => r.id === resolution)!.short
  const long = longSide(short)
  return orientation === "vertical" ? { width: short, height: long } : { width: long, height: short }
}

/** Which way up a canvas is: taller than wide is Vertical, anything else Horizontal. */
export const orientationOf = (width: number, height: number): Orientation => (height > width ? "vertical" : "horizontal")

/** The named resolution a canvas is exactly, or null for a size that isn't one of them (an older or custom project). */
export function resolutionOf(width: number, height: number): ResolutionId | null {
  const o = orientationOf(width, height)
  return RESOLUTIONS.find((r) => { const s = sizeFor(o, r.id); return s.width === width && s.height === height })?.id ?? null
}

/** "1920 × 1080". */
export const sizeText = (width: number, height: number) => `${width} × ${height}`

/**
 * The format a new project takes from its first picture: its orientation, and
 * the resolution that matches it, but never above Full HD (a 4K phone clip
 * would make every export slow and huge; Ultra HD stays a deliberate choice)
 * and never below Standard.
 */
export function formatFromSource(width: number, height: number): { width: number; height: number } {
  const short = Math.min(width, height)
  const match = RESOLUTIONS.filter((r) => r.id !== "uhd").find((r) => short >= r.short - 8) ?? RESOLUTIONS[RESOLUTIONS.length - 1]
  return sizeFor(orientationOf(width, height), match.id)
}

/** The size when the orientation changes and the resolution stays: the same named resolution if it has one, else the same shorter side. */
export function turnTo(orientation: Orientation, width: number, height: number): { width: number; height: number } {
  const known = resolutionOf(width, height)
  if (known) return sizeFor(orientation, known)
  const short = Math.min(width, height)
  const long = Math.max(width, height)
  return orientation === "vertical" ? { width: short, height: long } : { width: long, height: short }
}
