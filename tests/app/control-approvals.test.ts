import * as fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { freezeClock, useDataRoot as isolatedDataRoot } from "./support/sandbox";
import { imageFile } from "./support/fixtures";
import { releaseBackendOwners } from "@/lib/control/backend-ownership";
import type { ActionDependencies } from "@/lib/control/action-service";
import type { StoredAction } from "@/lib/control/action-store";

const origin = "http://127.0.0.1:2004";
const password = "fixture-independent-owner-password";
const digest = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const content = { title: "", text: "An exact owner preview", linkUrl: "", mediaId: null as string | null };
const input = { mode: "publish", requestKey: "owner-action", content, targetIds: ["bluesky:base"] };
const decision = (action: StoredAction, choice = "approve") => ({ decision: choice,
  expectedDigest: action.payloadDigest, expectedRevision: action.revision, expiresAt: action.expiresAt });
function request(endpoint: string, method = "GET", body?: unknown, headers: Record<string, string> = {}) {
  return new Request(`${origin}/api/approvals/${endpoint}`, { method,
    headers: { host: "127.0.0.1:2004", ...(method === "GET" ? {} : { origin, "content-type": "application/json" }), ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
}
beforeEach(() => { freezeClock(); });
afterEach(() => { releaseBackendOwners(); });
async function fixture(configured = true) {
  const root = isolatedDataRoot(); const filename = path.join(root, "poster.config.local.json");
  const config = { values: { BLUESKY_IDENTIFIER: "fixture.example", BLUESKY_APP_PASSWORD: "fixture-provider-secret",
    ...(configured ? { POSTER_ADMIN_PASSWORD: password } : {}) } };
  fs.writeFileSync(filename, JSON.stringify(config));
  const { controlInstanceId } = await import("@/lib/control/auth");
  const token = "ab".repeat(32); const rootBinding = digest(fs.realpathSync(root)); const backendId = randomUUID();
  const credential = { version: 1, rootBinding, backendId, instanceId: controlInstanceId(rootBinding, backendId), token, origin };
  fs.writeFileSync(path.join(root, ".poster-control.json"), JSON.stringify(credential), { mode: 0o600 });
  const { readControlConfig, readControlMedia, controlMediaRevision } = await import("@/lib/control/read-storage");
  const { readActionJournal, createActionStore } = await import("@/lib/control/action-store");
  const { createActionService } = await import("@/lib/control/action-service");
  const { assertBackendMutation } = await import("@/lib/control/backend-mutation");
  const { bindControlAccount } = await import("@/lib/control/account-binding");
  const owner = () => assertBackendMutation(root)!;
  const deps: ActionDependencies = { readConfig: () => readControlConfig(root), readRecords: () => readActionJournal(root).records,
    saveRecord: (record, revision = null) => createActionStore(root, owner()).save(record, revision), assertMutation: () => { owner(); },
    readMedia: (id) => readControlMedia(root, id), mediaRevision: (id) => controlMediaRevision(root, id),
    bindAccount: (target) => bindControlAccount(root, token, target), environmentValue: (name) => process.env[name],
    timezone: () => "Europe/Berlin", now: () => new Date(), createId: randomUUID };
  const sessions = await import("@/app/api/approvals/session/route");
  const actions = await import("@/app/api/approvals/actions/[actionId]/route");
  const auth = await import("@/lib/control/owner-auth");
  const service = createActionService(deps);
  const login = async (value = password, headers: Record<string, string> = {}) => sessions.POST(request("session", "POST", { password: value }, headers));
  const browser = async () => {
    const response = await login(); expect(response.status).toBe(200);
    const session = (await response.json()).data;
    return { cookie: response.headers.get("set-cookie")!.split(";")[0], "x-crossposter-csrf": session.csrf };
  };
  const decide = (action: StoredAction, body: unknown, headers: Record<string, string>) => actions.POST(request(`actions/${action.id}`, "POST", body, headers), { params: Promise.resolve({ actionId: action.id }) });
  const read = (id: string, headers: Record<string, string>) => actions.GET(request(`actions/${id}`, "GET", undefined, headers), { params: Promise.resolve({ actionId: id }) });
  const journal = () => fs.readFileSync(path.join(root, ".poster-actions.json"), "utf8");
  return { root, config, filename, token, credential, deps, service, sessions, actions, auth, login, browser, decide, read, journal };
}
describe("independent browser owner authority", () => {
  it("keeps unauthenticated GETs pure and creates no ownership, journal or session", async () => {
    const f = await fixture(); const files = fs.readdirSync(f.root);
    expect((await f.sessions.GET(request("session"))).status).toBe(401);
    expect((await f.read("absent", {})).status).toBe(401);
    expect(fs.readdirSync(f.root)).toEqual(files);
  });
  it.each(["missing", "placeholder", "machine", "oversized", "newline"])("fails closed with %s owner setup", async (kind) => {
    const f = await fixture(false);
    const values = { placeholder: "your-password", machine: f.token, oversized: "a".repeat(1025), newline: "owner\npassword" };
    if (kind !== "missing") { Object.assign(f.config.values, { POSTER_ADMIN_PASSWORD: values[kind as keyof typeof values] }); fs.writeFileSync(f.filename, JSON.stringify(f.config)); }
    expect(f.auth.ownerApprovalConfigured(f.root)).toBe(false);
    const response = await f.login(kind === "machine" ? f.token : password);
    expect(response.status).toBe(409); expect((await response.json()).error.code).toBe("approval_setup_required");
    expect(response.headers.has("set-cookie")).toBe(false);
  });
  it.each(["local", "environment", "legacy"])("reuses the independent %s admin-password setting", async (source) => {
    const f = await fixture(source === "local");
    if (source === "environment") vi.stubEnv("POSTER_ADMIN_PASSWORD", password);
    if (source === "legacy") fs.writeFileSync(f.filename, JSON.stringify({ ...f.config, POSTER_ADMIN_PASSWORD: password }));
    expect((await f.login()).status).toBe(200);
  });
  it("bounds failed password attempts and permits recovery after the local window", async () => {
    const f = await fixture();
    expect((await f.sessions.POST(request("session", "POST", {}))).status).toBe(400);
    expect((await f.sessions.POST(request("session", "POST", { password, token: f.token }))).status).toBe(400);
    for (let i = 0; i < 5; i++) expect((await f.login("wrong")).status).toBe(401);
    expect((await f.login()).status).toBe(401);
    vi.setSystemTime(new Date(Date.now() + 15 * 60_000));
    expect((await f.login()).status).toBe(200);
  });
  it("never authenticates the machine token as a password, cookie or CSRF secret", async () => {
    const f = await fixture(); const action = await f.service.prepare(input);
    expect((await f.login(f.token)).status).toBe(401);
    expect((await f.decide(action, decision(action), { cookie: `crossposter-owner=${f.token}`, "x-crossposter-csrf": f.token })).status).toBe(401);
    for (const headers of [{ authorization: `Bearer ${f.token}` }, { "x-crossposter-instance": f.credential.instanceId }] as Record<string, string>[]) {
      expect((await f.login(password, headers)).status).toBe(403);
      expect((await f.sessions.GET(request("session", "GET", undefined, headers))).status).toBe(403);
    }
    expect(f.deps.readRecords()[0].action.state).toBe("prepared");
  });
  it.each<Record<string, string>>([
    { origin: "https://evil.example" }, { origin: "null" }, { origin: "" }, { host: "localhost:2004" },
    { "x-forwarded-host": "evil.example" }, { "x-forwarded-for": "192.0.2.1" }, { "x-forwarded-for": "127.0.0.1, 127.0.0.1" },
    { forwarded: "for=127.0.0.1" }, { "x-forwarded-proto": "https" }, { "x-forwarded-port": "80" },
    { "sec-fetch-site": "cross-site" }, { "content-type": "text/plain" }
  ])("rejects substituted browser origin/host metadata %j", async (headers) => {
    const f = await fixture(); expect([400, 403]).toContain((await f.login(password, headers)).status);
  });
  it("requires protected rotating session cookies, CSRF and an unexpired unchanged owner credential", async () => {
    const f = await fixture(); const response = await f.login(); const login = (await response.json()).data;
    expect(response.headers.get("set-cookie")).toMatch(/HttpOnly; SameSite=Strict; Path=\/api\/approvals; Max-Age=900/);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    const cookie = response.headers.get("set-cookie")!.split(";")[0];
    expect((await f.sessions.GET(request("session", "GET", undefined, { cookie }))).status).toBe(200);
    const next = await f.login(password, { cookie }); expect(next.status).toBe(200);
    expect((await f.sessions.GET(request("session", "GET", undefined, { cookie }))).status).toBe(401);
    const browser = await f.browser();
    expect((await f.sessions.DELETE(request("session", "DELETE", {}, { cookie: browser.cookie }))).status).toBe(403);
    expect((await f.sessions.DELETE(request("session", "DELETE", {}, browser))).status).toBe(200);
    expect((await f.sessions.GET(request("session", "GET", undefined, browser))).status).toBe(401);
    const expires = await f.browser(); vi.setSystemTime(new Date(Date.parse(login.expiresAt)));
    expect((await f.sessions.GET(request("session", "GET", undefined, expires))).status).toBe(401);
    const changed = await f.browser(); Object.assign(f.config.values, { POSTER_ADMIN_PASSWORD: "changed-owner-password" }); fs.writeFileSync(f.filename, JSON.stringify(f.config));
    expect((await f.sessions.GET(request("session", "GET", undefined, changed))).status).toBe(401);
  });
});
describe("durable owner decisions", () => {
  it("GET and forged decisions leave exact preparation unchanged", async () => {
    const f = await fixture(); const action = await f.service.prepare(input); const browser = await f.browser(); const before = f.journal();
    expect((await f.read(action.id, browser)).status).toBe(200);
    for (const headers of [{ cookie: browser.cookie }, { ...browser, "x-crossposter-csrf": "wrong" }, { ...browser, origin: "https://evil.example" }]) {
      expect((await f.decide(action, decision(action), headers)).status).toBe(403);
    }
    expect(f.journal()).toBe(before);
  });
  it("keeps all owner credentials, cookies and decision inputs out of the fixed machine catalog", async () => {
    const { controlTools } = await import("@/lib/control/contracts");
    for (const tool of Object.values(controlTools)) {
      const schema = JSON.stringify(tool.publishedInputSchema);
      for (const key of ["password", "token", "cookie", "csrf", "decision"]) expect(schema).not.toContain(`"${key}"`);
    }
  });
  it.each(["approve", "reject"])("persists %s once against the full preparation without enqueue or provider IO", async (choice) => {
    const f = await fixture(); const action = await f.service.prepare(input); const browser = await f.browser(); const config = fs.readFileSync(f.filename, "utf8");
    const response = await f.decide(action, decision(action, choice), browser); expect(response.status).toBe(200);
    const result = (await response.json()).data; expect(result.state).toBe(choice === "approve" ? "approved" : "rejected");
    expect(result.ownerDecision).toBeUndefined(); expect(result.csrf).toBeUndefined();
    expect(result.payload).toEqual(action.payload); expect(result.outcomes.every((item: { state: string }) => item.state === "not_dispatched")).toBe(true);
    const stored = f.deps.readRecords()[0]; expect(stored.ownerDecision).toEqual({ actionId: action.id, payloadDigest: action.payloadDigest,
      preparationRevision: action.revision, expiresAt: action.expiresAt, decision: choice, decidedAt: new Date().toISOString() });
    const before = f.journal(); expect((await f.decide(action, decision(action, choice), browser)).status).toBe(200); expect(f.journal()).toBe(before);
    expect((await f.decide(action, decision(action, choice === "approve" ? "reject" : "approve"), browser)).status).toBe(409);
    releaseBackendOwners(); const restarted = await import("@/lib/control/action-store"); expect(restarted.readActionJournal(f.root).records[0]).toEqual(stored);
    const { controlAction } = await import("@/lib/control/action-http");
    const machineRead = await controlAction(new Request(`${origin}/api/mcp/v1/actions/${action.id}`, { headers: {
      authorization: `Bearer ${f.token}`, "x-crossposter-instance": f.credential.instanceId } }), "get_action", { actionId: action.id });
    const serialized = JSON.stringify(await machineRead.json());
    for (const secret of [password, f.token, browser["x-crossposter-csrf"], browser.cookie.split("=")[1], "ownerDecision"]) expect(serialized).not.toContain(secret);
    expect(fs.readFileSync(f.filename, "utf8")).toBe(config); expect(fs.existsSync(path.join(f.root, ".poster-uploads"))).toBe(false);
  });
  it.each(["expectedDigest", "expectedRevision", "expiresAt"])("refuses a substituted %s", async (field) => {
    const f = await fixture(); const action = await f.service.prepare(input); const browser = await f.browser(); const before = f.journal();
    expect((await f.decide(action, { ...decision(action), [field]: field === "expiresAt" ? "2099-01-01T00:00:00Z" : digest("forged") }, browser)).status).toBe(409);
    expect(f.journal()).toBe(before);
  });
  it("refuses expired actions, sessions and changed publication configuration", async () => {
    const f = await fixture(); const action = await f.service.prepare(input); const browser = await f.browser(); const before = f.journal();
    vi.setSystemTime(new Date(Date.now() + 15 * 60_000)); expect((await f.decide(action, decision(action), browser)).status).toBe(401);
    vi.setSystemTime(new Date(action.expiresAt)); const fresh = await f.browser();
    const expired = await f.decide(action, decision(action), fresh); expect(expired.status).toBe(409); expect((await expired.json()).error.code).toBe("approval_expired");
    vi.setSystemTime(new Date(action.createdAt)); Object.assign(f.config.values, { BLUESKY_APP_PASSWORD: "changed-provider-secret" }); fs.writeFileSync(f.filename, JSON.stringify(f.config));
    expect((await f.decide(action, decision(action), await f.browser())).status).toBe(409); expect(f.journal()).toBe(before);
  });
  it("refuses a schedule whose instant passes before the preparation deadline", async () => {
    const f = await fixture(); const scheduledFor = new Date(Date.now() + 60_000).toISOString();
    const action = await f.service.prepare({ ...input, mode: "schedule", scheduledFor });
    const browser = await f.browser(); const before = f.journal(); vi.setSystemTime(new Date(scheduledFor));
    const response = await f.decide(action, decision(action), browser);
    expect(response.status).toBe(409); expect((await response.json()).error.code).toBe("approval_expired"); expect(f.journal()).toBe(before);
  });
  it("rejects changed media bytes at the owner decision boundary", async () => {
    const f = await fixture(); const { saveUploadedMedia } = await import("@/lib/media-store");
    const media = await saveUploadedMedia(imageFile(), origin); const action = await f.service.prepare({ ...input, content: { ...content, mediaId: media.id } });
    fs.writeFileSync(media.path, Buffer.alloc(media.size, 1)); const before = f.journal();
    const response = await f.decide(action, decision(action), await f.browser());
    expect(response.status).toBe(409); expect((await response.json()).error.code).toBe("action_conflict"); expect(f.journal()).toBe(before);
  });
  it("allows only the unchanged retained cancellation even when publication resources are gone", async () => {
    const f = await fixture();
    const post = { id: "failed-queue", status: "failed", scheduledFor: "2020-01-01T00:00:00Z", createdAt: "2020-01-01T00:00:00Z", updatedAt: "2020-01-01T00:00:00Z",
      text: "", title: "", targets: [{ id: "x:removed", platform: "x", profileId: "removed", profileLabel: "Retained X" }], attempts: 1,
      media: { id: "00000000-0000-0000-0000-000000000000.png" } };
    fs.writeFileSync(f.filename, JSON.stringify({ ...f.config, scheduledPosts: [post] }));
    const { projectControlConfig, projectControlSchedule } = await import("@/lib/control/read-projections");
    const config = f.deps.readConfig(); const revision = projectControlSchedule(config.scheduledPosts[0], projectControlConfig(config, f.deps.environmentValue)).revision;
    const action = await f.service.prepare({ mode: "cancel", requestKey: "stop-broken-queue", scheduleId: post.id, expectedRevision: revision });
    const before = fs.readFileSync(f.filename, "utf8");
    expect((await f.decide(action, decision(action), await f.browser())).status).toBe(200);
    expect(fs.readFileSync(f.filename, "utf8")).toBe(before); expect(f.deps.readRecords()[0].action.state).toBe("approved");
    expect(fs.existsSync(path.join(f.root, ".poster-uploads"))).toBe(false);
  });
  it.each(["account", "draft", "reschedule", "cancel", "local-session", "media", "media-metadata"])("refuses %s changed in the final decision microtask gap", async (change) => {
    const f = await fixture(); let prepare: unknown = input; let mutate: () => void;
    if (change === "account") mutate = () => {
      Object.assign(f.config.values, { BLUESKY_APP_PASSWORD: "changed-in-final-gap" }); fs.writeFileSync(f.filename, JSON.stringify(f.config));
    };
    else if (change === "draft") {
      const draft = { ...content, targets: [{ id: "bluesky:base", platform: "bluesky" }], updatedAt: new Date().toISOString() };
      fs.writeFileSync(f.filename, JSON.stringify({ ...f.config, draft }));
      mutate = () => fs.writeFileSync(f.filename, JSON.stringify({ ...f.config, draft: { ...draft, text: "Changed draft" } }));
    } else if (change === "reschedule" || change === "cancel") {
      const post = { id: "gap-queue", status: "scheduled", scheduledFor: "2099-01-01T00:00:00Z", createdAt: "2020-01-01T00:00:00Z", updatedAt: "2020-01-01T00:00:00Z",
        ...content, targets: [{ id: "bluesky:base", platform: "bluesky" }], attempts: 0 };
      fs.writeFileSync(f.filename, JSON.stringify({ ...f.config, scheduledPosts: [post] }));
      const { projectControlConfig, projectControlSchedule } = await import("@/lib/control/read-projections");
      const config = f.deps.readConfig(); const revision = projectControlSchedule(config.scheduledPosts[0], projectControlConfig(config, f.deps.environmentValue)).revision;
      prepare = { mode: change, requestKey: `gap-${change}`, scheduleId: post.id, expectedRevision: revision,
        ...(change === "reschedule" ? { scheduledFor: "2099-01-02T00:00:00Z" } : {}) };
      mutate = () => fs.writeFileSync(f.filename, JSON.stringify({ ...f.config, scheduledPosts: [{ ...post, text: "Changed queued content" }] }));
    } else if (change === "local-session") {
      const directory = path.join(f.root, ".x-browser/default"); fs.mkdirSync(directory, { recursive: true });
      const cookies = path.join(directory, "Cookies"); fs.writeFileSync(cookies, "old-session-cookie");
      Object.assign(f.config.values, { X_BROWSER_PROFILE_DIR: ".x-browser/default" }); fs.writeFileSync(f.filename, JSON.stringify(f.config));
      prepare = { ...input, targetIds: ["x:base"] };
      mutate = () => fs.writeFileSync(cookies, "new-session-cookie");
    } else {
      const { saveUploadedMedia } = await import("@/lib/media-store"); const media = await saveUploadedMedia(imageFile(), origin);
      prepare = { ...input, content: { ...content, mediaId: media.id } };
      mutate = change === "media-metadata" ? () => fs.writeFileSync(`${media.path}.json`, JSON.stringify({
        ...JSON.parse(fs.readFileSync(`${media.path}.json`, "utf8")), filename: "replacement.png"
      })) : () => fs.writeFileSync(media.path, Buffer.alloc(media.size, 1));
    }
    const action = await f.service.prepare(prepare);
    if (change === "draft") expect(action.payload.draftRevision).not.toBeNull();
    const before = f.journal(); let verifiedMedia = false;
    if (change.startsWith("media")) {
      const media = await f.deps.readMedia(action.payload.content.mediaId!);
      vi.spyOn(f.deps, "readMedia").mockImplementationOnce(async () => { verifiedMedia = true; return media; });
    }
    const pending = f.service.decide(action.id, decision(action), () => {});
    const observed = pending.then(() => "resolved", (error: { code: string }) => error.code);
    try {
      if (change.startsWith("media")) {
        expect(verifiedMedia).toBe(true);
        // The fulfilled media Promise first resumes view's final checks. This
        // queued mutation then runs before decide's awaiting continuation.
        queueMicrotask(mutate);
      } else mutate(); // No-media view has already checked its dependencies.
      expect(await observed).toBe("action_conflict"); expect(f.journal()).toBe(before);
    } finally { await Promise.allSettled([pending]); }
  });
  it("refuses a stale rejection in the no-media decision microtask gap", async () => {
    const f = await fixture(); const action = await f.service.prepare(input); const before = f.journal();
    const pending = f.service.decide(action.id, decision(action, "reject"), () => {});
    const observed = pending.then(() => "resolved", (error: { code: string }) => error.code);
    try {
      Object.assign(f.config.values, { BLUESKY_APP_PASSWORD: "changed-before-rejection" }); fs.writeFileSync(f.filename, JSON.stringify(f.config));
      expect(await observed).toBe("action_conflict"); expect(f.journal()).toBe(before);
    } finally { await Promise.allSettled([pending]); }
  });
  it("keeps final cancellation validation independent of unrelated live publication configuration", async () => {
    const f = await fixture();
    const post = { id: "cancel-live-config", status: "failed", scheduledFor: "2020-01-01T00:00:00Z", createdAt: "2020-01-01T00:00:00Z", updatedAt: "2020-01-01T00:00:00Z",
      text: "", title: "", targets: [{ id: "x:removed", platform: "x", profileId: "removed", profileLabel: "Retained X" }], attempts: 1 };
    fs.writeFileSync(f.filename, JSON.stringify({ ...f.config, scheduledPosts: [post] }));
    const { projectControlConfig, projectControlSchedule } = await import("@/lib/control/read-projections"); const config = f.deps.readConfig();
    const revision = projectControlSchedule(config.scheduledPosts[0], projectControlConfig(config, f.deps.environmentValue)).revision;
    const action = await f.service.prepare({ mode: "cancel", requestKey: "cancel-live-config", scheduleId: post.id, expectedRevision: revision });
    const pending = f.service.decide(action.id, decision(action), () => {});
    try {
      fs.writeFileSync(f.filename, JSON.stringify({ values: { POSTER_ADMIN_PASSWORD: password }, scheduledPosts: [post] }));
      expect((await pending).state).toBe("approved");
      expect(f.deps.readConfig().scheduledPosts).toEqual([post]); expect(fs.existsSync(path.join(f.root, ".poster-uploads"))).toBe(false);
    } finally { await Promise.allSettled([pending]); }
  });
  it.each(["session", "deadline", "account", "decision"])("revalidates %s after held media IO and settles every operation", async (change) => {
    const f = await fixture(); const { saveUploadedMedia } = await import("@/lib/media-store");
    const media = await saveUploadedMedia(imageFile(), origin); const action = await f.service.prepare({ ...input, content: { ...content, mediaId: media.id } });
    const browser = await f.browser(); const before = f.journal();
    let entered = false; let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const read = f.deps.readMedia; const held = vi.spyOn(f.deps, "readMedia").mockImplementationOnce(async (id) => { entered = true; await gate; return read(id); });
    const pending = f.service.decide(action.id, decision(action), () => { f.auth.authenticateOwner(request(`actions/${action.id}`, "POST", {}, browser), f.root, true); });
    // Install a rejection observer before releasing the controlled operation.
    const observed = pending.then(() => "resolved", (error: { code: string }) => error.code);
    try {
      // Reaching the injected read is synchronous up to its first await. Assert
      // that precondition directly instead of waiting on an unbounded signal.
      expect(entered).toBe(true); expect(held).toHaveBeenCalledTimes(1);
      if (change === "session") vi.setSystemTime(new Date(Date.now() + 15 * 60_000));
      if (change === "deadline") vi.setSystemTime(new Date(action.expiresAt));
      if (change === "account") { Object.assign(f.config.values, { BLUESKY_APP_PASSWORD: "replaced-after-await" }); fs.writeFileSync(f.filename, JSON.stringify(f.config)); }
      if (change === "decision") await f.service.decide(action.id, decision(action, "reject"), () => {});
      release();
      expect(await observed).toBe(({ session: "approval_required", deadline: "approval_expired", account: "action_conflict", decision: "revision_conflict" })[change]);
      if (change !== "decision") expect(f.journal()).toBe(before);
      else expect(f.deps.readRecords()[0].action.state).toBe("rejected");
    } finally { release(); await Promise.allSettled([pending]); held.mockRestore(); }
  });
});
