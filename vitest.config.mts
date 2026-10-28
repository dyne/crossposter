import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL(".", import.meta.url)),
      "server-only": fileURLToPath(new URL("./tests/app/support/server-only.ts", import.meta.url))
    }
  },
  oxc: { jsx: { runtime: "automatic" } },
  test: {
    environment: "node",
    include: ["tests/app/**/*.test.{ts,tsx}"],
    setupFiles: ["./tests/app/setup.ts"],
    passWithNoTests: false,
    allowOnly: false,
    reporters: ["default", "./tests/app/support/require-tests.ts"],
    // Each file owns its environment and scratch directory. Tests within a file
    // run sequentially because application modules capture data paths at import.
    isolate: true,
    sequence: { concurrent: false },
    coverage: {
      provider: "v8",
      include: ["lib/**/*.{ts,tsx}", "app/api/**/*.ts", "components/**/*.{ts,tsx}"],
      reporter: ["text", "json-summary", "lcov"],
      reportsDirectory: "./coverage"
    }
  }
});
