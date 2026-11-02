import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const repository = fileURLToPath(new URL("..", import.meta.url));
const env = { PATH: process.env.PATH, NODE_ENV: "production", NEXT_TELEMETRY_DISABLED: "1" };
async function until(predicate, description) {
  for (let i = 0; i < 150; i++) { if (await predicate()) return; await new Promise((resolve) => setTimeout(resolve, 20)); }
  throw new Error(`Missing publication fixture precondition: ${description}`);
}
async function stop(child, exited, signal = "SIGTERM") {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill(signal); let timer;
  try { await Promise.race([exited, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Owned publication backend did not exit")), 5000); })]); }
  finally { clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await exited; } }
}
test("production approved HTTP execution survives disconnect, retains post-acceptance uncertainty and recovers interrupted targets without replay", { timeout: 30000 }, async () => {
  assert.ok(existsSync(path.join(repository, ".next/BUILD_ID")), "build before publication runtime tests");
  const root = mkdtempSync(path.join(tmpdir(), "crossposter-publication-runtime-")); let child, exited, output = "";
  try {
    const app = path.join(root, "app"), data = path.join(root, "data"); mkdirSync(app); mkdirSync(data);
    for (const entry of [".next", "node_modules", "public"]) symlinkSync(path.join(repository, entry), path.join(app, entry), "dir");
    copyFileSync(path.join(repository, "package.json"), path.join(app, "package.json"));
    const reservation = createServer(); reservation.listen(0, "127.0.0.1"); await once(reservation, "listening");
    const port = reservation.address().port; await new Promise((resolve) => reservation.close(resolve)); const origin = `http://127.0.0.1:${port}`;
    assert.equal(spawnSync(process.execPath, [path.join(repository, "scripts/setup-control.mjs"), "--data-root", data, "--origin", origin], { env, encoding: "utf8" }).status, 0);
    const credentialFile = path.join(data, ".poster-control.json"); const credential = JSON.parse(readFileSync(credentialFile, "utf8"));
    const machine = { authorization: `Bearer ${credential.token}`, "x-crossposter-instance": credential.instanceId, "content-type": "application/json" };
    const configFile = path.join(data, "poster.config.local.json"); const password = "publication-independent-owner-canary";
    writeFileSync(configFile, JSON.stringify({ values: { DEVTO_API_KEY: "runtime-base-canary", POSTER_ADMIN_PASSWORD: password },
      profiles: { devto: [{ id: "saved", label: "Saved", values: { DEVTO_API_KEY: "runtime-profile-canary" } }] }, activeProfiles: { devto: "saved" } }));
    const callsFile = path.join(data, "fixture-provider-calls.jsonl"), release = path.join(data, "fixture-provider-release");
    const calls = () => existsSync(callsFile) ? readFileSync(callsFile, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
    const start = async () => {
      child = spawn(process.execPath, ["--import", path.join(repository, "tests/control-provider-guard.mjs"), path.join(repository, "node_modules/next/dist/bin/next"), "start", app, "--hostname", "127.0.0.1", "--port", String(port)],
        { cwd: app, env: { ...env, CROSSPOSTER_APP_ROOT: app, CROSSPOSTER_DATA_DIR: data, POSTER_DISABLE_SCHEDULER: "true" }, stdio: ["ignore", "pipe", "pipe"] });
      exited = once(child, "exit"); for (const stream of [child.stdout, child.stderr]) stream.on("data", (bytes) => { output = (output + bytes).slice(-20000); });
      await until(async () => { if (child.exitCode !== null) throw new Error("Owned backend exited before readiness"); try { return (await fetch(`${origin}/api/mcp/v1/status`, { headers: machine })).status === 200; } catch { return false; } }, "production backend ready");
    };
    const read = async (route) => { const response = await fetch(`${origin}/api/mcp/v1/${route}`, { headers: machine }); assert.equal(response.status, 200); return (await response.json()).data; };
    const prepare = async (requestKey, targetIds) => {
      const response = await fetch(`${origin}/api/mcp/v1/actions`, { method: "POST", headers: machine,
        body: JSON.stringify({ mode: "publish", requestKey, content: { title: "Runtime publication", text: "Exact frozen body", linkUrl: "", mediaId: null }, targetIds }) });
      assert.equal(response.status, 200); return (await response.json()).data;
    };
    const approve = async (action) => {
      const headers = { origin, "content-type": "application/json" };
      const login = await fetch(`${origin}/api/approvals/session`, { method: "POST", headers, body: JSON.stringify({ password }) }); assert.equal(login.status, 200);
      const cookie = login.headers.get("set-cookie").split(";")[0], csrf = (await login.json()).data.csrf;
      const response = await fetch(`${origin}/api/approvals/actions/${action.id}`, { method: "POST", headers: { ...headers, cookie, "x-crossposter-csrf": csrf },
        body: JSON.stringify({ decision: "approve", expectedDigest: action.payloadDigest, expectedRevision: action.revision, expiresAt: action.expiresAt }) }); assert.equal(response.status, 200);
    };
    const commit = (action, options = {}) => fetch(`${origin}/api/mcp/v1/actions/${action.id}/commit`, { method: "POST", headers: machine, body: JSON.stringify({ expectedDigest: action.payloadDigest }), ...options });
    await start(); const action = await prepare("runtime-mixed", ["devto:base", "devto:saved"]);
    assert.equal((await commit(action)).status, 401); await approve(action);
    const controller = new AbortController(); const request = commit(action, { signal: controller.signal }).catch((error) => error);
    try {
      await until(() => calls().length === 1, "first strict base provider entered"); controller.abort(); await request;
      assert.deepEqual(calls(), [{ name: "base", title: "Runtime publication" }]);
      const duplicate = await commit(action); assert.equal(duplicate.status, 200); assert.equal((await duplicate.json()).data.state, "executing");
      const running = await read(`actions/${action.id}`); assert.deepEqual(running.outcomes.map((item) => item.state), ["dispatching", "not_dispatched"]);
      assert.equal((await read(`posts/${running.postId}`)).state, "running");
      writeFileSync(release, "release fixture only"); await until(async () => (await read(`actions/${action.id}`)).state === "uncertain", "post-acceptance ambiguity retained");
    } finally { writeFileSync(release, "release fixture only"); await request; }
    const complete = await read(`actions/${action.id}`); assert.deepEqual(complete.outcomes.map((item) => item.state), ["succeeded", "uncertain"]);
    assert.equal(complete.outcomes[0].url, "https://dev.to/fixture/published?v=retained"); assert.deepEqual(calls().map((call) => call.name), ["base", "profile"]);
    assert.equal(calls()[1].accepted, true);
    const history = JSON.parse(readFileSync(configFile, "utf8")).publishedPosts[0];
    assert.equal(history.id, complete.postId); assert.equal(history.results[1].uncertain, true); assert.equal(history.results[1].ok, false);
    const journal = JSON.parse(readFileSync(path.join(data, ".poster-actions.json"), "utf8")).records.find((record) => record.action.id === action.id).action;
    assert.deepEqual(journal.outcomes, complete.outcomes);
    await stop(child, exited); await start(); assert.equal((await read(`posts/${complete.postId}`)).actionId, action.id);
    assert.deepEqual((await read(`posts/${complete.postId}`)).outcomes, complete.outcomes);
    assert.equal((await (await commit(action)).json()).data.state, "uncertain"); assert.equal(calls().length, 2);
    for (const signal of ["SIGKILL", "SIGTERM"]) {
      unlinkSync(release); const interrupted = await prepare(`runtime-interrupted-${signal}`, ["devto:base"]); await approve(interrupted);
      assert.equal((await commit(interrupted)).status, 200); const expectedCalls = signal === "SIGKILL" ? 3 : 4;
      await until(() => calls().length === expectedCalls, "retained dispatch intent before shutdown"); await stop(child, exited, signal); await start();
      const journalFile = path.join(data, ".poster-actions.json"), before = readFileSync(journalFile, "utf8");
      const recovered = await read(`actions/${interrupted.id}`); assert.equal(recovered.state, "uncertain"); assert.equal(recovered.outcomes[0].state, "uncertain");
      assert.equal((await read(`posts/${recovered.postId}`)).state, "uncertain"); assert.equal(readFileSync(journalFile, "utf8"), before, "restart GETs are pure");
      assert.equal((await (await commit(interrupted)).json()).data.state, "uncertain"); assert.equal(calls().length, expectedCalls);
      writeFileSync(release, "release fixture only");
    }
    const rotated = { ...credential, token: "cd".repeat(32) }; writeFileSync(credentialFile, JSON.stringify(rotated), { mode: 0o600 });
    const rotation = await commit(action, { headers: { ...machine, authorization: `Bearer ${rotated.token}` } }); assert.equal(rotation.status, 409); assert.equal((await rotation.json()).error.code, "instance_mismatch"); assert.equal(calls().length, 4);
    for (const secret of [credential.token, password, "runtime-base-canary", "runtime-profile-canary"]) {
      assert.equal(output.includes(secret), false); assert.equal(JSON.stringify(complete).includes(secret), false);
      assert.equal(JSON.stringify(history).includes(secret), false); assert.equal(JSON.stringify(journal).includes(secret), false);
    }
    assert.equal(/Unexpected execution-test|Unexpected browser-test|EADDRINUSE/.test(output), false);
  } finally { await stop(child, exited); rmSync(root, { recursive: true, force: true }); }
});
