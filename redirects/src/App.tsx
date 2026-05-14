import { useEffect, useRef, useState } from "react"
import {
  ExternalLinkIcon,
  LogOutIcon,
  PlusIcon,
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
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
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

function canonicalSource(source: string) {
  const normalized = normalizeSource(source)
  return normalized.length > 1 ? normalized.replace(/\/+$/, "") : normalized
}

function sourceVariants(source: string) {
  const canonical = canonicalSource(source)
  return canonical === "/" ? [canonical] : [canonical, `${canonical}/`]
}

function collapseRedirects(rules: RedirectRule[]) {
  const bySource = new Map<string, RedirectRule>()
  for (const rule of rules) {
    bySource.set(canonicalSource(rule.source), rule)
  }

  return Array.from(bySource, ([source, rule]) => ({ ...rule, source }))
}

function redirectsForSave(rules: RedirectRule[]) {
  const redirects = new Map<string, RedirectRule>()

  for (const rule of rules) {
    for (const source of sourceVariants(rule.source)) {
      redirects.set(source, {
        source,
        destination: rule.destination,
        code: rule.code,
      })
    }
  }

  return Array.from(redirects.values())
}

function App() {
  const [loadState, setLoadState] = useState<LoadState>("loading")
  const [redirects, setRedirects] = useState<RedirectRule[]>([])
  const [source, setSource] = useState("")
  const [destination, setDestination] = useState("")
  const [code, setCode] = useState<"301" | "302">("301")
  const [accessError, setAccessError] = useState("")
  const redirectsRef = useRef<RedirectRule[]>([])

  function saveRedirects(nextRedirects: RedirectRule[]) {
    fetchJson("/redirects/api", {
      method: "PUT",
      body: JSON.stringify({ redirects: redirectsForSave(nextRedirects) }),
    }).catch((error: Error) => {
      toast.error(error.message)
    })
  }

  function commitRedirects(nextRedirects: RedirectRule[]) {
    redirectsRef.current = nextRedirects
    setRedirects(nextRedirects)
    saveRedirects(nextRedirects)
  }

  function addRedirect(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const nextSource = canonicalSource(source)
    const nextDestination = destination.trim()

    if (!/^https?:\/\//.test(nextDestination)) {
      toast.error("Destination must be an absolute URL")
      return
    }

    const nextRule = {
      id: crypto.randomUUID(),
      source: nextSource,
      destination: nextDestination,
      code: Number(code) as 301 | 302,
    }

    const currentRedirects = redirectsRef.current
    const existingIndex = currentRedirects.findIndex(
      (rule) => canonicalSource(rule.source) === nextSource
    )
    const nextRedirects =
      existingIndex === -1
        ? [...currentRedirects, nextRule]
        : currentRedirects.map((rule, index) =>
            index === existingIndex ? { ...nextRule, id: rule.id } : rule
          )

    commitRedirects(nextRedirects)
    setSource("")
    setDestination("")
    setCode("301")
  }

  function removeRule(id: string | undefined) {
    commitRedirects(redirectsRef.current.filter((rule) => rule.id !== id))
  }

  function logOut() {
    window.location.href = "/cdn-cgi/access/logout"
  }

  useEffect(() => {
    let cancelled = false

    async function loadInitialData() {
      try {
        const nextRedirects = await fetchJson<RedirectRule[]>("/redirects/api")
        if (cancelled) return
        const collapsedRedirects = collapseRedirects(nextRedirects).map(
          (rule, index) => ({
            id: rule.id || `${rule.source}-${index}`,
            ...rule,
          })
        )
        redirectsRef.current = collapsedRedirects
        setRedirects(collapsedRedirects)
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
            <CardTitle>Cloudflare Access required</CardTitle>
          </CardHeader>
          <CardContent>
            <Alert>
              <ShieldCheckIcon data-icon="inline-start" />
              <AlertTitle>Access did not pass through</AlertTitle>
              <AlertDescription>
                {accessError ||
                  "Protect /redirects* with a Cloudflare Access application."}
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
              <CardTitle className="text-4xl md:text-5xl">Redirects</CardTitle>
              <p className="mt-2 text-sm text-muted-foreground">
                {redirects.length} total
              </p>
            </div>
            <Button variant="outline" onClick={logOut}>
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
              {redirects.map((rule) => (
                <RedirectRow
                  key={rule.id}
                  rule={rule}
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
            </CardContent>
          </Card>
        </div>
      </div>
    </main>
  )
}

function RedirectRow({
  rule,
  onRemove,
}: {
  rule: RedirectRule
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
      <Badge variant="secondary">{rule.code}</Badge>
      <div className="flex gap-2">
        <Button variant="outline" size="sm" onClick={onRemove}>
          <Trash2Icon data-icon="inline-start" />
          Remove
        </Button>
      </div>
    </div>
  )
}

export default App
