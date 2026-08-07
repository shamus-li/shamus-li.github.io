import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import type { Redirect } from "../redirect"
import App from "./App"

function json(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
    ...init,
  })
}

function mockApi(redirects: Redirect[], putStatus = 204, getStatus = 200) {
  const puts: Redirect[][] = []

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (input.toString() !== "/redirects/api") {
        return json({ error: "Not found" }, { status: 404 })
      }
      if (init?.method === "PUT") {
        const body = JSON.parse(String(init.body ?? "{}")) as {
          redirects?: Redirect[]
        }
        puts.push(body.redirects ?? [])
        return putStatus >= 400
          ? json({ error: "Redirect update failed" }, { status: putStatus })
          : new Response(null, { status: putStatus })
      }
      return getStatus >= 400
        ? json({ error: "Access denied" }, { status: getStatus })
        : json(redirects)
    })
  )
  return puts
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve
  })
  return { promise, resolve }
}

describe("App", () => {
  it("renders immediately but disables mutations until redirects load", async () => {
    const user = userEvent.setup()
    const initialGet = deferred<Response>()
    const fetch = vi.fn(async () => initialGet.promise)
    vi.stubGlobal("fetch", fetch)

    render(<App />)

    expect(screen.getByText("Redirects")).not.toBeNull()
    expect(screen.getByText("Loading…")).not.toBeNull()
    const add = screen.getByRole("button", { name: "Add" }) as HTMLButtonElement
    expect(add.matches(":disabled")).toBe(true)
    await user.click(add)
    expect(fetch).toHaveBeenCalledTimes(1)

    initialGet.resolve(json([]))
    await waitFor(() => expect(add.matches(":disabled")).toBe(false))
  })

  it("shows an accessible initial-load error", async () => {
    mockApi([], 204, 403)

    render(<App />)

    expect(await screen.findByRole("alert")).not.toBeNull()
    expect(screen.getByText("Could not load redirects")).not.toBeNull()
    expect(screen.getByText("Access denied")).not.toBeNull()
  })

  it("loads canonical redirects with their status codes and links", async () => {
    mockApi([
      {
        source: "/external",
        destination: "https://example.com/external",
        code: 302,
      },
    ])

    render(<App />)

    expect(await screen.findByText("/external")).not.toBeNull()
    expect(screen.getByText("302")).not.toBeNull()
    const link = screen.getByRole("link", {
      name: "https://example.com/external",
    })
    expect(link.getAttribute("href")).toBe("https://example.com/external")
    expect(link.getAttribute("target")).toBe("_blank")
    expect(link.getAttribute("rel")).toBe("noreferrer")
  })

  it("adds one canonical redirect and resets the form after saving", async () => {
    const user = userEvent.setup()
    const puts = mockApi([])

    render(<App />)
    await screen.findByText("0 total")
    const source = screen.getByLabelText("Source") as HTMLInputElement
    const destination = screen.getByLabelText("Destination") as HTMLInputElement
    const code = screen.getByLabelText("Code") as HTMLSelectElement
    await user.type(source, "papers///")
    await user.type(destination, "https://example.com/papers")
    await user.selectOptions(code, "302")
    await user.click(screen.getByRole("button", { name: "Add" }))

    expect(await screen.findByText("/papers")).not.toBeNull()
    expect(screen.queryByText("/papers/")).toBeNull()
    await waitFor(() =>
      expect(puts).toEqual([
        [
          {
            source: "/papers",
            destination: "https://example.com/papers",
            code: 302,
          },
        ],
      ])
    )
    expect(source.value).toBe("")
    expect(destination.value).toBe("")
    expect(code.value).toBe("301")
  })

  it("replaces an existing canonical source instead of duplicating it", async () => {
    const user = userEvent.setup()
    const puts = mockApi([
      { source: "/papers", destination: "https://example.com/old", code: 301 },
    ])

    render(<App />)
    await screen.findByText("/papers")
    await user.type(screen.getByLabelText("Source"), "papers/")
    await user.type(
      screen.getByLabelText("Destination"),
      "https://example.com/new"
    )
    await user.click(screen.getByRole("button", { name: "Add" }))

    await screen.findByText("https://example.com/new")
    expect(screen.getAllByText("/papers")).toHaveLength(1)
    expect(screen.queryByText("https://example.com/old")).toBeNull()
    expect(puts.at(-1)).toEqual([
      { source: "/papers", destination: "https://example.com/new", code: 301 },
    ])
  })

  it("removes a redirect by canonical source", async () => {
    const user = userEvent.setup()
    const puts = mockApi([
      { source: "/old", destination: "https://example.com/old", code: 301 },
    ])

    render(<App />)
    await screen.findByText("/old")
    await user.click(screen.getByRole("button", { name: "Remove" }))

    await waitFor(() => expect(screen.queryByText("/old")).toBeNull())
    expect(puts).toEqual([[]])
  })

  it("locks all mutations while a save is in flight", async () => {
    const user = userEvent.setup()
    const pendingPut = deferred<Response>()
    const puts: Redirect[][] = []
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === "PUT") {
          const body = JSON.parse(String(init.body)) as {
            redirects: Redirect[]
          }
          puts.push(body.redirects)
          return pendingPut.promise
        }
        return json([])
      })
    )

    render(<App />)
    await screen.findByText("0 total")
    await user.type(screen.getByLabelText("Source"), "pending")
    await user.type(
      screen.getByLabelText("Destination"),
      "https://example.com/pending"
    )
    await user.click(screen.getByRole("button", { name: "Add" }))

    await screen.findByText("/pending")
    const add = screen.getByRole("button", { name: "Add" }) as HTMLButtonElement
    const remove = screen.getByRole("button", {
      name: "Remove",
    }) as HTMLButtonElement
    expect(add.matches(":disabled")).toBe(true)
    expect(remove.matches(":disabled")).toBe(true)
    await user.click(remove)
    expect(puts).toHaveLength(1)

    pendingPut.resolve(new Response(null, { status: 204 }))
    await waitFor(() => expect(add.matches(":disabled")).toBe(false))
  })

  it("rolls back a failed save and preserves the form", async () => {
    const user = userEvent.setup()
    mockApi(
      [{ source: "/old", destination: "https://example.com/old", code: 301 }],
      500
    )

    render(<App />)
    await screen.findByText("/old")
    const source = screen.getByLabelText("Source") as HTMLInputElement
    const destination = screen.getByLabelText("Destination") as HTMLInputElement
    await user.type(source, "broken")
    await user.type(destination, "https://example.com/broken")
    await user.click(screen.getByRole("button", { name: "Add" }))

    expect(await screen.findByText("Redirect update failed")).not.toBeNull()
    await waitFor(() => expect(screen.queryByText("/broken")).toBeNull())
    expect(screen.getByText("/old")).not.toBeNull()
    expect(source.value).toBe("broken")
    expect(destination.value).toBe("https://example.com/broken")
  })

  it("rejects non-HTTP destinations without saving", async () => {
    const user = userEvent.setup()
    const puts = mockApi([])

    render(<App />)
    await screen.findByText("0 total")
    await user.type(screen.getByLabelText("Source"), "bad")
    await user.type(
      screen.getByLabelText("Destination"),
      "mailto:test@example.com"
    )
    await user.click(screen.getByRole("button", { name: "Add" }))

    expect(
      await screen.findByText("Destination must be an absolute HTTP(S) URL")
    ).not.toBeNull()
    expect(puts).toEqual([])
  })

  it("rejects a whitespace-only source without saving", async () => {
    const user = userEvent.setup()
    const puts = mockApi([])

    render(<App />)
    await screen.findByText("0 total")
    await user.type(screen.getByLabelText("Source"), "   ")
    await user.type(
      screen.getByLabelText("Destination"),
      "https://example.com/root"
    )
    await user.click(screen.getByRole("button", { name: "Add" }))

    expect(await screen.findByText("Source is required")).not.toBeNull()
    expect(puts).toEqual([])
  })
})
