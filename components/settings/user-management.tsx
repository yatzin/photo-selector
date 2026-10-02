"use client"

import { useState } from "react"
import { signOut } from "next-auth/react"
import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { z } from "zod"
import { toast } from "sonner"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Form, FormField, FormItem, FormLabel, FormControl, FormMessage } from "@/components/ui/form"
import { Badge } from "@/components/ui/badge"
import { createUser, updateUserRole, resetUserPassword, deleteUser, updateSelf, changeOwnPassword } from "@/lib/actions/users"
import type { User } from "@/app/generated/prisma/client"

const roleLabel: Record<string, string> = { ADMIN: "Admin", USER: "User" }

export function UserManagement({ users, currentUserId }: { users: User[]; currentUserId: string }) {
  const [createOpen, setCreateOpen] = useState(false)
  const [editingSelf, setEditingSelf] = useState<User | null>(null)
  const [changingPassword, setChangingPassword] = useState(false)
  const [tempPassword, setTempPassword] = useState<{ name: string; password: string } | null>(null)

  async function handleRoleChange(id: string, role: string) {
    const result = await updateUserRole(id, role)
    if (result?.error) toast.error(typeof result.error === "string" ? result.error : "Failed to update role.")
    else toast.success("Role updated.")
  }

  async function handleResetPassword(id: string, name: string) {
    if (!confirm(`Reset password for ${name}? They will need to set a new password on next login.`)) return
    const result = await resetUserPassword(id)
    if (result?.error) { toast.error(result.error); return }
    setTempPassword({ name, password: result.tempPassword! })
  }

  async function handleDelete(id: string, name: string) {
    if (!confirm(`Delete user "${name}"? This cannot be undone.`)) return
    const result = await deleteUser(id)
    if (result?.error) toast.error(result.error)
    else toast.success(`"${name}" deleted.`)
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Users</h2>
        <Button onClick={() => setCreateOpen(true)}>Add User</Button>
      </div>

      <div className="rounded-lg border overflow-hidden bg-card">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-muted-foreground">
            <tr>
              <th className="text-left font-medium px-4 py-2.5">Name</th>
              <th className="text-left font-medium px-4 py-2.5 hidden sm:table-cell">Email</th>
              <th className="text-left font-medium px-4 py-2.5">Role</th>
              <th className="text-right font-medium px-4 py-2.5">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {users.map((u) => (
              <tr key={u.id} className="hover:bg-muted/20">
                <td className="px-4 py-3 font-medium">
                  {u.name}
                  {u.id === currentUserId && <Badge variant="outline" className="ml-2 text-xs">You</Badge>}
                  {u.mustResetPassword && <Badge variant="secondary" className="ml-2 text-xs">Must reset pw</Badge>}
                </td>
                <td className="px-4 py-3 text-muted-foreground hidden sm:table-cell">{u.email}</td>
                <td className="px-4 py-3">
                  {u.id === currentUserId ? (
                    <Badge variant="secondary">{roleLabel[u.role]}</Badge>
                  ) : (
                    <Select value={u.role} onValueChange={(v) => handleRoleChange(u.id, v ?? u.role)}>
                      <SelectTrigger className="h-7 w-28 text-xs">
                        <SelectValue>{(v: keyof typeof roleLabel) => roleLabel[v]}</SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="ADMIN">Admin</SelectItem>
                        <SelectItem value="USER">User</SelectItem>
                      </SelectContent>
                    </Select>
                  )}
                </td>
                <td className="px-4 py-3 text-right">
                  <div className="flex items-center justify-end gap-2">
                    {u.id === currentUserId ? (
                      <>
                        <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setChangingPassword(true)}>Change pw</Button>
                        <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setEditingSelf(u)}>Edit</Button>
                      </>
                    ) : (
                      <>
                        <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => handleResetPassword(u.id, u.name)}>Reset pw</Button>
                        <Button variant="ghost" size="sm" className="h-7 text-xs text-destructive hover:text-destructive" onClick={() => handleDelete(u.id, u.name)}>Delete</Button>
                      </>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <CreateUserDialog
        open={createOpen}
        onClose={(result) => {
          setCreateOpen(false)
          if (result) setTempPassword(result)
        }}
      />

      {editingSelf && (
        <EditSelfDialog
          user={editingSelf}
          onClose={() => setEditingSelf(null)}
        />
      )}

      {changingPassword && <ChangePasswordDialog onClose={() => setChangingPassword(false)} />}

      {tempPassword && (
        <Dialog open onOpenChange={() => setTempPassword(null)}>
          <DialogContent className="max-w-sm">
            <DialogHeader><DialogTitle>Temporary Password</DialogTitle></DialogHeader>
            <div className="space-y-3 text-sm">
              <p>Share this temporary password with <strong>{tempPassword.name}</strong>. They will be required to set a new password on first login.</p>
              <div className="rounded-md bg-muted px-4 py-3 font-mono text-lg tracking-widest text-center select-all">
                {tempPassword.password}
              </div>
            </div>
            <DialogFooter>
              <Button onClick={() => setTempPassword(null)}>Done</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  )
}

const createSchema = z.object({
  name: z.string().min(1, "Name is required"),
  email: z.string().min(1, "Email is required"),
  role: z.enum(["ADMIN", "USER"]),
})

function CreateUserDialog({ open, onClose }: { open: boolean; onClose: (result?: { name: string; password: string }) => void }) {
  const form = useForm({ resolver: zodResolver(createSchema), defaultValues: { name: "", email: "", role: "USER" as const } })

  async function onSubmit(values: z.infer<typeof createSchema>) {
    const result = await createUser(values)
    if (result?.error) {
      const emailError = Array.isArray(result.error.email) ? result.error.email[0] : null
      if (emailError) form.setError("email", { message: emailError })
      toast.error("Failed to create user.")
      return
    }
    toast.success(`User created.`)
    form.reset()
    onClose({ name: values.name, password: result.tempPassword! })
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader><DialogTitle>Add User</DialogTitle></DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <FormField control={form.control} name="name" render={({ field }) => (
              <FormItem><FormLabel>Name *</FormLabel><FormControl><Input {...field} /></FormControl><FormMessage /></FormItem>
            )} />
            <FormField control={form.control} name="email" render={({ field }) => (
              <FormItem><FormLabel>Email *</FormLabel><FormControl><Input type="email" {...field} /></FormControl><FormMessage /></FormItem>
            )} />
            <FormField control={form.control} name="role" render={({ field }) => (
              <FormItem>
                <FormLabel>Role *</FormLabel>
                <Select onValueChange={field.onChange} value={field.value}>
                  <FormControl><SelectTrigger><SelectValue>{(v: keyof typeof roleLabel) => roleLabel[v]}</SelectValue></SelectTrigger></FormControl>
                  <SelectContent>
                    <SelectItem value="ADMIN">Admin — sort photos + manage users and storage</SelectItem>
                    <SelectItem value="USER">User — sort photos</SelectItem>
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )} />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onClose()}>Cancel</Button>
              <Button type="submit" disabled={form.formState.isSubmitting}>
                {form.formState.isSubmitting ? "Creating…" : "Create User"}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  )
}

const editSelfSchema = z.object({
  name: z.string().min(1, "Name is required"),
  email: z.string().min(1, "Email is required"),
})

export function EditSelfDialog({ user, onClose }: { user: Pick<User, "name" | "email">; onClose: () => void }) {
  const form = useForm({
    resolver: zodResolver(editSelfSchema),
    defaultValues: { name: user.name, email: user.email },
  })

  async function onSubmit(values: z.infer<typeof editSelfSchema>) {
    const result = await updateSelf(values)
    if (result?.error) {
      const emailError = Array.isArray(result.error.email) ? result.error.email[0] : null
      if (emailError) form.setError("email", { message: emailError })
      toast.error("Failed to update profile.")
      return
    }
    toast.success("Profile updated.")
    onClose()
  }

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader><DialogTitle>Edit Profile</DialogTitle></DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <FormField control={form.control} name="name" render={({ field }) => (
              <FormItem><FormLabel>Name *</FormLabel><FormControl><Input {...field} /></FormControl><FormMessage /></FormItem>
            )} />
            <FormField control={form.control} name="email" render={({ field }) => (
              <FormItem><FormLabel>Email *</FormLabel><FormControl><Input {...field} /></FormControl><FormMessage /></FormItem>
            )} />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
              <Button type="submit" disabled={form.formState.isSubmitting}>
                {form.formState.isSubmitting ? "Saving…" : "Save Changes"}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  )
}

const changePasswordSchema = z
  .object({
    current: z.string().min(1, "Enter your current password"),
    next: z.string().min(1, "Enter a new password"),
    confirm: z.string().min(1, "Confirm the new password"),
  })
  .refine((v) => v.next === v.confirm, { path: ["confirm"], message: "Passwords do not match" })

export function ChangePasswordDialog({ onClose }: { onClose: () => void }) {
  const form = useForm({
    resolver: zodResolver(changePasswordSchema),
    defaultValues: { current: "", next: "", confirm: "" },
  })

  async function onSubmit(values: z.infer<typeof changePasswordSchema>) {
    const result = await changeOwnPassword(values)
    if ("error" in result && result.error) {
      form.setError(result.field, { message: result.error })
      return
    }
    // Every session for this account has just ended, this one included.
    await signOut({ callbackUrl: "/login?message=password-changed" })
  }

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader><DialogTitle>Change Password</DialogTitle></DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <FormField control={form.control} name="current" render={({ field }) => (
              <FormItem><FormLabel>Current password</FormLabel><FormControl><Input type="password" autoComplete="current-password" {...field} /></FormControl><FormMessage /></FormItem>
            )} />
            <FormField control={form.control} name="next" render={({ field }) => (
              <FormItem><FormLabel>New password</FormLabel><FormControl><Input type="password" autoComplete="new-password" {...field} /></FormControl><FormMessage /></FormItem>
            )} />
            <FormField control={form.control} name="confirm" render={({ field }) => (
              <FormItem><FormLabel>Confirm new password</FormLabel><FormControl><Input type="password" autoComplete="new-password" {...field} /></FormControl><FormMessage /></FormItem>
            )} />
            <p className="text-xs text-muted-foreground">
              Changing it signs you out on every device, including this one.
            </p>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
              <Button type="submit" disabled={form.formState.isSubmitting}>
                {form.formState.isSubmitting ? "Changing…" : "Change Password"}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  )
}
