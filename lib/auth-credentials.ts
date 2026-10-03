import { z } from "zod"
import type { LoginThrottle } from "./login-throttle"

// The sign-in check behind auth.ts, kept free of next-auth and Prisma so it can
// be tested directly.

// A real bcrypt hash (cost 12) of a random throwaway password. Compared against
// when the email has no account, so a miss costs the same time as a hit and the
// response time doesn't reveal which emails exist.
export const DUMMY_HASH = "$2b$12$I4l81dK9g6xVwxZitRgRJOw1WG7cXUr9MKBJPh2llx04BxtSWH7AC"

type StoredUser = {
  id: string
  name: string | null
  email: string
  role: string
  mustResetPassword: boolean
  sessionVersion: number
  passwordHash: string
}

export type SignedInUser = Omit<StoredUser, "passwordHash">

export type LoginDeps = {
  findUser(email: string): Promise<StoredUser | null>
  compare(password: string, hash: string): Promise<boolean>
  throttle: LoginThrottle
}

export type LoginResult = { status: "ok"; user: SignedInUser } | { status: "invalid" } | { status: "throttled" }

const credentialsSchema = z.object({ email: z.string().min(1), password: z.string().min(1) })

export async function verifyLogin(input: unknown, ip: string, deps: LoginDeps): Promise<LoginResult> {
  const parsed = credentialsSchema.safeParse(input)
  if (!parsed.success) return { status: "invalid" }
  const { email, password } = parsed.data

  if (deps.throttle.isBlocked(email, ip)) return { status: "throttled" }

  const user = await deps.findUser(email)
  const valid = await deps.compare(password, user?.passwordHash ?? DUMMY_HASH)
  if (!user || !valid) {
    deps.throttle.recordFailure(email, ip)
    return { status: "invalid" }
  }

  deps.throttle.recordSuccess(email)
  return {
    status: "ok",
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      mustResetPassword: user.mustResetPassword,
      sessionVersion: user.sessionVersion,
    },
  }
}
