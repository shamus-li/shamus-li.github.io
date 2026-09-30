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
      const body = JSON.parse(String(init?.body))
      mutations.push({ method, body })
      if (mutationStatus >= 400) {
        return json(
          { error: "Redirect update failed" },
          { status: mutationStatus }
        )
      }
      if (method === "POST") stored.push(body)
      if (method === "PUT") {
        stored = stored.map((rule) =>
          rule.source === body.source ? body.redirect : rule
        )
      }
      if (method === "DELETE") {
        stored = stored.filter((rule) => rule.source !== body.source)
      }
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

const papers: Redirect = {
  source: "/papers",
  destination: "https://example.com/papers",
  code: 301,
}

async function startNew() {
  const user = userEvent.setup()
  await user.click(await screen.findByRole("button", { name: "New redirect" }))
  return user
}

async function fill(source: string, destination: string) {
  const user = userEvent.setup()
  const sourceInput = screen.getByLabelText("Source")
  const destinationInput = screen.getByLabelText("Destination")
  await user.clear(sourceInput)
  await user.type(sourceInput, source)
  await user.clear(destinationInput)
  await user.type(destinationInput, destination)
  return user
}

describe("App", () => {
  it("disables new redirects until the list loads", async () => {
    const initialGet = deferred<Response>()
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => initialGet.promise)
    )

    render(<App />)

    const add = screen.getByRole("button", { name: "New redirect" })
    expect(add.matches(":disabled")).toBe(true)

    initialGet.resolve(json([]))
    await waitFor(() => expect(add.matches(":disabled")).toBe(false))
    expect(screen.getByText("No redirects yet")).not.toBeNull()
  })

  it("shows an accessible initial-load error", async () => {
    mockApi([], { getStatus: 403 })

    render(<App />)

    expect(await screen.findByRole("alert")).not.toBeNull()
    expect(screen.getByText("Could not load redirects")).not.toBeNull()
    expect(screen.getByText("Access denied")).not.toBeNull()
  })

  it("lists redirects with their codes and destination links", async () => {
    mockApi([{ ...papers, code: 302 }])

    render(<App />)

    expect(await screen.findByText("/papers")).not.toBeNull()
    expect(screen.getAllByText("302").length).toBeGreaterThan(0)
    const link = screen.getByRole("link", { name: papers.destination })
    expect(link.getAttribute("href")).toBe(papers.destination)
    expect(link.getAttribute("target")).toBe("_blank")
    expect(link.getAttribute("rel")).toBe("noreferrer")
  })

  it("creates a redirect from a new row in the list", async () => {
    const { mutations } = mockApi([])

    render(<App />)
    await startNew()
    const user = await fill("papers///", papers.destination)
    await user.click(screen.getByRole("combobox", { name: "Code" }))
    await user.click(await screen.findByRole("option", { name: "302 Temporary" }))
    await user.click(screen.getByRole("button", { name: "Save" }))

    expect(await screen.findByText("/papers")).not.toBeNull()
    expect(screen.queryByLabelText("Source")).toBeNull()
    expect(mutations).toEqual([
      { method: "POST", body: { ...papers, code: 302 } },
    ])
  })

  it("refuses to create a duplicate source", async () => {
    const { mutations } = mockApi([papers])

    render(<App />)
    await startNew()
    const user = await fill("papers/", "https://example.com/other")
    await user.keyboard("{Enter}")

    expect(
      await screen.findByText("A redirect for /papers already exists")
    ).not.toBeNull()
    expect(mutations).toEqual([])
    expect(
      (screen.getByLabelText("Source") as HTMLInputElement).value
    ).toBe("papers/")
  })

  it("edits a redirect inline", async () => {
    const { mutations } = mockApi([papers])

    render(<App />)
    const user = userEvent.setup()
    await user.click(await screen.findByRole("button", { name: "Edit /papers" }))
    expect(
      (screen.getByLabelText("Source") as HTMLInputElement).value
    ).toBe("/papers")
    await fill("/papers", "https://example.com/new")
    await user.keyboard("{Enter}")

    expect(await screen.findByText("https://example.com/new")).not.toBeNull()
    expect(mutations).toEqual([
      {
        method: "PUT",
        body: {
          source: "/papers",
          redirect: { ...papers, destination: "https://example.com/new" },
        },
      },
    ])
  })

  it("refuses to rename a redirect onto another source", async () => {
    const { mutations } = mockApi([
      papers,
      { source: "/taken", destination: "https://example.com/taken", code: 301 },
    ])

    render(<App />)
    const user = userEvent.setup()
    await user.click(await screen.findByRole("button", { name: "Edit /papers" }))
    await fill("/taken", papers.destination)
    await user.keyboard("{Enter}")

    expect(
      await screen.findByText("A redirect for /taken already exists")
    ).not.toBeNull()
    expect(mutations).toEqual([])
  })

  it("cancels editing with Escape", async () => {
    const { mutations } = mockApi([papers])

    render(<App />)
    const user = userEvent.setup()
    await user.click(await screen.findByRole("button", { name: "Edit /papers" }))
    await user.type(screen.getByLabelText("Destination"), "/changed")
    await user.keyboard("{Escape}")

    expect(screen.queryByLabelText("Destination")).toBeNull()
    expect(screen.getByText(papers.destination)).not.toBeNull()
    expect(mutations).toEqual([])
  })

  it("deletes a redirect only after the inline confirmation", async () => {
    const confirm = vi.spyOn(window, "confirm")
    const { mutations } = mockApi([papers])

    render(<App />)
    const user = userEvent.setup()
    await user.click(await screen.findByRole("button", { name: "Remove /papers" }))
    expect(mutations).toEqual([])

    await user.click(
      screen.getByRole("button", { name: "Confirm remove /papers" })
    )

    await waitFor(() => expect(screen.queryByText("/papers")).toBeNull())
    expect(mutations).toEqual([
      { method: "DELETE", body: { source: "/papers" } },
    ])
    expect(confirm).not.toHaveBeenCalled()
  })

  it("cancels the inline confirmation when focus leaves the button", async () => {
    const { mutations } = mockApi([papers])

    render(<App />)
    const user = userEvent.setup()
    await user.click(await screen.findByRole("button", { name: "Remove /papers" }))
    await user.tab()

    expect(screen.getByRole("button", { name: "Remove /papers" })).not.toBeNull()
    expect(mutations).toEqual([])
  })

  it("shows redirects changed elsewhere after saving", async () => {
    const api = mockApi([])

    render(<App />)
    await startNew()
    api.addElsewhere({
      source: "/elsewhere",
      destination: "https://example.com/elsewhere",
      code: 301,
    })
    const user = await fill("mine", "https://example.com/mine")
    await user.keyboard("{Enter}")

    expect(await screen.findByText("/elsewhere")).not.toBeNull()
    expect(screen.getByText("/mine")).not.toBeNull()
  })

  it("locks every action while a save is in flight", async () => {
    const pendingPost = deferred<Response>()
    const posts: unknown[] = []
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === "POST") {
          posts.push(JSON.parse(String(init.body)))
          return pendingPost.promise
        }
        return json([papers])
      })
    )

    render(<App />)
    await startNew()
    const user = await fill("pending", "https://example.com/pending")
    await user.keyboard("{Enter}")

    const save = screen.getByRole("button", { name: "Save" })
    const edit = screen.getByRole("button", { name: "Edit /papers" })
    expect(save.matches(":disabled")).toBe(true)
    expect(edit.matches(":disabled")).toBe(true)
    await user.click(save)
    expect(posts).toHaveLength(1)

    pendingPost.resolve(new Response(null, { status: 204 }))
    await waitFor(() => expect(screen.queryByLabelText("Source")).toBeNull())
  })

  it("keeps the row open with its values when a save fails", async () => {
    mockApi([papers], { mutationStatus: 500 })

    render(<App />)
    await startNew()
    const user = await fill("broken", "https://example.com/broken")
    await user.keyboard("{Enter}")

    expect(await screen.findByText("Redirect update failed")).not.toBeNull()
    expect(
      (screen.getByLabelText("Source") as HTMLInputElement).value
    ).toBe("broken")
    expect(screen.queryByText("/broken")).toBeNull()
  })

  it.each([
    ["bad", "mailto:test@example.com", "Redirect destinations must be absolute HTTP(S) URLs"],
    ["   ", "https://example.com/root", "Source is required"],
  ])(
    "rejects source %j and destination %j without saving",
    async (source, destination, message) => {
      const { mutations } = mockApi([])

      render(<App />)
      await startNew()
      const user = await fill(source, destination)
      await user.keyboard("{Enter}")

      expect(await screen.findByText(message)).not.toBeNull()
      expect(mutations).toEqual([])
    }
  )
})
