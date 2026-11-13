"use client"

import { useEffect, useState } from "react"
import { frameKey } from "@/lib/video/filmstrip"

// Snapshots of a video at given moments, for the timeline's filmstrip. One
// hidden video per file seeks to each wanted moment in turn and draws it to a
// small canvas; the pictures are cached for the page's life and shared by every
// clip of the file. Anything that fails (no frame, a tainted canvas) leaves the
// moment without a picture, and the tile keeps the file's poster.

const WIDTH = 160 // px; a tile is drawn at most this wide
const MAX_CACHE = 600

type Job = { url: string; wanted: Set<number>; running: boolean }

const pictures = new Map<string, string>() // `${url}|${ms}`
const jobs = new Map<string, Job>()
const listeners = new Set<() => void>()
const key = (url: string, ms: number) => `${url}|${ms}`

function notify() {
  listeners.forEach((l) => l())
}

async function run(job: Job) {
  if (job.running) return
  job.running = true
  const video = document.createElement("video")
  video.muted = true
  video.preload = "auto"
  video.playsInline = true
  video.src = job.url
  try {
    await new Promise<void>((ok, fail) => {
      video.onloadeddata = () => ok()
      video.onerror = () => fail(new Error("load"))
    })
    const h = Math.max(1, Math.round((WIDTH * (video.videoHeight || 9)) / (video.videoWidth || 16)))
    const canvas = document.createElement("canvas")
    canvas.width = WIDTH
    canvas.height = h
    const ctx = canvas.getContext("2d")
    while (job.wanted.size > 0 && ctx) {
      const ms = job.wanted.values().next().value as number
      job.wanted.delete(ms)
      if (pictures.has(key(job.url, ms))) continue
      try {
        await new Promise<void>((ok, fail) => {
          video.onseeked = () => ok()
          video.onerror = () => fail(new Error("seek"))
          video.currentTime = ms / 1000
        })
        ctx.drawImage(video, 0, 0, WIDTH, h)
        if (pictures.size >= MAX_CACHE) pictures.delete(pictures.keys().next().value as string)
        pictures.set(key(job.url, ms), canvas.toDataURL("image/jpeg", 0.6))
        notify()
      } catch {
        // No picture for this moment.
      }
    }
  } catch {
    // The file would not load: its tiles keep the poster.
  } finally {
    video.removeAttribute("src")
    video.load()
    job.running = false
    if (job.wanted.size === 0) jobs.delete(job.url)
  }
}

function want(url: string, times: number[]) {
  let job = jobs.get(url)
  for (const t of times) {
    const ms = frameKey(t)
    if (pictures.has(key(url, ms))) continue
    if (!job) jobs.set(url, (job = { url, wanted: new Set(), running: false }))
    job.wanted.add(ms)
  }
  if (job) void run(job)
}

/** A lookup from a moment (s) to its snapshot (a data URL), or undefined until it is drawn. Empty `url` asks for nothing. */
export function useFilmFrames(url: string, times: number[]): (t: number) => string | undefined {
  const [, bump] = useState(0)
  useEffect(() => {
    const l = () => bump((n) => n + 1)
    listeners.add(l)
    return () => void listeners.delete(l)
  }, [])
  const signature = times.map(frameKey).join(",")
  useEffect(() => {
    if (url) want(url, signature ? signature.split(",").map((s) => Number(s) / 1000) : [])
  }, [url, signature])
  return (t) => pictures.get(key(url, frameKey(t)))
}
