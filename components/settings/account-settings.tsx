"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { ChangePasswordDialog, EditSelfDialog } from "@/components/settings/user-management"

export function AccountSettings({ name, email, role }: { name: string; email: string; role: string }) {
  const [editing, setEditing] = useState(false)
  const [changingPassword, setChangingPassword] = useState(false)

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold">Account</h2>
      <div className="rounded-lg border bg-card p-4 space-y-4">
        <dl className="grid grid-cols-[6rem_1fr] gap-y-2 text-sm">
          <dt className="text-muted-foreground">Name</dt>
          <dd className="font-medium">{name}</dd>
          <dt className="text-muted-foreground">Email</dt>
          <dd>{email}</dd>
          <dt className="text-muted-foreground">Role</dt>
          <dd><Badge variant="secondary">{role === "ADMIN" ? "Admin" : "User"}</Badge></dd>
        </dl>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => setEditing(true)}>Edit profile</Button>
          <Button variant="outline" size="sm" onClick={() => setChangingPassword(true)}>Change password</Button>
        </div>
      </div>
      {editing && <EditSelfDialog user={{ name, email }} onClose={() => setEditing(false)} />}
      {changingPassword && <ChangePasswordDialog onClose={() => setChangingPassword(false)} />}
    </div>
  )
}
