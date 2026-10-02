import { auth } from "@/auth"
import { NextResponse } from "next/server"

export default auth((req) => {
  const { nextUrl } = req
  const session = req.auth

  // Auth API and the container healthcheck pass through
  if (nextUrl.pathname.startsWith("/api/auth") || nextUrl.pathname === "/api/health") return NextResponse.next()

  // Public routes
  const publicPaths = ["/login", "/setup"]
  if (publicPaths.includes(nextUrl.pathname)) {
    if (session) return NextResponse.redirect(new URL("/", req.url))
    return NextResponse.next()
  }

  // All other routes require authentication
  if (!session) {
    return NextResponse.redirect(new URL("/login", req.url))
  }

  // Force password change before accessing anything else
  if (session.user.mustResetPassword && nextUrl.pathname !== "/change-password") {
    return NextResponse.redirect(new URL("/change-password", req.url))
  }

  return NextResponse.next()
})

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
}
