import { cp, mkdir, rm } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..")
const distRoot = join(repoRoot, "dist")

const paths = [
  "404.html",
  "fft",
  "index.html",
  "sitemap.xml",
  "static",
]

await mkdir(distRoot, { recursive: true })
await rm(join(distRoot, "_redirects"), { force: true })

await Promise.all(
  paths.map((path) =>
    cp(join(repoRoot, path), join(distRoot, path), {
      recursive: true,
      force: true,
    }),
  ),
)
