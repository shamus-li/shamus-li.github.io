import path from "node:path"

import tailwindcss from "@tailwindcss/vite"
import { defineConfig } from "vitest/config"

const repoRoot = import.meta.dirname
const redirectsRoot = path.join(repoRoot, "redirects")
const redirectsSource = path.join(redirectsRoot, "src")

export default defineConfig({
  plugins: [tailwindcss()],
  resolve: {
    alias: { "@": redirectsSource },
  },
  build: {
    // Every supported browser has native module preloading.
    modulePreload: { polyfill: false },
    rollupOptions: {
      input: {
        main: path.join(repoRoot, "index.html"),
        redirects: path.join(redirectsRoot, "index.html"),
        work: path.join(repoRoot, "work/index.html"),
      },
    },
  },
  test: {
    projects: [
      {
        test: {
          name: "functions",
          include: ["tests/**/*.test.ts"],
          environment: "node",
        },
      },
      {
        extends: true,
        test: {
          name: "redirects",
          include: ["redirects/src/**/*.test.{ts,tsx}"],
          environment: "jsdom",
          setupFiles: path.join(redirectsRoot, "src/test/setup.ts"),
        },
      },
    ],
  },
})
