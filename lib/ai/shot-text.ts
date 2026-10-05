import type { ShotKind } from "@/lib/ai/review"

// Wording for the scans that flag images one by one.

export const SHOT_TEXT: Record<
  ShotKind,
  {
    /** The scan's name, as on its tab. */
    scan: string
    /** One flagged image, lower case. */
    one: string
    /** Results tab of flagged images. */
    flagged: string
    /** Results tab of images the user said the AI got wrong. */
    kept: string
    keep: string
    unkeep: string
    /** Images that can be moved to Sort Dropoff instead of deleted. */
    canMove: boolean
  }
> = {
  screenshots: {
    scan: "Find Screenshots", one: "screenshot", flagged: "Screenshots", kept: "Not screenshots",
    keep: "Not a screenshot", unkeep: "Is a screenshot", canMove: true,
  },
  quality: {
    scan: "Quality Checks", one: "bad photo", flagged: "Bad photos", kept: "Not bad",
    keep: "Not a bad photo", unkeep: "Is a bad photo", canMove: false,
  },
}
