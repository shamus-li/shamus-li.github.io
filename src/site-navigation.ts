import { mountPortrait } from "./portrait-light-field"

// Moving between the home and work pages swaps their content in place. Some
// browsers, such as Arc, paint their own white background between documents,
// which shows as a flash on this dark site.
const routes = new Set(["/", "/work/"])
const pages = new Map<string, Promise<Document>>()
let latest = 0

// The initial page is kept as parsed, before the portrait changes it.
pages.set(
  location.pathname,
  Promise.resolve(
    new DOMParser().parseFromString(
      document.documentElement.outerHTML,
      "text/html"
    )
  )
)
let unmount = location.pathname === "/" ? mountPortrait() : () => {}

function load(path: string) {
  let page = pages.get(path)
  if (!page) {
    page = fetch(path)
      .then((response) => {
        if (!response.ok) throw new Error(`${path} failed: ${response.status}`)
        return response.text()
      })
      .then((html) => new DOMParser().parseFromString(html, "text/html"))
    page.catch(() => pages.delete(path))
    pages.set(path, page)
  }
  return page
}

async function show(path: string, push: boolean) {
  const navigation = ++latest
  let page: Document
  try {
    page = await load(path)
  } catch {
    location.assign(path)
    return
  }
  const body = document.importNode(page.body, true)
  // Decode the new page's images first so it appears complete.
  await Promise.all(
    Array.from(body.querySelectorAll("img"), (image) =>
      image.decode().catch(() => undefined)
    )
  )
  if (navigation !== latest) return

  unmount()
  document.title = page.title
  document.documentElement.className = page.documentElement.className
  document.body.replaceWith(body)
  if (push) history.pushState(null, "", path)
  window.scrollTo(0, 0)
  unmount = path === "/" ? mountPortrait() : () => {}
}

function routeLink(target: EventTarget | null) {
  const link = target instanceof Element ? target.closest("a") : null
  return link &&
    !link.target &&
    link.origin === location.origin &&
    routes.has(link.pathname)
    ? link
    : null
}

document.addEventListener("pointerover", (event) => {
  const link = routeLink(event.target)
  if (link) void load(link.pathname).catch(() => undefined)
})

document.addEventListener("click", (event) => {
  const link = routeLink(event.target)
  if (
    !link ||
    event.defaultPrevented ||
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey
  )
    return
  event.preventDefault()
  if (link.pathname !== location.pathname) void show(link.pathname, true)
})

window.addEventListener("popstate", () => {
  if (routes.has(location.pathname)) void show(location.pathname, false)
})
