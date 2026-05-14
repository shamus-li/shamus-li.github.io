import { requireAccess } from "./access.js";
import { error, json, readJson } from "./http.js";
import { getRedirects, saveRedirects } from "./store.js";

export async function handleApi(context) {
  try {
    return await routeApi(context);
  } catch (err) {
    return error(err.message || "Request failed", err.status || 500);
  }
}

async function routeApi({ request, env }) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/api\/redirects\/?/, "");
  const user = await requireAccess({ request, env });

  if (request.method === "GET" && path === "status") {
    return json({
      authenticated: true,
      user,
    });
  }

  if (request.method === "GET" && path === "")
    return json(await getRedirects(env));

  if (request.method === "PUT" && path === "") {
    const body = await readJson(request);
    const redirects = validateRedirects(body.redirects);
    await saveRedirects(env, redirects);
    return json({ ok: true, redirects });
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
    return { source, destination, code, active: Boolean(rule.active) };
  });
}

function validationError(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}
