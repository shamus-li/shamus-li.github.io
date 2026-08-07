import {
  canonicalSource,
  parseRedirects,
  type Redirect,
} from "../../redirects/redirect.ts"

const API_BASE = "https://api.cloudflare.com/client/v4"

export type RedirectEnv = {
  CLOUDFLARE_ACCOUNT_ID?: string
  CLOUDFLARE_API_TOKEN?: string
  REDIRECT_HOSTNAME?: string
  REDIRECT_LIST_NAME?: string
}

type Credentials = {
  accountId: string
  token: string
}

type Config = Credentials & {
  hostname: string
  listId: string
}

type CloudflareWriteItem = {
  redirect: {
    source_url: string
    target_url: string
    status_code?: number
    preserve_query_string: boolean
    preserve_path_suffix: boolean
    subpath_matching: boolean
    include_subdomains: boolean
  }
  comment?: string
}

export class HttpError extends Error {
  status: number

  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

export async function listRedirects(env: RedirectEnv): Promise<Redirect[]> {
  const config = await configFor(env)
  const redirects = new Map<string, Redirect>()

  for (const item of await readListItems(config)) {
    if (!isManagedItem(item, config.hostname)) continue

    const redirect = redirectFromItem(item, config.hostname)
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

export async function replaceRedirects(
  env: RedirectEnv,
  redirects: Redirect[]
): Promise<void> {
  const config = await configFor(env)
  const existingItems = await readListItems(config)
  const unmanagedItems = existingItems
    .filter((item) => !isManagedItem(item, config.hostname))
    .map(itemForWrite)
  const managedItems = redirects.flatMap((redirect) =>
    sourceVariants(redirect.source).map((source) =>
      itemFromRedirect({ ...redirect, source }, config.hostname)
    )
  )
  const { result } = await cloudflareRequest(
    config,
    `/rules/lists/${config.listId}/items`,
    { method: "PUT", body: [...unmanagedItems, ...managedItems] }
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
  await waitForOperation(config, result.operation_id)
}

async function configFor(env: RedirectEnv): Promise<Config> {
  const accountId = required(env.CLOUDFLARE_ACCOUNT_ID, "CLOUDFLARE_ACCOUNT_ID")
  const token = required(env.CLOUDFLARE_API_TOKEN, "CLOUDFLARE_API_TOKEN")
  const hostname = required(env.REDIRECT_HOSTNAME, "REDIRECT_HOSTNAME")
    .replace(/^https?:\/\//, "")
    .replace(/\/+$/, "")
  const listName = required(env.REDIRECT_LIST_NAME, "REDIRECT_LIST_NAME")
  const credentials = { accountId, token }
  const { result } = await cloudflareRequest(credentials, "/rules/lists")

  if (!Array.isArray(result)) {
    throw new HttpError(
      "Cloudflare returned an invalid redirect-list response",
      502
    )
  }
  const list = result.find(
    (value) =>
      isRecord(value) &&
      value.kind === "redirect" &&
      value.name === listName &&
      typeof value.id === "string"
  )
  if (!isRecord(list) || typeof list.id !== "string") {
    throw new HttpError(
      `Cloudflare Bulk Redirect List "${listName}" was not found`,
      500
    )
  }

  return { ...credentials, hostname, listId: list.id }
}

async function readListItems(config: Config): Promise<unknown[]> {
  const items: unknown[] = []
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
    items.push(...result)
    cursor = cursorAfter(resultInfo)
  } while (cursor)

  return items
}

async function waitForOperation(config: Config, operationId: string) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const { result } = await cloudflareRequest(
      config,
      `/rules/lists/bulk_operations/${operationId}`
    )
    if (!isRecord(result)) {
      throw new HttpError(
        "Cloudflare returned an invalid bulk-operation response",
        502
      )
    }
    if (result.status === "completed") return
    if (result.status === "failed") {
      throw new HttpError(
        typeof result.error === "string"
          ? result.error
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
  options: { method?: "GET" | "PUT"; body?: CloudflareWriteItem[] } = {}
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

function redirectFromItem(item: unknown, hostname: string): Redirect {
  const redirect = redirectRecord(item)
  if (
    !redirect ||
    typeof redirect.source_url !== "string" ||
    typeof redirect.target_url !== "string"
  ) {
    throw new HttpError("Cloudflare returned an invalid redirect item", 502)
  }

  try {
    return parseRedirects([
      {
        source: pathFromSourceUrl(redirect.source_url, hostname),
        destination: redirect.target_url,
        code: redirect.status_code ?? 301,
      },
    ])[0]!
  } catch (error) {
    throw new HttpError(
      error instanceof Error
        ? error.message
        : "Cloudflare returned an invalid redirect item",
      502
    )
  }
}

function itemForWrite(item: unknown): CloudflareWriteItem {
  const value = isRecord(item) ? item : null
  const redirect = redirectRecord(item)
  if (
    !value ||
    !redirect ||
    typeof redirect.source_url !== "string" ||
    typeof redirect.target_url !== "string"
  ) {
    throw new HttpError(
      "Cloudflare returned an invalid unmanaged redirect item",
      502
    )
  }
  const statusCode = redirect.status_code
  if (
    statusCode !== undefined &&
    (typeof statusCode !== "number" ||
      ![301, 302, 307, 308].includes(statusCode))
  ) {
    throw new HttpError(
      "Cloudflare returned an invalid unmanaged redirect status code",
      502
    )
  }

  return {
    redirect: {
      source_url: redirect.source_url,
      target_url: redirect.target_url,
      ...(typeof statusCode === "number" ? { status_code: statusCode } : {}),
      preserve_query_string: redirect.preserve_query_string === true,
      preserve_path_suffix: redirect.preserve_path_suffix === true,
      subpath_matching: redirect.subpath_matching === true,
      include_subdomains: redirect.include_subdomains === true,
    },
    ...(typeof value.comment === "string" ? { comment: value.comment } : {}),
  }
}

function itemFromRedirect(
  redirect: Redirect,
  hostname: string
): CloudflareWriteItem {
  return {
    redirect: {
      source_url: `${hostname}${redirect.source}`,
      target_url: redirect.destination,
      status_code: redirect.code,
      preserve_query_string: false,
      preserve_path_suffix: false,
      subpath_matching: false,
      include_subdomains: false,
    },
  }
}

function sourceVariants(source: string) {
  const canonical = canonicalSource(source)
  return canonical === "/" ? [canonical] : [canonical, `${canonical}/`]
}

function pathFromSourceUrl(sourceUrl: string, hostname: string) {
  const withoutScheme = sourceUrl.replace(/^https?:\/\//, "")
  if (withoutScheme === hostname) return "/"
  return withoutScheme.startsWith(`${hostname}/`)
    ? `/${withoutScheme.slice(hostname.length + 1)}`
    : `/${withoutScheme.replace(/^\/+/, "")}`
}

function isManagedItem(item: unknown, hostname: string) {
  const redirect = redirectRecord(item)
  if (!redirect || typeof redirect.source_url !== "string") return false
  const withoutScheme = redirect.source_url.replace(/^https?:\/\//, "")
  return withoutScheme === hostname || withoutScheme.startsWith(`${hostname}/`)
}

function redirectRecord(item: unknown): Record<string, unknown> | null {
  return isRecord(item) && isRecord(item.redirect) ? item.redirect : null
}

function cursorAfter(value: unknown) {
  if (!isRecord(value) || !isRecord(value.cursors)) return ""
  return typeof value.cursors.after === "string" ? value.cursors.after : ""
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
