"use client"

import { useState } from "react"
import { toast } from "sonner"
import { Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { updateStockSettings } from "@/lib/actions/stock-settings"

export type StockSettingsInitial = { openverseClientId: string }

type Clears = { pixabay: boolean; pexels: boolean; openverse: boolean }

function SecretField({
  id, label, isSet, value, onChange, clear, onClear, hint, clearLabel = "Clear", showClear = isSet,
}: {
  id: string
  label: string
  isSet: boolean
  value: string
  onChange: (v: string) => void
  clear: boolean
  onClear: (v: boolean) => void
  hint: React.ReactNode
  clearLabel?: string
  showClear?: boolean
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <Label htmlFor={id}>{label}</Label>
        <span className={isSet && !clear ? "text-xs font-medium text-emerald-700 dark:text-emerald-400" : "text-xs text-muted-foreground"}>
          {clear ? "will be cleared" : isSet ? "set" : "not set"}
        </span>
      </div>
      <div className="flex items-center gap-3">
        <Input
          id={id}
          type="password"
          autoComplete="off"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={clear}
          placeholder={isSet ? "Enter a new key to replace it" : ""}
        />
        {showClear && (
          <Button type="button" variant="outline" size="sm" onClick={() => onClear(!clear)}>
            {clear ? "Undo" : clearLabel}
          </Button>
        )}
      </div>
      <p className="text-xs text-muted-foreground">{hint}</p>
    </div>
  )
}

export function StockSettings({
  initial, hasPixabayKey, hasPexelsKey, hasOpenverseSecret, unreadable,
}: {
  initial: StockSettingsInitial
  hasPixabayKey: boolean
  hasPexelsKey: boolean
  hasOpenverseSecret: boolean
  unreadable: boolean
}) {
  const [pixabayKey, setPixabayKey] = useState("")
  const [pexelsKey, setPexelsKey] = useState("")
  const [clientId, setClientId] = useState(initial.openverseClientId)
  const [clientSecret, setClientSecret] = useState("")
  const [clear, setClear] = useState<Clears>({ pixabay: false, pexels: false, openverse: false })
  const [saving, setSaving] = useState(false)

  async function save() {
    setSaving(true)
    const r = await updateStockSettings({
      pixabayKey: pixabayKey || undefined,
      pexelsKey: pexelsKey || undefined,
      openverseClientId: clientId || undefined,
      openverseClientSecret: clientSecret || undefined,
      clearPixabayKey: clear.pixabay,
      clearPexelsKey: clear.pexels,
      clearOpenverseSecret: clear.openverse,
    })
    setSaving(false)
    if ("error" in r) toast.error(r.error)
    else {
      toast.success("Stock media settings saved.")
      setPixabayKey("")
      setPexelsKey("")
      setClientSecret("")
      setClear({ pixabay: false, pexels: false, openverse: false })
    }
  }

  const link = "text-link underline underline-offset-2"

  return (
    <div className="space-y-6">
      <p className="text-sm text-muted-foreground">
        Only CC0 / public-domain media (Openverse) and media that needs no attribution (Pixabay, Pexels) are ever offered.
        Keys are stored encrypted and are never shown again after saving.
      </p>

      {unreadable && (
        <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-800 dark:text-amber-300">
          A stored key can&apos;t be read (AUTH_SECRET changed). Enter it again, or clear it.
        </p>
      )}

      <section className="space-y-4">
        <h2 className="text-lg font-semibold">Keys</h2>
        <div className="rounded-lg border bg-card p-4 space-y-5">
          <SecretField
            id="stock-pixabay" label="Pixabay API key" isSet={hasPixabayKey}
            value={pixabayKey} onChange={setPixabayKey}
            clear={clear.pixabay} onClear={(v) => setClear((c) => ({ ...c, pixabay: v }))}
            hint={<>Free. Get one at <a className={link} href="https://pixabay.com/api/docs/" target="_blank" rel="noreferrer">pixabay.com/api/docs</a>. Leave blank to keep the stored key.</>}
          />
          <SecretField
            id="stock-pexels" label="Pexels API key" isSet={hasPexelsKey}
            value={pexelsKey} onChange={setPexelsKey}
            clear={clear.pexels} onClear={(v) => setClear((c) => ({ ...c, pexels: v }))}
            hint={<>Free. Get one at <a className={link} href="https://www.pexels.com/api/" target="_blank" rel="noreferrer">pexels.com/api</a>. Leave blank to keep the stored key.</>}
          />
        </div>
      </section>

      <section className="space-y-4">
        <h2 className="text-lg font-semibold">Openverse (optional)</h2>
        <div className="rounded-lg border bg-card p-4 space-y-5">
          <p className="text-xs text-muted-foreground">
            Openverse works without credentials. Add a client ID and secret only if you want higher rate limits.
          </p>
          <div className="space-y-1.5">
            <Label htmlFor="stock-ov-id">Client ID</Label>
            <Input id="stock-ov-id" autoComplete="off" value={clientId} onChange={(e) => setClientId(e.target.value)} disabled={clear.openverse} />
          </div>
          <SecretField
            id="stock-ov-secret" label="Client secret" isSet={hasOpenverseSecret}
            value={clientSecret} onChange={setClientSecret}
            clear={clear.openverse} onClear={(v) => setClear((c) => ({ ...c, openverse: v }))}
            hint="Leave blank to keep the stored secret. Clearing removes the client ID too."
            clearLabel="Clear credentials" showClear={hasOpenverseSecret || Boolean(initial.openverseClientId)}
          />
        </div>
      </section>

      <Button onClick={save} disabled={saving}>{saving && <Loader2 className="h-4 w-4 animate-spin" />} Save</Button>
    </div>
  )
}
