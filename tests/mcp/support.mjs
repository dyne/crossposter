import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { createServer as httpServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

export const repository = fileURLToPath(new URL("../..", import.meta.url));
export const packageVersion = JSON.parse(readFileSync(path.join(repository, "package.json"), "utf8")).version;
export const cleanEnv = { PATH: process.env.PATH, NODE_ENV: "production", NEXT_TELEMETRY_DISABLED: "1" };
export async function freePort() {
  const reservation = createServer(); reservation.listen(0, "127.0.0.1"); await once(reservation, "listening");
  const port = reservation.address().port; await new Promise((resolve) => reservation.close(resolve)); return port;
}
export async function stopOwned(child, exited) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM"); let timer;
  const stopped = await Promise.race([exited.then(() => true), new Promise((resolve) => { timer = setTimeout(() => resolve(false), 5000); })]).finally(() => clearTimeout(timer));
  if (!stopped) { child.kill("SIGKILL"); await exited; }
}
export async function backendFixture() {
  const root = mkdtempSync(path.join(tmpdir(), "crossposter-mcp-"));
  const app = path.join(root, "app"), data = path.join(root, "data"), media = path.join(root, "selected media ü");
  for (const directory of [app, data, media]) mkdirSync(directory);
  for (const entry of [".next", "node_modules", "public"]) symlinkSync(path.join(repository, entry), path.join(app, entry), "dir");
  copyFileSync(path.join(repository, "package.json"), path.join(app, "package.json"));
  const port = await freePort(); const origin = `http://127.0.0.1:${port}`;
  assert.equal(spawnSync(process.execPath, [path.join(repository, "scripts/setup-control.mjs"), "--data-root", data, "--origin", origin], { env: cleanEnv, encoding: "utf8" }).status, 0);
  const credential = JSON.parse(readFileSync(path.join(data, ".poster-control.json"), "utf8"));
  const owner = "isolated-mcp-owner-canary", provider = "isolated-mcp-provider-canary";
  writeFileSync(path.join(data, "poster.config.local.json"), JSON.stringify({ values: { POSTER_ADMIN_PASSWORD: owner, BLUESKY_IDENTIFIER: "fixture.example", BLUESKY_APP_PASSWORD: provider },
    publishedPosts: [{ id: "retained-post", createdAt: "2020-01-01T12:00:00.000Z", title: "", text: "Retained", platforms: ["bluesky"], results: [{ platform: "bluesky", ok: true, message: "Published." }] }], scheduledPosts: [] }));
  const child = spawn(process.execPath, ["--require", path.join(repository, "tests/e2e/server-guard.cjs"), path.join(repository, "node_modules/next/dist/bin/next"),
    "start", app, "--hostname", "127.0.0.1", "--port", String(port)], { cwd: app, env: { ...cleanEnv,
      CROSSPOSTER_APP_ROOT: app, CROSSPOSTER_DATA_DIR: data, POSTER_DISABLE_SCHEDULER: "true" }, stdio: ["ignore", "pipe", "pipe"] });
  const exited = once(child, "exit"); let output = "";
  for (const stream of [child.stdout, child.stderr]) stream.on("data", (bytes) => { output = (output + bytes).slice(-16384); });
  const headers = { authorization: `Bearer ${credential.token}`, "x-crossposter-instance": credential.instanceId };
  const close = async () => { await stopOwned(child, exited); rmSync(root, { recursive: true, force: true }); };
  let lastStatus, lastCode;
  try {
    for (let attempt = 0; attempt < 100; attempt++) {
      assert.equal(child.exitCode, null, "fixture backend exited before readiness");
      try {
        const response = await fetch(`${origin}/api/mcp/v1/status`, { headers }); lastStatus = response.status;
        if (response.status === 200) return { root, app, data, media, origin, credential, owner, provider, headers, child, close, output: () => output };
        lastCode = (await response.json()).error?.code;
      } catch { /* starting */ }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`fixture backend did not become ready (status ${lastStatus}, code ${lastCode})`);
  } catch (error) { await close(); throw error; }
}
class ObservedStdioTransport extends StdioClientTransport {
  stdout = "";
  overflow = false;
  async start() {
    await super.start();
    this._process.stdout.on("data", (bytes) => {
      if (Buffer.byteLength(this.stdout) + bytes.length > 2 * 1024 * 1024) this.overflow = true;
      else this.stdout += bytes;
    });
  }
}
export async function connectBridge(fixture, overrides = {}, options = {}, executable = path.join(repository, "bin/crossposter-mcp.mjs")) {
  const client = new Client({ name: "crossposter-protocol-test", version: "1" }, { versionNegotiation: { mode: "legacy" }, ...options });
  const transport = new ObservedStdioTransport({ command: process.execPath, args: [executable],
    cwd: tmpdir(), env: { ...cleanEnv, CROSSPOSTER_DATA_DIR: fixture.data, CROSSPOSTER_MCP_ENDPOINT: fixture.origin,
      CROSSPOSTER_MCP_MEDIA_ROOTS: JSON.stringify([fixture.media]), ...overrides }, stderr: "pipe" });
  let stderr = ""; transport.stderr.on("data", (bytes) => { stderr = (stderr + bytes).slice(-16384); });
  try { await client.connect(transport); } catch (error) { await transport.close(); throw error; }
  const assertProtocol = () => {
    assert.equal(transport.overflow, false, "captured protocol output remains bounded");
    assert.ok(transport.stdout.length > 0);
    for (const line of transport.stdout.trim().split("\n")) assert.equal(JSON.parse(line).jsonrpc, "2.0", "every stdout line is protocol");
  };
  return { client, transport, stderr: () => stderr, assertProtocol, close: async () => { await client.close(); assertProtocol(); } };
}

export async function within(promise, milliseconds = 3000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Owned operation exceeded its test deadline")), milliseconds); })]); }
  finally { clearTimeout(timer); }
}
export async function wireFixture(handler) {
  const root = mkdtempSync(path.join(tmpdir(), "crossposter-mcp-wire-"));
  const data = path.join(root, "data"), media = path.join(root, "selected media ü"); mkdirSync(data); mkdirSync(media);
  const origin = `http://127.0.0.1:${await freePort()}`;
  assert.equal(spawnSync(process.execPath, [path.join(repository, "scripts/setup-control.mjs"), "--data-root", data, "--origin", origin], { env: cleanEnv, encoding: "utf8" }).status, 0);
  const credential = JSON.parse(readFileSync(path.join(data, ".poster-control.json"), "utf8"));
  const requests = [];
  const server = httpServer((request, response) => {
    requests.push({ method: request.method, path: request.url });
    response.setHeader("content-type", "application/json");
    if (request.url === "/api/mcp/v1/status") response.end(JSON.stringify({ ok: true, data: { apiVersion: "1", backendVersion: packageVersion,
      instanceId: credential.instanceId, scheduler: "disabled", approvalConfigured: true, readinessBasis: "configuration_only" } }));
    else void Promise.resolve(handler(request, response)).catch(() => { response.destroy(); });
  });
  server.listen(Number(new URL(origin).port), "127.0.0.1"); await once(server, "listening");
  return { root, data, media, origin, credential, requests, server,
    close: async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); rmSync(root, { recursive: true, force: true }); } };
}
