import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Every executable module in the extracted critical boundaries is gated on its
// own: a well-covered neighbor cannot hide an untested failure path. Type-only
// provider/types modules have no executable statements and are checked by tsc.
const criticalModules = [
  "lib/platform-catalog.ts",
  "lib/platform-limits.ts",
  "lib/config-spec.ts",
  "lib/publishing/contracts.ts",
  "lib/publishing/service.ts",
  "lib/publish-runner.ts",
  "lib/scheduling/lifecycle.ts",
  "lib/scheduling/policy.ts",
  "lib/scheduling/queries.ts",
  "lib/scheduling/service.ts",
  "lib/scheduler.ts",
  "lib/storage/codec-helpers.ts",
  "lib/storage/config-codec.ts",
  "lib/storage/content-codec.ts",
  "lib/storage/schedule-codec.ts"
];

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
      // Explicit include also measures files never imported by a test, including
      // route-page orchestration. Broader coverage is reported, not conflated
      // with the critical boundary acceptance thresholds below.
      include: ["lib/**/*.{ts,tsx}", "app/**/*.{ts,tsx}", "components/**/*.{ts,tsx}"],
      thresholds: Object.fromEntries(criticalModules.map((filename) => [
        filename, { statements: 85, branches: 80, perFile: true }
      ])),
      reporter: ["text", "json-summary", "lcov"],
      reportsDirectory: "./coverage"
    }
  }
});
