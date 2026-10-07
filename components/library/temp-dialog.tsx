"use client"

import { useEffect, useState } from "react"
import { toast } from "sonner"
import { Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"
import { listTempUsersAction, sendToTempAction, type TempUser } from "@/lib/actions/temp"

// "Move / copy to User Temp Storage": pick move or copy, whose folder, and a
// note for them. A file already in that folder is replaced and its note updated.

export type TempTarget = { root: string; folder: string[]; names: string[] }

export function TempDialog({
  target, canMove, onDone, onClose,
}: {
  target: TempTarget
  /** The source can be changed (not read-only, not being scanned); otherwise only Copy is offered. */
  canMove: boolean
  /** After a successful send, with the names that went and whether they were moved. */
  onDone: (ok: string[], moved: boolean) => void
  onClose: () => void
}) {
  const [users, setUsers] = useState<TempUser[] | null>(null)
  const [mode, setMode] = useState<"move" | "copy">(canMove ? "move" : "copy")
  const [userId, setUserId] = useState("")
  const [note, setNote] = useState("")
  const [busy, setBusy] = useState(false)

  // A photo already in someone's folder can't be sent to that same folder.
  const source = target.root === "temp" ? target.folder.join("/") : null
  const choices = users?.filter((u) => u.folder !== source) ?? []

  useEffect(() => {
    let live = true
    listTempUsersAction()
      .then((list) => live && setUsers(list))
      .catch(() => live && setUsers([]))
    return () => {
      live = false
    }
  }, [])

  const count = target.names.length
  const what = count === 1 ? target.names[0].split("/").at(-1) : `${count} items`

  async function go() {
    if (!userId || busy) return
    setBusy(true)
    try {
      const r = await sendToTempAction({ ...target, userId, mode, note })
      if ("error" in r) {
        toast.error(r.error)
        return
      }
      if (r.failed.length) {
        const first = r.failed[0]
        toast.error(`Couldn't ${mode} ${r.failed.length} item${r.failed.length === 1 ? "" : "s"}`, { description: `${first.name}: ${first.error}` })
      }
      if (r.ok.length) {
        toast.success(`${mode === "move" ? "Moved" : "Copied"} ${r.ok.length} to ${r.to}'s temp storage`)
        onDone(r.ok, mode === "move")
      }
      if (!r.failed.length) onClose()
    } catch {
      toast.error("Something went wrong. Check that the NAS is reachable.")
    } finally {
      setBusy(false)
    }
  }

  const radio = (value: "move" | "copy", label: string, enabled: boolean) => (
    <label
      className={cn(
        "flex flex-1 cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm",
        mode === value ? "border-primary bg-primary/5" : "border-input",
        !enabled && "cursor-not-allowed opacity-50"
      )}
    >
      <input type="radio" name="temp-mode" value={value} checked={mode === value} disabled={!enabled} onChange={() => setMode(value)} className="accent-primary" />
      {label}
    </label>
  )

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Send to User Temp Storage</DialogTitle>
          <DialogDescription className="break-all">{what}</DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault()
            void go()
          }}
        >
          <div className="grid gap-2">
            <Label>Action</Label>
            <div className="flex gap-2" role="radiogroup" aria-label="Move or copy">
              {radio("move", "Move", canMove)}
              {radio("copy", "Copy", true)}
            </div>
            {!canMove && <p className="text-xs text-muted-foreground">This folder can&apos;t be changed right now, so only a copy is possible.</p>}
          </div>
          <div className="grid gap-2">
            <Label htmlFor="temp-user">User</Label>
            <select
              id="temp-user"
              value={userId}
              onChange={(e) => setUserId(e.target.value)}
              disabled={!users}
              required
              className="h-9 rounded-lg border border-input bg-background px-2 text-sm text-foreground"
            >
              <option value="" disabled>{users ? "Choose a user…" : "Loading…"}</option>
              {choices.map((u) => (
                <option key={u.id} value={u.id}>{u.name}</option>
              ))}
            </select>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="temp-note">Details</Label>
            <Textarea
              id="temp-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={4000}
              rows={4}
              placeholder="Anything they should know about this"
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
            <Button type="submit" disabled={!userId || busy}>
              {busy && <Loader2 className="h-4 w-4 animate-spin" />} Go
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
