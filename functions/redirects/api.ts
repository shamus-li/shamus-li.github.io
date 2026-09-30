import { isRecord, parseRedirect } from "../../redirects/redirect.ts"
import {
  deleteRedirect,
  HttpError,
  listRedirects,
  saveRedirect,
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
    const body = await readJson(request)
    let redirect
    try {
      redirect = parseRedirect(body)
    } catch (error) {
      throw new HttpError(
        error instanceof Error ? error.message : "Invalid redirect",
        400
      )
    }
    await saveRedirect(env, redirect)
    return noContent()
  })
}

export function onRequestDelete({ request, env }: Context) {
  return respond(async () => {
    const body = await readJson(request)
    const source = isRecord(body) ? body.source : undefined
    if (typeof source !== "string" || !source.trim().startsWith("/")) {
      throw new HttpError("Redirect sources must start with /", 400)
    }
    await deleteRedirect(env, source)
    return noContent()
  })
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
