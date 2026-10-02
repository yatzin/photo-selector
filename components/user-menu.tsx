"use client"

import { signOut } from "next-auth/react"
import { useRouter } from "next/navigation"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { LogOut, KeyRound } from "lucide-react"

export function UserMenu({ name, email }: { name: string; email: string }) {
  const router = useRouter()
  const initials = name
    .split(" ")
    .map((n) => n[0])
    .join("")
    .toUpperCase()
    .slice(0, 2)

  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm transition-colors duration-150 hover:bg-muted outline-none">
        <Avatar className="h-7 w-7">
          <AvatarFallback className="bg-primary/15 text-xs font-medium text-primary">{initials}</AvatarFallback>
        </Avatar>
        <div className="text-left">
          <div className="font-medium leading-none">{name}</div>
          <div className="text-xs text-muted-foreground leading-none mt-0.5">{email}</div>
        </div>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuGroup>
          <DropdownMenuLabel>My Account</DropdownMenuLabel>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => router.push("/change-password")}>
          <KeyRound className="h-4 w-4 mr-2" />
          Change Password
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          className="text-destructive focus:text-destructive"
          onClick={() => signOut({ callbackUrl: "/login" })}
        >
          <LogOut className="h-4 w-4 mr-2" />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
