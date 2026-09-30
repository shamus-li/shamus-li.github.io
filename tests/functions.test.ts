import { afterEach, describe, expect, it, vi } from "vitest"

import {
  onRequestDelete,
  onRequestGet,
  onRequestPost,
} from "../functions/redirects/api.ts"
import {
  deleteRedirect,
  listRedirects,
  saveRedirect,
  type RedirectEnv,
} from "../functions/_lib/cloudflare-redirects.ts"

const accountId = "account-id"
const list = { id: "list-id" }

type Call = {
  method: string
  path: string
  query: string
  body: unknown
}

type ListPage = {
  items: unknown[]
  after?: string
}

function env(overrides: Partial<RedirectEnv> = {}): RedirectEnv {
  return {
    CLOUDFLARE_ACCOUNT_ID: accountId,
    CLOUDFLARE_API_TOKEN: "token",
    REDIRECT_HOSTNAME: "shamus.li",
    REDIRECT_LIST_ID: list.id,
    ...overrides,
  }
}

function context(
  url: string,
  options: {
    body?: unknown
    method?: string
    env?: RedirectEnv
    rawBody?: string
  } = {}
) {
  const body =
    options.rawBody ??
    (options.body === undefined ? undefined : JSON.stringify(options.body))
  return {
    env: options.env ?? env(),
    request: new Request(url, {
      method: options.method ?? "GET",
      body,
      headers:
        body === undefined ? undefined : { "content-type": "application/json" },
    }),
  }
}

function mockCloudflare(
  options: {
    items?: unknown[]
    operationStatuses?: string[]
    pages?: Record<string, ListPage>
    missingOperationId?: boolean
    itemsFailure?: boolean
  } = {}
) {
  const {
    items = [],
    operationStatuses = ["completed"],
    pages,
    missingOperationId = false,
    itemsFailure = false,
  } = options
  const calls: Call[] = []
  let operationCalls = 0

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = new URL(String(input))
      const body: unknown = init.body
        ? JSON.parse(String(init.body))
        : undefined
      calls.push({
        method: init.method ?? "GET",
        path: url.pathname,
        query: url.searchParams.toString(),
        body,
      })

      if (url.pathname.endsWith(`/rules/lists/${list.id}/items`)) {
        if (init.method === "POST" || init.method === "DELETE") {
          return cf(missingOperationId ? {} : { operation_id: "operation-id" })
        }
        if (itemsFailure) return cfError("items lookup failed", 200)
        if (pages) {
          const cursor = url.searchParams.get("cursor") ?? ""
          const page = pages[cursor]
          if (!page) return cfError(`Page ${cursor} not mocked`, 404)
          return cf(page.items, {
            result_info: { cursors: { after: page.after ?? "" } },
          })
        }
        return cf(items, { result_info: { cursors: {} } })
      }
      if (url.pathname.endsWith("/rules/lists/bulk_operations/operation-id")) {
        const status =
          operationStatuses[
            Math.min(operationCalls, operationStatuses.length - 1)
          ] ?? "failed"
        operationCalls += 1
        return cf(
          status === "failed"
            ? { status, error: "bulk operation failed" }
            : { status }
        )
      }
      return cfError(`${init.method ?? "GET"} ${url.pathname} not mocked`, 404)
    })
  )
  return calls
}

function cf(result: unknown, extra: Record<string, unknown> = {}) {
  return json({ success: true, errors: [], messages: [], result, ...extra })
}

function cfError(message: string, status: number) {
  return json({ success: false, errors: [{ message }], messages: [] }, status)
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

afterEach(() => vi.unstubAllGlobals())

describe("Cloudflare redirect storage", () => {
  it("returns ID-free canonical redirects for the configured hostname", async () => {
    mockCloudflare({
      items: [
        {
          id: "plain",
          redirect: {
            source_url: "shamus.li/papers",
            target_url: "https://example.com/papers",
            status_code: 301,
          },
        },
        {
          id: "slash",
          redirect: {
            source_url: "shamus.li/papers/",
            target_url: "https://example.com/papers",
            status_code: 301,
          },
        },
        {
          id: "root",
          redirect: {
            source_url: "https://shamus.li",
            target_url: "https://example.com",
          },
        },
        {
          id: "other-host",
          redirect: {
            source_url: "example.com/papers",
            target_url: "https://example.com/papers",
            status_code: 301,
          },
        },
        { id: "missing-redirect" },
      ],
    })

    await expect(listRedirects(env())).resolves.toEqual([
      {
        source: "/papers",
        destination: "https://example.com/papers",
        code: 301,
      },
      { source: "/", destination: "https://example.com", code: 301 },
    ])
  })

  it("rejects conflicting stored slash variants", async () => {
    mockCloudflare({
      items: [
        {
          id: "first",
          redirect: {
            source_url: "shamus.li/papers",
            target_url: "https://example.com/first",
            status_code: 301,
          },
        },
        {
          id: "second",
          redirect: {
            source_url: "shamus.li/papers/",
            target_url: "https://example.com/second",
            status_code: 302,
          },
        },
      ],
    })

    await expect(listRedirects(env())).rejects.toMatchObject({
      message: "Conflicting stored redirects for /papers",
      status: 409,
    })
  })

  it("paginates through Cloudflare list items", async () => {
    const calls = mockCloudflare({
      pages: {
        "": {
          after: "next-page",
          items: [
            {
              id: "first",
              redirect: {
                source_url: "shamus.li/first",
                target_url: "https://example.com/first",
                status_code: 301,
              },
            },
          ],
        },
        "next-page": {
          items: [
            {
              id: "second",
              redirect: {
                source_url: "shamus.li/second",
                target_url: "https://example.com/second",
                status_code: 302,
              },
            },
          ],
        },
      },
    })

    await expect(listRedirects(env())).resolves.toHaveLength(2)
    expect(
      calls
        .filter((call) => call.path.endsWith(`/rules/lists/${list.id}/items`))
        .map((call) => call.query)
    ).toEqual(["per_page=500", "per_page=500&cursor=next-page"])
  })

  it("saves one redirect as its slash variants without reading or rewriting the list", async () => {
    const calls = mockCloudflare()

    await saveRedirect(env(), {
      source: "/papers",
      destination: "https://example.com/papers",
      code: 302,
    })

    expect(
      calls.filter((call) => call.path.endsWith(`/rules/lists/${list.id}/items`))
    ).toEqual([
      {
        method: "POST",
        path: `/client/v4/accounts/${accountId}/rules/lists/${list.id}/items`,
        query: "",
        body: [
          {
            redirect: expect.objectContaining({
              source_url: "shamus.li/papers",
              target_url: "https://example.com/papers",
              status_code: 302,
            }),
          },
          {
            redirect: expect.objectContaining({
              source_url: "shamus.li/papers/",
              target_url: "https://example.com/papers",
              status_code: 302,
            }),
          },
        ],
      },
    ])
  })

  it("deletes only the items for one canonical source", async () => {
    const calls = mockCloudflare({
      items: [
        {
          id: "plain",
          redirect: {
            source_url: "shamus.li/papers",
            target_url: "https://example.com/papers",
            status_code: 301,
          },
        },
        {
          id: "slash",
          redirect: {
            source_url: "https://shamus.li/papers/",
            target_url: "https://example.com/papers",
            status_code: 301,
          },
        },
        {
          id: "other-host",
          redirect: {
            source_url: "example.com/papers",
            target_url: "https://example.com/papers",
          },
        },
        {
          id: "other-source",
          redirect: {
            source_url: "shamus.li/kept",
            target_url: "https://example.com/kept",
            status_code: 301,
          },
        },
      ],
    })

    await deleteRedirect(env(), "/papers/")

    expect(calls.find((call) => call.method === "DELETE")?.body).toEqual({
      items: [{ id: "plain" }, { id: "slash" }],
    })
  })

  it("reports a missing redirect without deleting anything", async () => {
    const calls = mockCloudflare()

    await expect(deleteRedirect(env(), "/missing")).rejects.toMatchObject({
      message: "No redirect exists for /missing",
      status: 404,
    })
    expect(calls.some((call) => call.method === "DELETE")).toBe(false)
  })

  it("supports hostname values with a scheme and trailing slash", async () => {
    const calls = mockCloudflare()

    await saveRedirect(env({ REDIRECT_HOSTNAME: "https://shamus.li/" }), {
      source: "/",
      destination: "https://example.com",
      code: 302,
    })

    expect(calls.find((call) => call.method === "POST")?.body).toEqual([
      {
        redirect: expect.objectContaining({
          source_url: "shamus.li/",
          status_code: 302,
        }),
      },
    ])
  })

  it("requires the configured redirect list", async () => {
    await expect(
      listRedirects(env({ REDIRECT_LIST_ID: "" }))
    ).rejects.toThrow("REDIRECT_LIST_ID is not configured")
  })

  it("surfaces failed or invalid Cloudflare bulk operations", async () => {
    mockCloudflare({ operationStatuses: ["failed"] })
    await expect(
      saveRedirect(env(), {
        source: "/papers",
        destination: "https://example.com",
        code: 301,
      })
    ).rejects.toMatchObject({ message: "bulk operation failed", status: 502 })

    vi.unstubAllGlobals()
    mockCloudflare({ missingOperationId: true })
    await expect(
      saveRedirect(env(), {
        source: "/papers",
        destination: "https://example.com",
        code: 301,
      })
    ).rejects.toMatchObject({
      message: "Cloudflare redirect update did not return an operation_id",
      status: 502,
    })
  })
})

describe("redirects API", () => {
  it("lists canonical redirects", async () => {
    mockCloudflare({
      items: [
        {
          id: "api-item",
          redirect: {
            source_url: "shamus.li/api-test/",
            target_url: "https://example.com/api-test",
            status_code: 301,
          },
        },
      ],
    })

    const response = await onRequestGet(
      context("http://localhost/redirects/api")
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual([
      {
        source: "/api-test",
        destination: "https://example.com/api-test",
        code: 301,
      },
    ])
  })

  it("validates, canonicalizes, and saves one redirect", async () => {
    const calls = mockCloudflare()
    const response = await onRequestPost(
      context("http://localhost/redirects/api", {
        method: "POST",
        body: {
          source: "/new/",
          destination: "https://example.com/new",
          code: 301,
        },
      })
    )

    expect(response.status).toBe(204)
    expect(await response.text()).toBe("")
    expect(calls.find((call) => call.method === "POST")?.body).toEqual([
      expect.objectContaining({
        redirect: expect.objectContaining({ source_url: "shamus.li/new" }),
      }),
      expect.objectContaining({
        redirect: expect.objectContaining({ source_url: "shamus.li/new/" }),
      }),
    ])
  })

  it.each([
    [["not an object"], "Redirects must be objects"],
    [
      {
        source: "missing-leading-slash",
        destination: "https://example.com",
        code: 301,
      },
      "Redirect sources must start with /",
    ],
    [
      { source: "/relative-destination", destination: "/local", code: 301 },
      "Redirect destinations must be absolute HTTP(S) URLs",
    ],
    [
      { source: "/bad-code", destination: "https://example.com", code: "301" },
      "Redirect code must be 301 or 302",
    ],
  ])(
    "rejects invalid redirects before calling Cloudflare",
    async (body, message) => {
      const calls = mockCloudflare()
      const response = await onRequestPost(
        context("http://localhost/redirects/api", { method: "POST", body })
      )

      expect(response.status).toBe(400)
      await expect(response.json()).resolves.toEqual({ error: message })
      expect(calls).toHaveLength(0)
    }
  )

  it("deletes one redirect by source", async () => {
    const calls = mockCloudflare({
      items: [
        {
          id: "old",
          redirect: {
            source_url: "shamus.li/old",
            target_url: "https://example.com/old",
            status_code: 301,
          },
        },
      ],
    })
    const response = await onRequestDelete(
      context("http://localhost/redirects/api", {
        method: "DELETE",
        body: { source: "/old/" },
      })
    )

    expect(response.status).toBe(204)
    expect(calls.find((call) => call.method === "DELETE")?.body).toEqual({
      items: [{ id: "old" }],
    })
  })

  it("rejects a delete without a source path", async () => {
    const calls = mockCloudflare()
    const response = await onRequestDelete(
      context("http://localhost/redirects/api", {
        method: "DELETE",
        body: { source: "old" },
      })
    )

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({
      error: "Redirect sources must start with /",
    })
    expect(calls).toHaveLength(0)
  })

  it("rejects malformed JSON", async () => {
    const calls = mockCloudflare()
    const response = await onRequestPost(
      context("http://localhost/redirects/api", {
        method: "POST",
        rawBody: "{",
      })
    )

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({
      error: "Request body must be valid JSON",
    })
    expect(calls).toHaveLength(0)
  })

  it("returns configuration failures as API errors", async () => {
    const response = await onRequestGet(
      context("http://localhost/redirects/api", {
        env: env({ CLOUDFLARE_API_TOKEN: "" }),
      })
    )

    expect(response.status).toBe(500)
    await expect(response.json()).resolves.toEqual({
      error: "CLOUDFLARE_API_TOKEN is not configured",
    })
  })

  it("maps unsuccessful Cloudflare envelopes to an upstream error", async () => {
    mockCloudflare({ itemsFailure: true })

    const response = await onRequestGet(
      context("http://localhost/redirects/api")
    )

    expect(response.status).toBe(502)
    await expect(response.json()).resolves.toEqual({
      error: "items lookup failed",
    })
  })
})
