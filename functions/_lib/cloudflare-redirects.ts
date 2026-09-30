import {
  canonicalSource,
  isRecord,
  parseRedirect,
  type Redirect,
} from "../../redirects/redirect.ts"

const API_BASE = "https://api.cloudflare.com/client/v4"

export type RedirectEnv = {
  CLOUDFLARE_ACCOUNT_ID?: string
  CLOUDFLARE_API_TOKEN?: string
  REDIRECT_HOSTNAME?: string
  REDIRECT_LIST_ID?: string
}

type Credentials = {
  accountId: string
  token: string
}

type Config = Credentials & {
  hostname: string
  listId: string
}

type ManagedItem = {
  id: string
  redirect: Redirect
}

export class HttpError extends Error {
  status: number

  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

export async function listRedirects(env: RedirectEnv): Promise<Redirect[]> {
  const config = configFor(env)
  const redirects = new Map<string, Redirect>()

  for (const { redirect } of await readManagedItems(config)) {
    const existing = redirects.get(redirect.source)
    if (
      existing &&
      (existing.destination !== redirect.destination ||
        existing.code !== redirect.code)
    ) {
      throw new HttpError(
        `Conflicting stored redirects for ${redirect.source}`,
        409
      )
    }
    redirects.set(redirect.source, redirect)
  }

  return [...redirects.values()]
}

export async function createRedirect(
  env: RedirectEnv,
  redirect: Redirect
): Promise<void> {
  const config = configFor(env)
  const items = await readManagedItems(config)
  rejectDuplicate(items, redirect.source)
  await addItems(config, redirect)
}

export async function updateRedirect(
  env: RedirectEnv,
  source: string,
  redirect: Redirect
): Promise<void> {
  const config = configFor(env)
  const items = await readManagedItems(config)
  const previous = itemsFor(items, source)
  if (redirect.source !== canonicalSource(source)) {
    rejectDuplicate(items, redirect.source)
  }
  // Adding list items replaces items with the same source URL. A renamed
  // redirect is added before the old one is deleted, so a failure between the
  // two steps never loses it.
  await addItems(config, redirect)
  if (redirect.source !== canonicalSource(source)) {
    await deleteItems(config, previous)
  }
}

export async function deleteRedirect(
  env: RedirectEnv,
  source: string
): Promise<void> {
  const config = configFor(env)
  await deleteItems(config, itemsFor(await readManagedItems(config), source))
}

function itemsFor(items: ManagedItem[], source: string) {
  const canonical = canonicalSource(source)
  const matches = items.filter((item) => item.redirect.source === canonical)
  if (!matches.length) {
    throw new HttpError(`No redirect exists for ${canonical}`, 404)
  }
  return matches
}

function rejectDuplicate(items: ManagedItem[], source: string) {
  if (items.some((item) => item.redirect.source === source)) {
    throw new HttpError(`A redirect for ${source} already exists`, 409)
  }
}

function addItems(config: Config, redirect: Redirect) {
  const sources =
    redirect.source === "/" ? ["/"] : [redirect.source, `${redirect.source}/`]
  return runOperation(
    config,
    "POST",
    sources.map((source) => ({
      redirect: {
        source_url: `${config.hostname}${source}`,
        target_url: redirect.destination,
        status_code: redirect.code,
        preserve_query_string: false,
        preserve_path_suffix: false,
        subpath_matching: false,
        include_subdomains: false,
      },
    }))
  )
}

function deleteItems(config: Config, items: ManagedItem[]) {
  return runOperation(config, "DELETE", {
    items: items.map(({ id }) => ({ id })),
  })
}

function configFor(env: RedirectEnv): Config {
  const accountId = required(env.CLOUDFLARE_ACCOUNT_ID, "CLOUDFLARE_ACCOUNT_ID")
  const token = required(env.CLOUDFLARE_API_TOKEN, "CLOUDFLARE_API_TOKEN")
  const hostname = required(env.REDIRECT_HOSTNAME, "REDIRECT_HOSTNAME")
    .replace(/^https?:\/\//, "")
    .replace(/\/+$/, "")
  const listId = required(env.REDIRECT_LIST_ID, "REDIRECT_LIST_ID")
  return { accountId, token, hostname, listId }
}

// Items for other hostnames share the list and are skipped.
async function readManagedItems(config: Config): Promise<ManagedItem[]> {
  const managed: ManagedItem[] = []
  let cursor = ""

  do {
    const query = new URLSearchParams({ per_page: "500" })
    if (cursor) query.set("cursor", cursor)
    const { result, resultInfo } = await cloudflareRequest(
      config,
      `/rules/lists/${config.listId}/items?${query}`
    )
    if (!Array.isArray(result)) {
      throw new HttpError(
        "Cloudflare returned invalid redirect-list items",
        502
      )
    }
    for (const item of result) {
      const redirect =
        isRecord(item) && isRecord(item.redirect) ? item.redirect : null
      const source =
        typeof redirect?.source_url === "string"
          ? managedSource(redirect.source_url, config.hostname)
          : null
      if (!redirect || source === null) continue
      if (typeof item.id !== "string") {
        throw new HttpError("Cloudflare returned a redirect item without an id", 502)
      }
      try {
        managed.push({
          id: item.id,
          redirect: parseRedirect({
            source,
            destination: redirect.target_url,
            code: redirect.status_code ?? 301,
          }),
        })
      } catch (error) {
        throw new HttpError(
          error instanceof Error
            ? error.message
            : "Cloudflare returned an invalid redirect item",
          502
        )
      }
    }
    cursor =
      isRecord(resultInfo) &&
      isRecord(resultInfo.cursors) &&
      typeof resultInfo.cursors.after === "string"
        ? resultInfo.cursors.after
        : ""
  } while (cursor)

  return managed
}

function managedSource(sourceUrl: string, hostname: string) {
  const withoutScheme = sourceUrl.replace(/^https?:\/\//, "")
  if (withoutScheme === hostname) return "/"
  return withoutScheme.startsWith(`${hostname}/`)
    ? withoutScheme.slice(hostname.length)
    : null
}

async function runOperation(
  config: Config,
  method: "POST" | "DELETE",
  body: unknown
) {
  const { result } = await cloudflareRequest(
    config,
    `/rules/lists/${config.listId}/items`,
    { method, body }
  )
  if (
    !isRecord(result) ||
    typeof result.operation_id !== "string" ||
    !result.operation_id
  ) {
    throw new HttpError(
      "Cloudflare redirect update did not return an operation_id",
      502
    )
  }

  for (let attempt = 0; attempt < 20; attempt += 1) {
    const { result: operation } = await cloudflareRequest(
      config,
      `/rules/lists/bulk_operations/${result.operation_id}`
    )
    if (!isRecord(operation)) {
      throw new HttpError(
        "Cloudflare returned an invalid bulk-operation response",
        502
      )
    }
    if (operation.status === "completed") return
    if (operation.status === "failed") {
      throw new HttpError(
        typeof operation.error === "string"
          ? operation.error
          : "Cloudflare redirect update failed",
        502
      )
    }
    await new Promise((resolve) => setTimeout(resolve, 300))
  }

  throw new HttpError("Cloudflare redirect update did not finish in time", 504)
}

async function cloudflareRequest(
  config: Credentials,
  path: string,
  options: { method?: "GET" | "POST" | "DELETE"; body?: unknown } = {}
) {
  const response = await fetch(
    `${API_BASE}/accounts/${config.accountId}${path}`,
    {
      method: options.method ?? "GET",
      headers: {
        authorization: `Bearer ${config.token}`,
        ...(options.body ? { "content-type": "application/json" } : {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
    }
  )
  const data: unknown = await response.json().catch(() => null)

  if (!isRecord(data)) {
    throw new HttpError(
      response.ok
        ? "Cloudflare returned an invalid response"
        : `${response.status} ${response.statusText}`,
      response.ok ? 502 : response.status
    )
  }
  if (!response.ok || data.success === false) {
    throw new HttpError(
      cloudflareError(data) || `${response.status} ${response.statusText}`,
      response.ok ? 502 : response.status
    )
  }

  return { result: data.result, resultInfo: data.result_info }
}

function cloudflareError(data: Record<string, unknown>) {
  if (!Array.isArray(data.errors)) return ""
  return data.errors
    .map((error) =>
      isRecord(error) && typeof error.message === "string" ? error.message : ""
    )
    .filter(Boolean)
    .join("; ")
}

function required(value: unknown, name: string): string {
  if (typeof value !== "string" || !value) {
    throw new HttpError(`${name} is not configured`, 500)
  }
  return value
}
