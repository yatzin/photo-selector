import { auth } from "@/auth"
import { redirect } from "next/navigation"
import { prisma } from "@/lib/prisma"
import { Sidebar, MobileSidebarTrigger } from "@/components/sidebar"
import { UserMenu } from "@/components/user-menu"
import { ThemeToggle } from "@/components/theme-toggle"
import packageJson from "@/package.json"

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await auth()
  if (!session) redirect("/login")
  const aiPending = await prisma.aiGroup.count({ where: { status: "ANALYZED" } })

  return (
    <div className="flex h-svh overflow-hidden">
      <Sidebar aiPending={aiPending} />
      <div className="flex flex-1 flex-col overflow-hidden">
        <header className="flex h-14 shrink-0 items-center justify-between gap-2 border-b border-border/60 bg-card/80 backdrop-blur-sm px-4">
          <MobileSidebarTrigger aiPending={aiPending} />
          <div className="flex-1" />
          <div className="flex shrink-0 items-center gap-2">
            <ThemeToggle />
            <UserMenu name={session.user.name ?? "User"} email={session.user.email ?? ""} />
          </div>
        </header>
        <main className="flex-1 overflow-y-auto p-6">{children}</main>
        <footer className="shrink-0 border-t border-border/60 px-4 py-2 text-center text-xs text-muted-foreground">
          Photo Selector &middot; v{packageJson.version}
        </footer>
      </div>
    </div>
  )
}
