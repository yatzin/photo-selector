// register() runs once per server instance before requests are handled. It
// only starts the background thumbnail worker; the first scan is scheduled,
// not awaited, so startup isn't blocked by a large library.
export async function register() {
  // Also evaluated for the edge runtime, which has no filesystem.
  if (process.env.NEXT_RUNTIME !== "nodejs") return

  const { startWorker } = await import("@/lib/worker-server")
  startWorker()
}
