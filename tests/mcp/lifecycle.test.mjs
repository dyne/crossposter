import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { backendFixture, cleanEnv, connectBridge, repository, wireFixture, within } from "./support.mjs";

const content = { title: "", text: "Executable fixture", linkUrl: "", mediaId: null };
const digest = `sha256:${"0".repeat(64)}`;
const target = { id: "bluesky:base", platform: "bluesky", profileId: null, label: "Fixture" };
function action(state = "executing") {
  return { id: "retained-action", revision: digest, payloadDigest: digest, payload: { mode: "publish", content,
    targets: [{ ...target, identityRevision: digest }], media: null, draftRevision: null }, state,
    createdAt: "2026-01-01T12:00:00Z", expiresAt: "2099-01-01T12:00:00Z", approvalUrl: "/approvals/retained-action",
    timezone: "Europe/Berlin", scheduledLocal: null, warnings: [], outcomes: [{ target, state: "not_dispatched", message: "Retained.", url: null }], postId: null, scheduleId: null };
}
const call = (bridge, name, input = {}, options) => bridge.client.callTool({ name, arguments: input }, options);
const bridgeEnv = (f) => ({ ...cleanEnv, CROSSPOSTER_DATA_DIR: f.data, CROSSPOSTER_MCP_ENDPOINT: f.origin, CROSSPOSTER_MCP_MEDIA_ROOTS: JSON.stringify([f.media]) });

test("actual executable serves modern and legacy SDK framing concurrently; EOF/SIGTERM/SIGINT leave the production backend and approved schedule alive", { timeout: 30000 }, async () => {
  const f = await backendFixture(); const bridges = [];
  try {
    const legacy = await connectBridge(f), modern = await connectBridge(f, {}, { versionNegotiation: { mode: { pin: "2026-07-28" } } }); bridges.push(legacy, modern);
    assert.equal(legacy.client.getNegotiatedProtocolVersion(), "2025-11-25"); assert.equal(modern.client.getNegotiatedProtocolVersion(), "2026-07-28");
    const results = await Promise.all([call(legacy, "get_status"), call(modern, "get_status")]);
    for (const result of results) assert.equal(result.structuredContent.data.instanceId, f.credential.instanceId);
    const prepared = (await call(modern, "prepare_action", { mode: "schedule", requestKey: "lifecycle-schedule", content, targetIds: [target.id], scheduledFor: "2099-01-01T12:00:00Z" })).structuredContent.data;
    const login = await fetch(`${f.origin}/api/approvals/session`, { method: "POST", headers: { origin: f.origin, "content-type": "application/json" }, body: JSON.stringify({ password: f.owner }) }); assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie").split(";")[0], csrf = (await login.json()).data.csrf;
    assert.equal((await fetch(`${f.origin}/api/approvals/actions/${prepared.id}`, { method: "POST", headers: { origin: f.origin, "content-type": "application/json", cookie, "x-crossposter-csrf": csrf },
      body: JSON.stringify({ decision: "approve", expectedDigest: prepared.payloadDigest, expectedRevision: prepared.revision, expiresAt: prepared.expiresAt }) })).status, 200);
    const committed = (await call(modern, "commit_action", { actionId: prepared.id, expectedDigest: prepared.payloadDigest })).structuredContent.data; assert.equal(committed.state, "scheduled");
    for (const [bridge, signal] of [[legacy, null], [modern, "SIGTERM"]]) {
      const child = bridge.transport._process, exited = once(child, "exit");
      if (signal) child.kill(signal); else child.stdin.end();
      const [code, exitSignal] = await within(exited); assert.equal(code, 0); assert.equal(exitSignal, null); bridge.assertProtocol(); assert.equal(bridge.stderr(), "");
      assert.equal(f.child.exitCode, null); assert.equal((await (await fetch(`${f.origin}/api/mcp/v1/scheduled`, { headers: f.headers })).json()).data.items[0].id, committed.scheduleId);
    }
    const interrupted = await connectBridge(f); bridges.push(interrupted); await call(interrupted, "get_status");
    const child = interrupted.transport._process, exited = once(child, "exit"); child.kill("SIGINT"); assert.equal((await within(exited))[0], 0);
    const reattached = await connectBridge(f); bridges.push(reattached);
    assert.equal((await call(reattached, "get_action", { actionId: prepared.id })).structuredContent.data.scheduleId, committed.scheduleId);
  } finally { for (const bridge of bridges) await bridge.close(); await f.close(); }
});

test("startup is explicit and redacted; oversized stdin closes cleanly with bounded protocol-only stdout", { timeout: 15000 }, async () => {
  const f = await wireFixture((_request, response) => response.end('{}'));
  try {
    for (const override of [{ CROSSPOSTER_MCP_ENDPOINT: "" }, { CROSSPOSTER_DATA_DIR: "relative" }, { CROSSPOSTER_MCP_MEDIA_ROOTS: "" },
      { CROSSPOSTER_MCP_ENDPOINT: "http://localhost:2004" }, { CROSSPOSTER_MCP_ENDPOINT: "http://192.0.2.1:2004" },
      { CROSSPOSTER_MCP_ENDPOINT: `${f.origin}/path` }, { CROSSPOSTER_MCP_MEDIA_ROOTS: '["relative"]' }]) {
      const result = spawnSync(process.execPath, [path.join(repository, "bin/crossposter-mcp.mjs")], { cwd: f.root, env: { ...bridgeEnv(f), ...override }, input: "", encoding: "utf8", timeout: 3000 });
      assert.equal(result.status, 1); assert.equal(result.stdout, ""); assert.ok(result.stderr.length < 600); assert.equal(result.stderr.includes(f.credential.token), false); assert.equal(result.stderr.includes(f.data), false);
    }
    const child = spawn(process.execPath, [path.join(repository, "bin/crossposter-mcp.mjs")], { cwd: f.root, env: bridgeEnv(f), stdio: ["pipe", "pipe", "pipe"] });
    const exited = once(child, "exit"); let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; }); child.stderr.on("data", (chunk) => { stderr += chunk; }); child.stdin.on("error", () => {});
    child.stdin.end(Buffer.alloc(1024 * 1024 + 10, 32));
    try { await within(exited); assert.ok(stdout.length < 1024); for (const line of stdout.trim().split("\n").filter(Boolean)) assert.equal(JSON.parse(line).jsonrpc, "2.0"); assert.ok(stderr.length < 200); }
    finally { if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await exited; } }
    assert.equal(f.requests.length, 0, "startup never scans, starts or probes a backend");
  } finally { await f.close(); }
});

test("outage/redirect and lost commit responses retain known action IDs, never invent preparation IDs, and never replay writes", { timeout: 15000 }, async () => {
  let mode = "drop", writes = 0;
  const redirected = await wireFixture((_request, response) => response.end(JSON.stringify({ ok: true, data: action() })));
  const f = await wireFixture(async (request, response) => {
    for await (const chunk of request) assert.ok(chunk.length > 0);
    if (request.method === "POST") { writes++; request.socket.destroy(); }
    else if (mode === "redirect") { response.statusCode = 302; response.setHeader("location", `${redirected.origin}/private`); response.end(); }
    else response.end(JSON.stringify({ ok: true, data: action() }));
  }); let bridge;
  try {
    bridge = await connectBridge(f);
    const result = await call(bridge, "commit_action", { actionId: "retained-action", expectedDigest: digest });
    assert.equal(result.structuredContent.error.code, "backend_unavailable"); assert.equal(result.structuredContent.error.actionId, "retained-action"); assert.equal(writes, 1);
    assert.equal((await call(bridge, "get_action", { actionId: "retained-action" })).structuredContent.data.state, "executing"); assert.equal(writes, 1);
    const preparation = await call(bridge, "prepare_action", { mode: "publish", requestKey: "recover-this-key", content, targetIds: [target.id] });
    assert.equal(preparation.structuredContent.error.actionId, undefined); assert.equal(writes, 2);
    mode = "redirect"; assert.equal((await call(bridge, "get_action", { actionId: "retained-action" })).structuredContent.error.code, "backend_unavailable"); assert.equal(writes, 2);
    assert.equal(redirected.requests.length, 0, "redirect destination receives no request or credential");
    f.server.closeAllConnections(); await new Promise((resolve) => f.server.close(resolve));
    const outage = await call(bridge, "get_action", { actionId: "retained-action" }); assert.equal(outage.structuredContent.error.actionId, "retained-action"); assert.equal(outage.structuredContent.error.code, "backend_unavailable");
    assert.equal(bridge.stderr(), "");
  } finally { await bridge?.close(); await f.close(); await redirected.close(); }
});

test("cancelled accepted requests and EOF abort bridge IO without owning or replaying backend work", { timeout: 15000 }, async () => {
  let entered, release; const accepted = new Promise((resolve) => { entered = resolve; }), gate = new Promise((resolve) => { release = resolve; }); let writes = 0;
  const f = await wireFixture(async (request, response) => {
    for await (const chunk of request) assert.ok(chunk.length > 0);
    if (request.method === "POST") { writes++; entered(); await gate; }
    if (!response.destroyed) response.end(JSON.stringify({ ok: true, data: action() }));
  }); let bridge, reattached, running;
  try {
    bridge = await connectBridge(f); const controller = new AbortController();
    running = call(bridge, "commit_action", { actionId: "retained-action", expectedDigest: digest }, { signal: controller.signal }).catch(() => null);
    await within(accepted); controller.abort(); await within(running); assert.equal(writes, 1);
    const child = bridge.transport._process, exited = once(child, "exit"); child.stdin.end(); assert.equal((await within(exited))[0], 0); release();
    reattached = await connectBridge(f); assert.equal((await call(reattached, "get_action", { actionId: "retained-action" })).structuredContent.data.state, "executing"); assert.equal(writes, 1);
  } finally { release(); await running; await bridge?.close(); await reattached?.close(); await f.close(); }
});

test("upload deadline, rejected roots and oversized declared/chunked responses stay bounded and redacted", { timeout: 15000 }, async () => {
  let mode = "deadline", uploads = 0;
  const f = await wireFixture(async (request, response) => {
    if (request.method === "POST") { uploads++; for await (const chunk of request) assert.ok(chunk.length > 0); return; }
    if (mode === "header") { response.setHeader("content-length", String(8 * 1024 * 1024 + 1)); response.write("x"); return; }
    response.write(JSON.stringify({ ok: true, data: action() }));
    const bytes = Buffer.alloc(512 * 1024, 32);
    for (let index = 0; index < 18 && !response.destroyed; index++) {
      if (!response.write(bytes)) await new Promise((resolve) => {
        const complete = () => { response.off("drain", complete); response.off("close", complete); resolve(); };
        response.once("drain", complete); response.once("close", complete);
      });
    }
    if (!response.destroyed) response.end();
  }); let bridge;
  try {
    const file = path.join(f.media, "image.png"); writeFileSync(file, Buffer.alloc(128 * 1024, 4));
    bridge = await connectBridge(f, { CROSSPOSTER_MCP_UPLOAD_TIMEOUT_MS: "150" });
    const deadline = await within(call(bridge, "upload_media", { localPath: file })); assert.equal(deadline.structuredContent.error.code, "backend_unavailable"); assert.equal(uploads, 1);
    mkdirSync(path.join(f.data, ".x-browser")); const privateFile = path.join(f.data, ".x-browser/session.json"); writeFileSync(privateFile, "private-session-canary");
    const refused = await call(bridge, "upload_media", { localPath: privateFile }); assert.equal(refused.structuredContent.error.code, "forbidden"); assert.equal(uploads, 1);
    for (mode of ["header", "chunked"]) {
      const result = await within(call(bridge, "get_action", { actionId: "retained-action" }), 5000);
      assert.equal(result.structuredContent.error.code, "backend_unavailable"); assert.equal(result.structuredContent.error.actionId, "retained-action"); assert.ok(JSON.stringify(result).length < 1000);
    }
    assert.equal(bridge.stderr(), "");
  } finally { await bridge?.close(); await f.close(); }
});

test("credential replacement or unsafe permissions fail closed without forwarding a mutation", { timeout: 15000 }, async () => {
  const f = await wireFixture((_request, response) => response.end(JSON.stringify({ ok: true, data: action() })));
  const filename = path.join(f.data, ".poster-control.json"), original = readFileSync(filename); let bridge;
  try {
    bridge = await connectBridge(f); assert.equal((await call(bridge, "get_status")).structuredContent.ok, true);
    writeFileSync(filename, JSON.stringify({ ...f.credential, token: "f".repeat(64) }));
    const before = f.requests.length; const rotated = await call(bridge, "commit_action", { actionId: "retained-action", expectedDigest: digest });
    assert.equal(rotated.structuredContent.error.code, "unauthorized"); assert.equal(rotated.structuredContent.error.actionId, "retained-action"); assert.equal(f.requests.length, before);
    writeFileSync(filename, original); chmodSync(filename, 0o644);
    assert.equal((await call(bridge, "get_status")).structuredContent.error.code, "storage_corrupt"); assert.equal(f.requests.length, before);
    assert.equal(bridge.stderr(), "");
  } finally { chmodSync(filename, 0o600); writeFileSync(filename, original); await bridge?.close(); await f.close(); }
});
