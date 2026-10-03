import { NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { allRootStatuses } from "@/lib/library-server"

// Container healthcheck. Unhealthy only when the database is down; a missing
// photo mount is reported but doesn't restart the container — restarting
// can't fix a bad volume mapping.
export async function GET() {
  try {
    await prisma.$queryRaw`SELECT 1`
  } catch (error) {
    console.error("Health check failed:", error)
    return NextResponse.json({ status: "error" }, { status: 503 })
  }
  const roots = await allRootStatuses()
  return NextResponse.json({
    status: "ok",
    folders: Object.fromEntries(roots.map((r) => [r.key, { readable: r.readable, writable: r.writable }])),
  })
}
