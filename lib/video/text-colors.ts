import type { Project } from "./project"

// Edit text's color helpers (client-safe): the colors other text clips in
// the project use, offered as swatches under Color, and the backdrop behind
// the font sample, dark or light by whichever gives the chosen color the
// higher WCAG contrast ratio.

export const MAX_USED_COLORS = 12

/**
 * The distinct colors (lower-case #rrggbb) of the project's text clips, on
 * every layer, leaving out the clip `excludeClipId` (its color still shows
 * when another clip uses it). Most used first, then by the earliest clip's
 * start; at most MAX_USED_COLORS.
 */
export function usedTextColors(project: Project, excludeClipId?: string): string[] {
  const seen = new Map<string, { count: number; first: number }>()
  for (const track of project.tracks) {
    for (const clip of track.clips) {
      if (!clip.text || clip.id === excludeClipId) continue
      const c = clip.text.color.toLowerCase()
      const s = seen.get(c)
      if (s) {
        s.count++
        s.first = Math.min(s.first, clip.start)
      } else seen.set(c, { count: 1, first: clip.start })
    }
  }
  return [...seen]
    .sort(([, a], [, b]) => b.count - a.count || a.first - b.first)
    .slice(0, MAX_USED_COLORS)
    .map(([c]) => c)
}

export const DARK_BACKDROP = "#171717"
export const LIGHT_BACKDROP = "#f5f5f5"
/** Between the two: what a text with a shadow is shown on when neither end shows both the letters and the shadow. */
export const MID_BACKDROP = "#8a8a8a"

/** WCAG relative luminance of a #rrggbb color. */
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const v = parseInt(hex.slice(i, i + 2), 16) / 255
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

const ratio = (a: number, b: number) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)

/**
 * The backdrop that shows both the letters and their shadow (`shadow`, a
 * #rrggbb) best: the one where the weaker of the two contrasts is highest.
 */
export function shadowBackdrop(hex: string, shadow: string): { background: string; contrast: number } {
  const lum = (c: string) => luminance(/^#[0-9a-f]{6}$/i.test(c) ? c : "#ffffff")
  const [a, b] = [lum(hex), lum(shadow)]
  const options = [DARK_BACKDROP, LIGHT_BACKDROP, MID_BACKDROP].map((background) => {
    const l = luminance(background)
    return { background, contrast: Math.min(ratio(a, l), ratio(b, l)) }
  })
  return options.reduce((best, o) => (o.contrast > best.contrast ? o : best))
}

/** The backdrop (dark or light) that gives `hex` the higher contrast, and that ratio; an invalid color counts as white. */
export function previewBackdrop(hex: string): { background: string; contrast: number } {
  const l = luminance(/^#[0-9a-f]{6}$/i.test(hex) ? hex : "#ffffff")
  const onDark = ratio(l, luminance(DARK_BACKDROP))
  const onLight = ratio(l, luminance(LIGHT_BACKDROP))
  return onDark >= onLight ? { background: DARK_BACKDROP, contrast: onDark } : { background: LIGHT_BACKDROP, contrast: onLight }
}
