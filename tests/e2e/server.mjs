import { spawn } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const repository = fileURLToPath(new URL("../..", import.meta.url));
const root = mkdtempSync(path.join(tmpdir(), "crossposter-e2e-"));
const app = path.join(root, "app");
const data = path.join(root, "data");
mkdirSync(app);
mkdirSync(data);
// Next only loads .env files from this disposable application directory.
// Build output/assets are read from the repository; user configuration is absent.
for (const entry of [".next", "public", "node_modules"]) {
  symlinkSync(path.join(repository, entry), path.join(app, entry), "dir");
}
copyFileSync(path.join(repository, "package.json"), path.join(app, "package.json"));

const child = spawn(process.execPath, [
  "--require", fileURLToPath(new URL("./server-guard.cjs", import.meta.url)),
  require.resolve("next/dist/bin/next"), "start", app,
  "--hostname", "127.0.0.1", "--port", "4173"
], {
  cwd: app,
  stdio: "inherit",
  // Inherit only runtime essentials, never provider credentials or .env state.
  env: {
    PATH: process.env.PATH,
    NODE_ENV: "production",
    NEXT_TELEMETRY_DISABLED: "1",
    CROSSPOSTER_APP_ROOT: repository,
    CROSSPOSTER_DATA_DIR: data,
    POSTER_DISABLE_SCHEDULER: "true",
    POSTER_REQUIRE_ADMIN_PASSWORD: "false"
  }
});
process.on("exit", () => rmSync(root, { recursive: true, force: true }));
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
child.on("error", (error) => { console.error(error); process.exit(1); });
child.on("exit", (code, signal) => process.exit(code ?? (signal === "SIGTERM" || signal === "SIGINT" ? 0 : 1)));
