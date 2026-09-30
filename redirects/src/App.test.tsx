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

type Mutation = { method: string; body: unknown }

// A fake API that stores redirects, so reloads reflect saved changes.
function mockApi(
  initial: Redirect[],
  { mutationStatus = 204, getStatus = 200 } = {}
) {
  let stored = [...initial]
  const mutations: Mutation[] = []

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (input.toString() !== "/redirects/api") {
        return json({ error: "Not found" }, { status: 404 })
      }
      const method = init?.method ?? "GET"
      if (method === "GET") {
        return getStatus >= 400
          ? json({ error: "Access denied" }, { status: getStatus })
          : json(stored)
      }
      const body: unknown = JSON.parse(String(init?.body))
      mutations.push({ method, body })
      if (mutationStatus >= 400) {
        return json(
          { error: "Redirect update failed" },
          { status: mutationStatus }
        )
      }
      const redirect = body as Redirect
      stored = stored.filter((rule) => rule.source !== redirect.source)
      if (method === "POST") stored.push(redirect)
      return new Response(null, { status: 204 })
    })
  )
  return {
    mutations,
    addElsewhere: (redirect: Redirect) => stored.push(redirect),
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve
  })
  return { promise, resolve }
}

async function fillForm(source: string, destination: string) {
  const user = userEvent.setup()
  await user.type(screen.getByLabelText("Source"), source)
  await user.type(screen.getByLabelText("Destination"), destination)
  await user.click(screen.getByRole("button", { name: "Add" }))
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
    mockApi([], { getStatus: 403 })

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

  it("saves one canonical redirect and resets the form", async () => {
    const user = userEvent.setup()
    const { mutations } = mockApi([])

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
    expect(mutations).toEqual([
      {
        method: "POST",
        body: {
          source: "/papers",
          destination: "https://example.com/papers",
          code: 302,
        },
      },
    ])
    expect(source.value).toBe("")
    expect(destination.value).toBe("")
    expect(code.value).toBe("301")
  })

  it("shows redirects changed elsewhere after saving", async () => {
    const api = mockApi([])

    render(<App />)
    await screen.findByText("0 total")
    api.addElsewhere({
      source: "/elsewhere",
      destination: "https://example.com/elsewhere",
      code: 301,
    })
    await fillForm("mine", "https://example.com/mine")

    expect(await screen.findByText("/elsewhere")).not.toBeNull()
    expect(screen.getByText("/mine")).not.toBeNull()
  })

  it("asks before replacing an existing source", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true)
    const { mutations } = mockApi([
      { source: "/papers", destination: "https://example.com/old", code: 301 },
    ])

    render(<App />)
    await screen.findByText("/papers")
    await fillForm("papers/", "https://example.com/new")

    await screen.findByText("https://example.com/new")
    expect(confirm).toHaveBeenCalledWith(
      "Replace the redirect for /papers? It currently goes to https://example.com/old."
    )
    expect(screen.getAllByText("/papers")).toHaveLength(1)
    expect(mutations).toEqual([
      {
        method: "POST",
        body: {
          source: "/papers",
          destination: "https://example.com/new",
          code: 301,
        },
      },
    ])
  })

  it("keeps the existing redirect and the form when replacing is cancelled", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(false)
    const { mutations } = mockApi([
      { source: "/papers", destination: "https://example.com/old", code: 301 },
    ])

    render(<App />)
    await screen.findByText("/papers")
    await fillForm("papers", "https://example.com/new")

    expect(mutations).toEqual([])
    expect(screen.getByText("https://example.com/old")).not.toBeNull()
    expect((screen.getByLabelText("Source") as HTMLInputElement).value).toBe(
      "papers"
    )
  })

  it("asks before deleting a redirect", async () => {
    const user = userEvent.setup()
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true)
    const { mutations } = mockApi([
      { source: "/old", destination: "https://example.com/old", code: 301 },
    ])

    render(<App />)
    await screen.findByText("/old")
    await user.click(screen.getByRole("button", { name: "Remove" }))

    await waitFor(() => expect(screen.queryByText("/old")).toBeNull())
    expect(confirm).toHaveBeenCalledWith("Delete the redirect for /old?")
    expect(mutations).toEqual([{ method: "DELETE", body: { source: "/old" } }])
  })

  it("keeps a redirect when deleting is cancelled", async () => {
    const user = userEvent.setup()
    vi.spyOn(window, "confirm").mockReturnValue(false)
    const { mutations } = mockApi([
      { source: "/old", destination: "https://example.com/old", code: 301 },
    ])

    render(<App />)
    await screen.findByText("/old")
    await user.click(screen.getByRole("button", { name: "Remove" }))

    expect(mutations).toEqual([])
    expect(screen.getByText("/old")).not.toBeNull()
  })

  it("locks all mutations while a save is in flight", async () => {
    const user = userEvent.setup()
    const pendingPost = deferred<Response>()
    const posts: unknown[] = []
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === "POST") {
          posts.push(JSON.parse(String(init.body)))
          return pendingPost.promise
        }
        return json([
          { source: "/old", destination: "https://example.com/old", code: 301 },
        ])
      })
    )

    render(<App />)
    await screen.findByText("/old")
    await fillForm("pending", "https://example.com/pending")

    const add = screen.getByRole("button", { name: "Add" }) as HTMLButtonElement
    const remove = screen.getByRole("button", {
      name: "Remove",
    }) as HTMLButtonElement
    expect(add.matches(":disabled")).toBe(true)
    expect(remove.matches(":disabled")).toBe(true)
    await user.click(remove)
    expect(posts).toHaveLength(1)

    pendingPost.resolve(new Response(null, { status: 204 }))
    await waitFor(() => expect(add.matches(":disabled")).toBe(false))
  })

  it("keeps the list and the form when a save fails", async () => {
    mockApi(
      [{ source: "/old", destination: "https://example.com/old", code: 301 }],
      { mutationStatus: 500 }
    )

    render(<App />)
    await screen.findByText("/old")
    await fillForm("broken", "https://example.com/broken")

    expect(await screen.findByText("Redirect update failed")).not.toBeNull()
    expect(screen.queryByText("/broken")).toBeNull()
    expect(screen.getByText("/old")).not.toBeNull()
    expect((screen.getByLabelText("Source") as HTMLInputElement).value).toBe(
      "broken"
    )
  })

  it("rejects non-HTTP destinations without saving", async () => {
    const { mutations } = mockApi([])

    render(<App />)
    await screen.findByText("0 total")
    await fillForm("bad", "mailto:test@example.com")

    expect(
      await screen.findByText(
        "Redirect destinations must be absolute HTTP(S) URLs"
      )
    ).not.toBeNull()
    expect(mutations).toEqual([])
  })

  it("rejects a whitespace-only source without saving", async () => {
    const { mutations } = mockApi([])

    render(<App />)
    await screen.findByText("0 total")
    await fillForm("   ", "https://example.com/root")

    expect(await screen.findByText("Source is required")).not.toBeNull()
    expect(mutations).toEqual([])
  })
})
