import http from "http"
import type { AddressInfo } from "net"
import { afterEach, describe, expect, it } from "vitest"
import { AiError, chatOnce, chatWithRetry, type AiClientConfig } from "./client"

type Handler = (body: Record<string, unknown>, req: http.IncomingMessage) => { status: number; json?: unknown; delayMs?: number }

let server: http.Server | null = null
let calls: Record<string, unknown>[] = []

async function start(handler: Handler): Promise<AiClientConfig> {
  calls = []
  server = http.createServer((req, res) => {
    let raw = ""
    req.on("data", (c) => (raw += c))
    req.on("end", () => {
      const body = JSON.parse(raw || "{}")
      calls.push({ ...body, _auth: req.headers.authorization, _path: req.url })
      const out = handler(body, req)
      setTimeout(() => {
        res.writeHead(out.status, { "Content-Type": "application/json" })
        res.end(JSON.stringify(out.json ?? {}))
      }, out.delayMs ?? 0)
    })
  })
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r))
  const port = (server!.address() as AddressInfo).port
  return { baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: "sk-test", model: "vision", temperature: 0.2, maxTokens: 500, timeoutSeconds: 5, extraBody: { keep_alive: "5m" } }
}

afterEach(async () => {
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()))
  server = null
})

const reply = (content: unknown) => ({ status: 200, json: { choices: [{ message: { role: "assistant", content } }] } })
const noSleep = async () => {}

describe("chatOnce", () => {
  it("posts an OpenAI-style request and returns the text", async () => {
    const cfg = await start(() => reply("hello"))
    const text = await chatOnce(cfg, [{ role: "user", content: "hi" }])
    expect(text).toBe("hello")
    expect(calls[0]._path).toBe("/v1/chat/completions")
    expect(calls[0]._auth).toBe("Bearer sk-test")
    expect(calls[0]).toMatchObject({ model: "vision", stream: false, temperature: 0.2, max_tokens: 500, keep_alive: "5m" })
  })

  it("joins array content parts", async () => {
    const cfg = await start(() => reply([{ type: "text", text: "a" }, { type: "text", text: "b" }]))
    expect(await chatOnce(cfg, [{ role: "user", content: "hi" }])).toBe("ab")
  })

  it("omits auth without a key", async () => {
    const cfg = await start(() => reply("x"))
    await chatOnce({ ...cfg, apiKey: null }, [{ role: "user", content: "hi" }])
    expect(calls[0]._auth).toBeUndefined()
  })

  it.each([
    [401, "auth"], [403, "auth"], [404, "model"], [400, "bad-request"], [500, "server"], [429, "server"],
  ])("maps HTTP %i to %s", async (status, kind) => {
    const cfg = await start(() => ({ status, json: { error: { message: "nope" } } }))
    await expect(chatOnce(cfg, [{ role: "user", content: "hi" }])).rejects.toMatchObject({ kind })
  })

  it("times out", async () => {
    const cfg = await start(() => ({ ...reply("late"), delayMs: 1500 }))
    await expect(chatOnce({ ...cfg, timeoutSeconds: 1 }, [{ role: "user", content: "hi" }])).rejects.toMatchObject({ kind: "timeout" })
  })

  it("reports an unreachable server as network", async () => {
    const cfg = await start(() => reply("x"))
    await new Promise<void>((r) => server!.close(() => r()))
    server = null
    await expect(chatOnce(cfg, [{ role: "user", content: "hi" }])).rejects.toMatchObject({ kind: "network" })
  })
})

describe("chatWithRetry", () => {
  it("retries server errors, then succeeds", async () => {
    let n = 0
    const cfg = await start(() => (++n < 3 ? { status: 503 } : reply("ok")))
    expect(await chatWithRetry(cfg, [{ role: "user", content: "hi" }], { sleep: noSleep })).toBe("ok")
    expect(n).toBe(3)
  })

  it("gives up after two retries", async () => {
    const cfg = await start(() => ({ status: 500 }))
    await expect(chatWithRetry(cfg, [{ role: "user", content: "hi" }], { sleep: noSleep })).rejects.toBeInstanceOf(AiError)
    expect(calls.length).toBe(3)
  })

  it("does not retry auth or bad requests", async () => {
    const cfg = await start(() => ({ status: 400 }))
    await expect(chatWithRetry(cfg, [{ role: "user", content: "hi" }], { sleep: noSleep })).rejects.toMatchObject({ kind: "bad-request" })
    expect(calls.length).toBe(1)
  })
})
