/**
 * The transitions a cut can have, by the name ffmpeg's xfade filter gives
 * each (the export passes it as it is), grouped as the Transition dialog
 * shows them. No imports, so project.ts and transitions.ts can both use it.
 */
export const TRANSITION_TYPES = [
  "fade", "fadeblack", "fadewhite",
  "wipeleft", "wiperight", "wipeup", "wipedown",
  "slideleft", "slideright", "slideup", "slidedown",
  "circleopen", "circleclose", "radial",
  "pixelize", "dissolve", "zoomin", "hblur",
] as const

export type TransitionType = (typeof TRANSITION_TYPES)[number]

/** A clip's transition from the clip before it (which must adjoin it): `duration` seconds, centred on the cut. */
export type Transition = { type: TransitionType; duration: number }

/** Shortest transition, in seconds. */
export const MIN_TRANSITION = 0.1
/** Longest transition, in seconds, whatever the footage allows. */
export const MAX_TRANSITION = 5
/** The length a new transition gets (or less, when that's all the footage allows). */
export const DEFAULT_TRANSITION = 1

export const isTransitionType = (v: unknown): v is TransitionType => typeof v === "string" && (TRANSITION_TYPES as readonly string[]).includes(v)
