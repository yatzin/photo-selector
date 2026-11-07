"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { useState } from "react"
import { cn } from "@/lib/utils"
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet"
import { ChevronsLeft, ChevronsRight, Clapperboard, FolderInput, FolderOutput, FolderKanban, Images, Inbox, Menu, Settings, Sparkles } from "lucide-react"
import { useStoredState } from "@/lib/hooks/use-stored-state"
import type { RootCounts } from "@/lib/library-server"

type NavItem = { href: string; label: string; icon: React.ElementType; badge?: number; subtitle?: string }

const navItems: (NavItem & { root: keyof RootCounts })[] = [
  { root: "upload", href: "/library/upload", label: "Mobile Upload", icon: FolderInput },
  { root: "dropoff", href: "/library/dropoff", label: "Sort Dropoff", icon: FolderOutput },
  { root: "temp", href: "/library/temp", label: "User Temp Storage", icon: Inbox },
]

// Tools: Video Editing, with its two folders.
const toolItems: (NavItem & { root: keyof RootCounts })[] = [
  { root: "video-inbox", href: "/library/video-inbox", label: "Inbox", icon: Inbox },
  { root: "video-projects", href: "/library/video-projects", label: "Projects", icon: FolderKanban },
]

const itemCount = (n: number) => `${n.toLocaleString()} item${n === 1 ? "" : "s"}`

const bottomItems: NavItem[] = [{ href: "/settings", label: "Settings", icon: Settings }]

function NavLink({ href, label, icon: Icon, badge, subtitle, onClick, collapsed }: NavItem & { onClick?: () => void; collapsed?: boolean }) {
  const pathname = usePathname()
  const active = pathname === href || pathname.startsWith(href + "/")
  // Icons only: the label, count and pending number move into the name and tooltip.
  const name = [label, subtitle, badge ? `${badge} pending` : ""].filter(Boolean).join(", ")
  return (
    <Link
      href={href}
      onClick={onClick}
      title={collapsed ? name : undefined}
      aria-label={collapsed ? name : undefined}
      className={cn(
        "relative flex items-center gap-3 whitespace-nowrap rounded-lg py-2.5 text-sm font-medium transition-colors duration-150",
        collapsed ? "justify-center px-0" : "px-3",
        active
          ? "bg-sidebar-primary/10 text-sidebar-primary"
          : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "absolute left-0 top-1.5 bottom-1.5 w-0.5 rounded-full bg-sidebar-primary transition-opacity duration-150",
          active ? "opacity-100" : "opacity-0"
        )}
      />
      <Icon className="h-[18px] w-[18px] shrink-0" strokeWidth={1.5} />
      {collapsed ? (
        badge ? <span aria-hidden="true" className="absolute right-2 top-1.5 h-2 w-2 rounded-full bg-primary" /> : null
      ) : subtitle === undefined ? (
        label
      ) : (
        <span className="flex min-w-0 flex-col leading-tight">
          <span className="truncate">{label}</span>
          <span className="text-[11px] font-normal text-muted-foreground tabular-nums">{subtitle}</span>
        </span>
      )}
      {badge && !collapsed ? <span className="ml-auto rounded-full bg-primary px-1.5 py-0.5 text-[10px] font-semibold leading-none text-primary-foreground">{badge}</span> : null}
    </Link>
  )
}

const heading = "px-3 pb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70"

/** A section heading, or (icons only) a thin rule between sections. */
function Section({ label, collapsed, first }: { label: string; collapsed: boolean; first?: boolean }) {
  if (collapsed) return first ? null : <div aria-hidden="true" className="mx-1 my-2 border-t" />
  return <p className={cn(heading, !first && "mt-3")}>{label}</p>
}

function SidebarContent({
  onNavClick, aiPending, counts, collapsed = false, onToggle,
}: {
  onNavClick?: () => void
  aiPending: number
  counts: RootCounts
  collapsed?: boolean
  /** Shows the collapse/expand button (desktop only). */
  onToggle?: () => void
}) {
  return (
    <div className={cn("flex h-full flex-col py-4", collapsed ? "px-2" : "px-3")}>
      <div className={cn("mb-6 flex items-center gap-2", collapsed ? "justify-center" : "px-3")}>
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground" title={collapsed ? "Photo Selector" : undefined}>
          <Images className="h-4 w-4" />
        </div>
        {!collapsed && <span className="whitespace-nowrap font-heading font-semibold tracking-tight">Photo Selector</span>}
      </div>
      <nav className="flex flex-1 flex-col gap-1">
        <Section label="Library" collapsed={collapsed} first />
        {navItems.map(({ root, ...item }) => <NavLink key={item.href} {...item} subtitle={itemCount(counts[root])} onClick={onNavClick} collapsed={collapsed} />)}
        <Section label="Review" collapsed={collapsed} />
        <NavLink href="/ai" label="AI" icon={Sparkles} badge={aiPending} onClick={onNavClick} collapsed={collapsed} />
        <Section label="Tools" collapsed={collapsed} />
        <NavLink href="/tools/video-editing" label="Video Editing" icon={Clapperboard} onClick={onNavClick} collapsed={collapsed} />
        <div className={cn("flex flex-col gap-1", !collapsed && "ml-4 border-l pl-2")}>
          {toolItems.map(({ root, ...item }) => <NavLink key={item.href} {...item} subtitle={itemCount(counts[root])} onClick={onNavClick} collapsed={collapsed} />)}
        </div>
      </nav>
      <nav className="flex flex-col gap-1 border-t pt-3 mt-3">
        {bottomItems.map((item) => <NavLink key={item.href} {...item} onClick={onNavClick} collapsed={collapsed} />)}
        {onToggle && (
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={!collapsed}
            aria-label={collapsed ? "Expand navigation" : "Collapse navigation"}
            title={collapsed ? "Expand navigation" : "Collapse navigation"}
            className={cn(
              "flex items-center gap-3 whitespace-nowrap rounded-lg py-2 text-sm text-muted-foreground transition-colors duration-150 hover:bg-muted/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              collapsed ? "justify-center px-0" : "px-3"
            )}
          >
            {collapsed ? <ChevronsRight className="h-[18px] w-[18px] shrink-0" strokeWidth={1.5} /> : <ChevronsLeft className="h-[18px] w-[18px] shrink-0" strokeWidth={1.5} />}
            {!collapsed && "Collapse"}
          </button>
        )}
      </nav>
    </div>
  )
}

export function Sidebar({ aiPending, counts }: { aiPending: number; counts: RootCounts }) {
  // The server and first paint are expanded; a stored "collapsed" takes over on hydration.
  const [mode, setMode] = useStoredState("ps.sidebar", "expanded", ["expanded", "collapsed"] as const)
  const collapsed = mode === "collapsed"
  // The width animates only for a toggle here, so a stored "collapsed" taking over on load doesn't slide in.
  const [animate, setAnimate] = useState(false)
  return (
    <aside
      className={cn(
        "hidden md:flex shrink-0 flex-col overflow-hidden border-r bg-card",
        animate && "transition-[width] duration-200 ease-out motion-reduce:transition-none",
        collapsed ? "w-14" : "w-56"
      )}
    >
      <SidebarContent
        aiPending={aiPending}
        counts={counts}
        collapsed={collapsed}
        onToggle={() => {
          setAnimate(true)
          setMode(collapsed ? "expanded" : "collapsed")
        }}
      />
    </aside>
  )
}

export function MobileSidebarTrigger({ aiPending, counts }: { aiPending: number; counts: RootCounts }) {
  const [open, setOpen] = useState(false)
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger className="inline-flex h-8 w-8 items-center justify-center rounded-md hover:bg-muted transition-colors md:hidden">
        <Menu className="h-4 w-4" />
        <span className="sr-only">Menu</span>
      </SheetTrigger>
      <SheetContent side="left" className="w-56 p-0">
        <SidebarContent aiPending={aiPending} counts={counts} onNavClick={() => setOpen(false)} />
      </SheetContent>
    </Sheet>
  )
}
