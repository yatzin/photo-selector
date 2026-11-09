import "server-only"
import { redirect } from "next/navigation"
import { auth } from "@/auth"
import { prisma } from "@/lib/prisma"
import { tempFolderName } from "@/lib/media"

/** The signed-in user's folder name under Video Projects; redirects to /login without a session. */
export async function currentUserFolder(): Promise<string> {
  const session = await auth()
  if (!session) redirect("/login")
  const user = await prisma.user.findUnique({ where: { id: session.user.id }, select: { name: true, email: true } })
  if (!user) redirect("/login")
  return tempFolderName(user.name, user.email)
}
