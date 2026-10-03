import NextAuth, { CredentialsSignin } from "next-auth"
import Credentials from "next-auth/providers/credentials"
import bcrypt from "bcryptjs"
import { prisma } from "@/lib/prisma"
import { verifyLogin } from "@/lib/auth-credentials"
import { refreshClaims } from "@/lib/auth-session"
import { clientIp, createLoginThrottle } from "@/lib/login-throttle"

// One throttle per process, kept on globalThis because route handlers and
// server actions can each load their own copy of this module.
const g = globalThis as unknown as { __psLoginThrottle?: ReturnType<typeof createLoginThrottle> }
const throttle = (g.__psLoginThrottle ??= createLoginThrottle())

/** Shown on the login page as "too many attempts" rather than "wrong password". */
export class TooManyAttempts extends CredentialsSignin {
  code = "rate_limited"
}

export const { handlers, signIn, signOut, auth } = NextAuth({
  providers: [
    Credentials({
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials, request) {
        const result = await verifyLogin(credentials, clientIp(request.headers), {
          findUser: (email) => prisma.user.findUnique({ where: { email } }),
          compare: (password, hash) => bcrypt.compare(password, hash),
          throttle,
        })
        if (result.status === "throttled") throw new TooManyAttempts()
        return result.status === "ok" ? result.user : null
      },
    }),
  ],
  callbacks: {
    // Runs on every session read, not only at sign-in: the account is re-read
    // so a role change, a deleted account or a revoked session (password
    // change, admin reset) takes effect on the next request. Returning null
    // ends the session.
    async jwt({ token, user }) {
      if (user) {
        token.id = user.id
        token.sessionVersion = (user as { sessionVersion: number }).sessionVersion
      }
      if (typeof token.id !== "string") return null
      const account = await prisma.user.findUnique({
        where: { id: token.id },
        select: { role: true, mustResetPassword: true, sessionVersion: true },
      })
      return refreshClaims(token as typeof token & { sessionVersion?: number }, account)
    },
    session({ session, token }) {
      session.user.id = token.id as string
      session.user.role = token.role as string
      session.user.mustResetPassword = token.mustResetPassword as boolean
      return session
    },
  },
  pages: {
    signIn: "/login",
  },
  session: { strategy: "jwt" },
  // Browsers share cookies across ports on the same host, so with the default
  // names this app would receive HomeCenter's session (and fail to decrypt it)
  // whenever both run on one machine or NAS. Only the names change; Auth.js
  // merges these over its defaults, keeping httpOnly/secure/sameSite.
  cookies: {
    sessionToken: { name: "photo-selector.session-token" },
    callbackUrl: { name: "photo-selector.callback-url" },
    csrfToken: { name: "photo-selector.csrf-token" },
  },
  trustHost: true,
})
