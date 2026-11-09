import { describe, expect, it } from "vitest"
import { importCategory, importRejection, isSameOrigin, isUploadId, kindFromProbe, MAX_IMPORT_BYTES, parseStreams, sanitizeImportName } from "./import"

describe("importCategory", () => {
  it("takes pictures, videos and sound by extension, any case", () => {
    expect(importCategory("a.JPG")).toBe("image")
    expect(importCategory("a.mov")).toBe("video")
    expect(importCategory("song.MP3")).toBe("audio")
    for (const ext of ["wav", "m4a", "aac", "ogg", "opus", "flac", "wma"]) expect(importCategory(`x.${ext}`)).toBe("audio")
    expect(importCategory("notes.txt")).toBeNull()
    expect(importCategory("mp3")).toBeNull()
  })
})

describe("sanitizeImportName", () => {
  it("keeps an ordinary name", () => {
    expect(sanitizeImportName("Holiday clip (1).mp4")).toBe("Holiday clip (1).mp4")
  })

  it("drops any path and steps outside", () => {
    expect(sanitizeImportName("../../etc/passwd.mp3")).toBe("passwd.mp3")
    expect(sanitizeImportName("C:\\Users\\me\\..\\song.wav")).toBe("song.wav")
  })

  it("replaces control and Windows-reserved characters", () => {
    expect(sanitizeImportName("a\u0000b\nc<d>e:f\"g|h?i*.mp4")).toBe("a_b_c_d_e_f_g_h_i_.mp4")
  })

  it("strips leading dots (hidden files, the peaks cache) and trailing dots and spaces", () => {
    expect(sanitizeImportName(".song.mp3.peaks")).toBe("song.mp3.peaks")
    expect(sanitizeImportName("...clip.mp4. . ")).toBe("clip.mp4")
  })

  it("guards Windows device names and empty stems", () => {
    expect(sanitizeImportName("CON.mp3")).toBe("_CON.mp3")
    expect(sanitizeImportName("  .mp4")).toBe("mp4")
    expect(sanitizeImportName("<>.mp4")).toBe("__.mp4")
  })

  it("shortens a long name and keeps its extension", () => {
    const n = sanitizeImportName(`${"x".repeat(400)}.flac`)
    expect(n.length).toBe(180)
    expect(n.endsWith(".flac")).toBe(true)
  })
})

describe("importRejection", () => {
  it("refuses unknown types, empty files and files over 4 GB, naming the file", () => {
    expect(importRejection("notes.txt", 10)).toMatch(/^notes\.txt/)
    expect(importRejection("a.mp4", 0)).toBe("a.mp4 is empty.")
    expect(importRejection("a.mp4", MAX_IMPORT_BYTES + 1)).toMatch(/4 GB/)
    expect(importRejection("a.mp4", MAX_IMPORT_BYTES)).toBeNull()
  })
})

describe("isUploadId", () => {
  it("takes 16 lower-case hex digits only", () => {
    expect(isUploadId("0123456789abcdef")).toBe(true)
    expect(isUploadId("../../../../etc")).toBe(false)
    expect(isUploadId("0123456789ABCDEF")).toBe(false)
  })
})

const FFMPEG_MP3 = `Input #0, mp3, from 'song.mp3':
  Duration: 00:03:05.25, start: 0.025057, bitrate: 192 kb/s
  Stream #0:0: Audio: mp3 (mp3float), 44100 Hz, stereo, fltp, 192 kb/s
  Stream #0:1: Video: mjpeg (Baseline), yuvj420p(pc), 500x500, 90k tbr, 90k tbn (attached pic)
At least one output file must be specified`

describe("parseStreams", () => {
  it("reads the length and the streams, ignoring cover art", () => {
    expect(parseStreams(FFMPEG_MP3)).toEqual({ duration: 185.25, hasVideo: false, hasAudio: true })
  })

  it("reads a still (no length) and a video with sound", () => {
    expect(parseStreams("  Duration: N/A, bitrate: N/A\n  Stream #0:0: Video: png, rgb24, 64x64\n")).toEqual({ duration: null, hasVideo: true, hasAudio: false })
    expect(parseStreams("  Duration: 00:00:02.00, start: 0\n  Stream #0:0[0x1](und): Video: h264\n  Stream #0:1[0x2](und): Audio: aac\n")).toEqual({ duration: 2, hasVideo: true, hasAudio: true })
  })

  it("finds nothing in a file ffmpeg can't read", () => {
    expect(parseStreams("x.mp4: Invalid data found when processing input")).toEqual({ duration: null, hasVideo: false, hasAudio: false })
  })
})

describe("kindFromProbe", () => {
  const none = { duration: null, hasVideo: false, hasAudio: false }

  it("trusts what ffmpeg read, not the name's claim", () => {
    expect(kindFromProbe("fake.mp4", none)).toEqual({ error: "fake.mp4 couldn't be read as a video." })
    expect(kindFromProbe("fake.jpg", none)).toEqual({ error: "fake.jpg couldn't be read as an image." })
    expect(kindFromProbe("silent.wav", { duration: 3, hasVideo: false, hasAudio: false })).toEqual({ error: "silent.wav has no sound ffmpeg can read." })
  })

  it("takes a video (with or without sound), an image and an audio file", () => {
    expect(kindFromProbe("a.mp4", { duration: 4, hasVideo: true, hasAudio: true })).toEqual({ kind: "video", duration: 4, hasAudio: true })
    expect(kindFromProbe("a.mp4", { duration: 4, hasVideo: true, hasAudio: false })).toEqual({ kind: "video", duration: 4, hasAudio: false })
    expect(kindFromProbe("a.png", { duration: null, hasVideo: true, hasAudio: false })).toEqual({ kind: "image" })
    expect(kindFromProbe("a.mp3", { duration: 185.25, hasVideo: false, hasAudio: true })).toEqual({ kind: "audio", duration: 185.25, hasAudio: true })
  })

  it("counts a video file with only sound as audio", () => {
    expect(kindFromProbe("voice.mp4", { duration: 9, hasVideo: false, hasAudio: true })).toEqual({ kind: "audio", duration: 9, hasAudio: true })
  })

  it("refuses too short, no length, and unknown types", () => {
    expect(kindFromProbe("a.wav", { duration: 0.1, hasVideo: false, hasAudio: true })).toEqual({ error: "a.wav is too short to edit." })
    expect(kindFromProbe("a.wav", { duration: null, hasVideo: false, hasAudio: true })).toEqual({ error: "a.wav: couldn't read its length." })
    expect("error" in kindFromProbe("a.txt", { duration: 3, hasVideo: true, hasAudio: true })).toBe(true)
  })
})

describe("isSameOrigin", () => {
  it("takes only a request from the app's own host", () => {
    expect(isSameOrigin("http://localhost:3200", "localhost:3200")).toBe(true)
    expect(isSameOrigin("https://nas.local", "NAS.local")).toBe(true)
    expect(isSameOrigin("https://evil.example", "nas.local")).toBe(false)
    expect(isSameOrigin(null, "nas.local")).toBe(false)
    expect(isSameOrigin("null", "nas.local")).toBe(false)
  })
})
