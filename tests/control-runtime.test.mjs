import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
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

async function stopOwned(child, exited) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM"); let timer;
  const stopped = await Promise.race([exited.then(() => true), new Promise((resolve) => { timer = setTimeout(() => resolve(false), 5000); })])
    .finally(() => clearTimeout(timer));
  if (!stopped) { child.kill("SIGKILL"); await exited; }
}

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

test("production preparations replay after backend restart, reads stay pure and competing backends cannot mutate", { timeout: 30000 }, async () => {
  assert.equal(existsSync(path.join(repository, ".next/BUILD_ID")), true, "build before the production control test");
  const root = mkdtempSync(path.join(tmpdir(), "crossposter-control-runtime-"));
  let child; let exited; let secondChild; let secondExited; let output = "";
  try {
    const app = path.join(root, "app"); const data = path.join(root, "data"); mkdirSync(app); mkdirSync(data);
    for (const entry of [".next", "node_modules", "public"]) symlinkSync(path.join(repository, entry), path.join(app, entry), "dir");
    copyFileSync(path.join(repository, "package.json"), path.join(app, "package.json"));
    const reservation = createServer(); reservation.listen(0, "127.0.0.1"); await once(reservation, "listening");
    const port = reservation.address().port; await new Promise((resolve) => reservation.close(resolve));
    const origin = `http://127.0.0.1:${port}`; assert.equal(bootstrap(data, origin).status, 0);
    const credential = JSON.parse(readFileSync(path.join(data, ".poster-control.json"), "utf8"));
    const bytes = '{"values":{"BLUESKY_IDENTIFIER":"runtime.example","BLUESKY_APP_PASSWORD":"runtime-fixture-password"},"publishedPosts":[],"scheduledPosts":[]}'; writeFileSync(path.join(data, "poster.config.local.json"), bytes);
    const startServer = (selectedPort) => {
      const started = spawn(process.execPath, ["--require", path.join(repository, "tests/e2e/server-guard.cjs"),
        path.join(repository, "node_modules/next/dist/bin/next"), "start", app, "--hostname", "127.0.0.1", "--port", String(selectedPort)],
      { cwd: app, env: { ...env, CROSSPOSTER_APP_ROOT: app, CROSSPOSTER_DATA_DIR: data, POSTER_DISABLE_SCHEDULER: "true" }, stdio: ["ignore", "pipe", "pipe"] });
      for (const stream of [started.stdout, started.stderr]) stream.on("data", (data) => { output = (output + data).slice(-16384); });
      return { child: started, exited: once(started, "exit") };
    };
    ({ child, exited } = startServer(port));
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
    assert.equal((await fetch(`${origin}/api/mcp/v1/actions/missing`, { headers, redirect: "error" })).status, 404);
    assert.equal((await fetch(`${origin}/api/mcp/v1/status`, { headers: { ...headers, origin: "https://evil.example" }, redirect: "error" })).status, 403);
    assert.equal((await fetch(`${origin}/api/mcp/v1/status`, { headers: { ...headers, "x-forwarded-host": "evil.example" }, redirect: "error" })).status, 403);
    assert.equal((await fetch(`${origin}/api/mcp/v1/status`, { headers: { ...headers, "x-forwarded-for": "192.0.2.1" }, redirect: "error" })).status, 403);
    assert.equal(readFileSync(path.join(data, "poster.config.local.json"), "utf8"), bytes);
    assert.equal(existsSync(path.join(data, ".poster-owner.json")), false);
    assert.equal(existsSync(path.join(data, ".poster-actions.json")), false);
    assert.equal(existsSync(path.join(data, ".poster-actions.anchor.json")), false);

    const input = { mode: "publish", requestKey: "runtime-stable", content: { title: " Title ", text: " Runtime preview ", linkUrl: "example.com", mediaId: null }, targetIds: ["bluesky:base"] };
    const prepare = (body = input) => fetch(`${origin}/api/mcp/v1/actions`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body), redirect: "error" });
    const preparedResponse = await prepare(); const prepared = await preparedResponse.json();
    assert.equal(preparedResponse.status, 200, prepared.error?.code); assert.equal(prepared.data.state, "prepared");
    assert.deepEqual(prepared.data.payload.content, { title: "Title", text: "Runtime preview", linkUrl: "https://example.com", mediaId: null });
    assert.equal(prepared.data.accountBindings, undefined); assert.equal(JSON.stringify(prepared).includes("runtime-fixture-password"), false);
    assert.equal(readFileSync(path.join(data, "poster.config.local.json"), "utf8"), bytes); assert.equal(existsSync(path.join(data, ".poster-uploads")), false);
    const journal = readFileSync(path.join(data, ".poster-actions.json"), "utf8");
    assert.deepEqual((await (await fetch(`${origin}/api/mcp/v1/actions/${prepared.data.id}`, { headers })).json()).data, prepared.data);
    assert.equal(readFileSync(path.join(data, ".poster-actions.json"), "utf8"), journal);

    await stopOwned(child, exited); assert.equal(existsSync(path.join(data, ".poster-owner.json")), false);
    ({ child, exited } = startServer(port));
    let restartedReady = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (child.exitCode !== null) throw new Error("Owned restarted backend exited before readiness.");
      try { if ((await fetch(`${origin}/api/mcp/v1/status`, { headers })).status === 200) { restartedReady = true; break; } } catch { /* starting */ }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(restartedReady, true);
    assert.deepEqual((await (await prepare()).json()).data, prepared.data);
    const changed = await prepare({ ...input, content: { ...input.content, text: "Changed" } }); assert.equal(changed.status, 409);
    assert.equal((await changed.json()).error.code, "idempotency_conflict");
    const futurePreparation = await prepare({ ...input, requestKey: "runtime-future", mode: "schedule", scheduledFor: "2099-01-01T13:00:00+01:00" });
    assert.equal(futurePreparation.status, 200); assert.equal((await futurePreparation.json()).data.payload.scheduledFor, "2099-01-01T12:00:00.000Z");
    assert.equal(readFileSync(path.join(data, "poster.config.local.json"), "utf8"), bytes);

    // A retained failed queue item remains cancellable with deleted credentials,
    // an unavailable browser session, absent media and invalid publication text.
    const cancelConfig = JSON.parse(bytes);
    cancelConfig.scheduledPosts = [{ id: "runtime-failed", status: "failed", scheduledFor: "2000-01-01T12:00:00Z", createdAt: "1999-12-01T12:00:00Z", updatedAt: "2000-01-01T12:00:00Z",
      title: "", text: "", platforms: ["x"], targets: [{ id: "x:deleted", platform: "x", profileId: "deleted", profileLabel: "Retained account" }],
      media: { id: "00000000-0000-0000-0000-000000000000.png" }, attempts: 1 }];
    const cancelBytes = JSON.stringify(cancelConfig); writeFileSync(path.join(data, "poster.config.local.json"), cancelBytes);
    const queueResponse = await fetch(`${origin}/api/mcp/v1/scheduled`, { headers }); assert.equal(queueResponse.status, 200);
    const queue = (await queueResponse.json()).data.items.find((item) => item.id === "runtime-failed"); assert.ok(queue);
    const cancelResponse = await prepare({ mode: "cancel", requestKey: "runtime-cancel-invalid", scheduleId: queue.id, expectedRevision: queue.revision });
    const cancellation = await cancelResponse.json(); assert.equal(cancelResponse.status, 200, cancellation.error?.code);
    assert.equal(cancellation.data.state, "prepared"); assert.equal(cancellation.data.payload.media, null);
    assert.equal(cancellation.data.payload.content.mediaId, cancelConfig.scheduledPosts[0].media.id);
    assert.match(cancellation.data.warnings.join(" "), /not verified/i);
    const cancelJournal = readFileSync(path.join(data, ".poster-actions.json"), "utf8");
    assert.deepEqual((await (await fetch(`${origin}/api/mcp/v1/actions/${cancellation.data.id}`, { headers })).json()).data, cancellation.data);
    assert.equal(readFileSync(path.join(data, ".poster-actions.json"), "utf8"), cancelJournal);
    assert.equal(readFileSync(path.join(data, "poster.config.local.json"), "utf8"), cancelBytes);
    assert.equal(existsSync(path.join(data, ".poster-uploads")), false);

    const dashboardRevision = (await (await fetch(`${origin}/api/draft`)).json()).revision;
    const save = () => fetch(`${origin}/api/draft`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedRevision: dashboardRevision, draft: { text: "owner fixture" } }) });
    assert.equal((await save()).status, 200);
    assert.equal(JSON.parse(readFileSync(path.join(data, ".poster-owner.json"), "utf8")).pid, child.pid);
    const upload = (endpoint) => { const form = new FormData(); form.set("file", new Blob(["fixture"], { type: "image/png" }), "fixture.png"); return fetch(`${endpoint}/api/media`, { method: "POST", body: form }); };
    // A second route bundle in the same backend must share the durable owner.
    const firstUpload = await upload(origin); assert.equal(firstUpload.status, 200);
    await firstUpload.json();
    const fixtureBytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=", "base64");
    const binaryUpload = (size = fixtureBytes.length) => fetch(`${origin}/api/mcp/v1/media`, { method: "POST",
      headers: { ...headers, "content-type": "application/octet-stream", "x-crossposter-filename": "runtime.png", "x-crossposter-media-size": String(size) }, body: fixtureBytes });
    const streamedResponse = await binaryUpload(); assert.equal(streamedResponse.status, 200);
    const streamed = await streamedResponse.json(); const oldMedia = streamed.data;
    assert.equal(oldMedia.contentType, "image/png"); assert.equal(oldMedia.kind, "image"); assert.equal(oldMedia.size, fixtureBytes.length);
    assert.equal(oldMedia.digest, `sha256:${createHash("sha256").update(fixtureBytes).digest("hex")}`);
    assert.equal(oldMedia.path, undefined); assert.equal(JSON.stringify(streamed).includes(data), false);
    assert.deepEqual(readFileSync(path.join(data,".poster-uploads",oldMedia.id)), fixtureBytes);
    const mediaDetail = () => fetch(`${origin}/api/mcp/v1/media/${oldMedia.id}`,{headers});
    assert.deepEqual(await (await mediaDetail()).json(), streamed);
    const uploadFiles = readdirSync(path.join(data,".poster-uploads")).sort();
    assert.equal((await binaryUpload(512*1024*1024+1)).status,400); assert.deepEqual(readdirSync(path.join(data,".poster-uploads")).sort(),uploadFiles);
    const streamedPreparation = await prepare({ ...input, requestKey:"runtime-streamed-media", content:{...input.content,mediaId:oldMedia.id} });
    assert.equal(streamedPreparation.status,200);assert.equal((await streamedPreparation.json()).data.payload.media.digest,oldMedia.digest);
    const configFile = path.join(data, "poster.config.local.json");
    const withProfile = JSON.parse(readFileSync(configFile, "utf8"));
    withProfile.profiles = { bluesky: [{ id: "retired", label: "Retired", values: { BLUESKY_IDENTIFIER: "retired.example", BLUESKY_APP_PASSWORD: "retired-fixture-secret" } }] };
    writeFileSync(configFile, JSON.stringify(withProfile));
    const draftRequest = (method, body) => fetch(`${origin}/api/mcp/v1/draft`, { method,
      headers: { ...headers, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const emptyDraft = (await (await draftRequest("GET")).json()).data;
    const oldContent = { title: "", text: "Retained runtime draft", linkUrl: "", mediaId: oldMedia.id };
    const oldDraftResponse = await draftRequest("PUT", { expectedRevision: emptyDraft.revision, content: oldContent, targetIds: ["bluesky:retired"] });
    assert.equal(oldDraftResponse.status, 200); const oldDraft = (await oldDraftResponse.json()).data;
    const retainedConfig = JSON.parse(readFileSync(configFile, "utf8")); const retainedDraft = retainedConfig.draft;
    retainedConfig.profiles = {}; writeFileSync(configFile, JSON.stringify(retainedConfig));
    unlinkSync(path.join(data, ".poster-uploads", oldMedia.id)); unlinkSync(path.join(data, ".poster-uploads", `${oldMedia.id}.json`));
    const beforeRecoveryRead = readFileSync(configFile, "utf8");
    const recoveryResponse = await draftRequest("GET"); assert.equal(recoveryResponse.status, 200);
    const recovery = (await recoveryResponse.json()).data;
    assert.deepEqual(recovery.content, oldContent); assert.deepEqual(recovery.targetIds, ["bluesky:retired"]);
    assert.notEqual(recovery.revision, oldDraft.revision); assert.equal(JSON.stringify(recovery).includes(data), false);
    assert.equal(readFileSync(configFile, "utf8"), beforeRecoveryRead);
    assert.equal((await draftRequest("DELETE", { expectedRevision: oldDraft.revision })).status, 409);
    assert.equal((await draftRequest("DELETE", { expectedRevision: recovery.revision })).status, 200);
    const cleared = (await (await draftRequest("GET")).json()).data;
    assert.equal(cleared.content.mediaId, null); assert.deepEqual(cleared.targetIds, []);

    const restoreOrphan = JSON.parse(readFileSync(configFile, "utf8")); restoreOrphan.draft = retainedDraft; writeFileSync(configFile, JSON.stringify(restoreOrphan));
    const nextUpload = await upload(origin); assert.equal(nextUpload.status, 200); const nextMedia = (await nextUpload.json()).media;
    const orphan = (await (await draftRequest("GET")).json()).data;
    const replaced = await draftRequest("PUT", { expectedRevision: orphan.revision,
      content: { ...oldContent, text: "Recovered runtime draft", mediaId: nextMedia.id }, targetIds: ["bluesky:base"] });
    assert.equal(replaced.status, 200); assert.equal((await replaced.json()).data.content.mediaId, nextMedia.id);
    const savedConfig = readFileSync(path.join(data, "poster.config.local.json"), "utf8");
    const savedMedia = readdirSync(path.join(data, ".poster-uploads")).sort();

    const secondReservation = createServer(); secondReservation.listen(0, "127.0.0.1"); await once(secondReservation, "listening");
    const secondPort = secondReservation.address().port; await new Promise((resolve) => secondReservation.close(resolve));
    const secondOrigin = `http://127.0.0.1:${secondPort}`;
    ({ child: secondChild, exited: secondExited } = startServer(secondPort));
    let secondReady = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (secondChild.exitCode !== null) throw new Error("Owned second fixture backend exited before readiness.");
      try {
        // Its different origin is deliberately forbidden by machine auth. This
        // pure response proves readiness without claiming the shared data root.
        if ((await fetch(`${secondOrigin}/api/mcp/v1/status`, { headers })).status === 403) { secondReady = true; break; }
      } catch { /* starting */ }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(secondReady, true);
    const json = { "content-type": "application/json" };
    assert.equal((await fetch(`${secondOrigin}/api/draft`, { method: "PUT", headers: json, body: '{"draft":{"text":"must not overwrite"}}' })).status, 500);
    assert.equal((await fetch(`${secondOrigin}/api/publish`, { method: "POST", headers: json, body: '{"text":"must not dispatch","platforms":["bluesky"]}' })).status, 500);
    assert.equal((await fetch(`${secondOrigin}/api/scheduled`, { method: "POST", headers: json,
      body: JSON.stringify({ text: "must not enqueue", platforms: ["bluesky"], scheduledFor: "2099-01-01T12:00:00Z" }) })).status, 500);
    assert.equal((await upload(secondOrigin)).status, 400);
    assert.equal(readFileSync(path.join(data, "poster.config.local.json"), "utf8"), savedConfig);
    assert.deepEqual(readdirSync(path.join(data, ".poster-uploads")).sort(), savedMedia);
    unlinkSync(path.join(data, ".poster-owner.json"));
    assert.equal((await save()).status, 500);
    assert.equal((await fetch(`${origin}/api/mcp/v1/actions/${prepared.data.id}`, { headers })).status, 200);
    assert.equal(existsSync(path.join(data, ".poster-owner.json")), false);
    const lost = await prepare({ ...input, requestKey: "lost-owner" }); assert.equal(lost.status, 409);
    assert.equal((await lost.json()).error.code, "ownership_conflict");
    assert.equal(readFileSync(path.join(data, "poster.config.local.json"), "utf8"), savedConfig);
    assert.equal(output.includes(credential.token), false); assert.equal(output.includes("Unexpected browser-test server IO"), false);
  } finally {
    for (const [ownedChild, ownedExit] of [[child, exited], [secondChild, secondExited]]) await stopOwned(ownedChild, ownedExit);
    rmSync(root, { recursive: true, force: true });
  }
});
