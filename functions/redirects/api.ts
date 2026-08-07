import { parseRedirects } from "../../redirects/redirect.ts"
import {
  HttpError,
  listRedirects,
  replaceRedirects,
  type RedirectEnv,
} from "../_lib/cloudflare-redirects.ts"

type Context = {
  request: Request
  env: RedirectEnv
}

export function onRequestGet({ env }: Context) {
  return respond(async () => json(await listRedirects(env)))
}

export function onRequestPut({ request, env }: Context) {
  return respond(async () => {
    let body: unknown
    try {
      body = await request.json()
    } catch {
      throw new HttpError("Request body must be valid JSON", 400)
    }

    let redirects
    try {
      redirects = parseRedirects(isRecord(body) ? body.redirects : undefined)
    } catch (error) {
      throw new HttpError(
        error instanceof Error ? error.message : "Invalid redirects",
        400
      )
    }
    await replaceRedirects(env, redirects)

    return new Response(null, {
      status: 204,
      headers: { "cache-control": "no-store" },
    })
  })
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
