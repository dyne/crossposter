import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { chromium, expect } from "@playwright/test";

const repository = fileURLToPath(new URL("..", import.meta.url));
const env = { PATH: process.env.PATH, NODE_ENV: "production", NEXT_TELEMETRY_DISABLED: "1" };
async function stopOwned(child, exited) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM"); let timer;
  const stopped = await Promise.race([exited.then(() => true), new Promise((resolve) => { timer = setTimeout(() => resolve(false), 5000); })]).finally(() => clearTimeout(timer));
  if (!stopped) { child.kill("SIGKILL"); await exited; }
}
test("production browser authority is independent of machine credentials and decisions survive backend restart without dispatch", { timeout: 30000 }, async (t) => {
  assert.equal(existsSync(path.join(repository, ".next/BUILD_ID")), true, "build before the production approval test");
  const root = mkdtempSync(path.join(tmpdir(), "crossposter-approval-runtime-"));
  let child; let exited; let browser; let output = "";
  const ownerPassword = "runtime-independent-owner-canary";
  try {
    const app = path.join(root, "app"); const data = path.join(root, "data"); mkdirSync(app); mkdirSync(data);
    for (const entry of [".next", "node_modules", "public"]) symlinkSync(path.join(repository, entry), path.join(app, entry), "dir");
    copyFileSync(path.join(repository, "package.json"), path.join(app, "package.json"));
    const reservation = createServer(); reservation.listen(0, "127.0.0.1"); await once(reservation, "listening");
    const port = reservation.address().port; await new Promise((resolve) => reservation.close(resolve));
    const origin = `http://127.0.0.1:${port}`;
    const setup = spawnSync(process.execPath, [path.join(repository, "scripts/setup-control.mjs"), "--data-root", data, "--origin", origin], { env, encoding: "utf8" });
    assert.equal(setup.status, 0);
    const credential = JSON.parse(readFileSync(path.join(data, ".poster-control.json"), "utf8"));
    const configFile = path.join(data, "poster.config.local.json");
    const config = { values: { BLUESKY_IDENTIFIER: "runtime.example", BLUESKY_APP_PASSWORD: "runtime-provider-canary" } };
    writeFileSync(configFile, JSON.stringify(config));
    const machine = { authorization: `Bearer ${credential.token}`, "x-crossposter-instance": credential.instanceId };
    const start = async () => {
      child = spawn(process.execPath, ["--require", path.join(repository, "tests/e2e/server-guard.cjs"), path.join(repository, "node_modules/next/dist/bin/next"),
        "start", app, "--hostname", "127.0.0.1", "--port", String(port)], { cwd: app,
        env: { ...env, CROSSPOSTER_APP_ROOT: app, CROSSPOSTER_DATA_DIR: data, POSTER_DISABLE_SCHEDULER: "true" }, stdio: ["ignore", "pipe", "pipe"] });
      exited = once(child, "exit");
      for (const stream of [child.stdout, child.stderr]) stream.on("data", (bytes) => { output = (output + bytes).slice(-16384); });
      for (let attempt = 0; attempt < 100; attempt++) {
        if (child.exitCode !== null) throw new Error("Owned approval backend exited before readiness.");
        try { if ((await fetch(`${origin}/api/mcp/v1/status`, { headers: machine })).status === 200) return; } catch { /* starting */ }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error("Owned approval backend did not become ready.");
    };
    const json = { origin, "content-type": "application/json" };
    const session = (body, headers = {}) => fetch(`${origin}/api/approvals/session`, { method: "POST", headers: { ...json, ...headers }, body: JSON.stringify(body), redirect: "error" });
    const prepared = async (key) => {
      const response = await fetch(`${origin}/api/mcp/v1/actions`, { method: "POST", headers: { ...machine, "content-type": "application/json" },
        body: JSON.stringify({ mode: "publish", requestKey: key, content: { title: "", text: "Production independent preview", linkUrl: "", mediaId: null }, targetIds: ["bluesky:base"] }) });
      assert.equal(response.status, 200); return (await response.json()).data;
    };
    await start();
    assert.equal((await session({ password: ownerPassword })).status, 409);
    assert.equal(existsSync(path.join(data, ".poster-owner.json")), false);
    assert.equal(existsSync(path.join(data, ".poster-actions.json")), false);
    config.values.POSTER_ADMIN_PASSWORD = ownerPassword; const configBytes = JSON.stringify(config); writeFileSync(configFile, configBytes);
    assert.equal((await (await fetch(`${origin}/api/mcp/v1/status`, { headers: machine })).json()).data.approvalConfigured, true);
    assert.equal((await session({ password: credential.token })).status, 401);
    assert.equal((await session({ password: ownerPassword }, machine)).status, 403);
    assert.equal((await session({ password: ownerPassword }, { origin: "https://evil.example" })).status, 403);
    assert.equal((await session({ password: ownerPassword }, { "x-forwarded-host": "evil.example" })).status, 403);
    const action = await prepared("approval-runtime-stable"); const journalFile = path.join(data, ".poster-actions.json"); const before = readFileSync(journalFile, "utf8");
    const commitEndpoint = `${origin}/api/mcp/v1/actions/${action.id}/commit`;
    const commit = (body) => fetch(commitEndpoint, { method: "POST", headers: { ...machine, "content-type": "application/json" }, body: JSON.stringify(body) });
    assert.equal((await commit({ expectedDigest: action.payloadDigest, text: "replacement" })).status, 400);
    const unapprovedCommit = await commit({ expectedDigest: action.payloadDigest });
    assert.equal(unapprovedCommit.status, 401); assert.equal((await unapprovedCommit.json()).error.code, "approval_required");
    assert.equal(readFileSync(journalFile, "utf8"), before);
    const login = await session({ password: ownerPassword }); assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie").split(";")[0]; const csrf = (await login.json()).data.csrf;
    assert.match(login.headers.get("set-cookie"), /HttpOnly; SameSite=Strict; Path=\/api\/approvals; Max-Age=900/);
    assert.equal((await fetch(`${origin}/api/approvals/session`, { headers: { cookie } })).status, 200);
    const endpoint = `${origin}/api/approvals/actions/${action.id}`;
    assert.equal((await fetch(endpoint, { headers: { cookie } })).status, 200);
    assert.equal(readFileSync(journalFile, "utf8"), before);
    const body = { decision: "approve", expectedDigest: action.payloadDigest, expectedRevision: action.revision, expiresAt: action.expiresAt };
    const decide = (headers, replacement = body) => fetch(endpoint, { method: "POST", headers: { ...json, ...headers }, body: JSON.stringify(replacement), redirect: "error" });
    assert.equal((await decide(machine)).status, 403);
    assert.equal((await decide({ cookie: `crossposter-owner=${credential.token}`, "x-crossposter-csrf": credential.token })).status, 401);
    assert.equal((await decide({ cookie })).status, 403);
    assert.equal((await decide({ cookie, "x-crossposter-csrf": csrf, origin: "https://evil.example" })).status, 403);
    assert.equal((await decide({ cookie, "x-crossposter-csrf": csrf }, { ...body, expectedRevision: action.payloadDigest })).status, 409);
    assert.equal(readFileSync(journalFile, "utf8"), before);
    const response = await decide({ cookie, "x-crossposter-csrf": csrf }); assert.equal(response.status, 200);
    const approved = (await response.json()).data; assert.equal(approved.state, "approved"); assert.deepEqual(approved.payload, action.payload);
    const retained = readFileSync(journalFile, "utf8"); const record = JSON.parse(retained).records[0];
    assert.equal(record.ownerDecision.preparationRevision, action.revision); assert.equal(record.ownerDecision.payloadDigest, action.payloadDigest);
    assert.equal((await decide({ cookie, "x-crossposter-csrf": csrf })).status, 200); assert.equal(readFileSync(journalFile, "utf8"), retained);
    assert.equal((await decide({ cookie, "x-crossposter-csrf": csrf }, { ...body, decision: "reject" })).status, 409);
    const machineView = await (await fetch(`${origin}/api/mcp/v1/actions/${action.id}`, { headers: machine })).json();
    assert.deepEqual(machineView.data, approved);
    for (const secret of [ownerPassword, credential.token, cookie.split("=")[1], csrf, "ownerDecision"]) assert.equal(JSON.stringify(machineView).includes(secret), false);
    assert.equal(readFileSync(configFile, "utf8"), configBytes);
    await stopOwned(child, exited); await start();
    assert.equal((await fetch(`${origin}/api/approvals/session`, { headers: { cookie } })).status, 401);
    assert.deepEqual((await (await fetch(`${origin}/api/mcp/v1/actions/${action.id}`, { headers: machine })).json()).data, approved);
    assert.equal(readFileSync(journalFile, "utf8"), retained);
    assert.equal(readFileSync(configFile, "utf8"), configBytes);
    assert.equal(approved.outcomes.every((outcome) => outcome.state === "not_dispatched"), true);
    // Exercise the shipped page, cookie/session and decision adapters together.
    // Only this explicit local backend is reachable from the owned browser.
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext(); const unexpected = [];
    await context.route("**/*", async (route) => {
      const request = route.request(); const url = new URL(request.url());
      if (url.origin !== origin || (url.pathname.startsWith("/api/") && !url.pathname.startsWith("/api/approvals/"))) {
        unexpected.push(`${request.method()} ${url.origin}${url.pathname}`); await route.abort(); return;
      }
      assert.equal(request.headers().authorization, undefined); assert.equal(request.headers()["x-crossposter-instance"], undefined);
      await route.continue();
    });
    await context.routeWebSocket(/.*/, (socket) => { unexpected.push(`WebSocket ${socket.url()}`); socket.close(); });
    const browserAction = await prepared("approval-runtime-browser"); const page = await context.newPage();
    const pageResponse = await page.goto(`${origin}${browserAction.approvalUrl}`);
    assert.equal(pageResponse.headers()["x-frame-options"], "DENY"); assert.match(pageResponse.headers()["content-security-policy"], /frame-ancestors 'none'/);
    await expect(page.getByLabel("Local owner password")).toBeVisible();
    await page.getByLabel("Local owner password").fill(credential.token); await page.getByRole("button", { name: "Sign in to review" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "password was not accepted" })).toBeVisible();
    await page.getByLabel("Local owner password").fill(ownerPassword);
    const [nativeResponse, nativeRequest] = await Promise.all([
      page.waitForNavigation({ waitUntil: "domcontentloaded" }),
      page.waitForRequest((request) => request.isNavigationRequest() && request.frame() === page.mainFrame()),
      page.getByLabel("Local owner password").evaluate((input) => HTMLFormElement.prototype.submit.call(input.form))
    ]);
    const nativeUrl = new URL(nativeRequest.url());
    assert.equal(nativeRequest.method(), "POST"); assert.equal(nativeUrl.pathname, "/api/approvals/session"); assert.equal(nativeUrl.search, "");
    assert.equal(new URLSearchParams(nativeRequest.postData()).get("password"), ownerPassword);
    const nativeHeaders = nativeRequest.headers(); const nativeError = (await nativeResponse.json()).error.code;
    // A browser may send an opaque Origin for a native form under no-referrer.
    // Preserve strict origin refusal; otherwise the form encoding is refused.
    const sameOrigin = nativeHeaders.origin === origin && (!nativeHeaders["sec-fetch-site"] || nativeHeaders["sec-fetch-site"] === "same-origin");
    assert.equal(nativeResponse.status(), sameOrigin ? 400 : 403); assert.equal(nativeError, sameOrigin ? "validation_failed" : "forbidden");
    t.diagnostic(`Native fallback: method=${nativeRequest.method()}, queryKeys=${[...nativeUrl.searchParams.keys()].length}, origin=${nativeHeaders.origin ?? "absent"}, site=${nativeHeaders["sec-fetch-site"] ?? "absent"}, status=${nativeResponse.status()}, code=${nativeError}`);
    assert.equal((await context.cookies()).some((cookie) => cookie.name === "crossposter-owner"), false);
    assert.equal(JSON.parse(readFileSync(journalFile, "utf8")).records.find((record) => record.action.id === browserAction.id).action.state, "prepared");
    await page.goto(`${origin}${browserAction.approvalUrl}`);
    await page.getByLabel("Local owner password").fill(ownerPassword); await page.getByRole("button", { name: "Sign in to review" }).click();
    await expect(page.getByRole("heading", { name: "Ready for your decision" })).toBeFocused();
    await expect(page.getByText(browserAction.payloadDigest, { exact: true })).toBeVisible();
    const ownerCookie = (await context.cookies()).find((item) => item.name === "crossposter-owner");
    assert.equal(ownerCookie.httpOnly, true); assert.equal(ownerCookie.sameSite, "Strict"); assert.equal(ownerCookie.path, "/api/approvals");
    await page.getByRole("button", { name: "Approve", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Approved for later commit" })).toBeFocused();
    assert.equal((await (await fetch(`${origin}/api/mcp/v1/actions/${browserAction.id}`, { headers: machine })).json()).data.state, "approved");
    assert.equal(readFileSync(configFile, "utf8"), configBytes);
    await stopOwned(child, exited); await start(); await page.reload();
    await expect(page.getByLabel("Local owner password")).toBeVisible();
    await page.getByLabel("Local owner password").fill(ownerPassword); await page.getByRole("button", { name: "Sign in to review" }).click();
    await expect(page.getByRole("heading", { name: "Approved for later commit" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Approve", exact: true })).toBeDisabled();
    assert.deepEqual(unexpected, []); await context.close(); await browser.close(); browser = null;
    for (const secret of [ownerPassword, credential.token, cookie.split("=")[1], csrf]) assert.equal(output.includes(secret), false);
    assert.equal(/Unexpected server network|Unexpected server subprocess|EADDRINUSE/.test(output), false);
  } finally { await browser?.close(); await stopOwned(child, exited); rmSync(root, { recursive: true, force: true }); }
});
