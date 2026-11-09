import type { Project } from "./project"

// Edit text's colour helpers (client-safe): the colours other text clips in
// the project use, offered as swatches under Colour, and the backdrop behind
// the font sample, dark or light by whichever gives the chosen colour the
// higher WCAG contrast ratio.

export const MAX_USED_COLOURS = 12

/**
 * The distinct colours (lower-case #rrggbb) of the project's text clips, on
 * every layer, leaving out the clip `excludeClipId` (its colour still shows
 * when another clip uses it). Most used first, then by the earliest clip's
 * start; at most MAX_USED_COLOURS.
 */
export function usedTextColours(project: Project, excludeClipId?: string): string[] {
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
    .slice(0, MAX_USED_COLOURS)
    .map(([c]) => c)
}

export const DARK_BACKDROP = "#171717"
export const LIGHT_BACKDROP = "#f5f5f5"

/** WCAG relative luminance of a #rrggbb colour. */
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const v = parseInt(hex.slice(i, i + 2), 16) / 255
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

const ratio = (a: number, b: number) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)

/** The backdrop (dark or light) that gives `hex` the higher contrast, and that ratio; an invalid colour counts as white. */
export function previewBackdrop(hex: string): { background: string; contrast: number } {
  const l = luminance(/^#[0-9a-f]{6}$/i.test(hex) ? hex : "#ffffff")
  const onDark = ratio(l, luminance(DARK_BACKDROP))
  const onLight = ratio(l, luminance(LIGHT_BACKDROP))
  return onDark >= onLight ? { background: DARK_BACKDROP, contrast: onDark } : { background: LIGHT_BACKDROP, contrast: onLight }
}
