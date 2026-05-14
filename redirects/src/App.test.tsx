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

function mockApi(redirects: RedirectRule[], putStatus = 200) {
  const puts: RedirectRule[][] = []

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString()
      if (url === "/api/redirects" && init?.method === "PUT") {
        const body = JSON.parse(String(init.body || "{}"))
        puts.push(body.redirects || [])
        return putStatus >= 400
          ? json({ error: "Redirect update failed" }, { status: putStatus })
          : json({ ok: true, redirects: body.redirects || [] })
      }
      if (url === "/api/redirects") return json(redirects)
      return json({ error: "not found" }, { status: 404 })
    }),
  )
  vi.spyOn(crypto, "randomUUID").mockReturnValue(
    "00000000-0000-4000-8000-000000000000",
  )
  return puts
}

describe("App", () => {
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
})
