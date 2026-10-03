import { auth, signOut } from "@/auth"
import { prisma } from "@/lib/prisma"
import { redirect } from "next/navigation"
import bcrypt from "bcryptjs"
import { checkPasswordChange, PASSWORD_ERROR_TEXT, type PasswordChangeError } from "@/lib/password-change"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Button } from "@/components/ui/button"

async function changePassword(formData: FormData) {
  "use server"
  const session = await auth()
  if (!session?.user?.id) redirect("/login")

  const account = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { mustResetPassword: true, passwordHash: true },
  })
  if (!account) redirect("/login")

  const newPassword = String(formData.get("newPassword") ?? "")
  const error = await checkPasswordChange(
    {
      current: String(formData.get("currentPassword") ?? ""),
      next: newPassword,
      confirm: String(formData.get("confirm") ?? ""),
    },
    account,
    (password, hash) => bcrypt.compare(password, hash)
  )
  if (error) redirect(`/change-password?error=${error}`)

  const passwordHash = await bcrypt.hash(newPassword, 12)
  // The version bump signs this account out on every device, including any
  // that someone else may have been using.
  await prisma.user.update({
    where: { id: session.user.id },
    data: { passwordHash, mustResetPassword: false, sessionVersion: { increment: 1 } },
  })

  await signOut({ redirectTo: "/login?message=password-changed" })
}

export default async function ChangePasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; message?: string }>
}) {
  const [{ error, message }, session] = await Promise.all([searchParams, auth()])
  // A forced reset (first sign-in, or an admin reset) just used the temporary
  // password, so it isn't asked for again.
  const askCurrent = !session?.user?.mustResetPassword

  const errorText = error && error in PASSWORD_ERROR_TEXT ? PASSWORD_ERROR_TEXT[error as PasswordChangeError] : null

  return (
    <div className="min-h-svh flex items-center justify-center bg-muted/40 p-4">
      <div className="w-full max-w-sm space-y-6">
        <div className="text-center">
          <h1 className="font-heading text-2xl font-semibold tracking-tight">Set your password</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Choose a new password before continuing.
          </p>
        </div>

        <Card>
          <CardHeader className="pb-4">
            <CardTitle className="text-base">New password</CardTitle>
            {errorText && (
              <CardDescription className="text-destructive">{errorText}</CardDescription>
            )}
            {message === "password-changed" && (
              <CardDescription className="text-emerald-700 dark:text-emerald-400">
                Password changed — please sign in again.
              </CardDescription>
            )}
          </CardHeader>
          <CardContent>
            <form action={changePassword} className="space-y-4">
              {askCurrent && (
                <div className="space-y-1.5">
                  <Label htmlFor="currentPassword">Current password</Label>
                  <Input
                    id="currentPassword"
                    name="currentPassword"
                    type="password"
                    autoComplete="current-password"
                    required
                  />
                </div>
              )}
              <div className="space-y-1.5">
                <Label htmlFor="newPassword">New password</Label>
                <Input
                  id="newPassword"
                  name="newPassword"
                  type="password"
                  autoComplete="new-password"
                  required
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="confirm">Confirm password</Label>
                <Input
                  id="confirm"
                  name="confirm"
                  type="password"
                  autoComplete="new-password"
                  required
                />
              </div>
              <Button type="submit" className="w-full">
                Set password
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
