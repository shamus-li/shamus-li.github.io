import { useEffect, useMemo, useState } from "react"
import {
  ExternalLinkIcon,
  LogOutIcon,
  PauseIcon,
  PlayIcon,
  PlusIcon,
  SaveIcon,
  ShieldCheckIcon,
  Trash2Icon,
} from "lucide-react"
import { toast } from "sonner"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Separator } from "@/components/ui/separator"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Spinner } from "@/components/ui/spinner"
import { Toaster } from "@/components/ui/sonner"

type RedirectRule = {
  id?: string
  source: string
  destination: string
  code: 301 | 302
  active: boolean
}

type AccessUser = {
  email?: string
  name?: string
  local?: boolean
}

type Status = {
  authenticated: boolean
  user?: AccessUser
}

type LoadState = "loading" | "ready" | "blocked"

async function fetchJson<T>(url: string, options: RequestInit = {}) {
  const response = await fetch(url, {
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", ...options.headers },
    ...options,
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok)
    throw new Error(body.error || `${response.status} ${response.statusText}`)
  return body as T
}

function normalizeSource(source: string) {
  const trimmed = source.trim()
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`
}

function App() {
  const [status, setStatus] = useState<Status | null>(null)
  const [loadState, setLoadState] = useState<LoadState>("loading")
  const [redirects, setRedirects] = useState<RedirectRule[]>([])
  const [source, setSource] = useState("")
  const [destination, setDestination] = useState("")
  const [code, setCode] = useState<"301" | "302">("301")
  const [saving, setSaving] = useState(false)
  const [syncStatus, setSyncStatus] = useState("Connected")
  const [accessError, setAccessError] = useState("")

  const activeCount = redirects.filter((rule) => rule.active).length
  const pausedCount = redirects.length - activeCount
  const userLabel =
    status?.user?.email ||
    status?.user?.name ||
    (status?.user?.local ? "Local preview" : "Access")
  const exportText = useMemo(
    () =>
      redirects
        .filter((rule) => rule.active)
        .map((rule) => `${rule.source} ${rule.destination} ${rule.code}`)
        .join("\n"),
    [redirects]
  )

  async function saveRedirects() {
    setSaving(true)
    setSyncStatus("Saving...")
    try {
      await fetchJson("/api/redirects", {
        method: "PUT",
        body: JSON.stringify({ redirects }),
      })
      setSyncStatus("Saved")
      toast.success("Redirects saved")
    } finally {
      setSaving(false)
    }
  }

  function addRedirect(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const nextSource = normalizeSource(source)
    const nextDestination = destination.trim()

    if (!/^https?:\/\//.test(nextDestination)) {
      toast.error("Destination must be an absolute URL")
      return
    }

    setRedirects((current) => [
      ...current,
      {
        id: crypto.randomUUID(),
        source: nextSource,
        destination: nextDestination,
        code: Number(code) as 301 | 302,
        active: true,
      },
    ])
    setSource("")
    setDestination("")
    setCode("301")
    setSyncStatus("Unsaved changes")
  }

  function updateRule(id: string | undefined, patch: Partial<RedirectRule>) {
    setRedirects((current) =>
      current.map((rule) => (rule.id === id ? { ...rule, ...patch } : rule))
    )
    setSyncStatus("Unsaved changes")
  }

  function removeRule(id: string | undefined) {
    setRedirects((current) => current.filter((rule) => rule.id !== id))
    setSyncStatus("Unsaved changes")
  }

  function logOut() {
    window.location.href = "/cdn-cgi/access/logout"
  }

  useEffect(() => {
    let cancelled = false

    async function loadInitialData() {
      try {
        const nextStatus = await fetchJson<Status>("/api/redirects/status")
        const nextRedirects = await fetchJson<RedirectRule[]>("/api/redirects")
        if (cancelled) return
        setStatus(nextStatus)
        setRedirects(
          nextRedirects.map((rule, index) => ({
            id: rule.id || `${rule.source}-${index}`,
            ...rule,
          }))
        )
        setLoadState("ready")
      } catch (error) {
        if (cancelled) return
        setAccessError(
          error instanceof Error ? error.message : "Could not load redirects"
        )
        setLoadState("blocked")
      }
    }

    void loadInitialData()

    return () => {
      cancelled = true
    }
  }, [])

  if (loadState === "loading") {
    return (
      <main className="flex min-h-svh items-center justify-center bg-muted/30 p-4">
        <Toaster />
        <Card className="w-full max-w-sm">
          <CardHeader>
            <CardDescription>Redirect manager</CardDescription>
            <CardTitle>Checking access</CardTitle>
          </CardHeader>
          <CardContent>
            <Spinner />
          </CardContent>
        </Card>
      </main>
    )
  }

  if (loadState === "blocked") {
    return (
      <main className="flex min-h-svh items-center justify-center bg-muted/30 p-4">
        <Toaster />
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardDescription>Redirect manager</CardDescription>
            <CardTitle>Cloudflare Access required</CardTitle>
          </CardHeader>
          <CardContent>
            <Alert>
              <ShieldCheckIcon data-icon="inline-start" />
              <AlertTitle>Access did not pass through</AlertTitle>
              <AlertDescription>
                {accessError ||
                  "Protect /redirects and /api/redirects with a Cloudflare Access application."}
              </AlertDescription>
            </Alert>
          </CardContent>
        </Card>
      </main>
    )
  }

  return (
    <main className="min-h-svh bg-muted/30 p-4 md:p-8">
      <Toaster />
      <div className="mx-auto flex max-w-6xl flex-col gap-4">
        <Card>
          <CardHeader className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <CardDescription>Redirect manager</CardDescription>
              <CardTitle className="text-4xl md:text-5xl">Redirects</CardTitle>
              <p className="mt-2 text-sm text-muted-foreground">
                Protected by Cloudflare Access as {userLabel}
              </p>
            </div>
            <Button variant="outline" onClick={logOut}>
              <LogOutIcon data-icon="inline-start" />
              Sign out
            </Button>
          </CardHeader>
        </Card>

        <div className="grid gap-4 md:grid-cols-3">
          <SummaryCard label="Active" value={activeCount} />
          <SummaryCard label="Paused" value={pausedCount} />
          <SummaryCard label="Total" value={redirects.length} />
        </div>

        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
          <Card className="min-w-0">
            <CardHeader className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <CardTitle>Rules</CardTitle>
                <CardDescription>{syncStatus}</CardDescription>
              </div>
              <Button
                disabled={saving}
                onClick={() =>
                  saveRedirects().catch((error: Error) =>
                    toast.error(error.message)
                  )
                }
              >
                {saving ? <Spinner /> : <SaveIcon data-icon="inline-start" />}
                Save
              </Button>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              {redirects.map((rule) => (
                <RedirectRow
                  key={rule.id}
                  rule={rule}
                  onToggle={() => updateRule(rule.id, { active: !rule.active })}
                  onRemove={() => removeRule(rule.id)}
                />
              ))}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Add redirect</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-5">
              <form className="flex flex-col gap-4" onSubmit={addRedirect}>
                <FieldGroup>
                  <Field>
                    <FieldLabel htmlFor="source">Source</FieldLabel>
                    <Input
                      id="source"
                      required
                      value={source}
                      onChange={(event) => setSource(event.target.value)}
                      placeholder="/new-link"
                    />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="destination">Destination</FieldLabel>
                    <Input
                      id="destination"
                      required
                      value={destination}
                      onChange={(event) => setDestination(event.target.value)}
                      placeholder="https://example.com"
                    />
                  </Field>
                  <Field>
                    <FieldLabel>Code</FieldLabel>
                    <Select
                      value={code}
                      onValueChange={(value) => setCode(value as "301" | "302")}
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          <SelectItem value="301">301 permanent</SelectItem>
                          <SelectItem value="302">302 temporary</SelectItem>
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                  </Field>
                </FieldGroup>
                <Button type="submit">
                  <PlusIcon data-icon="inline-start" />
                  Add
                </Button>
              </form>
              <Separator />
              <div className="flex flex-col gap-2">
                <h2 className="text-base font-medium">Active rules</h2>
                <pre className="max-h-44 overflow-auto rounded-lg bg-foreground p-3 text-xs text-background">
                  {exportText || "No active redirects"}
                </pre>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </main>
  )
}

function SummaryCard({ label, value }: { label: string; value: number }) {
  return (
    <Card>
      <CardContent className="pt-6">
        <div className="text-3xl font-semibold">{value}</div>
        <div className="text-sm text-muted-foreground">{label}</div>
      </CardContent>
    </Card>
  )
}

function RedirectRow({
  rule,
  onToggle,
  onRemove,
}: {
  rule: RedirectRule
  onToggle: () => void
  onRemove: () => void
}) {
  return (
    <div className="grid min-w-0 gap-3 rounded-lg border bg-card p-3 md:grid-cols-[minmax(120px,0.65fr)_minmax(140px,1fr)_auto_auto] md:items-center">
      <div className="min-w-0 truncate font-medium">{rule.source}</div>
      <a
        className="flex min-w-0 items-center gap-2 truncate text-sm text-muted-foreground"
        href={rule.destination}
        rel="noreferrer"
        target="_blank"
      >
        <span className="truncate">{rule.destination}</span>
        <ExternalLinkIcon data-icon="inline-end" />
      </a>
      <Badge variant={rule.active ? "secondary" : "outline"}>
        {rule.active ? rule.code : "paused"}
      </Badge>
      <div className="flex gap-2">
        <Button variant="outline" size="sm" onClick={onToggle}>
          {rule.active ? (
            <PauseIcon data-icon="inline-start" />
          ) : (
            <PlayIcon data-icon="inline-start" />
          )}
          {rule.active ? "Pause" : "Resume"}
        </Button>
        <Button variant="outline" size="sm" onClick={onRemove}>
          <Trash2Icon data-icon="inline-start" />
          Remove
        </Button>
      </div>
    </div>
  )
}

export default App
