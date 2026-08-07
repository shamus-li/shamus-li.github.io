import { afterEach, describe, expect, it, vi } from "vitest"

import { onRequestGet, onRequestPut } from "../functions/redirects/api.ts"
import {
  listRedirects,
  replaceRedirects,
  type RedirectEnv,
} from "../functions/_lib/cloudflare-redirects.ts"

const accountId = "account-id"
const list = { id: "list-id", name: "pages_to_custom_domain", kind: "redirect" }

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
    REDIRECT_LIST_NAME: list.name,
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
    lists?: unknown[]
    operationStatuses?: string[]
    pages?: Record<string, ListPage>
    missingOperationId?: boolean
    listFailure?: boolean
  } = {}
) {
  const {
    items = [],
    lists = [list],
    operationStatuses = ["completed"],
    pages,
    missingOperationId = false,
    listFailure = false,
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

      if (url.pathname.endsWith("/rules/lists")) {
        return listFailure ? cfError("list lookup failed", 200) : cf(lists)
      }
      if (url.pathname.endsWith(`/rules/lists/${list.id}/items`)) {
        if (init.method === "PUT") {
          return cf(missingOperationId ? {} : { operation_id: "operation-id" })
        }
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
          redirect: {
            source_url: "shamus.li/papers",
            target_url: "https://example.com/first",
            status_code: 301,
          },
        },
        {
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

  it("expands canonical redirects and preserves unmanaged list items", async () => {
    const calls = mockCloudflare({
      items: [
        {
          comment: "keep me",
          redirect: {
            source_url: "shamus-li.github.io/phd-survey-2026",
            target_url: "https://shamus.li/phd-survey-2026",
            status_code: 301,
            preserve_query_string: true,
            preserve_path_suffix: true,
            subpath_matching: true,
            include_subdomains: true,
          },
        },
        {
          comment: "no explicit status",
          redirect: {
            source_url: "example.com/no-status",
            target_url: "https://example.com/preserved",
          },
        },
        {
          redirect: {
            source_url: "shamus.li/old",
            target_url: "https://example.com/old",
            status_code: 301,
          },
        },
      ],
    })

    await replaceRedirects(env(), [
      {
        source: "/papers",
        destination: "https://example.com/papers",
        code: 301,
      },
    ])

    expect(calls.find((call) => call.method === "PUT")?.body).toEqual([
      {
        comment: "keep me",
        redirect: {
          source_url: "shamus-li.github.io/phd-survey-2026",
          target_url: "https://shamus.li/phd-survey-2026",
          status_code: 301,
          preserve_query_string: true,
          preserve_path_suffix: true,
          subpath_matching: true,
          include_subdomains: true,
        },
      },
      {
        comment: "no explicit status",
        redirect: {
          source_url: "example.com/no-status",
          target_url: "https://example.com/preserved",
          preserve_query_string: false,
          preserve_path_suffix: false,
          subpath_matching: false,
          include_subdomains: false,
        },
      },
      {
        redirect: expect.objectContaining({
          source_url: "shamus.li/papers",
          target_url: "https://example.com/papers",
        }),
      },
      {
        redirect: expect.objectContaining({
          source_url: "shamus.li/papers/",
          target_url: "https://example.com/papers",
        }),
      },
    ])
  })

  it("rejects invalid unmanaged status codes before replacing the list", async () => {
    const calls = mockCloudflare({
      items: [
        {
          redirect: {
            source_url: "example.com/invalid",
            target_url: "https://example.com/invalid",
            status_code: 303,
          },
        },
      ],
    })

    await expect(replaceRedirects(env(), [])).rejects.toMatchObject({
      message: "Cloudflare returned an invalid unmanaged redirect status code",
      status: 502,
    })
    expect(calls.some((call) => call.method === "PUT")).toBe(false)
  })

  it("supports hostname values with a scheme and trailing slash", async () => {
    const calls = mockCloudflare()

    await replaceRedirects(env({ REDIRECT_HOSTNAME: "https://shamus.li/" }), [
      { source: "/", destination: "https://example.com", code: 302 },
    ])

    expect(calls.find((call) => call.method === "PUT")?.body).toEqual([
      {
        redirect: expect.objectContaining({
          source_url: "shamus.li/",
          status_code: 302,
        }),
      },
    ])
  })

  it("requires the configured redirect list", async () => {
    mockCloudflare({
      lists: [{ id: "other", name: "other", kind: "redirect" }],
    })

    await expect(
      listRedirects(env({ REDIRECT_LIST_NAME: "missing_list" }))
    ).rejects.toThrow(
      'Cloudflare Bulk Redirect List "missing_list" was not found'
    )
    await expect(
      listRedirects(env({ REDIRECT_LIST_NAME: "" }))
    ).rejects.toThrow("REDIRECT_LIST_NAME is not configured")
  })

  it("surfaces failed or invalid Cloudflare bulk operations", async () => {
    mockCloudflare({ operationStatuses: ["failed"] })
    await expect(
      replaceRedirects(env(), [
        { source: "/papers", destination: "https://example.com", code: 301 },
      ])
    ).rejects.toMatchObject({ message: "bulk operation failed", status: 502 })

    vi.unstubAllGlobals()
    mockCloudflare({ missingOperationId: true })
    await expect(
      replaceRedirects(env(), [
        { source: "/papers", destination: "https://example.com", code: 301 },
      ])
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

  it("validates, canonicalizes, and saves redirects", async () => {
    const calls = mockCloudflare()
    const response = await onRequestPut(
      context("http://localhost/redirects/api", {
        method: "PUT",
        body: {
          redirects: [
            {
              source: "/new/",
              destination: "https://example.com/new",
              code: 301,
            },
          ],
        },
      })
    )

    expect(response.status).toBe(204)
    expect(await response.text()).toBe("")
    expect(calls.find((call) => call.method === "PUT")?.body).toEqual([
      expect.objectContaining({
        redirect: expect.objectContaining({ source_url: "shamus.li/new" }),
      }),
      expect.objectContaining({
        redirect: expect.objectContaining({ source_url: "shamus.li/new/" }),
      }),
    ])
  })

  it.each([
    [{ redirects: "not an array" }, "Redirects must be an array"],
    [
      {
        redirects: [
          {
            source: "missing-leading-slash",
            destination: "https://example.com",
            code: 301,
          },
        ],
      },
      "Redirect sources must start with /",
    ],
    [
      {
        redirects: [
          { source: "/relative-destination", destination: "/local", code: 301 },
        ],
      },
      "Redirect destinations must be absolute HTTP(S) URLs",
    ],
    [
      {
        redirects: [
          {
            source: "/bad-code",
            destination: "https://example.com",
            code: "301",
          },
        ],
      },
      "Redirect code must be 301 or 302",
    ],
    [
      {
        redirects: [
          {
            source: "/same",
            destination: "https://example.com/one",
            code: 301,
          },
          {
            source: "/same/",
            destination: "https://example.com/two",
            code: 301,
          },
        ],
      },
      "Duplicate redirect source /same",
    ],
    [
      {
        redirects: [
          {
            source: "/identical",
            destination: "https://example.com/same",
            code: 301,
          },
          {
            source: "/identical/",
            destination: "https://example.com/same",
            code: 301,
          },
        ],
      },
      "Duplicate redirect source /identical",
    ],
  ])(
    "rejects invalid redirects before calling Cloudflare",
    async (body, message) => {
      const calls = mockCloudflare()
      const response = await onRequestPut(
        context("http://localhost/redirects/api", { method: "PUT", body })
      )

      expect(response.status).toBe(400)
      await expect(response.json()).resolves.toEqual({ error: message })
      expect(calls).toHaveLength(0)
    }
  )

  it("rejects malformed JSON", async () => {
    const calls = mockCloudflare()
    const response = await onRequestPut(
      context("http://localhost/redirects/api", {
        method: "PUT",
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
    mockCloudflare({ listFailure: true })

    const response = await onRequestGet(
      context("http://localhost/redirects/api")
    )

    expect(response.status).toBe(502)
    await expect(response.json()).resolves.toEqual({
      error: "list lookup failed",
    })
  })
})
