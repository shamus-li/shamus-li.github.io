import path from "node:path"
import { fileURLToPath } from "node:url"

import tailwindcss from "@tailwindcss/vite"
import { defineConfig } from "vitest/config"

const repoRoot = path.dirname(fileURLToPath(import.meta.url))
const redirectsRoot = path.join(repoRoot, "redirects")

export default defineConfig({
  root: repoRoot,
  base: "/",
  publicDir: path.join(repoRoot, "public"),
  plugins: [tailwindcss()],
  build: {
    assetsDir: "redirects/assets",
    emptyOutDir: true,
    outDir: path.join(repoRoot, "dist"),
    rollupOptions: {
      input: path.join(redirectsRoot, "index.html"),
      onwarn(warning, warn) {
        if (
          warning.code === "MODULE_LEVEL_DIRECTIVE" &&
          warning.message.includes('"use client"')
        )
          return
        warn(warning)
      },
    },
  },
  resolve: {
    alias: {
      "@": path.join(redirectsRoot, "src"),
    },
  },
  test: {
    environment: "jsdom",
    include: ["redirects/src/**/*.test.{ts,tsx}"],
    setupFiles: path.join(redirectsRoot, "src/test/setup.ts"),
  },
})
