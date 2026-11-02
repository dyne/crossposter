import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const repository = fileURLToPath(new URL("..", import.meta.url));
const setup = path.join(repository, "scripts/setup-control.mjs");
const env = { PATH: process.env.PATH, NODE_ENV: "production", NEXT_TELEMETRY_DISABLED: "1" };
const bootstrap = (root, origin) => spawnSync(process.execPath, [setup, "--data-root", root, "--origin", origin], { env, encoding: "utf8" });

test("explicit setup binds a private credential to the canonical root and never replaces existing state", () => {
  const root = mkdtempSync(path.join(tmpdir(), "crossposter-control-setup-"));
  try {
    const data = path.join(root, "data"); mkdirSync(data); symlinkSync(data, path.join(root, "alias"), "dir");
    const config = path.join(data, "poster.config.local.json"); writeFileSync(config, '{"values":{"POSTER_ADMIN_PASSWORD":"fixture-owner-canary"}}');
    const result = bootstrap(path.join(root, "alias"), "http://127.0.0.1:2004"); assert.equal(result.status, 0);
    const filename = path.join(data, ".poster-control.json"); const bytes = readFileSync(filename, "utf8"); const credential = JSON.parse(bytes);
    assert.equal(statSync(filename).mode & 0o777, 0o600);
    assert.equal(credential.rootBinding, `sha256:${createHash("sha256").update(realpathSync(data)).digest("hex")}`);
    assert.match(credential.token, /^[a-f0-9]{64}$/); assert.equal(result.stdout.includes(credential.token), false);
    assert.equal(result.stderr, ""); assert.equal(readFileSync(config, "utf8"), '{"values":{"POSTER_ADMIN_PASSWORD":"fixture-owner-canary"}}');
    assert.equal(bootstrap(data, "http://127.0.0.1:2004").status, 1); assert.equal(readFileSync(filename, "utf8"), bytes);
    writeFileSync(filename, "corrupt fixture"); assert.equal(bootstrap(data, "http://127.0.0.1:2004").status, 1);
    assert.equal(readFileSync(filename, "utf8"), "corrupt fixture");
    const other = path.join(root, "other"); mkdirSync(other); symlinkSync(filename, path.join(other, ".poster-control.json"));
    assert.equal(bootstrap(other, "http://127.0.0.1:2004").status, 1);
    for (const origin of ["https://evil.example", "http://localhost:2004", "http://127.0.0.1:2004/path"]) {
      const empty = path.join(root, `empty-${Math.random()}`); mkdirSync(empty);
      assert.equal(bootstrap(empty, origin).status, 1); assert.equal(existsSync(path.join(empty, ".poster-control.json")), false);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("production Next routes accept direct loopback machine reads and reject hostile forwarding", { timeout: 30000 }, async () => {
  assert.equal(existsSync(path.join(repository, ".next/BUILD_ID")), true, "build before the production control test");
  const root = mkdtempSync(path.join(tmpdir(), "crossposter-control-runtime-"));
  let child; let exited; let output = "";
  try {
    const app = path.join(root, "app"); const data = path.join(root, "data"); mkdirSync(app); mkdirSync(data);
    for (const entry of [".next", "node_modules", "public"]) symlinkSync(path.join(repository, entry), path.join(app, entry), "dir");
    copyFileSync(path.join(repository, "package.json"), path.join(app, "package.json"));
    const reservation = createServer(); reservation.listen(0, "127.0.0.1"); await once(reservation, "listening");
    const port = reservation.address().port; await new Promise((resolve) => reservation.close(resolve));
    const origin = `http://127.0.0.1:${port}`; assert.equal(bootstrap(data, origin).status, 0);
    const credential = JSON.parse(readFileSync(path.join(data, ".poster-control.json"), "utf8"));
    const bytes = '{"publishedPosts":[],"scheduledPosts":[]}'; writeFileSync(path.join(data, "poster.config.local.json"), bytes);
    child = spawn(process.execPath, ["--require", path.join(repository, "tests/e2e/server-guard.cjs"),
      path.join(repository, "node_modules/next/dist/bin/next"), "start", app, "--hostname", "127.0.0.1", "--port", String(port)],
    { cwd: app, env: { ...env, CROSSPOSTER_APP_ROOT: app, CROSSPOSTER_DATA_DIR: data, POSTER_DISABLE_SCHEDULER: "true" }, stdio: ["ignore", "pipe", "pipe"] });
    exited = once(child, "exit"); child.stdout.on("data", (data) => { output = (output + data).slice(-16384); });
    child.stderr.on("data", (data) => { output = (output + data).slice(-16384); });
    const headers = { authorization: `Bearer ${credential.token}`, "x-crossposter-instance": credential.instanceId };
    let ready = false; let lastStatus; let lastCode;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (child.exitCode !== null) throw new Error("Owned fixture backend exited before readiness.");
      try {
        const response = await fetch(`${origin}/api/mcp/v1/status`, { headers, redirect: "error" });
        lastStatus = response.status; lastCode = (await response.json()).error?.code;
        if (response.status === 200) { ready = true; break; }
      }
      catch { /* server is still starting */ }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(ready, true, `production authenticated read must become ready (status ${lastStatus}; code ${lastCode})`);
    const result = await (await fetch(`${origin}/api/mcp/v1/status`, { headers, redirect: "error" })).json();
    assert.equal(result.data.instanceId, credential.instanceId); assert.equal(result.data.scheduler, "disabled");
    assert.equal((await fetch(`${origin}/api/mcp/v1/posts`, { headers, redirect: "error" })).status, 200);
    assert.equal((await fetch(`${origin}/api/mcp/v1/status`, { headers: { ...headers, origin: "https://evil.example" }, redirect: "error" })).status, 403);
    assert.equal((await fetch(`${origin}/api/mcp/v1/status`, { headers: { ...headers, "x-forwarded-host": "evil.example" }, redirect: "error" })).status, 403);
    assert.equal((await fetch(`${origin}/api/mcp/v1/status`, { headers: { ...headers, "x-forwarded-for": "192.0.2.1" }, redirect: "error" })).status, 403);
    assert.equal(readFileSync(path.join(data, "poster.config.local.json"), "utf8"), bytes);
    assert.equal(output.includes(credential.token), false); assert.equal(output.includes("Unexpected browser-test server IO"), false);
  } finally {
    if (child && child.exitCode === null) {
      child.kill("SIGTERM");
      let timer;
      const stopped = await Promise.race([exited.then(() => true), new Promise((resolve) => { timer = setTimeout(() => resolve(false), 5000); })])
        .finally(() => clearTimeout(timer));
      if (!stopped) { child.kill("SIGKILL"); await exited; }
    }
    rmSync(root, { recursive: true, force: true });
  }
});
