import { setTransform, type Project } from "./project"
import { IDENTITY } from "./transform"

/**
 * How big a stock result is when it's dropped on the preview: its linear scale
 * (1 = fitted to the frame). 0.4 x 0.4 is 16% of the frame, about a sixth.
 * It lands centred; the user moves or resizes it from there.
 */
export const STOCK_DROP_SCALE = 0.4

/** The same project with the clip shrunk to the stock-drop size (the same project for an unknown or audio clip). */
export function withStockDropSize(p: Project, clipId: string): Project {
  return setTransform(p, clipId, { ...IDENTITY, scale: STOCK_DROP_SCALE })
}
