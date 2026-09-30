import { isRecord, parseRedirect } from "../../redirects/redirect.ts"
import {
  createRedirect,
  deleteRedirect,
  HttpError,
  listRedirects,
  updateRedirect,
  type RedirectEnv,
} from "../_lib/cloudflare-redirects.ts"

type Context = {
  request: Request
  env: RedirectEnv
}

export function onRequestGet({ env }: Context) {
  return respond(async () => json(await listRedirects(env)))
}

export function onRequestPost({ request, env }: Context) {
  return respond(async () => {
    await createRedirect(env, parseBody(await readJson(request)))
    return noContent()
  })
}

export function onRequestPut({ request, env }: Context) {
  return respond(async () => {
    const body = await readJson(request)
    const record = isRecord(body) ? body : {}
    await updateRedirect(env, parseSource(record.source), parseBody(record.redirect))
    return noContent()
  })
}

export function onRequestDelete({ request, env }: Context) {
  return respond(async () => {
    const body = await readJson(request)
    await deleteRedirect(env, parseSource(isRecord(body) ? body.source : undefined))
    return noContent()
  })
}

function parseBody(value: unknown) {
  try {
    return parseRedirect(value)
  } catch (error) {
    throw new HttpError(
      error instanceof Error ? error.message : "Invalid redirect",
      400
    )
  }
}

function parseSource(value: unknown) {
  if (typeof value !== "string" || !value.trim().startsWith("/")) {
    throw new HttpError("Redirect sources must start with /", 400)
  }
  return value
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json()
  } catch {
    throw new HttpError("Request body must be valid JSON", 400)
  }
}

async function respond(action: () => Promise<Response>) {
  try {
    return await action()
  } catch (error) {
    return json(
      { error: error instanceof Error ? error.message : "Request failed" },
      { status: error instanceof HttpError ? error.status : 500 }
    )
  }
}

function noContent() {
  return new Response(null, {
    status: 204,
    headers: { "cache-control": "no-store" },
  })
}

function json(data: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...init.headers,
    },
  })
}
