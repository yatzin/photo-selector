import { IMAGE_EXTENSIONS, VIDEO_EXTENSIONS } from "@/lib/media"
import { MIN_CLIP } from "./project"

// The rules for files uploaded from the user's computer with Import (the
// route app/api/video-projects/[project]/import does the disk work). Nothing
// here touches the disk, so the client checks a file before sending it and
// the server checks it again: the extension picks what a file may be, and
// only ffmpeg's reading of its content (kindFromProbe) says what it is.

/** Sound files ffmpeg reads; their clips go on the audio layer. */
export const AUDIO_EXTENSIONS = new Set([".mp3", ".wav", ".m4a", ".aac", ".ogg", ".oga", ".opus", ".flac", ".wma"])

/** Largest file Import takes: 4 GiB. */
export const MAX_IMPORT_BYTES = 4 * 1024 ** 3
/** The browser sends a file in pieces this big, one request each, so no request runs into a server timeout. */
export const IMPORT_CHUNK_BYTES = 32 * 1024 * 1024
/** Largest piece the server takes in one request. */
export const MAX_IMPORT_CHUNK_BYTES = 64 * 1024 * 1024
const MAX_NAME_LENGTH = 180

export type ImportCategory = "image" | "video" | "audio"

/** The lower-case extension of a file name ("" for none). */
function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".")
  return dot > 0 ? name.slice(dot).toLowerCase() : ""
}

/** What a file may be from its extension, or null for one Import doesn't take. */
export function importCategory(name: string): ImportCategory | null {
  const ext = extensionOf(name)
  if (IMAGE_EXTENSIONS.has(ext)) return "image"
  if (VIDEO_EXTENSIONS.has(ext)) return "video"
  if (AUDIO_EXTENSIONS.has(ext)) return "audio"
  return null
}

/** The file picker's accept list: any picture, video or sound, and every extension the server takes by name. */
export const IMPORT_ACCEPT = ["video/*", "image/*", "audio/*", ...IMAGE_EXTENSIONS, ...VIDEO_EXTENSIONS, ...AUDIO_EXTENSIONS].join(",")

const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i

/**
 * A browser-sent file name made safe to store in assets/: any path before it
 * goes, control characters and those Windows refuses (<>:"/\|?*) become "_",
 * leading dots and spaces (a hidden file, or one that could pass for the
 * waveform cache) and trailing dots and spaces go, a Windows device name gets
 * a "_" in front, and a long name is cut to 180 characters keeping its
 * extension. "media" stands in when no name is left before the extension.
 */
export function sanitizeImportName(raw: string): string {
  const last = raw.split(/[\\/]/).pop() ?? ""
  const name = last.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, "_").replace(/^[.\s]+/, "").replace(/[.\s]+$/, "")
  const ext = extensionOf(name)
  let stem = name.slice(0, name.length - ext.length).trim()
  if (!stem) stem = "media"
  if (RESERVED.test(stem)) stem = `_${stem}`
  stem = stem.slice(0, MAX_NAME_LENGTH - ext.length).trim()
  return `${stem}${ext}`
}

/** Why a file can't be imported from its name and size alone, or null when it may be sent. */
export function importRejection(name: string, size: number): string | null {
  if (!importCategory(name)) return `${name} isn't a video, image or audio file Import can take.`
  if (!(size > 0)) return `${name} is empty.`
  if (size > MAX_IMPORT_BYTES) return `${name} is larger than the 4 GB import limit.`
  return null
}

/** An upload's id: what the server hands back after a file's first piece. */
export const isUploadId = (id: string) => /^[0-9a-f]{16}$/.test(id)

/** What ffmpeg says a file holds: its length (null when it gives none, as for a still), and whether it has a picture (cover art doesn't count) and sound. */
export type ProbedStreams = { duration: number | null; hasVideo: boolean; hasAudio: boolean }

/** Parses `ffmpeg -i` stderr into ProbedStreams; a file ffmpeg can't read has no streams. */
export function parseStreams(stderr: string): ProbedStreams {
  const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr)
  const duration = m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : null
  const streams = stderr.split(/\r?\n/).filter((l) => /^\s*Stream #/.test(l))
  return {
    duration,
    hasVideo: streams.some((l) => /: Video:/.test(l) && !/\(attached pic\)/.test(l)),
    hasAudio: streams.some((l) => /: Audio:/.test(l)),
  }
}

export type ImportKind = { kind: "image" } | { kind: "video" | "audio"; duration: number; hasAudio: boolean }

/**
 * What an uploaded file is, from its name and what ffmpeg read in it (never
 * from the type the browser claimed): an image needs a picture ffmpeg can
 * decode; an audio file needs sound; a video file with a picture is a video
 * (with or without sound) and one with only sound counts as audio. Videos
 * and audio need a length of at least MIN_CLIP. Otherwise `{ error }`, naming
 * the file.
 */
export function kindFromProbe(name: string, s: ProbedStreams): ImportKind | { error: string } {
  const category = importCategory(name)
  if (!category) return { error: `${name} isn't a video, image or audio file Import can take.` }
  if (category === "image") return s.hasVideo ? { kind: "image" } : { error: `${name} couldn't be read as an image.` }
  const kind = category === "audio" ? (s.hasAudio ? "audio" : null) : s.hasVideo ? "video" : s.hasAudio ? "audio" : null
  if (!kind) return { error: category === "audio" ? `${name} has no sound ffmpeg can read.` : `${name} couldn't be read as a video.` }
  if (s.duration === null) return { error: `${name}: couldn't read its length.` }
  if (s.duration < MIN_CLIP) return { error: `${name} is too short to edit.` }
  return { kind, duration: s.duration, hasAudio: s.hasAudio }
}
