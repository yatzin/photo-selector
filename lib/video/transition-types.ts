/**
 * The transitions a cut can have, grouped as the Transition dialog shows
 * them. The first eighteen are named as ffmpeg's xfade filter names them (the
 * export passes the name as it is); the rest (CUSTOM_TRANSITIONS) are the
 * app's own, drawn by lib/video/transition-fx in the preview and the export.
 * No imports, so project.ts and transitions.ts can both use it.
 */
export const TRANSITION_TYPES = [
  "fade", "fadeblack", "fadewhite",
  "wipeleft", "wiperight", "wipeup", "wipedown",
  "slideleft", "slideright", "slideup", "slidedown",
  "circleopen", "circleclose", "radial",
  "pixelize", "dissolve", "zoomin", "hblur",
  "collage", "exchange", "pageturn", "reveal", "heart",
  "glitch", "glitchreveal", "whip-left", "whip-right", "whip-up", "whip-down",
] as const

export type TransitionType = (typeof TRANSITION_TYPES)[number]

/** The transitions xfade has no built-in for: the export draws them itself (lib/video/transition-fx). */
export const CUSTOM_TRANSITIONS = ["collage", "exchange", "pageturn", "reveal", "heart", "glitch", "glitchreveal", "whip-left", "whip-right", "whip-up", "whip-down"] as const satisfies readonly TransitionType[]
export type CustomTransition = (typeof CUSTOM_TRANSITIONS)[number]
export const isCustomTransition = (t: TransitionType): t is CustomTransition => (CUSTOM_TRANSITIONS as readonly string[]).includes(t)

/**
 * The transitions between two adjoining audio clips (the audio layer's), as
 * the dialog groups them: five crossfade curves, Dip to silence, and four
 * creative hand-offs. Their own ids, so the type alone says which family a
 * transition belongs to: audio clips take only these, picture clips only the
 * picture ones.
 */
export const AUDIO_TRANSITION_TYPES = [
  "audio-linear", "audio-equalpower", "audio-scurve", "audio-log", "audio-exp", "audio-dip",
  "audio-lowpass", "audio-tapestop", "audio-echo", "audio-telephone",
] as const

export type AudioTransitionType = (typeof AUDIO_TRANSITION_TYPES)[number]

/** The crossfade curves (and, at a free edge, the fade curves). */
export const AUDIO_CURVES = ["audio-linear", "audio-equalpower", "audio-scurve", "audio-log", "audio-exp"] as const satisfies readonly AudioTransitionType[]
export type AudioCurve = (typeof AUDIO_CURVES)[number]
export const isAudioCurve = (t: unknown): t is AudioCurve => typeof t === "string" && (AUDIO_CURVES as readonly string[]).includes(t)

/** A picture or an audio transition's type. */
export type AnyTransitionType = TransitionType | AudioTransitionType

/** A clip's transition from the clip before it (which must adjoin it): `duration` seconds, centred on the cut. A picture type between picture clips, an audio one between audio clips. */
export type Transition = { type: AnyTransitionType; duration: number }

/** Shortest transition, in seconds. */
export const MIN_TRANSITION = 0.1
/** Longest transition, in seconds, whatever the footage allows. */
export const MAX_TRANSITION = 10
/** The length a new transition gets (or less, when that's all the footage allows). */
export const DEFAULT_TRANSITION = 1

export const isTransitionType = (v: unknown): v is TransitionType => typeof v === "string" && (TRANSITION_TYPES as readonly string[]).includes(v)
export const isAudioTransitionType = (v: unknown): v is AudioTransitionType => typeof v === "string" && (AUDIO_TRANSITION_TYPES as readonly string[]).includes(v)
export const isAnyTransitionType = (v: unknown): v is AnyTransitionType => isTransitionType(v) || isAudioTransitionType(v)

/**
 * An "in" or "out" transition at a clip's free edge (no clip adjoins it
 * there), from or to nothing: the layers below, black, or silence. It runs
 * inside the clip, its first (`edgeIn`) or last (`edgeOut`) `duration`
 * seconds, so it needs no footage beyond the clip and trims nothing.
 */
export type EdgeTransition = { type: AnyTransitionType; duration: number }
export type Edge = "in" | "out"

/** Shortest and longest edge transition, in seconds; in and out together fit in the clip. */
export const MIN_EDGE = 0.1
export const MAX_EDGE = 10
/** The length a new edge transition gets (or less, when the clip is short). */
export const DEFAULT_EDGE = 1

/**
 * The picture transitions a free edge offers, worked on the clip's own
 * transparency. The dips to black and white mean nothing against nothing; a
 * zoom in only zooms its outgoing picture, and the collage's squares are the
 * outgoing picture's, so those two come in only at an out edge.
 */
export const EDGE_PICTURE_TYPES: Record<Edge, readonly TransitionType[]> = {
  in: TRANSITION_TYPES.filter((t) => t !== "fadeblack" && t !== "fadewhite" && t !== "zoomin" && t !== "collage"),
  out: TRANSITION_TYPES.filter((t) => t !== "fadeblack" && t !== "fadewhite"),
}

/** The sound fades a free edge of an audio clip offers: the five curves, a low-pass sweep, a tape start (in) or stop (out), and an echo tail (out only). */
export const EDGE_AUDIO_TYPES: Record<Edge, readonly AudioTransitionType[]> = {
  in: [...AUDIO_CURVES, "audio-lowpass", "audio-tapestop"],
  out: [...AUDIO_CURVES, "audio-lowpass", "audio-tapestop", "audio-echo"],
}

/** Whether `type` may sit at that edge of a picture clip (`audio` false) or an audio clip. */
export const isEdgeType = (type: unknown, edge: Edge, audio: boolean): type is AnyTransitionType =>
  typeof type === "string" && (audio ? (EDGE_AUDIO_TYPES[edge] as readonly string[]) : (EDGE_PICTURE_TYPES[edge] as readonly string[])).includes(type)

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
export const MAX_CUT_AUDIO = 10
/** The length a new audio overlap gets (or less, when that's all there is). */
export const DEFAULT_CUT_AUDIO = 1
/** The fade (s, linear) at an overlap's new sound edge, so it never clicks; at most the overlap itself. */
export const CUT_AUDIO_FADE = 0.15

export const isCutAudioMode = (v: unknown): v is CutAudio["mode"] => typeof v === "string" && (CUT_AUDIO_MODES as readonly string[]).includes(v)
