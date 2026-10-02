import { HardDrive, UserRound, Users } from "lucide-react"

// The sub-pages of Settings, chosen with ?tab=. Everyone manages their own
// account; storage and users are server setup, for admins only.

export type SettingsSectionId = "account" | "storage" | "users"

export type SettingsSection = {
  id: SettingsSectionId
  label: string
  description: string
  icon: React.ElementType
  adminOnly: boolean
}

export const SETTINGS_SECTIONS: SettingsSection[] = [
  { id: "account", label: "Account", description: "Your name, email and password", icon: UserRound, adminOnly: false },
  { id: "storage", label: "Storage", description: "The photo folders this app reads and writes", icon: HardDrive, adminOnly: true },
  { id: "users", label: "Users", description: "Who can sign in, and their roles", icon: Users, adminOnly: true },
]

export function visibleSections(isAdmin: boolean): SettingsSection[] {
  return SETTINGS_SECTIONS.filter((s) => isAdmin || !s.adminOnly)
}

/** The requested section if this user may see it, else the first one. */
export function resolveSection(tab: string | string[] | undefined, isAdmin: boolean): SettingsSection {
  const visible = visibleSections(isAdmin)
  const want = Array.isArray(tab) ? tab[0] : tab
  return visible.find((s) => s.id === want) ?? visible[0]
}

export const settingsHref = (id: SettingsSectionId) => `/settings?tab=${id}`
