"use client"

import { useState } from "react"
import { toast } from "sonner"
import { CircleCheck, CircleX, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { testAiConnection, updateAiSettings, type AiTestResult } from "@/lib/actions/ai-settings"
import { AI_PRESETS, type AiSettingsInput } from "@/lib/ai/settings-schema"
import { DEFAULT_INSTRUCTIONS, MAX_INSTRUCTIONS_LENGTH, REPLY_FORMAT, storedInstructions } from "@/lib/ai/prompt"
import { DEFAULT_SCREENSHOT_INSTRUCTIONS, SCREENSHOT_REPLY_FORMAT, SHOTS_PER_REQUEST } from "@/lib/ai/screenshot-prompt"

export type AiSettingsInitial = Omit<AiSettingsInput, "apiKey" | "clearApiKey">

function Field({ id, label, hint, children }: { id: string; label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  )
}

export function AiSettings({ initial, hasStoredKey, keyUnreadable }: { initial: AiSettingsInitial; hasStoredKey: boolean; keyUnreadable: boolean }) {
  const [form, setForm] = useState<AiSettingsInitial>(initial)
  const [apiKey, setApiKey] = useState("")
  const [clearApiKey, setClearApiKey] = useState(false)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [test, setTest] = useState<AiTestResult | null>(null)

  const set = <K extends keyof AiSettingsInitial>(key: K, value: AiSettingsInitial[K]) => setForm((f) => ({ ...f, [key]: value }))
  const payload = (): AiSettingsInput => ({ ...form, apiKey: apiKey || undefined, clearApiKey })

  async function save() {
    setSaving(true)
    const r = await updateAiSettings(payload())
    setSaving(false)
    if ("error" in r) toast.error(r.error)
    else {
      toast.success("AI settings saved.")
      setApiKey("")
      setClearApiKey(false)
    }
  }

  async function runTest() {
    setTesting(true)
    setTest(null)
    setTest(await testAiConnection(payload()))
    setTesting(false)
  }

  return (
    <div className="space-y-6">
      <section className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Connection</h2>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={form.enabled} onChange={(e) => set("enabled", e.target.checked)} className="h-4 w-4 accent-primary" />
            AI review on
          </label>
        </div>
        <div className="rounded-lg border bg-card p-4 space-y-4">
          <div className="flex flex-wrap gap-2">
            {AI_PRESETS.map((p) => (
              <Button key={p.id} type="button" variant="outline" size="sm" onClick={() => set("baseUrl", p.baseUrl)}>{p.label}</Button>
            ))}
          </div>
          <Field id="ai-url" label="Base URL" hint="Any OpenAI-compatible server. For Ollama on another PC use http://<pc-address>:11434/v1.">
            <Input id="ai-url" value={form.baseUrl} onChange={(e) => set("baseUrl", e.target.value)} placeholder="http://192.168.1.20:11434/v1" />
          </Field>
          <Field
            id="ai-key"
            label="API key"
            hint={keyUnreadable ? "The stored key can't be read (AUTH_SECRET changed). Enter it again." : hasStoredKey ? "A key is stored. Leave blank to keep it." : "Not needed for local servers."}
          >
            <div className="flex items-center gap-3">
              <Input id="ai-key" type="password" autoComplete="off" value={apiKey} onChange={(e) => setApiKey(e.target.value)} disabled={clearApiKey} />
              {hasStoredKey && (
                <label className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
                  <input type="checkbox" checked={clearApiKey} onChange={(e) => setClearApiKey(e.target.checked)} /> Clear key
                </label>
              )}
            </div>
          </Field>
          <Field id="ai-model" label="Model" hint="Must accept images, e.g. qwen2.5vl:7b, llava, gpt-4o-mini.">
            <Input id="ai-model" value={form.model} onChange={(e) => set("model", e.target.value)} />
          </Field>
          <div className="flex flex-wrap items-center gap-3">
            <Button type="button" variant="outline" size="sm" onClick={runTest} disabled={testing}>
              {testing && <Loader2 className="h-4 w-4 animate-spin" />} Test connection
            </Button>
            {test && "error" in test && <span className="inline-flex items-center gap-1 text-sm text-destructive"><CircleX className="h-4 w-4" />{test.error}</span>}
            {test && "success" in test && (
              <span className={test.seesImages ? "inline-flex items-center gap-1 text-sm text-emerald-700 dark:text-emerald-400" : "inline-flex items-center gap-1 text-sm text-amber-700 dark:text-amber-400"}>
                {test.seesImages ? <CircleCheck className="h-4 w-4" /> : <CircleX className="h-4 w-4" />}{test.detail}
              </span>
            )}
          </div>
        </div>
      </section>

      <details className="group rounded-lg border bg-card p-4">
        <summary className="cursor-pointer text-sm font-medium">Advanced</summary>
        <div className="mt-4 grid gap-4 sm:grid-cols-3">
          <Field id="ai-temp" label="Temperature" hint="Blank = server default.">
            <Input id="ai-temp" inputMode="decimal" value={form.temperature ?? ""} onChange={(e) => set("temperature", e.target.value)} />
          </Field>
          <Field id="ai-max" label="Max tokens" hint="Blank = server default.">
            <Input id="ai-max" inputMode="numeric" value={form.maxTokens ?? ""} onChange={(e) => set("maxTokens", e.target.value)} />
          </Field>
          <Field id="ai-timeout" label="Time limit (s)" hint="Per group. Blank = 120.">
            <Input id="ai-timeout" inputMode="numeric" value={form.timeoutSeconds ?? ""} onChange={(e) => set("timeoutSeconds", e.target.value)} />
          </Field>
        </div>
        <div className="mt-4 space-y-4">
          <Field id="ai-extra" label="Extra request JSON" hint='Merged into every request, e.g. {"keep_alive":"10m"}.'>
            <Textarea id="ai-extra" rows={3} className="font-mono text-xs" value={form.extraBody ?? ""} onChange={(e) => set("extraBody", e.target.value)} />
          </Field>
        </div>
      </details>

      <section className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Find Similar instructions</h2>
          <Button type="button" variant="outline" size="sm" disabled={storedInstructions(form.instructions ?? "") === null} onClick={() => set("instructions", DEFAULT_INSTRUCTIONS)}>
            Reset to default
          </Button>
        </div>
        <div className="rounded-lg border bg-card p-4 space-y-3">
          <Field id="ai-prompt" label="What makes a good photo" hint="Sent to the model with every group. Edit freely; Reset brings back the built-in text.">
            <Textarea id="ai-prompt" rows={11} maxLength={MAX_INSTRUCTIONS_LENGTH} value={form.instructions ?? ""} onChange={(e) => set("instructions", e.target.value)} />
          </Field>
          <div className="space-y-1.5">
            <p className="text-sm font-medium">Reply format (always added, can&apos;t be changed)</p>
            <pre className="whitespace-pre-wrap rounded-md bg-muted px-3 py-2 font-mono text-xs text-muted-foreground">{REPLY_FORMAT}</pre>
          </div>
        </div>
      </section>

      <section className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Screenshot instructions</h2>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={storedInstructions(form.screenshotInstructions ?? "", DEFAULT_SCREENSHOT_INSTRUCTIONS) === null}
            onClick={() => set("screenshotInstructions", DEFAULT_SCREENSHOT_INSTRUCTIONS)}
          >
            Reset to default
          </Button>
        </div>
        <div className="rounded-lg border bg-card p-4 space-y-3">
          <Field
            id="ai-shot-prompt"
            label="What counts as a screenshot"
            hint={`Used by Find Screenshots, sent with each batch of ${SHOTS_PER_REQUEST} images. Photos with camera details (make, model, exposure) and HEIC files skip the AI.`}
          >
            <Textarea id="ai-shot-prompt" rows={9} maxLength={MAX_INSTRUCTIONS_LENGTH} value={form.screenshotInstructions ?? ""} onChange={(e) => set("screenshotInstructions", e.target.value)} />
          </Field>
          <div className="space-y-1.5">
            <p className="text-sm font-medium">Reply format (always added, can&apos;t be changed)</p>
            <pre className="whitespace-pre-wrap rounded-md bg-muted px-3 py-2 font-mono text-xs text-muted-foreground">{SCREENSHOT_REPLY_FORMAT}</pre>
          </div>
        </div>
      </section>

      <section className="space-y-4">
        <h2 className="text-lg font-semibold">Grouping</h2>
        <div className="rounded-lg border bg-card p-4 grid gap-4 sm:grid-cols-2">
          <Field id="ai-window" label="Time window (seconds)" hint="Photos further apart than this are never grouped.">
            <Input id="ai-window" inputMode="numeric" value={form.groupWindowSeconds} onChange={(e) => set("groupWindowSeconds", e.target.value)} />
          </Field>
          <Field id="ai-sim" label="How similar" hint="Loose groups more; strict only near-identical shots.">
            <select id="ai-sim" value={form.similarity} onChange={(e) => set("similarity", e.target.value)} className="h-8 w-full rounded-lg border border-input bg-background text-foreground px-2 text-sm">
              <option value="strict">Strict</option>
              <option value="similar">Similar</option>
              <option value="loose">Loose</option>
            </select>
          </Field>
          <Field id="ai-px" label="Image size sent (pixels)" hint="Long edge. Bigger is slower but sees faces better.">
            <Input id="ai-px" inputMode="numeric" value={form.imageMaxPx} onChange={(e) => set("imageMaxPx", e.target.value)} />
          </Field>
          <Field id="ai-group" label="Largest group" hint="Bigger bursts are split into chunks of this size.">
            <Input id="ai-group" inputMode="numeric" value={form.maxGroupSize} onChange={(e) => set("maxGroupSize", e.target.value)} />
          </Field>
        </div>
      </section>

      <Button onClick={save} disabled={saving}>{saving && <Loader2 className="h-4 w-4 animate-spin" />} Save</Button>
    </div>
  )
}
