// register() runs once per server instance before requests are handled. It
// creates User Temp Storage if missing, starts the background thumbnail worker and the AI scan runner; the first scan is scheduled,
// not awaited, so startup isn't blocked by a large library.
export async function register() {
  // Also evaluated for the edge runtime, which has no filesystem.
  if (process.env.NEXT_RUNTIME !== "nodejs") return

  const { ensureTempRoot } = await import("@/lib/library-server")
  await ensureTempRoot()

  const { startWorker } = await import("@/lib/worker-server")
  startWorker()

  const { startAiRunner } = await import("@/lib/ai/runner-server")
  startAiRunner()

  // The video inbox is staging: delete files that arrived over 6 months ago, at startup and then daily.
  const { cleanExpiredInbox } = await import("@/lib/video/inbox-cleanup-server")
  const sweep = () =>
    cleanExpiredInbox().then(
      (n) => n > 0 && console.log(`[video] removed ${n} inbox file${n === 1 ? "" : "s"} older than 6 months`),
      (error) => console.error("[video] cleanup failed:", error)
    )
  void sweep()
  setInterval(() => void sweep(), 24 * 60 * 60 * 1000).unref()
}
