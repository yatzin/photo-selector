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

/**
 * A J-cut ("j": the incoming clip's sound starts `duration` seconds before
 * its picture) or an L-cut ("l": the outgoing clip's sound carries on that
 * long past its picture) at a clip's cut from the clip before it (which must
 * adjoin it). The pictures cut where they always did.
 */
export type CutAudio = { mode: "j" | "l"; duration: number }

export const CUT_AUDIO_MODES = ["j", "l"] as const
/** Shortest and longest audio overlap, in seconds. */
export const MIN_CUT_AUDIO = 0.1
export const MAX_CUT_AUDIO = 5
/** The length a new audio overlap gets (or less, when that's all there is). */
export const DEFAULT_CUT_AUDIO = 1
/** The fade (s, linear) at an overlap's new sound edge, so it never clicks; at most the overlap itself. */
export const CUT_AUDIO_FADE = 0.15

export const isCutAudioMode = (v: unknown): v is CutAudio["mode"] => typeof v === "string" && (CUT_AUDIO_MODES as readonly string[]).includes(v)
