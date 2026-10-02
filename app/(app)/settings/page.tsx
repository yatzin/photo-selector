import { auth } from "@/auth"
import { prisma } from "@/lib/prisma"
import { redirect } from "next/navigation"
import { UserManagement } from "@/components/settings/user-management"
import { AccountSettings } from "@/components/settings/account-settings"
import { StorageStatus } from "@/components/settings/storage-status"
import { AiSettings } from "@/components/settings/ai-settings"
import { loadAiConfig } from "@/lib/ai/config"
import { SettingsNav } from "@/components/settings/settings-nav"
import { allRootStatuses } from "@/lib/library-server"
import { workerStatus } from "@/lib/worker-server"
import { resolveSection, visibleSections, type SettingsSectionId } from "@/lib/settings-sections"

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string | string[] }>
}) {
  const session = await auth()
  if (!session) redirect("/login")

  const isAdmin = session.user.role === "ADMIN"
  const sections = visibleSections(isAdmin)
  const section = resolveSection((await searchParams).tab, isAdmin)
  const is = (id: SettingsSectionId) => section.id === id

  // Only the open section's data is loaded.
  const [me, users, roots, ai] = await Promise.all([
    prisma.user.findUnique({ where: { id: session.user.id }, select: { name: true, email: true, role: true } }),
    is("users") ? prisma.user.findMany({ orderBy: { createdAt: "asc" } }) : Promise.resolve([]),
    is("storage") ? allRootStatuses() : Promise.resolve([]),
    is("ai") ? loadAiConfig() : Promise.resolve(null),
  ])
  // A session whose user row is gone. Redirecting to /login would bounce
  // straight back (proxy.ts sends signed-in sessions away from /login).
  if (!me) {
    return (
      <div className="space-y-4 max-w-3xl">
        <h1 className="font-heading text-2xl font-semibold">Settings</h1>
        <p className="text-sm text-muted-foreground">
          The account you&apos;re signed in as no longer exists. Sign out from the menu in the top
          right, then sign in again.
        </p>
      </div>
    )
  }

  return (
    <div className="max-w-5xl space-y-6">
      <div>
        <h1 className="font-heading text-2xl font-semibold">Settings</h1>
        <p className="mt-0.5 text-sm text-muted-foreground">{section.description}</p>
      </div>

      <div className="grid gap-6 md:grid-cols-[12.5rem_minmax(0,1fr)]">
        {sections.length > 1 && (
          <aside className="md:sticky md:top-0 md:self-start">
            <SettingsNav sections={sections} active={section.id} />
          </aside>
        )}

        <div className={sections.length > 1 ? "min-w-0 max-w-3xl" : "min-w-0 max-w-3xl md:col-span-2"}>
          {is("account") && <AccountSettings name={me.name} email={me.email} role={me.role} />}
          {is("storage") && <StorageStatus roots={roots} worker={workerStatus()} />}
          {is("ai") && ai && (
            <AiSettings
              initial={{
                enabled: ai.enabled,
                baseUrl: ai.baseUrl ?? "",
                model: ai.model ?? "",
                temperature: ai.temperature?.toString() ?? "",
                maxTokens: ai.maxTokens?.toString() ?? "",
                timeoutSeconds: ai.timeoutSeconds?.toString() ?? "",
                extraBody: ai.extraBody ? JSON.stringify(JSON.parse(ai.extraBody), null, 2) : "",
                customPrompt: ai.customPrompt ?? "",
                groupWindowSeconds: String(ai.groupWindowSeconds),
                similarity: ai.similarity,
                imageMaxPx: String(ai.imageMaxPx),
                maxGroupSize: String(ai.maxGroupSize),
              }}
              hasStoredKey={ai.hasStoredKey}
              keyUnreadable={ai.keyUnreadable}
            />
          )}
          {is("users") && <UserManagement users={users} currentUserId={session.user.id} />}
        </div>
      </div>
    </div>
  )
}
