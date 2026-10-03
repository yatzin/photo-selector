import { signIn } from "@/auth"
import { AuthError, CredentialsSignin } from "next-auth"
import { redirect } from "next/navigation"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Button } from "@/components/ui/button"
import { Images } from "lucide-react"

async function login(formData: FormData) {
  "use server"
  try {
    await signIn("credentials", {
      email: formData.get("email"),
      password: formData.get("password"),
      redirectTo: "/",
    })
  } catch (error) {
    if (error instanceof CredentialsSignin && error.code === "rate_limited") {
      redirect("/login?error=locked")
    }
    if (error instanceof AuthError) {
      redirect("/login?error=1")
    }
    throw error
  }
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; message?: string }>
}) {
  const { error, message } = await searchParams

  return (
    <div className="min-h-svh flex items-center justify-center bg-muted/40 p-4">
      <div className="w-full max-w-sm space-y-6">
        <div className="flex flex-col items-center gap-2 text-center">
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary text-primary-foreground">
            <Images className="h-5 w-5" />
          </div>
          <h1 className="font-heading text-2xl font-semibold tracking-tight">Photo Selector</h1>
          <p className="text-sm text-muted-foreground">Sign in to your account</p>
        </div>

        <Card>
          <CardHeader className="pb-4">
            <CardTitle className="text-base">Welcome back</CardTitle>
            {error && (
              <CardDescription className="text-destructive">
                {error === "locked"
                  ? "Too many failed attempts. Wait 15 minutes, then try again."
                  : "Invalid email or password."}
              </CardDescription>
            )}
            {!error && message === "password-changed" && (
              <CardDescription className="text-emerald-700 dark:text-emerald-400">
                Password changed. Sign in with your new password.
              </CardDescription>
            )}
          </CardHeader>
          <CardContent>
            <form action={login} className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="email">Email</Label>
                <Input
                  id="email"
                  name="email"
                  type="email"
                  autoComplete="email"
                  required
                  placeholder="you@example.com"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="password">Password</Label>
                <Input
                  id="password"
                  name="password"
                  type="password"
                  autoComplete="current-password"
                  required
                />
              </div>
              <Button type="submit" className="w-full">
                Sign in
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
