import { listRedirects, replaceRedirects } from "./store.js";

export async function handleApi(context) {
  try {
    return await routeApi(context);
  } catch (err) {
    return error(err.message || "Request failed", err.status || 500);
  }
}

async function routeApi({ request, env }) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/redirects\/api\/?/, "");

  if (request.method === "GET" && path === "")
    return json(await listRedirects(env));

  if (request.method === "PUT" && path === "") {
    const body = await readJson(request);
    const redirects = validateRedirects(body.redirects);
    return json({ ok: true, redirects: await replaceRedirects(env, redirects) });
  }

  return error("Not found", 404);
}

function validateRedirects(redirects) {
  if (!Array.isArray(redirects))
    throw validationError("Redirects must be an array");
  return redirects.map((rule) => {
    const source = String(rule.source || "").trim();
    const destination = String(rule.destination || "").trim();
    const code = Number(rule.code);
    if (!source.startsWith("/"))
      throw validationError("Redirect sources must start with /");
    if (!/^https?:\/\//.test(destination))
      throw validationError("Redirect destinations must be absolute URLs");
    if (![301, 302].includes(code))
      throw validationError("Redirect code must be 301 or 302");
    return { source, destination, code };
  });
}

function validationError(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...(init.headers || {}),
    },
  });
}

function error(message, status = 400) {
  return json({ error: message }, { status });
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}
