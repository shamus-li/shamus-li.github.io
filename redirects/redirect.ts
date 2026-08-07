export type RedirectCode = 301 | 302

export type Redirect = {
  source: string
  destination: string
  code: RedirectCode
}

export function canonicalSource(source: string) {
  const normalized = source.trim().replace(/^\/*/, "/")
  return normalized.length > 1 ? normalized.replace(/\/+$/, "") : normalized
}

export function parseRedirects(value: unknown): Redirect[] {
  if (!Array.isArray(value)) throw new Error("Redirects must be an array")

  const redirects = new Map<string, Redirect>()

  for (const valueRule of value) {
    if (!isRecord(valueRule)) throw new Error("Redirects must contain objects")

    const { source, destination, code } = valueRule
    if (typeof source !== "string" || !source.trim().startsWith("/")) {
      throw new Error("Redirect sources must start with /")
    }
    if (typeof destination !== "string" || !isHttpUrl(destination.trim())) {
      throw new Error("Redirect destinations must be absolute HTTP(S) URLs")
    }
    if (code !== 301 && code !== 302) {
      throw new Error("Redirect code must be 301 or 302")
    }

    const redirect: Redirect = {
      source: canonicalSource(source),
      destination: destination.trim(),
      code,
    }
    const existing = redirects.get(redirect.source)
    if (existing) {
      throw new Error(`Duplicate redirect source ${redirect.source}`)
    }
    redirects.set(redirect.source, redirect)
  }

  return [...redirects.values()]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function isHttpUrl(value: string) {
  try {
    const url = new URL(value)
    return url.protocol === "http:" || url.protocol === "https:"
  } catch {
    return false
  }
}
