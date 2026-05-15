import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import App from "./App"

type RedirectRule = {
  source: string
  destination: string
  code: 301 | 302
}

function json(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
    ...init,
  })
}

function mockApi(redirects: RedirectRule[], putStatus = 200, getStatus = 200) {
  const puts: RedirectRule[][] = []

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString()
      if (url === "/redirects/api" && init?.method === "PUT") {
        const body = JSON.parse(String(init.body || "{}"))
        puts.push(body.redirects || [])
        return putStatus >= 400
          ? json({ error: "Redirect update failed" }, { status: putStatus })
          : json({ ok: true, redirects: body.redirects || [] })
      }
      if (url === "/redirects/api") {
        return getStatus >= 400
          ? json({ error: "Access denied" }, { status: getStatus })
          : json(redirects)
      }
      return json({ error: "not found" }, { status: 404 })
    }),
  )
  vi.spyOn(crypto, "randomUUID").mockReturnValue(
    "00000000-0000-4000-8000-000000000000",
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
  it("shows an access error when initial loading fails", async () => {
    mockApi([], 200, 403)

    render(<App />)

    expect(await screen.findByText("Cloudflare Access required")).not.toBeNull()
    expect(screen.getByText("Access denied")).not.toBeNull()
  })

  it("adds one displayed redirect and saves both slash variants", async () => {
    const user = userEvent.setup()
    const puts = mockApi([])

    render(<App />)
    await screen.findByText("Rules")
    await user.type(screen.getByLabelText("Source"), "papers/")
    await user.type(screen.getByLabelText("Destination"), "https://example.com/papers")
    await user.click(screen.getByRole("button", { name: "Add" }))

    expect(screen.getByText("/papers")).not.toBeNull()
    await waitFor(() =>
      expect(puts.at(-1)?.map((rule) => rule.source)).toEqual(["/papers", "/papers/"]),
    )
  })

  it("keeps existing redirects when adding a new one", async () => {
    const user = userEvent.setup()
    const puts = mockApi([
      { source: "/old", destination: "https://example.com/old", code: 301 },
    ])

    render(<App />)
    await screen.findByText("/old")
    await user.type(screen.getByLabelText("Source"), "new")
    await user.type(screen.getByLabelText("Destination"), "https://example.com/new")
    await user.click(screen.getByRole("button", { name: "Add" }))

    await waitFor(() =>
      expect(puts.at(-1)).toEqual([
        { source: "/old", destination: "https://example.com/old", code: 301 },
        { source: "/old/", destination: "https://example.com/old", code: 301 },
        { source: "/new", destination: "https://example.com/new", code: 301 },
        { source: "/new/", destination: "https://example.com/new", code: 301 },
      ]),
    )
  })

  it("normalizes repeated trailing slashes and clears the form", async () => {
    const user = userEvent.setup()
    const puts = mockApi([])

    render(<App />)
    await screen.findByText("Rules")
    await user.type(screen.getByLabelText("Source"), "papers///")
    await user.type(screen.getByLabelText("Destination"), "https://example.com/papers")
    await user.click(screen.getByRole("button", { name: "Add" }))

    expect(screen.getByText("/papers")).not.toBeNull()
    expect(screen.queryByText("/papers/")).toBeNull()
    expect(screen.getByLabelText("Source")).toHaveProperty("value", "")
    expect(screen.getByLabelText("Destination")).toHaveProperty("value", "")
    await waitFor(() =>
      expect(puts.at(-1)?.map((rule) => rule.source)).toEqual(["/papers", "/papers/"]),
    )
  })

  it("replaces an existing canonical source instead of duplicating it", async () => {
    const user = userEvent.setup()
    const puts = mockApi([
      { source: "/papers", destination: "https://example.com/old", code: 301 },
      { source: "/papers/", destination: "https://example.com/old", code: 301 },
    ])

    render(<App />)
    await screen.findByText("/papers")
    await user.type(screen.getByLabelText("Source"), "papers/")
    await user.type(screen.getByLabelText("Destination"), "https://example.com/new")
    await user.click(screen.getByRole("button", { name: "Add" }))

    expect(screen.getAllByText("/papers")).toHaveLength(1)
    expect(screen.queryByText("https://example.com/old")).toBeNull()
    expect(screen.getByText("https://example.com/new")).not.toBeNull()
    await waitFor(() =>
      expect(puts.at(-1)).toEqual([
        { source: "/papers", destination: "https://example.com/new", code: 301 },
        { source: "/papers/", destination: "https://example.com/new", code: 301 },
      ]),
    )
  })

  it("collapses slash variants and removes both", async () => {
    const user = userEvent.setup()
    const puts = mockApi([
      { source: "/old", destination: "https://example.com/old", code: 301 },
      { source: "/old/", destination: "https://example.com/old", code: 301 },
    ])

    render(<App />)
    await screen.findByText("/old")
    expect(screen.queryByText("/old/")).toBeNull()

    await user.click(screen.getByRole("button", { name: "Remove" }))

    await waitFor(() => expect(screen.queryByText("/old")).toBeNull())
    expect(puts.at(-1)).toEqual([])
  })

  it("preserves API-provided status codes when autosaving another change", async () => {
    const user = userEvent.setup()
    const puts = mockApi([
      { source: "/temporary", destination: "https://example.com/temporary", code: 302 },
    ])

    render(<App />)
    await screen.findByText("/temporary")
    expect(screen.getByText("302")).not.toBeNull()

    await user.type(screen.getByLabelText("Source"), "permanent")
    await user.type(screen.getByLabelText("Destination"), "https://example.com/permanent")
    await user.click(screen.getByRole("button", { name: "Add" }))

    await waitFor(() =>
      expect(puts.at(-1)).toContainEqual({
        source: "/temporary",
        destination: "https://example.com/temporary",
        code: 302,
      }),
    )
  })

  it("sends remove immediately after an add", async () => {
    const user = userEvent.setup()
    const puts = mockApi([])

    render(<App />)
    await screen.findByText("Rules")
    await user.type(screen.getByLabelText("Source"), "temporary")
    await user.type(screen.getByLabelText("Destination"), "https://example.com/temporary")
    await user.click(screen.getByRole("button", { name: "Add" }))
    await waitFor(() => expect(puts).toHaveLength(1))

    await user.click(screen.getByRole("button", { name: "Remove" }))

    await waitFor(() => expect(puts).toHaveLength(2))
    expect(puts[1]).toEqual([])
  })

  it("serializes autosaves so later edits cannot be overwritten", async () => {
    const user = userEvent.setup()
    const firstPut = deferred<Response>()
    const calls: RedirectRule[][] = []

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (input.toString() === "/redirects/api" && init?.method === "PUT") {
          calls.push(JSON.parse(String(init.body || "{}")).redirects || [])
          if (calls.length === 1) return firstPut.promise
          return json({ ok: true, redirects: calls.at(-1) })
        }
        return json([])
      }),
    )
    vi.spyOn(crypto, "randomUUID").mockReturnValue(
      "00000000-0000-4000-8000-000000000000",
    )

    render(<App />)
    await screen.findByText("Rules")
    await user.type(screen.getByLabelText("Source"), "temporary")
    await user.type(screen.getByLabelText("Destination"), "https://example.com/temporary")
    await user.click(screen.getByRole("button", { name: "Add" }))
    await waitFor(() => expect(calls).toHaveLength(1))

    await user.click(screen.getByRole("button", { name: "Remove" }))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(calls).toHaveLength(1)

    firstPut.resolve(json({ ok: true, redirects: calls[0] }))
    await waitFor(() => expect(calls).toHaveLength(2))
    expect(calls[1]).toEqual([])
  })

  it("does not save relative destinations", async () => {
    const user = userEvent.setup()
    const puts = mockApi([])

    render(<App />)
    await screen.findByText("Rules")
    await user.type(screen.getByLabelText("Source"), "bad")
    await user.type(screen.getByLabelText("Destination"), "/relative")
    await user.click(screen.getByRole("button", { name: "Add" }))

    expect(await screen.findByText("Destination must be an absolute URL")).not.toBeNull()
    expect(puts).toEqual([])
  })

  it("shows save failures without save status text", async () => {
    const user = userEvent.setup()
    mockApi([], 500)

    render(<App />)
    await screen.findByText("Rules")
    await user.type(screen.getByLabelText("Source"), "broken")
    await user.type(screen.getByLabelText("Destination"), "https://example.com/broken")
    await user.click(screen.getByRole("button", { name: "Add" }))

    expect(await screen.findByText("Redirect update failed")).not.toBeNull()
    expect(screen.queryByText("Saved")).toBeNull()
  })

  it("renders destination links as external links", async () => {
    mockApi([
      { source: "/external", destination: "https://example.com/external", code: 301 },
    ])

    render(<App />)
    const link = await screen.findByRole("link", {
      name: "https://example.com/external",
    })

    expect(link.getAttribute("href")).toBe("https://example.com/external")
    expect(link.getAttribute("target")).toBe("_blank")
    expect(link.getAttribute("rel")).toBe("noreferrer")
  })
})
