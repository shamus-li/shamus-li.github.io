import { afterEach, describe, expect, it, vi } from "vitest";

import { handleApi } from "../functions/_lib/api.js";
import { listRedirects, replaceRedirects } from "../functions/_lib/store.js";

const accountId = "account-id";
const list = { id: "list-id", name: "pages_to_custom_domain", kind: "redirect" };

function env(overrides = {}) {
  return {
    CLOUDFLARE_ACCOUNT_ID: accountId,
    CLOUDFLARE_API_TOKEN: "token",
    REDIRECT_HOSTNAME: "shamus.li",
    REDIRECT_LIST_NAME: list.name,
    ...overrides,
  };
}

function context(url, { body, method = "GET", env: nextEnv = env(), rawBody } = {}) {
  return {
    env: nextEnv,
    next: vi.fn(async () => new Response("next")),
    request: new Request(url, {
      method,
      body: rawBody ?? (body === undefined ? undefined : JSON.stringify(body)),
      headers: body === undefined ? undefined : { "content-type": "application/json" },
    }),
  };
}

function mockCloudflare({
  items = [],
  lists = [list],
  operationStatuses = ["completed"],
  pages,
} = {}) {
  const calls = [];
  let operationCalls = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input, init = {}) => {
      const url = new URL(String(input));
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({
        method: init.method || "GET",
        path: url.pathname,
        query: url.searchParams.toString(),
        body,
      });

      if (url.pathname.endsWith("/rules/lists")) return cf(lists);
      if (url.pathname.endsWith(`/rules/lists/${list.id}/items`)) {
        if (init.method === "PUT") return cf({ operation_id: "operation-id" });
        if (pages) {
          const cursor = url.searchParams.get("cursor") || "";
          return cf(pages[cursor].items, {
            result_info: { cursors: { after: pages[cursor].after || "" } },
          });
        }
        return cf(items, { result_info: { cursors: {} } });
      }
      if (url.pathname.endsWith("/rules/lists/bulk_operations/operation-id")) {
        const status = operationStatuses[Math.min(operationCalls, operationStatuses.length - 1)];
        operationCalls += 1;
        return cf(
          status === "failed"
            ? { status, error: "bulk operation failed" }
            : { status },
        );
      }
      return cfError(`${init.method || "GET"} ${url.pathname} not mocked`, 404);
    }),
  );
  return calls;
}

function cf(result, extra = {}) {
  return json({ success: true, errors: [], messages: [], result, ...extra });
}

function cfError(message, status) {
  return json({ success: false, errors: [{ message }], messages: [] }, status);
}

function json(body, status = 200) {
  const init = typeof status === "number" ? { status } : status;
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("redirect store", () => {
  it("reads only configured-hostname redirects from the Cloudflare list", async () => {
    mockCloudflare({
      items: [
      {
        id: "item-id",
        redirect: {
          source_url: "shamus.li/papers",
          target_url: "https://example.com/papers",
          status_code: 301,
        },
      },
      {
        id: "root-id",
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
      {
        id: "missing-redirect",
      },
    ],
    });

    await expect(listRedirects(env())).resolves.toEqual([
      {
        id: "item-id",
        source: "/papers",
        destination: "https://example.com/papers",
        code: 301,
      },
      {
        id: "root-id",
        source: "/",
        destination: "https://example.com",
        code: 301,
      },
    ]);
  });

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
    });

    await expect(listRedirects(env())).resolves.toEqual([
      {
        id: "first",
        source: "/first",
        destination: "https://example.com/first",
        code: 301,
      },
      {
        id: "second",
        source: "/second",
        destination: "https://example.com/second",
        code: 302,
      },
    ]);
    expect(
      calls
        .filter((call) => call.path.endsWith(`/rules/lists/${list.id}/items`))
        .map((call) => call.query),
    ).toEqual(["per_page=500", "per_page=500&cursor=next-page"]);
  });

  it("replaces the configured Cloudflare Bulk Redirect List", async () => {
    const calls = mockCloudflare();

    await replaceRedirects(env(), [
      { source: "/papers", destination: "https://example.com/papers", code: 301 },
    ]);

    expect(calls.find((call) => call.method === "PUT")?.body).toEqual([
      {
        redirect: expect.objectContaining({
          source_url: "shamus.li/papers",
          target_url: "https://example.com/papers",
          status_code: 301,
          preserve_query_string: false,
          preserve_path_suffix: false,
          subpath_matching: false,
          include_subdomains: false,
        }),
      },
    ]);
  });

  it("preserves list items outside the configured hostname", async () => {
    const calls = mockCloudflare({
      items: [
      {
        id: "github-pages-item",
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
        id: "managed-item",
        redirect: {
          source_url: "shamus.li/old",
          target_url: "https://example.com/old",
          status_code: 301,
        },
      },
    ],
    });

    await replaceRedirects(env(), [
      { source: "/papers", destination: "https://example.com/papers", code: 301 },
    ]);

    expect(calls.find((call) => call.method === "PUT")?.body).toEqual([
      {
        redirect: expect.objectContaining({
          source_url: "shamus-li.github.io/phd-survey-2026",
          target_url: "https://shamus.li/phd-survey-2026",
          preserve_query_string: true,
          preserve_path_suffix: true,
          subpath_matching: true,
          include_subdomains: true,
        }),
      },
      {
        redirect: expect.objectContaining({
          source_url: "shamus.li/papers",
          target_url: "https://example.com/papers",
        }),
      },
    ]);
  });

  it("supports hostname values with scheme and trailing slash", async () => {
    const calls = mockCloudflare();

    await replaceRedirects(
      env({ REDIRECT_HOSTNAME: "https://shamus.li/" }),
      [{ source: "papers", destination: "https://example.com/papers", code: 302 }],
    );

    expect(calls.find((call) => call.method === "PUT")?.body).toEqual([
      {
        redirect: expect.objectContaining({
          source_url: "shamus.li/papers",
          target_url: "https://example.com/papers",
          status_code: 302,
        }),
      },
    ]);
  });

  it("fails when the configured redirect list does not exist", async () => {
    mockCloudflare({ lists: [{ id: "other", name: "other", kind: "redirect" }] });

    await expect(listRedirects(env({ REDIRECT_LIST_NAME: "missing_list" }))).rejects.toThrow(
      'Cloudflare Bulk Redirect List "missing_list" was not found',
    );
  });

  it("requires the redirect list name to come from configuration", async () => {
    await expect(listRedirects(env({ REDIRECT_LIST_NAME: "" }))).rejects.toThrow(
      "REDIRECT_LIST_NAME is not configured",
    );
  });

  it("surfaces failed Cloudflare bulk operations", async () => {
    mockCloudflare({ operationStatuses: ["failed"] });

    await expect(
      replaceRedirects(env(), [
        { source: "/papers", destination: "https://example.com/papers", code: 301 },
      ]),
    ).rejects.toMatchObject({ message: "bulk operation failed", status: 502 });
  });
});

describe("redirects API", () => {
  it("lists redirects", async () => {
    mockCloudflare({
      items: [
      {
        id: "api-item",
        redirect: {
          source_url: "shamus.li/api-test",
          target_url: "https://example.com/api-test",
          status_code: 301,
        },
      },
    ],
    });

    const response = await handleApi(context("http://localhost/redirects/api"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual([
      {
        id: "api-item",
        source: "/api-test",
        destination: "https://example.com/api-test",
        code: 301,
      },
    ]);
  });

  it("validates and saves redirects", async () => {
    const calls = mockCloudflare();
    const redirects = [
      { source: "/new", destination: "https://example.com/new", code: 301 },
      { source: "/new/", destination: "https://example.com/new", code: 301 },
    ];

    const response = await handleApi(
      context("http://localhost/redirects/api", {
        method: "PUT",
        body: { redirects },
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, redirects });
    expect(calls.find((call) => call.method === "PUT")?.body).toHaveLength(2);
  });

  it.each([
    [
      { redirects: "not an array" },
      "Redirects must be an array",
    ],
    [
      {
        redirects: [
          { source: "missing-leading-slash", destination: "https://example.com", code: 301 },
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
      "Redirect destinations must be absolute URLs",
    ],
    [
      {
        redirects: [
          { source: "/bad-code", destination: "https://example.com", code: 307 },
        ],
      },
      "Redirect code must be 301 or 302",
    ],
  ])("rejects invalid redirects before calling Cloudflare", async (body, message) => {
    const calls = mockCloudflare();

    const response = await handleApi(
      context("http://localhost/redirects/api", {
        method: "PUT",
        body,
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: message });
    expect(calls).toHaveLength(0);
  });

  it("treats malformed JSON as an empty request body", async () => {
    const calls = mockCloudflare();

    const response = await handleApi(
      context("http://localhost/redirects/api", {
        method: "PUT",
        rawBody: "{",
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Redirects must be an array",
    });
    expect(calls).toHaveLength(0);
  });

  it("returns 404 for unsupported routes", async () => {
    const response = await handleApi(context("http://localhost/redirects/api/unknown"));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "Not found" });
  });

  it("returns configuration failures as API errors", async () => {
    const response = await handleApi(
      context("http://localhost/redirects/api", {
        env: env({ CLOUDFLARE_API_TOKEN: "" }),
      }),
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: "CLOUDFLARE_API_TOKEN is not configured",
    });
  });
});
