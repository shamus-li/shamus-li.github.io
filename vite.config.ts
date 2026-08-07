import path from "node:path"

import tailwindcss from "@tailwindcss/vite"
import { defineConfig } from "vitest/config"

const repoRoot = import.meta.dirname
const redirectsRoot = path.join(repoRoot, "redirects")

export default defineConfig({
  plugins: [tailwindcss()],
  build: {
    rollupOptions: {
      input: {
        main: path.join(repoRoot, "index.html"),
        redirects: path.join(redirectsRoot, "index.html"),
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
