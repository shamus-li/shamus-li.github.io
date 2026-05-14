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

function context(url, { body, method = "GET", env: nextEnv = env() } = {}) {
  return {
    env: nextEnv,
    next: vi.fn(async () => new Response("next")),
    request: new Request(url, {
      method,
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: body === undefined ? undefined : { "content-type": "application/json" },
    }),
  };
}

function mockCloudflare(items = []) {
  const calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input, init = {}) => {
      const url = new URL(String(input));
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method: init.method || "GET", path: url.pathname, body });

      if (url.pathname.endsWith("/rules/lists")) return cf([list]);
      if (url.pathname.endsWith(`/rules/lists/${list.id}/items`)) {
        if (init.method === "PUT") return cf({ operation_id: "operation-id" });
        return cf(items, { result_info: { cursors: {} } });
      }
      if (url.pathname.endsWith("/rules/lists/bulk_operations/operation-id")) {
        return cf({ status: "completed" });
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
  it("reads redirects from the configured Cloudflare Bulk Redirect List", async () => {
    mockCloudflare([
      {
        id: "item-id",
        redirect: {
          source_url: "shamus.li/papers",
          target_url: "https://example.com/papers",
          status_code: 301,
        },
      },
    ]);

    await expect(listRedirects(env())).resolves.toEqual([
      {
        id: "item-id",
        source: "/papers",
        destination: "https://example.com/papers",
        code: 301,
      },
    ]);
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
        }),
      },
    ]);
  });

  it("preserves list items outside the configured hostname", async () => {
    const calls = mockCloudflare([
      {
        id: "github-pages-item",
        redirect: {
          source_url: "shamus-li.github.io/phd-survey-2026",
          target_url: "https://shamus.li/phd-survey-2026",
          status_code: 301,
          preserve_query_string: true,
        },
      },
    ]);

    await replaceRedirects(env(), [
      { source: "/papers", destination: "https://example.com/papers", code: 301 },
    ]);

    expect(calls.find((call) => call.method === "PUT")?.body).toEqual([
      {
        redirect: expect.objectContaining({
          source_url: "shamus-li.github.io/phd-survey-2026",
          target_url: "https://shamus.li/phd-survey-2026",
          preserve_query_string: true,
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
});

describe("redirects API", () => {
  it("lists redirects", async () => {
    mockCloudflare([
      {
        id: "api-item",
        redirect: {
          source_url: "shamus.li/api-test",
          target_url: "https://example.com/api-test",
          status_code: 301,
        },
      },
    ]);

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

  it("rejects invalid redirects before calling Cloudflare", async () => {
    const calls = mockCloudflare();

    const response = await handleApi(
      context("http://localhost/redirects/api", {
        method: "PUT",
        body: {
          redirects: [
            { source: "missing-leading-slash", destination: "https://example.com", code: 301 },
          ],
        },
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Redirect sources must start with /",
    });
    expect(calls).toHaveLength(0);
  });
});
