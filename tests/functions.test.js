import { describe, expect, it, vi } from "vitest";

import { handleApi } from "../functions/_lib/api.js";
import {
  DEFAULT_REDIRECTS,
  findRedirect,
  getRedirects,
  saveRedirects,
} from "../functions/_lib/store.js";
import { onRequest } from "../functions/[[path]].js";

function createKv(initialEntries = {}) {
  const values = new Map(Object.entries(initialEntries));
  return {
    get: vi.fn(async (key, type) => {
      const value = values.get(key);
      if (value === undefined) return null;
      if (type === "json") return JSON.parse(value);
      return value;
    }),
    put: vi.fn(async (key, value) => {
      values.set(key, value);
    }),
    values,
  };
}

function createEnv(kv = createKv()) {
  return {
    REDIRECTS_KV: kv,
    ACCESS_TEAM_DOMAIN: "https://example.cloudflareaccess.com",
    ACCESS_AUD: "test-audience",
  };
}

function createContext(url, { env = createEnv(), method = "GET", body } = {}) {
  return {
    request: new Request(url, {
      method,
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: body === undefined ? undefined : { "content-type": "application/json" },
    }),
    env,
    next: vi.fn(async () => new Response("next", { status: 200 })),
  };
}

async function readJson(response) {
  return response.json();
}

describe("redirect store", () => {
  it("seeds KV with default redirects on first read", async () => {
    const kv = createKv();
    const env = createEnv(kv);

    const redirects = await getRedirects(env);

    expect(redirects).toEqual(DEFAULT_REDIRECTS);
    expect(kv.get).toHaveBeenCalledWith("redirects", "json");
    expect(kv.put).toHaveBeenCalledWith(
      "redirects",
      JSON.stringify(DEFAULT_REDIRECTS),
      undefined,
    );
  });

  it("reads saved redirects from KV instead of defaults", async () => {
    const saved = [
      {
        source: "/saved",
        destination: "https://example.com/saved",
        code: 302,
        active: true,
      },
    ];
    const kv = createKv({ redirects: JSON.stringify(saved) });

    await expect(getRedirects(createEnv(kv))).resolves.toEqual(saved);
    expect(kv.put).not.toHaveBeenCalled();
  });

  it("saves redirects to KV and resolves active matches only", async () => {
    const kv = createKv();
    const env = createEnv(kv);
    const redirects = [
      {
        source: "/active",
        destination: "https://example.com/active",
        code: 301,
        active: true,
      },
      {
        source: "/paused",
        destination: "https://example.com/paused",
        code: 301,
        active: false,
      },
    ];

    await saveRedirects(env, redirects);

    await expect(findRedirect(env, "/active")).resolves.toEqual(redirects[0]);
    await expect(findRedirect(env, "/paused")).resolves.toBeUndefined();
  });
});

describe("redirects API", () => {
  it("returns Access status for local preview requests", async () => {
    const response = await handleApi(createContext("http://localhost/api/redirects/status"));

    await expect(readJson(response)).resolves.toMatchObject({
      authenticated: true,
      user: { local: true },
    });
  });

  it("lists redirects from KV", async () => {
    const redirects = [
      {
        source: "/api-test",
        destination: "https://example.com/api-test",
        code: 301,
        active: true,
      },
    ];
    const env = createEnv(createKv({ redirects: JSON.stringify(redirects) }));

    const response = await handleApi(
      createContext("http://localhost/api/redirects", { env }),
    );

    expect(response.status).toBe(200);
    await expect(readJson(response)).resolves.toEqual(redirects);
  });

  it("validates and saves redirect updates", async () => {
    const kv = createKv();
    const redirects = [
      {
        source: "/new",
        destination: "https://example.com/new",
        code: 302,
        active: true,
      },
      {
        source: "/new/",
        destination: "https://example.com/new",
        code: 302,
        active: true,
      },
    ];

    const response = await handleApi(
      createContext("http://localhost/api/redirects", {
        env: createEnv(kv),
        method: "PUT",
        body: { redirects },
      }),
    );

    expect(response.status).toBe(200);
    await expect(readJson(response)).resolves.toEqual({ ok: true, redirects });
    expect(JSON.parse(kv.values.get("redirects"))).toEqual(redirects);
  });

  it("rejects invalid redirect updates before writing KV", async () => {
    const kv = createKv();

    const response = await handleApi(
      createContext("http://localhost/api/redirects", {
        env: createEnv(kv),
        method: "PUT",
        body: {
          redirects: [
            {
              source: "missing-leading-slash",
              destination: "https://example.com",
              code: 301,
              active: true,
            },
          ],
        },
      }),
    );

    expect(response.status).toBe(400);
    await expect(readJson(response)).resolves.toEqual({
      error: "Redirect sources must start with /",
    });
    expect(kv.put).not.toHaveBeenCalled();
  });
});

describe("Pages redirect function", () => {
  it("redirects active GET and HEAD requests from KV", async () => {
    const env = createEnv(
      createKv({
        redirects: JSON.stringify([
          {
            source: "/go",
            destination: "https://example.com/go",
            code: 301,
            active: true,
          },
          {
            source: "/go/",
            destination: "https://example.com/go",
            code: 301,
            active: true,
          },
        ]),
      }),
    );

    const getResponse = await onRequest(createContext("http://localhost/go", { env }));
    const headResponse = await onRequest(
      createContext("http://localhost/go/", { env, method: "HEAD" }),
    );

    expect(getResponse.status).toBe(301);
    expect(getResponse.headers.get("location")).toBe("https://example.com/go");
    expect(getResponse.headers.get("cache-control")).toBe("no-store");
    expect(headResponse.status).toBe(301);
    expect(headResponse.headers.get("location")).toBe("https://example.com/go");
    expect(headResponse.headers.get("cache-control")).toBe("no-store");
  });

  it("falls through when no active redirect matches", async () => {
    const context = createContext("http://localhost/missing", {
      env: createEnv(
        createKv({
          redirects: JSON.stringify([
            {
              source: "/paused",
              destination: "https://example.com/paused",
              code: 301,
              active: false,
            },
          ]),
        }),
      ),
    });

    const response = await onRequest(context);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("next");
    expect(context.next).toHaveBeenCalledOnce();
  });

  it("uses default redirects when the KV binding is unavailable", async () => {
    const response = await onRequest({
      ...createContext("http://localhost/4660-feedback"),
      env: {},
    });

    expect(response.status).toBe(301);
    expect(response.headers.get("location")).toBe(
      "https://forms.gle/hM4a3iq7VX1szfd86",
    );
  });
});
