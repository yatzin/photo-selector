import { execSync } from "child_process"
import fs from "fs/promises"
import http from "http"
import os from "os"
import path from "path"
import type { AddressInfo } from "net"
import sharp from "sharp"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

// Integration test for the background runner: a throwaway SQLite database,
// throwaway photo folders and a fake OpenAI-compatible vision server.

type Behaviour = { status?: number; delayMs?: number; onStart?: () => void | Promise<void> }

const tmp = path.join(os.tmpdir(), `ps-runner-${process.pid}-${Date.now()}`)
const upload = path.join(tmp, "upload")
const folder = path.join(upload, "burst")
let server: http.Server
let behaviours: Behaviour[] = []
let calls = 0

let runner: typeof import("./runner-server")
let prisma: typeof import("@/lib/prisma").prisma

function scene(variant: "a" | "b", dx: number): Buffer {
  return Buffer.from(
    variant === "a"
      ? `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><rect width="400" height="300" fill="#3a7bd5"/><circle cx="320" cy="70" r="40" fill="#ffd200"/><rect x="${150 + dx}" y="120" width="60" height="160" fill="#7b3f00"/></svg>`
      : `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><rect width="400" height="300" fill="#202020"/><rect x="${20 + dx}" y="20" width="120" height="260" fill="#c62828"/><circle cx="280" cy="200" r="80" fill="#f5f5f5"/></svg>`
  )
}

async function makePhotos() {
  await fs.rm(folder, { recursive: true, force: true })
  await fs.mkdir(folder, { recursive: true })
  for (const [variant, hour] of [["a", 10], ["b", 14]] as const) {
    for (let i = 0; i < 3; i++) {
      await sharp(scene(variant, i * 3))
        .withExif({ IFD0: { DateTime: `2025:07:04 ${hour}:00:0${i * 2}` } })
        .jpeg()
        .toFile(path.join(folder, `${variant}${i + 1}.jpg`))
    }
  }
}

/** jessi/2025/10 with no photos of its own: day 10 has burst a, day 11 has burst b. */
const month = path.join(upload, "2025", "10")
async function makeMonth() {
  await fs.rm(path.join(upload, "2025"), { recursive: true, force: true })
  for (const [variant, day] of [["a", "10"], ["b", "11"]] as const) {
    await fs.mkdir(path.join(month, day), { recursive: true })
    for (let i = 0; i < 3; i++) {
      await sharp(scene(variant, i * 3))
        .withExif({ IFD0: { DateTime: `2025:10:${day} 12:00:0${i * 2}` } })
        .jpeg()
        .toFile(path.join(month, day, `${variant}${i + 1}.jpg`))
    }
  }
}

beforeAll(async () => {
  await fs.mkdir(path.join(tmp, "dropoff"), { recursive: true })
  const dbUrl = `file:${path.join(tmp, "test.db").split(path.sep).join("/")}`
  Object.assign(process.env, {
    DATABASE_URL: dbUrl,
    AUTH_SECRET: "runner-test-secret",
    PHOTOS_UPLOAD_DIR: upload,
    PHOTOS_DROPOFF_DIR: path.join(tmp, "dropoff"),
    PHOTOS_CACHE_DIR: path.join(tmp, "cache"),
  })
  execSync("npx prisma migrate deploy", { env: process.env, stdio: "ignore" })

  server = http.createServer((req, res) => {
    let raw = ""
    req.on("data", (c) => (raw += c))
    req.on("end", async () => {
      const b = behaviours.shift() ?? {}
      calls++
      await b.onStart?.()
      const parts = JSON.parse(raw).messages[1].content as { type: string }[]
      const n = parts.filter((p) => p.type === "image_url").length
      const ranking = Array.from({ length: n }, (_, i) => ({ photo: n - i, note: "" }))
      setTimeout(() => {
        res.writeHead(b.status ?? 200, { "Content-Type": "application/json" })
        res.end(JSON.stringify(b.status && b.status >= 400 ? { error: { message: "nope" } } : { choices: [{ message: { content: JSON.stringify({ ranking, best: [n], reason: "ok" }) } }] }))
      }, b.delayMs ?? 0)
    })
  })
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
  const port = (server.address() as AddressInfo).port

  runner = await import("./runner-server")
  prisma = (await import("@/lib/prisma")).prisma
  await prisma.aiSettings.create({ data: { id: "singleton", enabled: true, baseUrl: `http://127.0.0.1:${port}/v1`, model: "fake", timeoutSeconds: 10 } })
}, 120_000)

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()))
  await prisma?.$disconnect()
  await fs.rm(tmp, { recursive: true, force: true }).catch(() => {})
})

beforeEach(async () => {
  behaviours = []
  calls = 0
  await prisma.aiRun.deleteMany({})
  await makePhotos()
})

const groupsOf = (runId: string) => prisma.aiGroup.findMany({ where: { runId }, orderBy: { takenAt: "asc" }, include: { photos: true } })

describe("AI runner", () => {
  it("groups the folder and analyzes every group", async () => {
    const run = await runner.createRun({ root: "upload", folder: "burst", fresh: false, userId: null })
    if ("error" in run) throw new Error(run.error)
    await runner.drainRunner()
    const done = await prisma.aiRun.findUniqueOrThrow({ where: { id: run.runId } })
    expect(done.status).toBe("DONE")
    const groups = await groupsOf(run.runId)
    expect(groups.map((g) => g.status)).toEqual(["ANALYZED", "ANALYZED"])
    expect(groups.map((g) => g.photos.find((p) => p.suggested)?.name)).toEqual(["a3.jpg", "b3.jpg"])
  }, 60_000)

  it("refuses a second scan of a folder that is already being scanned", async () => {
    const first = await runner.createRun({ root: "upload", folder: "burst", fresh: false, userId: null })
    expect("runId" in first).toBe(true)
    const second = await runner.createRun({ root: "upload", folder: "burst", fresh: true, userId: null })
    expect(second).toEqual({ error: expect.stringMatching(/already/i) })
  }, 60_000)

  it("retries failed groups after other groups were resolved and their files moved", async () => {
    behaviours = [{ status: 400 }] // first group: model rejects it
    const run = await runner.createRun({ root: "upload", folder: "burst", fresh: false, userId: null })
    if ("error" in run) throw new Error(run.error)
    await runner.drainRunner()
    let groups = await groupsOf(run.runId)
    expect(groups.map((g) => g.status)).toEqual(["FAILED", "ANALYZED"])

    // The user resolves the analyzed group: its photos leave the folder.
    for (const p of groups[1].photos) await fs.rename(path.join(folder, p.name), path.join(tmp, "dropoff", p.name))
    await prisma.aiGroup.update({ where: { id: groups[1].id }, data: { status: "RESOLVED" } })

    expect(await runner.requeueRun(run.runId)).toEqual({ ok: true })
    await runner.drainRunner()
    const after = await prisma.aiRun.findUniqueOrThrow({ where: { id: run.runId } })
    expect(after.error).toBeNull()
    expect(after.status).toBe("DONE")
    groups = await groupsOf(run.runId)
    expect(groups.map((g) => g.status)).toEqual(["ANALYZED", "RESOLVED"])
  }, 60_000)

  it("fails only the group whose photo changed, not the whole retry", async () => {
    behaviours = [{ status: 400 }, {}]
    const run = await runner.createRun({ root: "upload", folder: "burst", fresh: false, userId: null })
    if ("error" in run) throw new Error(run.error)
    await runner.drainRunner()
    const failed = (await groupsOf(run.runId))[0]
    // Someone edits a photo of the failed group while the run is idle.
    const p = path.join(folder, failed.photos[0].name)
    await fs.utimes(p, new Date(), new Date(Date.now() + 60_000))

    await runner.requeueRun(run.runId)
    await runner.drainRunner()
    const after = await prisma.aiRun.findUniqueOrThrow({ where: { id: run.runId } })
    expect(after.status).toBe("DONE")
    const g = await prisma.aiGroup.findUniqueOrThrow({ where: { id: failed.id } })
    expect(g.status).toBe("FAILED")
    expect(g.error).toMatch(/changed since the scan/i)
  }, 60_000)

  it("does not let a cancel overwrite a retry that arrived while the request was in flight", async () => {
    let runId = ""
    let retried: Promise<unknown> = Promise.resolve()
    behaviours = [
      {
        delayMs: 300,
        onStart: async () => {
          // Cancel, then Retry, while the first AI request is still running.
          // The Retry lands before the runner has noticed the cancel.
          await prisma.aiRun.update({ where: { id: runId }, data: { status: "CANCELLED" } })
          retried = runner.requeueRun(runId)
          await retried
          runner.abortRun(runId)
        },
      },
    ]
    const run = await runner.createRun({ root: "upload", folder: "burst", fresh: false, userId: null })
    if ("error" in run) throw new Error(run.error)
    runId = run.runId
    await runner.drainRunner()
    // The runner may go idle between the cancel and the retry landing; the
    // retry kicks it again, as the Retry button does.
    await new Promise((r) => setTimeout(r, 100))
    await retried
    await runner.drainRunner()
    const after = await prisma.aiRun.findUniqueOrThrow({ where: { id: runId } })
    expect(after.status).toBe("DONE")
    expect((await groupsOf(runId)).every((g) => g.status === "ANALYZED")).toBe(true)
  }, 60_000)

  it("a re-scan keeps the earlier scan's analyzed groups and redoes only its failed ones", async () => {
    behaviours = [{ status: 400 }] // first group (a*) fails, second (b*) is analyzed
    const first = await runner.createRun({ root: "upload", folder: "burst", fresh: false, userId: null })
    if ("error" in first) throw new Error(first.error)
    await runner.drainRunner()

    calls = 0
    const second = await runner.createRun({ root: "upload", folder: "burst", fresh: false, userId: null })
    if ("error" in second) throw new Error(second.error)
    await runner.drainRunner()

    expect(calls).toBe(1)
    const kept = await groupsOf(first.runId)
    expect(kept.map((g) => [g.status, g.photos.map((p) => p.name).sort()])).toEqual([["ANALYZED", ["b1.jpg", "b2.jpg", "b3.jpg"]]])
    const old = await prisma.aiRun.findUniqueOrThrow({ where: { id: first.runId } })
    expect([old.groupCount, old.analyzedCount, old.failedCount]).toEqual([1, 1, 0])
    const redone = await groupsOf(second.runId)
    expect(redone.map((g) => [g.status, g.photos.map((p) => p.name).sort()])).toEqual([["ANALYZED", ["a1.jpg", "a2.jpg", "a3.jpg"]]])
  }, 60_000)

  it("a re-scan redoes a kept group whose photo changed since it was analyzed", async () => {
    const first = await runner.createRun({ root: "upload", folder: "burst", fresh: false, userId: null })
    if ("error" in first) throw new Error(first.error)
    await runner.drainRunner()
    await fs.utimes(path.join(folder, "a1.jpg"), new Date(), new Date(Date.now() + 60_000))

    const second = await runner.createRun({ root: "upload", folder: "burst", fresh: false, userId: null })
    if ("error" in second) throw new Error(second.error)
    await runner.drainRunner()

    expect((await groupsOf(first.runId)).map((g) => g.photos.map((p) => p.name).sort())).toEqual([["b1.jpg", "b2.jpg", "b3.jpg"]])
    expect((await prisma.aiRun.findUniqueOrThrow({ where: { id: first.runId } })).groupCount).toBe(1)
    expect((await groupsOf(second.runId)).map((g) => g.photos.map((p) => p.name).sort())).toEqual([["a1.jpg", "a2.jpg", "a3.jpg"]])
  }, 60_000)

  it("start fresh takes over every unreviewed group and removes an older scan left empty", async () => {
    const first = await runner.createRun({ root: "upload", folder: "burst", fresh: false, userId: null })
    if ("error" in first) throw new Error(first.error)
    await runner.drainRunner()

    const second = await runner.createRun({ root: "upload", folder: "burst", fresh: true, userId: null })
    if ("error" in second) throw new Error(second.error)
    await runner.drainRunner()

    expect(await prisma.aiRun.findUnique({ where: { id: first.runId } })).toBeNull()
    expect(await groupsOf(second.runId)).toHaveLength(2)
  }, 60_000)

  it("start fresh keeps an older scan that still has reviewed groups, with its count updated", async () => {
    const first = await runner.createRun({ root: "upload", folder: "burst", fresh: false, userId: null })
    if ("error" in first) throw new Error(first.error)
    await runner.drainRunner()
    const [a] = await groupsOf(first.runId)
    await prisma.aiGroup.update({ where: { id: a.id }, data: { status: "DISMISSED" } })

    const second = await runner.createRun({ root: "upload", folder: "burst", fresh: true, userId: null })
    if ("error" in second) throw new Error(second.error)
    await runner.drainRunner()

    const old = await prisma.aiRun.findUniqueOrThrow({ where: { id: first.runId } })
    expect([old.groupCount, old.analyzedCount, old.failedCount]).toEqual([1, 1, 0])
  }, 60_000)

  it("refuses to retry an older scan while a newer scan of the same folder is running", async () => {
    behaviours = [{ status: 400 }, { status: 400 }]
    const first = await runner.createRun({ root: "upload", folder: "burst", fresh: false, userId: null })
    if ("error" in first) throw new Error(first.error)
    await runner.drainRunner()
    await prisma.aiRun.create({ data: { root: "upload", folder: "burst", fresh: false, status: "QUEUED" } })
    expect(await runner.requeueRun(first.runId)).toEqual({ error: expect.stringMatching(/another scan/i) })
  }, 60_000)

  it("resumes an analysis interrupted by a restart", async () => {
    const run = await runner.createRun({ root: "upload", folder: "burst", fresh: false, userId: null })
    if ("error" in run) throw new Error(run.error)
    await runner.drainRunner()
    // Simulate a crash mid-analysis: groups back to PENDING, run still ANALYZING.
    await prisma.aiGroup.updateMany({ where: { runId: run.runId }, data: { status: "PENDING" } })
    await prisma.aiRun.update({ where: { id: run.runId }, data: { status: "ANALYZING", finishedAt: null } })
    calls = 0
    await runner.drainRunner()
    expect(calls).toBe(2)
    expect((await prisma.aiRun.findUniqueOrThrow({ where: { id: run.runId } })).status).toBe("DONE")
  }, 60_000)

  it("a month scan groups the photos of all its day folders", async () => {
    await makeMonth()
    const run = await runner.createRun({ root: "upload", folder: "2025/10", fresh: false, userId: null })
    if ("error" in run) throw new Error(run.error)
    await runner.drainRunner()
    const done = await prisma.aiRun.findUniqueOrThrow({ where: { id: run.runId } })
    expect([done.status, done.includeDays, done.photoCount]).toEqual(["DONE", true, 6])
    const groups = await groupsOf(run.runId)
    expect(groups.map((g) => g.photos.map((p) => p.name).sort())).toEqual([
      ["10/a1.jpg", "10/a2.jpg", "10/a3.jpg"],
      ["11/b1.jpg", "11/b2.jpg", "11/b3.jpg"],
    ])
  }, 60_000)

  it("refuses to scan a day folder on its own when its month can be scanned", async () => {
    await makeMonth()
    expect(await runner.createRun({ root: "upload", folder: "2025/10/10", fresh: false, userId: null })).toEqual({ error: expect.stringMatching(/month/i) })
  }, 60_000)

  it("resolving a month-scan group moves picks to Dropoff, trashes the rest from their day folder, and undo restores them there", async () => {
    await makeMonth()
    const review = await import("./review-server")
    const user = await prisma.user.create({ data: { name: "t", email: `t${Date.now()}@x.y`, passwordHash: "x" } })
    const run = await runner.createRun({ root: "upload", folder: "2025/10", fresh: false, userId: null })
    if ("error" in run) throw new Error(run.error)
    await runner.drainRunner()
    const [a] = await groupsOf(run.runId)

    expect(await review.resolveGroup(a.id, ["10/a3.jpg"], user.id)).toMatchObject({ moved: 1, trashed: 2, missing: 0 })
    await expect(fs.stat(path.join(tmp, "dropoff", "a3.jpg"))).resolves.toBeTruthy()
    await expect(fs.stat(path.join(month, "10", "a1.jpg"))).rejects.toThrow()

    expect(await review.undoGroup(a.id)).toEqual({ restored: 2 })
    await expect(fs.stat(path.join(month, "10", "a1.jpg"))).resolves.toBeTruthy()
    await expect(fs.stat(path.join(month, "10", "a2.jpg"))).resolves.toBeTruthy()
    await fs.rm(path.join(tmp, "dropoff", "a3.jpg"))
  }, 60_000)

  it("deleting a whole group trashes every photo in it, and undo restores them", async () => {
    const review = await import("./review-server")
    const user = await prisma.user.create({ data: { name: "t", email: `d${Date.now()}@x.y`, passwordHash: "x" } })
    const run = await runner.createRun({ root: "upload", folder: "burst", fresh: false, userId: null })
    if ("error" in run) throw new Error(run.error)
    await runner.drainRunner()
    const [a] = await groupsOf(run.runId)

    expect(await review.trashGroup(a.id, user.id)).toEqual({ moved: 0, kept: 0, trashed: 3, missing: 0 })
    for (const n of ["a1.jpg", "a2.jpg", "a3.jpg"]) await expect(fs.stat(path.join(folder, n))).rejects.toThrow()
    const g = await prisma.aiGroup.findUniqueOrThrow({ where: { id: a.id }, include: { photos: true } })
    expect(g.status).toBe("RESOLVED")
    expect(g.photos.every((p) => p.decision === "TRASH")).toBe(true)
    expect(await review.trashGroup(a.id, user.id)).toEqual({ error: expect.stringMatching(/already/i) })

    expect(await review.undoGroup(a.id)).toEqual({ restored: 3 })
    for (const n of ["a1.jpg", "a2.jpg", "a3.jpg"]) await expect(fs.stat(path.join(folder, n))).resolves.toBeTruthy()
    // The restored photos are usable again in the group (restoring changes their ctime).
    expect(await review.trashGroup(a.id, user.id)).toEqual({ moved: 0, kept: 0, trashed: 3, missing: 0 })
    await review.undoGroup(a.id)
  }, 60_000)

  it("queues a scan for each listed folder that has never been scanned", async () => {
    const other = path.join(upload, "other")
    await fs.rm(other, { recursive: true, force: true })
    await fs.mkdir(other, { recursive: true })
    for (const n of ["x1.jpg", "x2.jpg"]) await sharp(scene("a", 0)).jpeg().toFile(path.join(other, n))
    const first = await runner.createRun({ root: "upload", folder: "burst", fresh: false, userId: null })
    if ("error" in first) throw new Error(first.error)
    await runner.drainRunner()

    const folders = [
      { root: "upload" as const, folder: "burst", imageCount: 6, includeDays: false },
      { root: "upload" as const, folder: "other", imageCount: 2, includeDays: false },
      { root: "upload" as const, folder: "tiny", imageCount: 1, includeDays: false },
    ]
    expect(await runner.queueUnscanned(folders, null)).toEqual({ queued: 1 })
    await runner.drainRunner()
    expect(await prisma.aiRun.count({ where: { folder: "other" } })).toBe(1)
    expect(await prisma.aiRun.count({ where: { folder: "burst" } })).toBe(1)
    expect(await runner.queueUnscanned(folders, null)).toEqual({ queued: 0 })
  }, 60_000)

  it("clears waiting scans but leaves running and finished ones", async () => {
    const mk = (folder: string, status: "QUEUED" | "ANALYZING" | "DONE") => prisma.aiRun.create({ data: { root: "upload", folder, status } })
    await mk("q1", "QUEUED")
    await mk("q2", "QUEUED")
    const running = await mk("r", "ANALYZING")
    const done = await mk("d", "DONE")
    // A finished scan put back in the queue by Retry keeps its results.
    const retried = await prisma.aiRun.create({ data: { root: "upload", folder: "t", status: "QUEUED", startedAt: new Date(), groupedAt: new Date() } })
    expect(await runner.clearQueue()).toEqual({ removed: 3 })
    expect((await prisma.aiRun.findMany({ select: { id: true } })).map((r) => r.id).sort()).toEqual([running.id, done.id, retried.id].sort())
    expect((await prisma.aiRun.findUniqueOrThrow({ where: { id: retried.id } })).status).toBe("CANCELLED")
  }, 60_000)

  it("settles several groups in one go and reports the totals", async () => {
    const review = await import("./review-server")
    const user = await prisma.user.create({ data: { name: "t", email: `m${Date.now()}@x.y`, passwordHash: "x" } })
    const run = await runner.createRun({ root: "upload", folder: "burst", fresh: false, userId: null })
    if ("error" in run) throw new Error(run.error)
    await runner.drainRunner()
    const [a, b] = await groupsOf(run.runId)

    const r = await review.resolveGroups([{ groupId: a.id, keep: ["a1.jpg"] }, { groupId: b.id, keep: ["b2.jpg", "b3.jpg"] }, { groupId: "nope", keep: ["x"] }], user.id)
    expect(r).toEqual({ groups: 2, moved: 3, trashed: 3, failed: 1 })
    expect((await groupsOf(run.runId)).map((g) => g.status)).toEqual(["RESOLVED", "RESOLVED"])
    for (const n of ["a1.jpg", "b2.jpg", "b3.jpg"]) await fs.rm(path.join(tmp, "dropoff", n))
  }, 60_000)

  it("locks a folder only while its scan is actually running, not while it waits in the queue", async () => {
    const { folderLocked } = await import("./lock-server")
    await prisma.aiRun.create({ data: { root: "upload", folder: "waiting", status: "QUEUED" } })
    await prisma.aiRun.create({ data: { root: "upload", folder: "busy", status: "ANALYZING" } })
    expect(await folderLocked("upload", ["waiting"])).toBe(false)
    expect(await folderLocked("upload", ["busy"])).toBe(true)
  }, 60_000)
})

