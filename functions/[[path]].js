import { accessErrorResponse, requireAccess } from "./_lib/access.js";
import { handleApi } from "./_lib/api.js";
import { findRedirect } from "./_lib/store.js";

export async function onRequest(context) {
  const { request } = context;
  const url = new URL(request.url);

  if (url.pathname.startsWith("/api/redirects")) {
    return handleApi(context);
  }

  if (url.pathname === "/redirects" || url.pathname.startsWith("/redirects/")) {
    try {
      await requireAccess(context);
    } catch (err) {
      return accessErrorResponse(err, request);
    }
  }

  if (request.method === "GET" || request.method === "HEAD") {
    const rule = await findRedirect(context.env, url.pathname);
    if (rule) return Response.redirect(rule.destination, rule.code);
  }

  return context.next();
}
