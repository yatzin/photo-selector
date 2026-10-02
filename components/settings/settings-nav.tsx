import Link from "next/link"
import { cn } from "@/lib/utils"
import { settingsHref, type SettingsSection, type SettingsSectionId } from "@/lib/settings-sections"

// Settings' sub navigation: a column beside the content on wide screens, a
// row of scrollable pills above it on narrow ones. Plain links (?tab=), so
// each section is bookmarkable and the server loads only what it shows.
export function SettingsNav({ sections, active }: { sections: SettingsSection[]; active: SettingsSectionId }) {
  return (
    <nav aria-label="Settings sections" className="-mx-1 overflow-x-auto px-1 md:mx-0 md:overflow-visible md:px-0">
      <ul className="flex gap-1 md:flex-col">
        {sections.map((s) => {
          const Icon = s.icon
          const current = s.id === active
          return (
            <li key={s.id} className="shrink-0">
              <Link
                href={settingsHref(s.id)}
                aria-current={current ? "page" : undefined}
                className={cn(
                  "relative flex items-center gap-2.5 whitespace-nowrap rounded-lg px-3 py-2 text-sm font-medium transition-colors duration-150",
                  current
                    ? "bg-primary/10 text-primary"
                    : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                )}
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    "absolute bottom-1.5 left-0 top-1.5 hidden w-0.5 rounded-full bg-primary md:block",
                    current ? "opacity-100" : "opacity-0"
                  )}
                />
                <Icon className="h-4 w-4 shrink-0" strokeWidth={1.75} />
                {s.label}
              </Link>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}
