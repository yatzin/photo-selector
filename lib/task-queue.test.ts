import { describe, expect, it } from "vitest"
import { createTaskQueue } from "./task-queue"

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((r) => (resolve = r))
  return { promise, resolve }
}

describe("createTaskQueue", () => {
  it("never runs more than the concurrency limit", async () => {
    const q = createTaskQueue(2)
    let running = 0
    let peak = 0
    const job = async () => {
      running++
      peak = Math.max(peak, running)
      await new Promise((r) => setTimeout(r, 5))
      running--
    }
    await Promise.all(Array.from({ length: 6 }, (_, i) => q.run(`k${i}`, job)))
    expect(peak).toBe(2)
  })

  it("runs the same key once while it is in flight", async () => {
    const q = createTaskQueue(1)
    let calls = 0
    const fn = async () => ++calls
    const [a, b] = await Promise.all([q.run("same", fn), q.run("same", fn)])
    expect([a, b, calls]).toEqual([1, 1, 1])
  })

  it("starts high-priority work before queued background work", async () => {
    const q = createTaskQueue(1)
    const gate = deferred()
    const order: string[] = []
    const blocker = q.run("blocker", () => gate.promise)
    const low = q.run("low", async () => void order.push("low"), "low")
    const high = q.run("high", async () => void order.push("high"), "high")
    gate.resolve()
    await Promise.all([blocker, low, high])
    expect(order).toEqual(["high", "low"])
  })

  it("promotes a queued background job when someone asks for it", async () => {
    const q = createTaskQueue(1)
    const gate = deferred()
    const order: string[] = []
    const blocker = q.run("blocker", () => gate.promise)
    const other = q.run("other", async () => void order.push("other"), "low")
    const wanted = q.run("wanted", async () => void order.push("wanted"), "low")
    const again = q.run("wanted", async () => void order.push("dup"), "high")
    gate.resolve()
    await Promise.all([blocker, other, wanted, again])
    expect(order).toEqual(["wanted", "other"])
  })

  it("passes failures to every waiter and keeps going", async () => {
    const q = createTaskQueue(1)
    await expect(q.run("bad", async () => { throw new Error("boom") })).rejects.toThrow("boom")
    await expect(q.run("good", async () => 1)).resolves.toBe(1)
  })

  it("runs AI scan work before the background backlog, after what someone is viewing", async () => {
    // A scan someone started shouldn't wait behind thousands of queued
    // background thumbnails.
    const q = createTaskQueue(1)
    const gate = deferred()
    const order: string[] = []
    const blocker = q.run("blocker", () => gate.promise)
    const low = q.run("low", async () => void order.push("low"), "low")
    const scan = q.run("scan", async () => void order.push("scan"), "scan")
    const high = q.run("high", async () => void order.push("high"), "high")
    gate.resolve()
    await Promise.all([blocker, low, scan, high])
    expect(order).toEqual(["high", "scan", "low"])
  })

  it("moves a queued background job up when an AI scan needs it", async () => {
    const q = createTaskQueue(1)
    const gate = deferred()
    const order: string[] = []
    const blocker = q.run("blocker", () => gate.promise)
    const other = q.run("other", async () => void order.push("other"), "low")
    const shared = q.run("shared", async () => void order.push("shared"), "low")
    const scan = q.run("shared", async () => void order.push("dup"), "scan")
    gate.resolve()
    await Promise.all([blocker, other, shared, scan])
    expect(order).toEqual(["shared", "other"])
  })

  it("promotes a queued scan job to high when someone views it", async () => {
    const q = createTaskQueue(1)
    const gate = deferred()
    const order: string[] = []
    const blocker = q.run("blocker", () => gate.promise)
    const low = q.run("low", async () => void order.push("low"), "low")
    const scan = q.run("x", async () => void order.push("x"), "scan")
    const view = q.run("x", async () => void order.push("dup"), "high")
    gate.resolve()
    await Promise.all([blocker, low, scan, view])
    expect(order).toEqual(["x", "low"])
  })
})

describe("abandoned requests", () => {
  it("drops a queued job when its only waiter gives up", async () => {
    const q = createTaskQueue(1)
    const gate = deferred()
    let ran = false
    const blocker = q.run("blocker", () => gate.promise)
    const ac = new AbortController()
    const waiting = q.run("thumb", async () => void (ran = true), "high", ac.signal)
    expect(q.pending).toBe(1)
    ac.abort()
    await expect(waiting).rejects.toThrow(/abort/i)
    expect(q.pending).toBe(0)
    gate.resolve()
    await blocker
    await new Promise((r) => setTimeout(r, 5))
    expect(ran).toBe(false)
  })

  it("keeps the job while someone else still wants it", async () => {
    const q = createTaskQueue(1)
    const gate = deferred()
    const blocker = q.run("blocker", () => gate.promise)
    const ac = new AbortController()
    const leaving = q.run("thumb", async () => "done", "high", ac.signal)
    const staying = q.run("thumb", async () => "dup", "low") // e.g. the background worker
    ac.abort()
    await expect(leaving).rejects.toThrow(/abort/i)
    gate.resolve()
    await blocker
    await expect(staying).resolves.toBe("done")
  })

  it("lets a job that already started finish", async () => {
    const q = createTaskQueue(1)
    const gate = deferred()
    let finished = false
    const ac = new AbortController()
    const waiting = q.run("thumb", async () => { await gate.promise; finished = true }, "high", ac.signal)
    await new Promise((r) => setTimeout(r, 0)) // job has started
    ac.abort()
    await expect(waiting).rejects.toThrow(/abort/i)
    gate.resolve()
    await new Promise((r) => setTimeout(r, 5))
    expect(finished).toBe(true)
    expect(q.active).toBe(0)
  })

  it("refuses work for a request that is already gone", async () => {
    const q = createTaskQueue(1)
    let ran = false
    const ac = new AbortController()
    ac.abort()
    await expect(q.run("thumb", async () => void (ran = true), "high", ac.signal)).rejects.toThrow(/abort/i)
    expect(q.pending).toBe(0)
    expect(ran).toBe(false)
  })
})
