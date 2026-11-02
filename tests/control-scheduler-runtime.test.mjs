import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const repository = fileURLToPath(new URL("..", import.meta.url));
const baseEnv = { PATH: process.env.PATH, NODE_ENV: "production", NEXT_TELEMETRY_DISABLED: "1" };
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function within(operation, ms = 7000) {
  let timer;
  try { return await Promise.race([operation, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Owned scheduler fixture operation did not settle")), ms); })]); }
  finally { clearTimeout(timer); }
}
async function until(predicate, description) {
  for (let attempt = 0; attempt < 200; attempt++) { if (await predicate()) return; await pause(25); }
  throw new Error(`Missing scheduler fixture precondition: ${description}`);
}
async function freePort() {
  const server = createServer(); server.listen(0, "127.0.0.1"); await once(server, "listening"); const port = server.address().port;
  await new Promise((resolve) => server.close(resolve)); return port;
}
async function assertClosed(port) {
  const server = createServer(); server.listen(port, "127.0.0.1"); await within(once(server, "listening")); await new Promise((resolve) => server.close(resolve));
}
async function fixture() {
  assert.ok(existsSync(path.join(repository, ".next/BUILD_ID")), "build before production scheduler tests");
  const root = mkdtempSync(path.join(tmpdir(), "crossposter-scheduler-runtime-"));
  const app = path.join(root, "app"), data = path.join(root, "data"); mkdirSync(app); mkdirSync(data); mkdirSync(path.join(app, "bin"));
  for (const entry of [".next", "node_modules", "public"]) symlinkSync(path.join(repository, entry), path.join(app, entry), "dir");
  copyFileSync(path.join(repository, "bin/crossposter.mjs"), path.join(app, "bin/crossposter.mjs"));
  copyFileSync(path.join(repository, "package.json"), path.join(app, "package.json"));
  const port = await freePort(), origin = `http://127.0.0.1:${port}`;
  assert.equal(spawnSync(process.execPath, [path.join(repository, "scripts/setup-control.mjs"), "--data-root", data, "--origin", origin], { env: baseEnv, encoding: "utf8" }).status, 0);
  const credential = JSON.parse(readFileSync(path.join(data, ".poster-control.json"), "utf8"));
  const password = "scheduler-independent-owner-fixture";
  writeFileSync(path.join(data, "poster.config.local.json"), JSON.stringify({ values: { DEVTO_API_KEY: "scheduler-fixture-api-key", POSTER_ADMIN_PASSWORD: password } }));
  const machine = { authorization: `Bearer ${credential.token}`, "x-crossposter-instance": credential.instanceId, "content-type": "application/json" };
  const owned = [], clients = []; let output = "";
  const events = () => { const filename = path.join(data, "fixture-scheduler-events.jsonl"); return existsSync(filename) ? readFileSync(filename, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []; };
  const calls = () => events().filter((event) => event.event === "provider-entered");
  const read = async (route) => { const response = await fetch(`${origin}/api/mcp/v1/${route}`, { headers: machine }); assert.equal(response.status, 200); return (await response.json()).data; };
  async function start({ disabled = false, fromDotEnv = false, selectedPort = port } = {}) {
    if (fromDotEnv) writeFileSync(path.join(data, ".env"), "POSTER_DISABLE_SCHEDULER=true\n");
    const selectedOrigin = `http://127.0.0.1:${selectedPort}`;
    const child = spawn(process.execPath, [path.join(app, "bin/crossposter.mjs"), "--host", "127.0.0.1", "--port", String(selectedPort), "--data-dir", data, "--no-open", "--no-update"], {
      cwd: app, env: { ...baseEnv, CROSSPOSTER_APP_ROOT: app, CROSSPOSTER_DATA_DIR: data, CROSSPOSTER_RUN_MODE: "production",
        CROSSPOSTER_SCHEDULER_FIXTURE_ORIGIN: selectedOrigin, NODE_OPTIONS: `--import=${path.join(repository, "tests/control-scheduler-guard.mjs")}`,
        ...(fromDotEnv ? {} : { POSTER_DISABLE_SCHEDULER: disabled ? "true" : "false" }) }, stdio: ["pipe", "pipe", "pipe"]
    });
    const processState = { child, exited: once(child, "exit"), port: selectedPort, origin: selectedOrigin }; owned.push(processState);
    for (const stream of [child.stdout, child.stderr]) stream.on("data", (bytes) => { output = (output + bytes).slice(-30000); });
    await until(async () => {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Owned launcher exited before readiness: ${output}`);
      try { return (await fetch(`${selectedOrigin}/api/mcp/v1/status`, { headers: machine })).status === (selectedPort === port ? 200 : 403); } catch { return false; }
    }, "actual launcher/Next ready");
    const spawned = events().find((event) => event.pid === child.pid && event.event === "backend-spawned"); assert.ok(spawned);
    processState.backendPid = spawned.childPid; return processState;
  }
  async function stop(processState, backendSignal) {
    if (!processState || processState.child.exitCode !== null || processState.child.signalCode !== null) return;
    if (backendSignal) process.kill(processState.backendPid, backendSignal); else processState.child.kill("SIGTERM");
    try { await within(processState.exited, 6000); }
    catch (error) { process.kill(processState.backendPid, "SIGKILL"); await within(processState.exited); throw error; }
    await assertClosed(processState.port);
  }
  async function accepted(requestKey, delay = 2000) {
    const response = await fetch(`${origin}/api/mcp/v1/actions`, { method: "POST", headers: machine,
      body: JSON.stringify({ mode: "schedule", requestKey, scheduledFor: new Date(Date.now() + delay).toISOString(), content: { title: `Headless ${requestKey}`, text: "Frozen headless fixture", linkUrl: "", mediaId: null }, targetIds: ["devto:base"] }) });
    assert.equal(response.status, 200); const action = (await response.json()).data;
    const headers = { origin, "content-type": "application/json" };
    const login = await fetch(`${origin}/api/approvals/session`, { method: "POST", headers, body: JSON.stringify({ password }) }); assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie").split(";")[0], csrf = (await login.json()).data.csrf;
    const approval = await fetch(`${origin}/api/approvals/actions/${action.id}`, { method: "POST", headers: { ...headers, cookie, "x-crossposter-csrf": csrf },
      body: JSON.stringify({ decision: "approve", expectedDigest: action.payloadDigest, expectedRevision: action.revision, expiresAt: action.expiresAt }) }); assert.equal(approval.status, 200);
    const commit = await fetch(`${origin}/api/mcp/v1/actions/${action.id}/commit`, { method: "POST", headers: machine, body: JSON.stringify({ expectedDigest: action.payloadDigest }) });
    assert.equal(commit.status, 200); const queued = (await commit.json()).data; assert.equal(queued.state, "scheduled"); return queued;
  }
  // This is an HTTP attachment/EOF stand-in, not the later MCP stdio adapter.
  async function attachment() {
    const program = `const fs = require("node:fs"); const c = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      fetch(c.origin + "/api/mcp/v1/status", { headers: { authorization: "Bearer " + c.token, "x-crossposter-instance": c.instanceId } })
        .then(r => { if (r.status !== 200) process.exit(1); process.send({ attached: true }); });
      process.stdin.resume(); process.stdin.on("end", () => process.exit(0));`;
    const child = spawn(process.execPath, ["-e", program, path.join(data, ".poster-control.json")], { env: { PATH: process.env.PATH }, stdio: ["pipe", "ignore", "pipe", "ipc"] });
    const exited = once(child, "exit"); clients.push({ child, exited }); assert.deepEqual((await within(once(child, "message")))[0], { attached: true });
    return { child, exited };
  }
  const release = () => writeFileSync(path.join(data, "fixture-scheduler-release"), "fixture release");
  async function dispose() {
    release();
    for (const client of clients) { if (client.child.exitCode === null && client.child.signalCode === null) { client.child.stdin.end(); await within(client.exited); } }
    for (const processState of owned) await stop(processState);
    for (const secret of [credential.token, password, "scheduler-fixture-api-key"]) assert.equal(output.includes(secret), false);
    assert.equal(events().some((event) => event.event.startsWith("denied-")), false, "all unexpected network/process IO stays denied");
    rmSync(root, { recursive: true, force: true });
  }
  return { root, data, port, origin, machine, events, calls, read, start, stop, accepted, attachment, release, dispose };
}

test("headless launcher starts scheduling without a dashboard, survives attachment EOF and shares one owner during overlapping ticks", { timeout: 30000 }, async () => {
  const f = await fixture(); let first, second;
  try {
    first = await f.start(); const clients = await Promise.all([f.attachment(), f.attachment()]);
    const action = await f.accepted("disconnected");
    for (const client of clients) client.child.stdin.end();
    for (const [code, signal] of await Promise.all(clients.map((client) => within(client.exited)))) { assert.equal(code, 0); assert.equal(signal, null); }
    await until(() => f.calls().length === 1, "accepted job dispatch after both EOF stand-ins");
    assert.equal((await f.read(`actions/${action.id}`)).outcomes[0].state, "dispatching");
    const before = f.events().length; await until(() => f.events().slice(before).filter((event) => event.event === "interval-fired").length >= 3, "timer and launcher ping overlap while held");
    assert.equal(f.calls().length, 1);
    const overlap = await fetch(`${f.origin}/api/scheduled/tick`, { method: "POST" }); assert.equal((await overlap.json()).skipped, true);
    const secondPort = await freePort(); second = await f.start({ selectedPort: secondPort });
    const refused = await fetch(`${second.origin}/api/scheduled/tick`, { method: "POST" }); assert.equal(refused.status, 500);
    assert.equal(JSON.parse(readFileSync(path.join(f.data, ".poster-owner.json"), "utf8")).pid, first.backendPid);
    assert.equal(f.calls().some((event) => event.pid === second.backendPid), false); await f.stop(second);
    f.release(); await until(async () => (await f.read(`actions/${action.id}`)).state === "succeeded", "disconnected scheduled success");
    assert.equal((await f.read(`posts/action-${action.id}`)).state, "succeeded"); assert.equal((await f.read("scheduled")).items.length, 0);
    for (const [role, pid] of [["launcher", first.child.pid], ["backend", first.backendPid]]) assert.equal(f.events().filter((event) => event.pid === pid && event.role === role && event.event === "interval-started").length, 1);
    assert.equal(f.events().some((event) => event.event === "request" && !event.route.startsWith("/api/")), false, "startup never requests dashboard pages");
    await f.stop(first); assert.equal(existsSync(path.join(f.data, ".poster-owner.json")), false);
    for (const pid of [first.child.pid, first.backendPid]) assert.equal(f.events().find((event) => event.pid === pid && event.event === "exit").activeIntervals, 0);
  } finally { await f.dispose(); }
});

for (const fromDotEnv of [false, true]) test(`scheduler disable from ${fromDotEnv ? "data .env" : "environment"} stops automatic ticks while explicit ticks remain available`, { timeout: 20000 }, async () => {
  const f = await fixture();
  try {
    await f.start({ disabled: true, fromDotEnv }); f.release(); const action = await f.accepted("disabled", 1000);
    await pause(1250); assert.equal(f.calls().length, 0); assert.equal((await f.read(`actions/${action.id}`)).state, "scheduled");
    assert.equal(f.events().some((event) => ["interval-started", "ping"].includes(event.event)), false);
    const explicit = await fetch(`${f.origin}/api/scheduled/tick`, { method: "POST" }); assert.equal((await explicit.json()).processed, 1);
    assert.equal((await f.read(`actions/${action.id}`)).state, "succeeded"); assert.equal(f.calls().length, 1);
    assert.equal(f.events().some((event) => event.event === "interval-started"), false);
  } finally { await f.dispose(); }
});

test("a separately restarted headless backend catches up an accepted overdue job which never dispatched", { timeout: 20000 }, async () => {
  const f = await fixture();
  try {
    const first = await f.start({ disabled: true }); const action = await f.accepted("overdue", 1000); await f.stop(first);
    assert.equal(existsSync(path.join(f.data, ".poster-owner.json")), false); await pause(1100); f.release();
    const restarted = await f.start(); assert.notEqual(restarted.backendPid, first.backendPid);
    await until(async () => (await f.read(`actions/${action.id}`)).state === "succeeded", "overdue catch-up from launcher warmup");
    assert.equal(f.calls().length, 1); assert.equal(f.calls()[0].pid, restarted.backendPid);
  } finally { await f.dispose(); }
});

test("production scheduled dispatch interrupted by backend death recovers uncertain without automatic publication replay", { timeout: 20000 }, async () => {
  const f = await fixture();
  try {
    const first = await f.start(); const action = await f.accepted("interrupted", 1000); await until(() => f.calls().length === 1, "provider intent before backend kill");
    await f.stop(first, "SIGKILL"); assert.equal(existsSync(path.join(f.data, ".poster-owner.json")), true);
    const restarted = await f.start(); await until(() => JSON.parse(readFileSync(path.join(f.data, "poster.config.local.json"), "utf8")).scheduledPosts[0]?.status === "failed", "restart terminal queue reconciliation");
    const recovered = await f.read(`actions/${action.id}`); assert.equal(recovered.state, "uncertain"); assert.equal(recovered.outcomes[0].state, "uncertain");
    assert.equal((await f.read(`posts/${recovered.postId}`)).state, "uncertain"); assert.equal(f.calls().length, 1);
    assert.equal(JSON.parse(readFileSync(path.join(f.data, ".poster-owner.json"), "utf8")).pid, restarted.backendPid);
  } finally { await f.dispose(); }
});
