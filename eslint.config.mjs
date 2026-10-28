import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { FlatCompat } from "@eslint/eslintrc";

const compat = new FlatCompat({
  baseDirectory: dirname(fileURLToPath(import.meta.url))
});

const config = [
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    ignores: [".gestalt/**", ".next/**", ".venv/**", "node_modules/**", "next-env.d.ts", "coverage/**", "test-results/**", "playwright-report/**"]
  },
  {
    files: ["tests/e2e/server-guard.cjs"],
    rules: { "@typescript-eslint/no-require-imports": "off" }
  }
];

export default config;
