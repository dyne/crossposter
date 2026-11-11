import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { cleanEnv, connectBridge, freePort, repository, stopOwned, within } from "./mcp/support.mjs";

test("actual npm tarball preserves runtime/bridge/launcher bytes, excludes private/tests, builds fresh with the lock, and runs both executables from another cwd", { timeout: 180000 }, async () => {
  const root = mkdtempSync(path.join(tmpdir(), "crossposter-mcp-package-"));
  const evidenceParent = process.env.CROSSPOSTER_TEST_EVIDENCE_DIR || path.join(repository, "test-results/mcp-package"); mkdirSync(evidenceParent, { recursive: true });
  const evidence = mkdtempSync(path.join(evidenceParent, "audit-"));
  const hash = (bytes) => createHash("sha256").update(bytes).digest("hex"); const steps = [];
  const run = (name, command, args, cwd, environment = cleanEnv, expectedExit = 0) => {
    const startedAt = new Date().toISOString();
    const result = spawnSync(command, args, { cwd, env: environment, encoding: "utf8", timeout: 100000, maxBuffer: 8 * 1024 * 1024 });
    const completedAt = new Date().toISOString(), log = path.join(evidence, `${name}.log`); writeFileSync(log, result.stdout + result.stderr);
    steps.push({ command: [command, ...args], cwd, startedAt, completedAt, observedAt: new Date().toISOString(), exit: result.status,
      signal: result.signal, log, logSha256: hash(readFileSync(log)), logBytes: readFileSync(log).length });
    writeFileSync(path.join(evidence, "steps.json"), JSON.stringify(steps, null, 2));
    assert.equal(result.status, expectedExit, `${name} exit must match; complete retained diagnostics: ${log}`); return result;
  };
  let child, exited, bridge;
  try {
    const dryRun = JSON.parse(run("pack-dry-run", "npm", ["pack", "--dry-run", "--json", "--cache", "/tmp/crossposter-npm-cache"], repository).stdout)[0];
    const packed = run("pack", "npm", ["pack", "--json", "--pack-destination", root, "--cache", "/tmp/crossposter-npm-cache"], repository);
    const listing = JSON.parse(packed.stdout)[0]; const tarball = path.join(root, listing.filename);
    assert.deepEqual(listing.files, dryRun.files, "actual package paths, byte sizes and modes match the audited dry-run");
    copyFileSync(tarball, path.join(evidence, listing.filename));
    const extracted = path.join(root, "extracted"); mkdirSync(extracted); run("extract", "tar", ["-xzf", tarball, "-C", extracted], root);
    const app = path.join(extracted, "package"); const files = [];
    for (const entry of listing.files) {
      assert.equal(/(^|\/)(?:tests|test-results|coverage|\.gestalt|\.impeccable|\.next|node_modules)(?:\/|$)/.test(entry.path), false, "package excludes test/generated coordination trees");
      assert.equal(/(^|\/)(?:\.poster-|\.instagram-|\.pinterest-|poster\.config\.local|\.env(?:\.|$))/.test(entry.path), false, "package excludes all private control/provider state");
      const source = path.join(repository, entry.path), delivered = path.join(app, entry.path);
      assert.ok(existsSync(source), "every delivered byte has current checkout provenance");
      assert.equal(readFileSync(delivered).equals(readFileSync(source)), true, `runtime bytes match: ${entry.path}`);
      files.push({ path: entry.path, bytes: readFileSync(delivered).length, sha256: hash(readFileSync(delivered)) });
    }
    for (const required of ["bin/crossposter.mjs", "bin/crossposter-mcp.mjs", "mcp/main.ts", "dist/mcp/mcp/main.js", "dist/mcp/mcp/backend.js", "dist/mcp/mcp/upload.js", "dist/mcp/lib/control/credential.js", "scripts/setup-control.mjs", "scripts/codex-crossposter.mjs", "MCP_SETUP.md", "AGENT_POSTING.md", "MCP_DESIGN_ANALYSIS.md"]) assert.ok(files.some((file) => file.path === required), required);
    for (const executable of ["bin/crossposter.mjs", "bin/crossposter-mcp.mjs"]) assert.ok(listing.files.find((file) => file.path === executable).mode & 0o111, `${executable} retains executable mode`);
    // npm intentionally omits package-lock.json from tarballs. Supply the current
    // exact lock only as build evidence, never imply it was a published file.
    copyFileSync(path.join(repository, "package-lock.json"), path.join(app, "package-lock.json"));
    run("locked-install", "npm", ["ci", "--include=dev", "--ignore-scripts", "--prefer-offline", "--no-audit", "--cache", "/tmp/crossposter-npm-cache"], app);
    run("fresh-build", "npm", ["run", "build"], app);
    for (const file of files.filter((item) => item.path.startsWith("dist/mcp/"))) assert.equal(hash(readFileSync(path.join(app, file.path))), file.sha256, "fresh bridge compilation matches packed bytes");
    const caller = path.join(root, "different cwd ü"), data = path.join(root, "data"), media = path.join(root, "media");
    for (const directory of [caller, data, media]) mkdirSync(directory);
    const port = await freePort(), origin = `http://127.0.0.1:${port}`;
    const setupHelp = run("setup-help", process.execPath, [path.join(app, "scripts/setup-control.mjs"), "--help"], caller);
    assert.match(setupHelp.stdout, /Usage: node scripts\/setup-control.mjs --data-root/); assert.equal(setupHelp.stderr, "");
    const debugHelp = run("manual-debug-launcher-help", process.execPath, [path.join(app, "scripts/codex-crossposter.mjs"), "--help"], caller);
    assert.match(debugHelp.stdout, /\.codex-crossposter/); assert.equal(debugHelp.stderr, "");
    const backendHelp = run("backend-help", process.execPath, [path.join(app, "bin/crossposter.mjs"), "--help"], caller);
    assert.match(backendHelp.stdout, /--host 127\.0\.0\.1/); assert.equal(backendHelp.stderr, "");
    const bridgeHelp = run("bridge-help-refused", process.execPath, [path.join(app, "bin/crossposter-mcp.mjs"), "--help"], caller, cleanEnv, 1);
    assert.equal(bridgeHelp.stdout, ""); assert.match(bridgeHelp.stderr, /^Crossposter MCP startup refused\./);
    run("setup", process.execPath, [path.join(app, "scripts/setup-control.mjs"), "--data-root", data, "--origin", origin], caller);
    const credential = JSON.parse(readFileSync(path.join(data, ".poster-control.json"), "utf8"));
    const owner = "package-automated-owner-fixture";
    writeFileSync(path.join(data, "poster.config.local.json"), JSON.stringify({ values: { DEVTO_API_KEY: "scheduler-fixture-api-key" } }));
    child = spawn(process.execPath, [path.join(app, "bin/crossposter.mjs"), "--host", "127.0.0.1", "--port", String(port), "--data-dir", data, "--no-open", "--no-update"], {
      cwd: caller, env: { ...cleanEnv, CROSSPOSTER_APP_ROOT: app, CROSSPOSTER_DATA_DIR: data, CROSSPOSTER_RUN_MODE: "production", POSTER_DISABLE_SCHEDULER: "false",
        POSTER_ADMIN_PASSWORD: owner, CROSSPOSTER_TIMEZONE: "Europe/Berlin",
        CROSSPOSTER_SCHEDULER_FIXTURE_ORIGIN: origin, NODE_OPTIONS: `--import=${path.join(repository, "tests/control-scheduler-guard.mjs")}` }, stdio: ["pipe", "pipe", "pipe"] });
    exited = once(child, "exit"); let output = "";
    writeFileSync(path.join(evidence, "backend.log"), "");
    for (const stream of [child.stdout, child.stderr]) stream.on("data", (bytes) => {
      appendFileSync(path.join(evidence, "backend.log"), bytes); output = (output + bytes).slice(-16384);
    });
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      assert.equal(child.exitCode, null, "packaged launcher remains alive before readiness");
      try { if ((await fetch(`${origin}/api/mcp/v1/status`, { headers: { authorization: `Bearer ${credential.token}`, "x-crossposter-instance": credential.instanceId } })).status === 200) { ready = true; break; } } catch { /* starting */ }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(ready, true);
    let accepted;
    for (const mode of ["legacy", { pin: "2026-07-28" }]) {
      bridge = await connectBridge({ data, media, origin }, {}, { versionNegotiation: { mode } }, path.join(app, "bin/crossposter-mcp.mjs"));
      assert.equal((await bridge.client.listTools()).tools.length, 13);
      assert.equal((await bridge.client.callTool({ name: "get_status", arguments: {} })).structuredContent.data.instanceId, credential.instanceId);
      if (typeof mode === "object") {
        const prepared = (await bridge.client.callTool({ name: "prepare_action", arguments: { mode: "schedule", requestKey: "packaged-disconnect", scheduledFor: new Date(Date.now() + 1500).toISOString(),
          content: { title: "Packaged fixture", text: "Frozen packaged schedule", linkUrl: "", mediaId: null }, targetIds: ["devto:base"] } })).structuredContent.data;
        const headers = { origin, "content-type": "application/json" };
        const login = await fetch(`${origin}/api/approvals/session`, { method: "POST", headers, body: JSON.stringify({ password: owner }) }); assert.equal(login.status, 200);
        const cookie = login.headers.get("set-cookie").split(";")[0], csrf = (await login.json()).data.csrf;
        assert.equal((await fetch(`${origin}/api/approvals/actions/${prepared.id}`, { method: "POST", headers: { ...headers, cookie, "x-crossposter-csrf": csrf },
          body: JSON.stringify({ decision: "approve", expectedDigest: prepared.payloadDigest, expectedRevision: prepared.revision, expiresAt: prepared.expiresAt }) })).status, 200);
        accepted = (await bridge.client.callTool({ name: "commit_action", arguments: { actionId: prepared.id, expectedDigest: prepared.payloadDigest } })).structuredContent.data;
        assert.equal(accepted.state, "scheduled");
      }
      assert.equal(bridge.stderr(), ""); await bridge.close(); bridge = undefined;
    }
    const disconnectedAt = Date.now(); writeFileSync(path.join(data, "fixture-scheduler-release"), "fixture release");
    let completed;
    for (let attempt = 0; attempt < 100; attempt++) {
      completed = (await (await fetch(`${origin}/api/mcp/v1/actions/${accepted.id}`, { headers: { authorization: `Bearer ${credential.token}`, "x-crossposter-instance": credential.instanceId } })).json()).data;
      if (completed.state === "succeeded") break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(completed.state, "succeeded", "persistent packaged backend dispatches the approved schedule after all MCP clients exit");
    assert.equal(child.exitCode, null); assert.equal(output.includes(credential.token), false);
    const events = readFileSync(path.join(data, "fixture-scheduler-events.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(events.some((event) => event.event.startsWith("denied-")), false);
    const pings = events.filter((event) => event.event === "ping" && event.route === "/api/scheduled/tick");
    assert.ok(pings.length > 0); assert.ok(pings.every((event) => event.method === "POST"), "packaged launcher dispatch requests are explicit POSTs");
    assert.equal(events.some((event) => event.event === "request" && !event.route.startsWith("/api/")), false, "no dashboard request starts the packaged scheduler");
    const dispatched = events.filter((event) => event.event === "provider-entered"); assert.equal(dispatched.length, 1); assert.ok(dispatched[0].at >= disconnectedAt);
    assert.equal(output.includes(owner), false); assert.equal(output.includes("scheduler-fixture-api-key"), false);
    const stopped = exited; child.kill("SIGTERM"); await within(stopped, 6000); child = undefined;
    const settledEvents = readFileSync(path.join(data, "fixture-scheduler-events.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const exits = settledEvents.filter((event) => event.event === "exit");
    assert.equal(exits.length, 2); assert.ok(exits.every((event) => event.activeIntervals === 0), "launcher and backend release owned timers");
    assert.equal(existsSync(path.join(data, ".poster-owner.json")), false);
    writeFileSync(path.join(evidence, "scheduler-events.json"), JSON.stringify(settledEvents, null, 2));
    writeFileSync(path.join(evidence, "manifest.json"), JSON.stringify({ tarball: path.join(evidence, listing.filename), tarballSha256: hash(readFileSync(tarball)), files,
      lockSha256: hash(readFileSync(path.join(repository, "package-lock.json"))), sdk: "server/client/core2.4.0", negotiated: ["2025-11-25", "2026-07-28"],
      checks: "all runtime source/dist/launcher bytes matched; fresh locked install/build; packaged launcher POST ticks and MCP from different cwd; approved schedule dispatches once after all MCP clients exit, provider IO intercepted; no dashboard request; launcher/backend timers and owner released", disconnectedAt, providerDispatchedAt: dispatched[0].at,
      cleanup: "both executables stopped and awaited" }, null, 2));
    console.log(`Package audit: ${files.length} delivered files matched; retained manifest ${path.join(evidence, "manifest.json")}`);
  } finally { await bridge?.close(); await stopOwned(child, exited); rmSync(root, { recursive: true, force: true }); }
});
