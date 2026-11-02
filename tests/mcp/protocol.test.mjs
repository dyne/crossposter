import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { controlTools } from "../../dist/mcp/lib/control/contracts.js";
import { backendFixture, connectBridge, packageVersion } from "./support.mjs";

const content = { title: "", text: "Protocol fixture", linkUrl: "", mediaId: null };
const digest = `sha256:${"0".repeat(64)}`;
const hash = (value) => createHash("sha256").update(JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]])) : item)).digest("hex");
async function call(client, name, input = {}) {
  const result = await client.callTool({ name, arguments: input });
  assert.equal(controlTools[name].outputSchema.safeParse(result.structuredContent).success, true, `${name} returns declared output`);
  assert.equal(result.content.length, 1); assert.equal(result.content[0].type, "text"); assert.ok(result.content[0].text.length < 400);
  return result;
}

test("official client discovers the frozen strict public catalog and rejects inputs before HTTP", { timeout: 30000 }, async () => {
  const fixture = await backendFixture(); let bridge;
  try {
    bridge = await connectBridge(fixture); const { tools } = await bridge.client.listTools();
    assert.equal(tools.length, 13); assert.deepEqual(tools.map((tool) => tool.name), Object.keys(controlTools));
    const snapshot = {};
    for (const tool of tools) {
      const contract = controlTools[tool.name];
      assert.deepEqual(tool.annotations, contract.annotations); assert.deepEqual(tool.inputSchema, contract.publishedInputSchema);
      assert.equal(tool.inputSchema.type, "object"); assert.equal(tool.outputSchema.type, "object");
      assert.ok(tool.description.length > 40);
      snapshot[tool.name] = { input: hash(tool.inputSchema), output: hash(tool.outputSchema), annotations: tool.annotations };
    }
    assert.deepEqual(snapshot, JSON.parse(readFileSync(new URL("./catalog.snapshot.json", import.meta.url), "utf8")));
    const prep = tools.find((tool) => tool.name === "prepare_action").inputSchema;
    const variants = prep.oneOf ?? prep.anyOf; assert.equal(variants.length, 4);
    for (const variant of variants) assert.equal(variant.additionalProperties, false);
    assert.deepEqual(variants.map((variant) => variant.properties.mode.const), ["publish", "schedule", "reschedule", "cancel"]);
    const fieldNames = (value) => Object.entries(value ?? {}).flatMap(([key, item]) => [key, ...(item && typeof item === "object" ? fieldNames(item) : [])]);
    assert.equal(fieldNames(tools.map((tool) => tool.inputSchema)).some((name) => /password|token|authorization|admin|decision/i.test(name)), false);
    for (const input of [
      ["get_status", { arbitrary: true }], ["list_targets", { limit: 0 }],
      ["prepare_action", { mode: "publish", requestKey: "x", content: { ...content, extra: true }, targetIds: ["bluesky:base"] }],
      ["prepare_action", { mode: "schedule", requestKey: "x", content, targetIds: ["bluesky:base"], scheduledFor: "2099-01-01T12:00:00" }],
      ["prepare_action", { mode: "cancel", requestKey: "x", scheduleId: "x", expectedRevision: digest, content }],
      ["commit_action", { actionId: "x", expectedDigest: digest, decision: "approve" }],
      ["upload_media", { localPath: "/tmp/x.png", roots: ["/"] }]
    ]) {
      const result = await bridge.client.callTool({ name: input[0], arguments: input[1] }); assert.equal(result.isError, true);
      assert.match(result.content[0].text, /Control request is invalid/);
    }
    await assert.rejects(bridge.client.callTool({ name: "owner_login", arguments: {} }));
    assert.equal(bridge.stderr(), "");
  } finally { await bridge?.close(); await fixture.close(); }
});

test("all thirteen tools round-trip over real MCP framing against the production control backend", { timeout: 30000 }, async () => {
  const fixture = await backendFixture(); let bridge;
  try {
    bridge = await connectBridge(fixture); const { client } = bridge; await client.listTools();
    const visited = new Set();
    const run = async (name, input) => { visited.add(name); return call(client, name, input); };
    assert.equal((await run("get_status")).structuredContent.data.backendVersion, packageVersion);
    const targets = await run("list_targets"); assert.ok(targets.structuredContent.data.items.some((target) => target.id === "bluesky:base"));
    const draft = (await run("get_draft")).structuredContent.data;
    const file = path.join(fixture.media, "selected ü image.png");
    const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=", "base64"); writeFileSync(file, bytes);
    const media = (await run("upload_media", { localPath: file })).structuredContent.data;
    assert.equal(media.digest, `sha256:${createHash("sha256").update(bytes).digest("hex")}`);
    assert.deepEqual((await run("get_media", { mediaId: media.id })).structuredContent.data, media);
    const saved = (await run("save_draft", { expectedRevision: draft.revision, content: { ...content, mediaId: media.id }, targetIds: ["bluesky:base"] })).structuredContent.data;
    assert.equal((await run("save_draft", { expectedRevision: draft.revision, content, targetIds: [] })).structuredContent.error.code, "revision_conflict");
    const cleared = await run("clear_draft", { expectedRevision: saved.revision }); assert.equal(cleared.structuredContent.data.content.text, "");
    const action = (await run("prepare_action", { mode: "schedule", requestKey: "mcp-stable", content, targetIds: ["bluesky:base"], scheduledFor: "2099-01-01T12:00:00+01:00" })).structuredContent.data;
    assert.equal(action.payload.scheduledFor, "2099-01-01T11:00:00.000Z");
    assert.deepEqual((await run("get_action", { actionId: action.id })).structuredContent.data, action);
    const refused = await run("commit_action", { actionId: action.id, expectedDigest: action.payloadDigest }); assert.equal(refused.isError, true); assert.equal(refused.structuredContent.error.code, "approval_required");
    const loginEndpoint = `${fixture.origin}/api/approvals/session`;
    assert.equal((await fetch(loginEndpoint, { method: "POST", headers: { ...fixture.headers, origin: fixture.origin, "content-type": "application/json" }, body: JSON.stringify({ password: fixture.owner }) })).status, 403);
    const login = await fetch(loginEndpoint, { method: "POST", headers: { origin: fixture.origin, "content-type": "application/json" }, body: JSON.stringify({ password: fixture.owner }) }); assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie").split(";")[0], csrf = (await login.json()).data.csrf;
    const decision = await fetch(`${fixture.origin}/api/approvals/actions/${action.id}`, { method: "POST", headers: { origin: fixture.origin, "content-type": "application/json", cookie, "x-crossposter-csrf": csrf },
      body: JSON.stringify({ decision: "approve", expectedDigest: action.payloadDigest, expectedRevision: action.revision, expiresAt: action.expiresAt }) }); assert.equal(decision.status, 200);
    const committed = await run("commit_action", { actionId: action.id, expectedDigest: action.payloadDigest }); assert.equal(committed.structuredContent.data.state, "scheduled"); assert.equal(committed.isError, false);
    assert.deepEqual((await run("commit_action", { actionId: action.id, expectedDigest: action.payloadDigest })).structuredContent.data, committed.structuredContent.data);
    const queue = await run("list_scheduled_posts"); assert.equal(queue.structuredContent.data.items[0].id, committed.structuredContent.data.scheduleId);
    const retained = queue.structuredContent.data.items[0];
    for (const [mode, fields] of [["publish", { content, targetIds: ["bluesky:base"] }],
      ["reschedule", { scheduleId: retained.id, expectedRevision: retained.revision, scheduledFor: "2099-01-02T12:00:00Z" }],
      ["cancel", { scheduleId: retained.id, expectedRevision: retained.revision }]]) {
      const prepared = await run("prepare_action", { mode, requestKey: `mcp-${mode}`, ...fields });
      assert.equal(prepared.structuredContent.data.payload.mode, mode); assert.equal(prepared.structuredContent.data.state, "prepared");
    }
    const posts = await run("list_posts"); assert.ok(posts.structuredContent.data.items.length > 0);
    assert.equal((await run("get_post", { postId: posts.structuredContent.data.items[0].id })).structuredContent.ok, true);
    assert.deepEqual([...visited].sort(), Object.keys(controlTools).sort());
    for (const secret of [fixture.credential.token, fixture.owner, fixture.provider, fixture.data]) assert.equal(JSON.stringify(committed).includes(secret), false);
    assert.equal(bridge.stderr(), "");
  } finally { await bridge?.close(); await fixture.close(); }
});

test("typed protocol fixture preserves partial/uncertain outcomes and rejects unauthorized, mismatched and invalid backends", { timeout: 30000 }, async () => {
  const fixture = await backendFixture(); let bridge; let mode = "normal"; const paths = [];
  const target = { id: "bluesky:base", platform: "bluesky", profileId: null, label: "Fixture" };
  const post = (state) => ({ id: "retained", createdAt: "2020-01-01T12:00:00Z", content, targets: [target], outcomes: [{ target, state: state === "partial" ? "failed" : "uncertain", message: "Recorded outcome.", url: null }], state, actionId: null });
  const proxy = createServer(async (request, response) => {
    paths.push(request.url);
    let result;
    if (mode === "unauthorized") { response.statusCode = 401; result = { ok: false, error: { code: "unauthorized", message: "untrusted-backend-secret", retryable: false } }; }
    else if (request.url.endsWith("/status")) result = { ok: true, data: { apiVersion: "1", backendVersion: mode === "version" ? "wrong" : packageVersion,
      instanceId: mode === "identity" ? digest : fixture.credential.instanceId, scheduler: "disabled", approvalConfigured: true, readinessBasis: "configuration_only" } };
    else if (mode === "invalid") result = { ok: true, data: { secret: "invalid backend shape" } };
    else result = { ok: true, data: post(mode) };
    response.setHeader("content-type", "application/json"); response.end(JSON.stringify(result));
  });
  // Bind the test HTTP fixture to the same explicitly configured endpoint only after
  // stopping Next; it remains a protocol result-mapping test, not provider evidence.
  try {
    await fixture.child.kill("SIGTERM"); await once(fixture.child, "exit");
    proxy.listen(Number(new URL(fixture.origin).port), "127.0.0.1"); await once(proxy, "listening");
    bridge = await connectBridge(fixture); await bridge.client.listTools();
    for (mode of ["partial", "uncertain"]) {
      const result = await call(bridge.client, "get_post", { postId: "retained" });
      assert.equal(result.isError, false, "target failure is retained data, not failure to read the post");
      assert.equal(result.structuredContent.data.state, mode); assert.equal(result.structuredContent.data.outcomes.length, 1); assert.match(result.content[0].text, new RegExp(mode));
    }
    for (mode of ["unauthorized", "version", "identity", "invalid"]) {
      const before = paths.length; const result = await call(bridge.client, "get_post", { postId: "retained" });
      assert.equal(result.isError, true); assert.equal(result.structuredContent.error.code, mode === "unauthorized" ? "unauthorized" : mode === "invalid" ? "backend_unavailable" : "instance_mismatch");
      if (mode !== "invalid") assert.equal(paths.length, before + 1, "identity check stops before target operation");
      assert.equal(JSON.stringify(result).includes("untrusted-backend-secret"), false);
    }
    assert.equal(paths.some((url) => url.includes("approvals")), false); assert.equal(bridge.stderr(), "");
  } finally { await bridge?.close(); proxy.closeAllConnections(); if (proxy.listening) await new Promise((resolve) => proxy.close(resolve)); await fixture.close(); }
});
