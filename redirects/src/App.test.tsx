import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import App from "./App"

type RedirectRule = {
  id?: string
  source: string
  destination: string
  code: 301 | 302
  active: boolean
}

type MockRedirectApi = {
  fetchMock: ReturnType<typeof vi.fn>
  lastPutRedirects: RedirectRule[] | null
  putRedirects: RedirectRule[][]
  resolveNextPut: () => void
}

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
    ...init,
  })
}

function mockRedirectApi(
  redirects: RedirectRule[],
  options: { holdPuts?: boolean; putStatus?: number; putBody?: unknown } = {}
): MockRedirectApi {
  const putResolvers: Array<() => void> = []
  const api: MockRedirectApi = {
    fetchMock: vi.fn(),
    lastPutRedirects: null,
    putRedirects: [],
    resolveNextPut: () => putResolvers.shift()?.(),
  }

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input.toString()

    if (url === "/api/redirects/status") {
      return jsonResponse({
        authenticated: true,
        user: { email: "shamus.ca01@gmail.com" },
      })
    }

    if (url === "/api/redirects" && init?.method === "PUT") {
      const body = JSON.parse(String(init.body || "{}")) as {
        redirects?: RedirectRule[]
      }
      api.lastPutRedirects = body.redirects || []
      api.putRedirects.push(api.lastPutRedirects)
      if (options.holdPuts) {
        await new Promise<void>((resolve) => putResolvers.push(resolve))
      }
      if (options.putStatus && options.putStatus >= 400) {
        return jsonResponse(
          options.putBody || { error: "Save failed" },
          { status: options.putStatus }
        )
      }
      return jsonResponse({ ok: true, redirects: api.lastPutRedirects })
    }

    if (url === "/api/redirects") {
      return jsonResponse(redirects)
    }

    return jsonResponse({ error: "not found" }, { status: 404 })
  })

  api.fetchMock = fetchMock
  vi.stubGlobal("fetch", fetchMock)
  vi.spyOn(crypto, "randomUUID").mockReturnValue(
    "00000000-0000-4000-8000-000000000000"
  )
  return api
}

describe("App", () => {
  it("adds a redirect rule", async () => {
    const user = userEvent.setup()
    mockRedirectApi([])

    render(<App />)

    await screen.findByText("Rules")
    expect(screen.queryByText("Redirect manager")).toBeNull()
    expect(
      screen.queryByText(/Protected by Cloudflare Access as/i)
    ).toBeNull()
    expect(screen.queryByText("Active rules")).toBeNull()
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull()
    expect(screen.queryByText("Autosaving...")).toBeNull()
    expect(screen.queryByText("Saved")).toBeNull()

    await user.type(screen.getByLabelText("Source"), "papers")
    await user.type(
      screen.getByLabelText("Destination"),
      "https://example.com/really/long/path/that/should/truncate/naturally"
    )
    await user.click(screen.getByRole("button", { name: "Add" }))

    expect(screen.getByText("/papers")).not.toBeNull()
    expect(
      screen.getByText(
        "https://example.com/really/long/path/that/should/truncate/naturally"
      )
    ).not.toBeNull()
    expect(screen.queryByText("Autosaving...")).toBeNull()
    expect(screen.queryByText("Saved")).toBeNull()
  })

  it("shows slash variants as one redirect rule", async () => {
    mockRedirectApi([
      {
        source: "/papers",
        destination: "https://example.com/papers",
        code: 301,
        active: true,
      },
      {
        source: "/papers/",
        destination: "https://example.com/papers",
        code: 301,
        active: true,
      },
    ])

    render(<App />)

    await screen.findByText("/papers")

    expect(screen.getAllByText("/papers")).toHaveLength(1)
    expect(screen.queryByText("/papers/")).toBeNull()
  })

  it("saves both slash variants when a single redirect is added", async () => {
    const user = userEvent.setup()
    const api = mockRedirectApi([])

    render(<App />)

    await screen.findByText("Rules")

    await user.type(screen.getByLabelText("Source"), "papers/")
    await user.type(
      screen.getByLabelText("Destination"),
      "https://example.com/papers"
    )
    await user.click(screen.getByRole("button", { name: "Add" }))

    await waitFor(() =>
      expect(api.lastPutRedirects?.map((rule) => rule.source)).toEqual([
        "/papers",
        "/papers/",
      ])
    )
    expect(api.lastPutRedirects?.map((rule) => rule.code)).toEqual([301, 301])
    expect(screen.queryByText("Autosaving...")).toBeNull()
    expect(screen.queryByText("Saved")).toBeNull()
  })

  it("removes a displayed redirect and saves both variants as removed", async () => {
    const user = userEvent.setup()
    const api = mockRedirectApi([
      {
        id: "old-rule",
        source: "/old",
        destination: "https://example.com/old",
        code: 301,
        active: true,
      },
      {
        id: "old-rule-slash",
        source: "/old/",
        destination: "https://example.com/old",
        code: 301,
        active: true,
      },
    ])

    render(<App />)

    await screen.findByText("/old")
    expect(screen.queryByText("/old/")).toBeNull()
    await user.click(screen.getByRole("button", { name: "Remove" }))

    await waitFor(() => expect(screen.queryByText("/old")).toBeNull())

    await waitFor(() => expect(api.lastPutRedirects).toEqual([]))
    expect(screen.queryByText("Autosaving...")).toBeNull()
    expect(screen.queryByText("Saved")).toBeNull()
  })

  it("sends remove immediately even when the previous add save is still pending", async () => {
    const user = userEvent.setup()
    const api = mockRedirectApi([], { holdPuts: true })

    render(<App />)

    await screen.findByText("Rules")
    await user.type(screen.getByLabelText("Source"), "temporary")
    await user.type(
      screen.getByLabelText("Destination"),
      "https://example.com/temporary"
    )
    await user.click(screen.getByRole("button", { name: "Add" }))

    await waitFor(() => expect(api.putRedirects).toHaveLength(1))
    await user.click(screen.getByRole("button", { name: "Remove" }))

    await waitFor(() => expect(api.putRedirects).toHaveLength(2))
    expect(api.putRedirects[0].map((rule) => rule.source)).toEqual([
      "/temporary",
      "/temporary/",
    ])
    expect(api.putRedirects[1]).toEqual([])

    api.resolveNextPut()
    api.resolveNextPut()
  })

  it("sends pause immediately even when the previous add save is still pending", async () => {
    const user = userEvent.setup()
    const api = mockRedirectApi([], { holdPuts: true })

    render(<App />)

    await screen.findByText("Rules")
    await user.type(screen.getByLabelText("Source"), "pausable")
    await user.type(
      screen.getByLabelText("Destination"),
      "https://example.com/pausable"
    )
    await user.click(screen.getByRole("button", { name: "Add" }))

    await waitFor(() => expect(api.putRedirects).toHaveLength(1))
    await user.click(screen.getByRole("button", { name: "Pause" }))

    await waitFor(() => expect(api.putRedirects).toHaveLength(2))
    expect(api.putRedirects[0].map((rule) => rule.active)).toEqual([
      true,
      true,
    ])
    expect(api.putRedirects[1].map((rule) => rule.active)).toEqual([
      false,
      false,
    ])

    api.resolveNextPut()
    api.resolveNextPut()
  })

  it("saves every pause and resume change", async () => {
    const user = userEvent.setup()
    const api = mockRedirectApi([
      {
        id: "rule",
        source: "/rule",
        destination: "https://example.com/rule",
        code: 301,
        active: true,
      },
    ])

    render(<App />)

    await screen.findByText("/rule")
    await user.click(screen.getByRole("button", { name: "Pause" }))
    await waitFor(() => expect(api.lastPutRedirects?.[0].active).toBe(false))

    await user.click(screen.getByRole("button", { name: "Resume" }))
    await waitFor(() => expect(api.lastPutRedirects?.[0].active).toBe(true))

    expect(api.putRedirects).toHaveLength(2)
  })

  it("shows an error only when saving fails", async () => {
    const user = userEvent.setup()
    mockRedirectApi([], {
      putStatus: 500,
      putBody: { error: "KV write failed" },
    })

    render(<App />)

    await screen.findByText("Rules")
    await user.type(screen.getByLabelText("Source"), "broken")
    await user.type(screen.getByLabelText("Destination"), "https://example.com/broken")
    await user.click(screen.getByRole("button", { name: "Add" }))

    expect(await screen.findByText("KV write failed")).not.toBeNull()
    expect(screen.queryByText("Autosaving...")).toBeNull()
    expect(screen.queryByText("Saved")).toBeNull()
  })
})
