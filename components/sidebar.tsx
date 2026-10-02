"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { useState } from "react"
import { cn } from "@/lib/utils"
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet"
import { FolderInput, FolderOutput, Images, Menu, Settings } from "lucide-react"

type NavItem = { href: string; label: string; icon: React.ElementType }

const navItems: NavItem[] = [
  { href: "/library/upload", label: "Mobile Upload", icon: FolderInput },
  { href: "/library/dropoff", label: "Sort Dropoff", icon: FolderOutput },
]

const bottomItems: NavItem[] = [{ href: "/settings", label: "Settings", icon: Settings }]

function NavLink({ href, label, icon: Icon, onClick }: NavItem & { onClick?: () => void }) {
  const pathname = usePathname()
  const active = pathname === href || pathname.startsWith(href + "/")
  return (
    <Link
      href={href}
      onClick={onClick}
      className={cn(
        "relative flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors duration-150",
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
      {label}
    </Link>
  )
}

function SidebarContent({ onNavClick }: { onNavClick?: () => void }) {
  return (
    <div className="flex flex-col h-full px-3 py-4">
      <div className="mb-6 flex items-center gap-2 px-3">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
          <Images className="h-4 w-4" />
        </div>
        <span className="font-heading font-semibold tracking-tight">Photo Selector</span>
      </div>
      <nav className="flex flex-1 flex-col gap-1">
        <p className="px-3 pb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">Library</p>
        {navItems.map((item) => <NavLink key={item.href} {...item} onClick={onNavClick} />)}
      </nav>
      <nav className="flex flex-col gap-1 border-t pt-3 mt-3">
        {bottomItems.map((item) => <NavLink key={item.href} {...item} onClick={onNavClick} />)}
      </nav>
    </div>
  )
}

export function Sidebar() {
  return (
    <aside className="hidden md:flex w-56 shrink-0 flex-col border-r bg-card">
      <SidebarContent />
    </aside>
  )
}

export function MobileSidebarTrigger() {
  const [open, setOpen] = useState(false)
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger className="inline-flex h-8 w-8 items-center justify-center rounded-md hover:bg-muted transition-colors md:hidden">
        <Menu className="h-4 w-4" />
        <span className="sr-only">Menu</span>
      </SheetTrigger>
      <SheetContent side="left" className="w-56 p-0">
        <SidebarContent onNavClick={() => setOpen(false)} />
      </SheetContent>
    </Sheet>
  )
}
