import { useEffect, useState, type FormEvent } from "react"
import {
  ExternalLinkIcon,
  LogOutIcon,
  PlusIcon,
  ShieldCheckIcon,
  Trash2Icon,
} from "lucide-react"
import { Toaster, toast } from "sonner"

import { Button } from "./components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "./components/ui/card"
import { Input } from "./components/ui/input"
import {
  canonicalSource,
  parseRedirects,
  type Redirect,
  type RedirectCode,
} from "../redirect"

function errorMessage(value: unknown, fallback: string) {
  if (
    typeof value === "object" &&
    value !== null &&
    "error" in value &&
    typeof value.error === "string"
  ) {
    return value.error
  }
  return fallback
}

async function request(options?: RequestInit): Promise<unknown> {
  const response = await fetch("/redirects/api", {
    credentials: "same-origin",
    ...options,
  })
  const body: unknown =
    response.status === 204
      ? undefined
      : await response.json().catch(() => undefined)

  if (!response.ok) {
    throw new Error(
      errorMessage(body, `${response.status} ${response.statusText}`)
    )
  }
  return body
}

function App() {
  const [redirects, setRedirects] = useState<Redirect[] | null>(null)
  const [loadError, setLoadError] = useState("")
  const [saving, setSaving] = useState(false)

  async function persist(nextRedirects: Redirect[]) {
    if (!redirects || saving) return false

    const previousRedirects = redirects
    setRedirects(nextRedirects)
    setSaving(true)
    try {
      await request({
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ redirects: nextRedirects }),
      })
      return true
    } catch (error) {
      setRedirects(previousRedirects)
      toast.error(
        error instanceof Error ? error.message : "Could not update redirects"
      )
      return false
    } finally {
      setSaving(false)
    }
  }

  async function addRedirect(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!redirects || saving) return

    const form = event.currentTarget
    const data = new FormData(form)
    const rawSource = String(data.get("source") ?? "").trim()
    if (!rawSource) {
      toast.error("Source is required")
      return
    }
    const source = canonicalSource(rawSource)
    const destination = String(data.get("destination") ?? "").trim()
    const code: RedirectCode = data.get("code") === "302" ? 302 : 301

    let validDestination = false
    try {
      validDestination = ["http:", "https:"].includes(
        new URL(destination).protocol
      )
    } catch {
      // Invalid URLs are handled below.
    }
    if (!validDestination) {
      toast.error("Destination must be an absolute HTTP(S) URL")
      return
    }

    const nextRule = { source, destination, code }
    const nextRedirects = redirects.some((rule) => rule.source === source)
      ? redirects.map((rule) => (rule.source === source ? nextRule : rule))
      : [...redirects, nextRule]

    if (await persist(nextRedirects)) form.reset()
  }

  function removeRedirect(source: string) {
    if (!redirects) return
    void persist(redirects.filter((rule) => rule.source !== source))
  }

  useEffect(() => {
    let cancelled = false

    void request()
      .then((body) => {
        if (!cancelled) setRedirects(parseRedirects(body))
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setLoadError(
            error instanceof Error ? error.message : "Could not load redirects"
          )
        }
      })

    return () => {
      cancelled = true
    }
  }, [])

  if (loadError) {
    return (
      <main className="flex min-h-svh items-center justify-center bg-muted/30 p-4">
        <Toaster />
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle>Could not load redirects</CardTitle>
          </CardHeader>
          <CardContent>
            <div
              className="grid w-full grid-cols-[auto_1fr] gap-x-2 rounded-lg border bg-card px-2.5 py-2 text-left text-sm text-card-foreground"
              role="alert"
            >
              <ShieldCheckIcon className="row-span-2 mt-0.5 size-4" />
              <div className="font-medium">Redirects unavailable</div>
              <div className="text-sm text-balance text-muted-foreground md:text-pretty">
                {loadError}
              </div>
            </div>
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
              <CardTitle className="text-4xl md:text-5xl">Redirects</CardTitle>
              <p className="mt-2 text-sm text-muted-foreground">
                {redirects === null ? "Loading…" : `${redirects.length} total`}
              </p>
            </div>
            <Button
              variant="outline"
              onClick={() => {
                window.location.href = "/cdn-cgi/access/logout"
              }}
            >
              <LogOutIcon data-icon="inline-start" />
              Sign out
            </Button>
          </CardHeader>
        </Card>

        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
          <Card className="min-w-0">
            <CardHeader>
              <CardTitle>Rules</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              {redirects?.map((rule) => (
                <RedirectRow
                  disabled={saving}
                  key={rule.source}
                  rule={rule}
                  onRemove={() => removeRedirect(rule.source)}
                />
              ))}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Add redirect</CardTitle>
            </CardHeader>
            <CardContent>
              <form onSubmit={addRedirect}>
                <fieldset
                  className="flex flex-col gap-4 border-0 p-0"
                  disabled={redirects === null || saving}
                >
                  <div className="flex flex-col gap-5">
                    <label className="flex flex-col gap-2">
                      <span className="text-sm font-medium">Source</span>
                      <Input name="source" required placeholder="/new-link" />
                    </label>
                    <label className="flex flex-col gap-2">
                      <span className="text-sm font-medium">Destination</span>
                      <Input
                        name="destination"
                        required
                        placeholder="https://example.com"
                      />
                    </label>
                    <label className="flex flex-col gap-2">
                      <span className="text-sm font-medium">Code</span>
                      <select
                        className="h-8 w-full rounded-lg border border-input bg-background px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                        defaultValue="301"
                        name="code"
                      >
                        <option value="301">301 permanent</option>
                        <option value="302">302 temporary</option>
                      </select>
                    </label>
                  </div>
                  <Button type="submit">
                    <PlusIcon data-icon="inline-start" />
                    Add
                  </Button>
                </fieldset>
              </form>
            </CardContent>
          </Card>
        </div>
      </div>
    </main>
  )
}

function RedirectRow({
  disabled,
  rule,
  onRemove,
}: {
  disabled: boolean
  rule: Redirect
  onRemove: () => void
}) {
  return (
    <div className="grid min-w-0 gap-3 rounded-lg border bg-card p-3 md:grid-cols-[minmax(120px,0.65fr)_minmax(140px,1fr)_auto_auto] md:items-center">
      <div className="min-w-0 truncate font-medium">{rule.source}</div>
      <a
        className="grid min-w-0 grid-cols-[minmax(0,1fr)_1rem] items-center gap-2 text-sm text-muted-foreground"
        href={rule.destination}
        rel="noreferrer"
        target="_blank"
      >
        <span className="truncate">{rule.destination}</span>
        <ExternalLinkIcon className="size-4 shrink-0" data-icon="inline-end" />
      </a>
      <span className="inline-flex h-5 w-fit shrink-0 items-center justify-center rounded-4xl bg-secondary px-2 py-0.5 text-xs font-medium whitespace-nowrap text-secondary-foreground">
        {rule.code}
      </span>
      <Button
        disabled={disabled}
        variant="outline"
        size="sm"
        onClick={onRemove}
      >
        <Trash2Icon data-icon="inline-start" />
        Remove
      </Button>
    </div>
  )
}

export default App
