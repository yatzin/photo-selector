// Extends next-auth types to include role and mustResetPassword on the session
import type { DefaultSession } from "next-auth"

declare module "next-auth" {
  interface Session {
    user: DefaultSession["user"] & {
      id: string
      role: string
      mustResetPassword: boolean
    }
  }
}
