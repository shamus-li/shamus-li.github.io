import js from "@eslint/js"
import globals from "globals"
import reactHooks from "eslint-plugin-react-hooks"
import tseslint from "typescript-eslint"
import { defineConfig, globalIgnores } from "eslint/config"

export default defineConfig([
  globalIgnores(["dist", "node_modules"]),
  {
    files: ["**/*.{ts,tsx}"],
    extends: [js.configs.recommended, tseslint.configs.recommended],
  },
  {
    files: ["src/**/*.ts", "redirects/src/**/*.{ts,tsx}"],
    extends: [reactHooks.configs.flat.recommended],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
  },
  {
    files: ["redirects/redirect.ts", "functions/**/*.ts"],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.worker,
    },
  },
  {
    files: ["tests/**/*.ts", "vite.config.ts"],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.node,
    },
  },
])
