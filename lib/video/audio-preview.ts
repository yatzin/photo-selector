import { fxAmount, normalizeClipAudio, type ClipAudio } from "./audio-levels"

// The Audio levels dialog's rendered preview (Generate preview): the server
// runs a clip's real export chain over the first PREVIEW_CAP seconds of its
// source window, for the effects the live Web Audio preview can't play
// (lib/video/audio-preview-server, the audio-preview route). The request's
// shape and checks, the window and the cache key. Plain data, safe on the
// client.

/** How much of the clip's window a rendered preview covers (s). */
export const PREVIEW_CAP = 12

/** Shortest window worth rendering (s). */
const MIN_WINDOW = 0.05

export type PreviewRequest = { assetId: string; in: number; out: number; audio: ClipAudio | undefined }

const ms = (t: number) => Math.round(t * 1000) / 1000

/** The part of a clip's window [inSec, outSec) a preview renders: its first PREVIEW_CAP seconds, in whole milliseconds. */
export function previewWindow(inSec: number, outSec: number, cap = PREVIEW_CAP): { in: number; out: number } {
  const from = ms(inSec)
  return { in: from, out: ms(Math.min(outSec, from + cap)) }
}

/** A POST body ({ assetId, in, out, gainDb, fx }) checked like a stored clip's audio levels, or why it isn't one. */
export function parsePreviewRequest(body: unknown): PreviewRequest | { error: string } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return { error: "Invalid request." }
  const { assetId, in: from, out: to, gainDb, fx } = body as Record<string, unknown>
  if (typeof assetId !== "string" || assetId === "" || assetId.length > 200) return { error: "Invalid media." }
  if (typeof from !== "number" || typeof to !== "number" || !Number.isFinite(from) || !Number.isFinite(to) || from < 0 || to < from + MIN_WINDOW) return { error: "Invalid time range." }
  const audio = normalizeClipAudio({ gainDb, fx })
  if (audio === null) return { error: "Invalid audio levels." }
  return { assetId, in: from, out: to, audio }
}

/** What a rendered preview sounds like, as text for the cache's hash: the asset, the window and the gain and effects (with their intensities). */
export function previewKey(assetId: string, win: { in: number; out: number }, audio: ClipAudio | undefined): string {
  return JSON.stringify([assetId, ms(win.in), ms(win.out), audio?.gainDb ?? 0, (audio?.fx ?? []).map((f) => [f.type, fxAmount(f)])])
}
