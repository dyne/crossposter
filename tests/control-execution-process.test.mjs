import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import ts from "typescript";

const repository = fileURLToPath(new URL("..", import.meta.url));
async function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "crossposter-execution-process-"));
  const data = path.join(root, "data"); mkdirSync(data); symlinkSync(path.join(repository, "node_modules"), path.join(root, "node_modules"), "dir");
  const sources = { "lib/control/backend-ownership.ts": "owner", "lib/control/action-store.ts": "action-store",
    "lib/control/execution-service.ts": "execution-service", "lib/control/contracts.ts": "contracts", "lib/control/canonical.ts": "canonical",
    "lib/control/errors.ts": "errors", "lib/platform-catalog.ts": "platform-catalog", "lib/storage/durable-json.ts": "durable-json", "lib/storage/json-limits.ts": "json-limits" };
  for (const [source, name] of Object.entries(sources)) {
    let compiled = ts.transpileModule(readFileSync(path.join(repository, source), "utf8"), {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }
    }).outputText.replace('import "server-only";', "");
    compiled = compiled.replace(/from "([^"]+)"/g, (full, specifier) => {
      if (specifier.startsWith("node:") || !specifier.startsWith(".") && !specifier.startsWith("@/")) return full;
      const target = specifier.startsWith("@/") ? specifier.slice(2) + ".ts" : path.posix.normalize(path.posix.join(path.posix.dirname(source), specifier)) + ".ts";
      assert.ok(sources[target], `missing runtime import ${target}`); return `from "./${sources[target]}.mjs"`;
    });
    writeFileSync(path.join(root, `${name}.mjs`), compiled);
  }
  const program = `
    import { createServer } from "node:http";
    import { backendOwner, releaseBackendOwners } from "./owner.mjs";
    import { createActionStore, actionRevision } from "./action-store.mjs";
    import { createExecutionService } from "./execution-service.mjs";
    import { payloadDigest } from "./canonical.mjs";
    const root = process.argv[2], mode = process.argv[3];
    const owner = backendOwner(root), store = createActionStore(root, owner);
    const target = { id: "bluesky:base", platform: "bluesky", profileId: null, label: "Fixture" };
    let clock = Date.now(), calls = 0, release;
    const gate = new Promise(resolve => { release = resolve; });
    if (!store.read().length) {
      const payload = { mode: "publish", content: { title: "", text: "Disposable process fixture", linkUrl: "", mediaId: null },
        targets: [{ ...target, identityRevision: payloadDigest(target) }], media: null, draftRevision: null };
      const action = { id: "process-action", revision: "", payloadDigest: payloadDigest(payload), payload, state: "prepared",
        createdAt: new Date(clock).toISOString(), expiresAt: new Date(clock + 1800000).toISOString(), approvalUrl: "/approvals/process-action",
        timezone: "Europe/Berlin", scheduledLocal: null, warnings: [], outcomes: [{ target, state: "not_dispatched", message: "Not dispatched", url: null }], postId: null, scheduleId: null };
      action.revision = actionRevision(action);
      const prepared = store.save({ requestKey: "process-key", inputDigest: payloadDigest({}), action, accountBindings: { [target.id]: payloadDigest({}) } }, null);
      const approved = { ...action, state: "approved" }; approved.revision = actionRevision(approved);
      store.save({ ...prepared, action: approved, ownerDecision: { actionId: action.id, payloadDigest: action.payloadDigest,
        preparationRevision: action.revision, expiresAt: action.expiresAt, decision: "approve", decidedAt: action.createdAt } }, action.revision);
    }
    function update(state, outcome) {
      const record = store.read()[0]; const action = { ...record.action, state, outcomes: [{ ...record.action.outcomes[0], state: outcome, message: "Fixture outcome" }] };
      action.revision = actionRevision(action); store.save({ ...record, action }, record.action.revision);
    }
    const service = createExecutionService({ readRecords: store.read, saveRecord: store.save, assertMutation: owner.assert, now: () => new Date(clock),
      snapshot: async (record) => {
        if (mode === "before-dispatch" && record.action.state === "executing") { process.send({ event: "claimed" }); await gate; }
        return { action: record.action, assertUnchanged: () => { owner.assert(); return {}; } };
      },
      run: async (record, assertCurrent) => {
        update("executing", "dispatching"); assertCurrent(); calls++; process.send({ event: "dispatching" });
        await gate; update("succeeded", "succeeded");
      }
    });
    service.recover();
    const server = createServer(async (request, response) => {
      try {
        const action = store.read()[0].action;
        const result = request.method === "POST" ? await service.commit({ actionId: action.id, expectedDigest: action.payloadDigest }) : action;
        if (request.url === "/disconnect") { response.destroy(); return; }
        response.end(JSON.stringify({ action: result, calls, active: service.active(), now: clock }));
      } catch (error) { response.statusCode = 503; response.end(JSON.stringify({ code: error.code })); }
    });
    server.listen(0, "127.0.0.1", () => process.send({ event: "ready", port: server.address().port }));
    process.on("message", (message) => { if (message === "release") release(); if (message === "advance") { clock += 900000; process.send({ event: "advanced" }); } });
    process.on("SIGTERM", async () => { release(); await service.shutdown(); server.close(() => { releaseBackendOwners(); process.exit(0); }); server.closeAllConnections(); });
  `;
  writeFileSync(path.join(root, "worker.mjs"), program);
  const children = [];
  async function start(mode = "dispatching") {
    const child = spawn(process.execPath, [path.join(root, "worker.mjs"), data, mode], { cwd: root, env: { PATH: process.env.PATH }, stdio: ["ignore", "ignore", "pipe", "ipc"] });
    const exited = once(child, "exit"); const events = []; let stderr = "";
    child.on("message", (message) => events.push(message)); child.stderr.on("data", (bytes) => { stderr = (stderr + bytes).slice(-2048); });
    const owned = { child, exited, events, stderr: () => stderr }; children.push(owned);
    await until(() => events.some((event) => event.event === "ready"), "owned worker ready", owned);
    return { ...owned, origin: `http://127.0.0.1:${events.find((event) => event.event === "ready").port}` };
  }
  async function dispose() {
    for (const owned of children) await stop(owned, "SIGKILL");
    rmSync(root, { recursive: true, force: true });
  }
  return { data, start, dispose };
}
async function stop(owned, signal = "SIGTERM") {
  if (owned.child.exitCode !== null || owned.child.signalCode !== null) return;
  owned.child.kill(signal); let timer;
  try { await Promise.race([owned.exited, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Owned worker did not exit")), 5000); })]); }
  finally { clearTimeout(timer); if (owned.child.exitCode === null && owned.child.signalCode === null) { owned.child.kill("SIGKILL"); await owned.exited; } }
}
async function until(predicate, description, owned) {
  for (let i = 0; i < 100; i++) {
    if (await predicate()) return;
    if (owned?.child.exitCode !== null && owned?.child.exitCode !== undefined) throw new Error(`Owned worker exited: ${owned.stderr()}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Unobserved fixture precondition: ${description}`);
}
const status = async (worker) => (await fetch(worker.origin)).json();

test("backend-owned execution outlives HTTP disconnect and fifteen minutes of simulated provider work", { timeout: 15000 }, async () => {
  const f = await fixture(); let worker; let request;
  try {
    worker = await f.start();
    request = fetch(`${worker.origin}/disconnect`, { method: "POST" }).catch((error) => error);
    await until(() => worker.events.some((event) => event.event === "dispatching"), "fake provider entered", worker);
    assert.ok((await request) instanceof Error, "fixture response connection is lost after durable claim"); worker.child.send("advance");
    await until(() => worker.events.some((event) => event.event === "advanced"), "fifteen minutes advanced", worker);
    const duplicate = await (await fetch(worker.origin, { method: "POST" })).json();
    assert.equal(duplicate.action.state, "executing"); assert.equal(duplicate.calls, 1); assert.equal(duplicate.active, 1);
    assert.equal(duplicate.now - Date.parse(duplicate.action.createdAt), 900000);
    assert.equal((await status(worker)).action.outcomes[0].state, "dispatching");
    worker.child.send("release"); await until(async () => (await status(worker)).action.state === "succeeded", "retained success", worker);
    await stop(worker); worker = await f.start();
    const replay = await (await fetch(worker.origin, { method: "POST" })).json(); assert.equal(replay.action.state, "succeeded"); assert.equal(replay.calls, 0);
    assert.equal(worker.stderr(), "");
  } finally { if (worker?.child.connected) worker.child.send("release"); await request; await f.dispose(); }
});

test("shutdown before a claim preserves independent approval for one later backend execution", { timeout: 15000 }, async () => {
  const f = await fixture(); let worker;
  try {
    worker = await f.start(); assert.equal((await status(worker)).action.state, "approved"); await stop(worker);
    worker = await f.start(); const response = await (await fetch(worker.origin, { method: "POST" })).json(); assert.equal(response.action.state, "executing");
    await until(() => worker.events.some((event) => event.event === "dispatching"), "first fake call after restart", worker);
    worker.child.send("release"); await until(async () => (await status(worker)).action.state === "succeeded", "success after restart", worker);
    assert.equal((await status(worker)).calls, 1); assert.equal(worker.stderr(), "");
  } finally { if (worker?.child.connected) worker.child.send("release"); await f.dispose(); }
});

for (const mode of ["before-dispatch", "dispatching"]) {
  test(`restart after ${mode} retains one claim and never automatically resumes`, { timeout: 15000 }, async () => {
    const f = await fixture(); let worker;
    try {
      worker = await f.start(mode); const response = await (await fetch(worker.origin, { method: "POST" })).json();
      assert.equal(response.action.state, "executing");
      await until(() => worker.events.some((event) => event.event === (mode === "before-dispatch" ? "claimed" : "dispatching")), mode, worker);
      await stop(worker, "SIGKILL"); worker = await f.start();
      const replay = await (await fetch(worker.origin, { method: "POST" })).json();
      assert.equal(replay.action.state, "uncertain"); assert.equal(replay.calls, 0);
      assert.equal(replay.action.outcomes[0].state, mode === "before-dispatch" ? "not_dispatched" : "uncertain");
      const retained = JSON.parse(readFileSync(path.join(f.data, ".poster-actions.json"), "utf8")).records[0].action;
      assert.deepEqual(retained, replay.action); assert.equal(worker.stderr(), "");
    } finally { if (worker?.child.connected) worker.child.send("release"); await f.dispose(); }
  });
}
