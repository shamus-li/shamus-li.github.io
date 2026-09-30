import { useEffect, useState } from "react"
import {
  CircleAlertIcon,
  LogOutIcon,
  PencilIcon,
  PlusIcon,
  Trash2Icon,
} from "lucide-react"
import { toast } from "sonner"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from "@/components/ui/item"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { Toaster } from "@/components/ui/sonner"
import {
  canonicalSource,
  parseRedirect,
  parseRedirects,
  type Redirect,
} from "../redirect"

type Draft = { source: string; destination: string; code: string }

// Rows sit flush inside one bordered list, separated by their bottom border.
const row = "rounded-none border-0 border-b border-border last:border-b-0"

// `original` is the source being edited, or null for a new redirect.
type Editing = { original: string | null; draft: Draft }

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
  const [editing, setEditing] = useState<Editing | null>(null)

  // Sends one change, then reloads so edits made elsewhere also show up.
  async function mutate(method: "POST" | "PUT" | "DELETE", body: unknown) {
    setSaving(true)
    try {
      await request({
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
      setRedirects(parseRedirects(await request()))
      return true
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Could not update redirects"
      )
      return false
    } finally {
      setSaving(false)
    }
  }

  async function save() {
    if (!editing || !redirects) return
    const { original, draft } = editing
    if (!draft.source.trim()) {
      toast.error("Source is required")
      return
    }

    let redirect: Redirect
    try {
      redirect = parseRedirect({
        source: canonicalSource(draft.source),
        destination: draft.destination,
        code: Number(draft.code),
      })
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Invalid redirect")
      return
    }
    if (
      redirect.source !== original &&
      redirects.some((rule) => rule.source === redirect.source)
    ) {
      toast.error(`A redirect for ${redirect.source} already exists`)
      return
    }

    const saved =
      original === null
        ? await mutate("POST", redirect)
        : await mutate("PUT", { source: original, redirect })
    if (saved) setEditing(null)
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

  const editRow = editing && (
    <EditRow
      key={editing.original ?? "new"}
      draft={editing.draft}
      saving={saving}
      onChange={(draft) => setEditing({ ...editing, draft })}
      onSave={() => void save()}
      onCancel={() => setEditing(null)}
    />
  )

  return (
    <main className="mx-auto flex min-h-svh max-w-5xl flex-col gap-6 px-4 py-10 md:px-8">
      <Toaster />
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Redirects</h1>
          {redirects && (
            <p className="text-sm text-muted-foreground">
              {redirects.length === 1
                ? "1 redirect"
                : `${redirects.length} redirects`}
            </p>
          )}
        </div>
        <div className="flex gap-2">
          <Button
            variant="ghost"
            onClick={() => {
              window.location.href = "/cdn-cgi/access/logout"
            }}
          >
            <LogOutIcon data-icon="inline-start" />
            Sign out
          </Button>
          <Button
            disabled={!redirects || editing !== null || saving}
            onClick={() =>
              setEditing({
                original: null,
                draft: { source: "", destination: "", code: "301" },
              })
            }
          >
            <PlusIcon data-icon="inline-start" />
            New redirect
          </Button>
        </div>
      </header>

      {loadError ? (
        <Alert variant="destructive">
          <CircleAlertIcon />
          <AlertTitle>Could not load redirects</AlertTitle>
          <AlertDescription>{loadError}</AlertDescription>
        </Alert>
      ) : (
        <ItemGroup className="gap-0 rounded-lg border">
          {editing?.original === null && editRow}
          {redirects === null ? (
            [0, 1, 2].map((index) => (
              <Item key={index} className={row} role="listitem">
                <ItemContent>
                  <Skeleton className="h-4 w-32" />
                  <Skeleton className="h-4 w-64 max-w-full" />
                </ItemContent>
              </Item>
            ))
          ) : redirects.length === 0 && !editing ? (
            <Item className={`${row} justify-center py-6 text-muted-foreground`}
              role="listitem">
              No redirects yet
            </Item>
          ) : (
            redirects.map((rule) =>
              editing?.original === rule.source ? (
                editRow
              ) : (
                <RuleRow
                  key={rule.source}
                  disabled={saving || editing !== null}
                  rule={rule}
                  onEdit={() =>
                    setEditing({
                      original: rule.source,
                      draft: {
                        source: rule.source,
                        destination: rule.destination,
                        code: String(rule.code),
                      },
                    })
                  }
                  onRemove={() =>
                    void mutate("DELETE", { source: rule.source })
                  }
                />
              )
            )
          )}
        </ItemGroup>
      )}
    </main>
  )
}

function RuleRow({
  disabled,
  rule,
  onEdit,
  onRemove,
}: {
  disabled: boolean
  rule: Redirect
  onEdit: () => void
  onRemove: () => void
}) {
  const [confirming, setConfirming] = useState(false)

  return (
    <Item className={`${row} flex-nowrap`} role="listitem">
      <ItemContent className="min-w-0">
        <ItemTitle className="max-w-full">
          <span className="truncate">{rule.source}</span>
          {/* On phones the code sits by the source to leave room for the destination. */}
          <Badge className="sm:hidden" variant="secondary">
            {rule.code}
          </Badge>
        </ItemTitle>
        <ItemDescription className="truncate [&>a]:no-underline">
          <a
            className="hover:text-foreground"
            href={rule.destination}
            rel="noreferrer"
            target="_blank"
          >
            {rule.destination}
          </a>
        </ItemDescription>
      </ItemContent>
      <ItemActions className="gap-1">
        <Badge className="mr-1 max-sm:hidden" variant="secondary">
          {rule.code}
        </Badge>
        <Button
          aria-label={`Edit ${rule.source}`}
          disabled={disabled}
          size="icon"
          variant="ghost"
          onClick={onEdit}
        >
          <PencilIcon />
        </Button>
        <Button
          aria-label={`${confirming ? "Confirm remove" : "Remove"} ${rule.source}`}
          disabled={disabled}
          className={confirming ? "" : "max-sm:size-8 max-sm:p-0"}
          variant={confirming ? "destructive" : "ghost"}
          onBlur={() => setConfirming(false)}
          onClick={() => (confirming ? onRemove() : setConfirming(true))}
        >
          <Trash2Icon data-icon="inline-start" />
          {/* Both labels share one grid cell so the button keeps its width.
              Trimming to cap height centers the text on the icon. Phones show
              only the icon until the button asks to confirm. */}
          <span
            className={`grid [&>span]:[text-box:trim-both_cap_alphabetic] ${confirming ? "" : "max-sm:hidden"}`}
          >
            <span className={`col-start-1 row-start-1 ${confirming ? "invisible" : ""}`}>
              Remove
            </span>
            <span className={`col-start-1 row-start-1 ${confirming ? "" : "invisible"}`}>
              Confirm
            </span>
          </span>
        </Button>
      </ItemActions>
    </Item>
  )
}

function EditRow({
  draft,
  saving,
  onChange,
  onSave,
  onCancel,
}: {
  draft: Draft
  saving: boolean
  onChange: (draft: Draft) => void
  onSave: () => void
  onCancel: () => void
}) {
  return (
    <Item asChild className={`${row} bg-muted/30`} role="listitem">
      <form
        onSubmit={(event) => {
          event.preventDefault()
          onSave()
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") onCancel()
        }}
      >
        <div className="grid w-full gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)_10rem]">
          <Input
            aria-label="Source"
            className="text-sm"
            autoFocus
            disabled={saving}
            placeholder="/new-link"
            value={draft.source}
            onChange={(event) =>
              onChange({ ...draft, source: event.target.value })
            }
          />
          <Input
            aria-label="Destination"
            className="text-sm"
            disabled={saving}
            placeholder="https://example.com"
            value={draft.destination}
            onChange={(event) =>
              onChange({ ...draft, destination: event.target.value })
            }
          />
          <Select
            disabled={saving}
            value={draft.code}
            onValueChange={(code) => onChange({ ...draft, code })}
          >
            <SelectTrigger aria-label="Code" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="301">301 Permanent</SelectItem>
              <SelectItem value="302">302 Temporary</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="flex w-full justify-end gap-1">
          <Button
            disabled={saving}
            type="button"
            variant="ghost"
            onClick={onCancel}
          >
            Cancel
          </Button>
          <Button disabled={saving} type="submit">
            Save
          </Button>
        </div>
      </form>
    </Item>
  )
}

export default App
