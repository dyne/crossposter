import * as fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { freezeClock, useDataRoot as isolatedDataRoot } from "./support/sandbox";
import { imageFile } from "./support/fixtures";
import { releaseBackendOwners } from "@/lib/control/backend-ownership";
import type { ActionRecord, StoredAction } from "@/lib/control/action-store";
import type { ExecutionDependencies, ExecutionService } from "@/lib/control/execution-service";

const origin = "http://127.0.0.1:2004";
const input = { mode: "publish", requestKey: "execution", content: { title: "", text: "Exact approved content", linkUrl: "", mediaId: null as string | null }, targetIds: ["bluesky:base"] };
const pending = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; };
const services: ExecutionService[] = [];
beforeEach(() => { freezeClock(); });
afterEach(async () => { await Promise.allSettled(services.splice(0).map((service) => service.shutdown())); releaseBackendOwners(); });

async function fixture() {
  const root = isolatedDataRoot(); const filename = path.join(root, "poster.config.local.json");
  const config = { values: { BLUESKY_IDENTIFIER: "fixture.example", BLUESKY_APP_PASSWORD: "fixture-execution-secret", POSTER_ADMIN_PASSWORD: "independent-fixture-password" } };
  fs.writeFileSync(filename, JSON.stringify(config));
  const { controlInstanceId } = await import("@/lib/control/auth");
  const rootBinding = `sha256:${createHash("sha256").update(fs.realpathSync(root)).digest("hex")}`; const backendId = randomUUID();
  const credential = { version: 1, rootBinding, backendId, instanceId: controlInstanceId(rootBinding, backendId), token: "ef".repeat(32), origin };
  fs.writeFileSync(path.join(root, ".poster-control.json"), JSON.stringify(credential), { mode: 0o600 });
  const { backendActionDependencies } = await import("@/lib/control/action-backend");
  const { createActionService } = await import("@/lib/control/action-service");
  const { createExecutionService } = await import("@/lib/control/execution-service");
  const { actionRevision } = await import("@/lib/control/action-store");
  const deps = backendActionDependencies(root, credential.token); const actions = createActionService(deps);
  const current = (id: string) => deps.readRecords().find((item) => item.action.id === id)!;
  const update = (id: string, updateAction: (action: StoredAction) => StoredAction) => {
    const record = current(id); const action = updateAction(record.action); action.revision = actionRevision(action);
    return deps.saveRecord({ ...record, action }, record.action.revision);
  };
  const approve = async (action: StoredAction) => actions.decide(action.id, { decision: "approve", expectedDigest: action.payloadDigest, expectedRevision: action.revision, expiresAt: action.expiresAt }, () => {});
  const make = (run?: ExecutionDependencies["run"], overrides: Partial<ExecutionDependencies> = {}) => {
    const service = createExecutionService({ ...deps, snapshot: actions.executionSnapshot, run, ...overrides }); services.push(service);
    executionBackends.set(root, { token: credential.token, service }); return service;
  };
  const { executionBackends } = await import("@/lib/control/execution-state");
  const publisher = async (overrides: Partial<import("@/lib/control/approved-publisher").ApprovedPublishDependencies> = {}) => {
    const { createApprovedPublisher } = await import("@/lib/control/approved-publisher");
    const { providers } = await import("@/lib/providers"); const { getUploadedMedia } = await import("@/lib/media-store");
    const { appendPublishedPost } = await import("@/lib/local-config");
    return createApprovedPublisher({ ...deps, providers, readUploadedMedia: getUploadedMedia, appendHistory: appendPublishedPost, assertContext: () => {}, ...overrides });
  };
  const post = async (id: string) => {
    const { createControlReadService } = await import("@/lib/control/read-service");
    return createControlReadService({ ...deps, instanceId: credential.instanceId, backendVersion: "fixture", schedulerEnabled: false }).read("get_post", { postId: id });
  };
  const dispatching = (record: ActionRecord) => update(record.action.id, (action) => ({ ...action, outcomes: action.outcomes.map((outcome) => ({ ...outcome, state: "dispatching", message: "Provider dispatch is in progress." })) }));
  const succeed = (record: ActionRecord) => update(record.action.id, (action) => ({ ...action, state: "succeeded", outcomes: action.outcomes.map((outcome) => ({ ...outcome, state: "succeeded", message: "Publication succeeded.", url: "https://example.test/post/1" })) }));
  const commit = (action: StoredAction) => ({ actionId: action.id, expectedDigest: action.payloadDigest });
  return { root, filename, config, credential, deps, actions, current, update, approve, make, dispatching, succeed, commit, publisher, post };
}

describe("approved execution claims", () => {
  it("requires the separate durable approval and never accepts replacement arguments", async () => {
    const f = await fixture(); const run = vi.fn(); const service = f.make(run); const action = await f.actions.prepare(input);
    await expect(service.commit(f.commit(action))).rejects.toMatchObject({ code: "approval_required", actionId: action.id });
    const approved = await f.approve(action);
    for (const extra of [{ content: input.content }, { targetIds: ["mastodon:base"] }, { approved: true }, { scheduledFor: "2099-01-01T00:00:00Z" }]) {
      await expect(service.commit({ ...f.commit(approved), ...extra })).rejects.toMatchObject({ code: "validation_failed" });
    }
    await expect(service.commit({ ...f.commit(approved), expectedDigest: `sha256:${"0".repeat(64)}` })).rejects.toMatchObject({ code: "action_conflict" });
    expect(run).not.toHaveBeenCalled(); expect(f.current(action.id).action.state).toBe("approved");
  });
  it.each(["rejected", "expired", "changed", "unsupported"])("does not claim or dispatch %s actions", async (kind) => {
    const f = await fixture(); const run = vi.fn(); const service = f.make(run);
    const action = await f.actions.prepare(kind === "unsupported" ? { ...input, mode: "schedule", scheduledFor: "2099-01-01T00:00:00Z" } : input);
    if (kind === "rejected") await f.actions.decide(action.id, { decision: "reject", expectedDigest: action.payloadDigest, expectedRevision: action.revision, expiresAt: action.expiresAt }, () => {});
    else await f.approve(action);
    if (kind === "expired") vi.setSystemTime(new Date(action.expiresAt));
    if (kind === "changed") { f.config.values.BLUESKY_APP_PASSWORD = "replacement-secret"; fs.writeFileSync(f.filename, JSON.stringify(f.config)); }
    await expect(service.commit(f.commit(action))).rejects.toMatchObject({ code: ({ rejected: "approval_rejected", expired: "approval_expired", changed: "action_conflict", unsupported: "backend_unavailable" })[kind] });
    expect(run).not.toHaveBeenCalled(); expect(f.current(action.id).action.state).not.toBe("executing");
  });
  it("authenticates the production commit seam and rejects replacement arguments before execution", async () => {
    const f = await fixture(); const action = await f.actions.prepare(input); await f.approve(action);
    const { POST } = await import("@/app/api/mcp/v1/actions/[actionId]/commit/route");
    const { providers } = await import("@/lib/providers"); vi.mocked(providers.bluesky).mockResolvedValue({ platform: "bluesky", ok: true, message: "Fixture" });
    const send = (body: unknown, auth = true) => POST(new Request(`${origin}/api/mcp/v1/actions/${action.id}/commit`, { method: "POST", headers: { host: "127.0.0.1:2004", "content-type": "application/json",
      ...(auth ? { authorization: `Bearer ${f.credential.token}`, "x-crossposter-instance": f.credential.instanceId } : {}) }, body: JSON.stringify(body) }), { params: Promise.resolve({ actionId: action.id }) });
    expect((await send({ expectedDigest: action.payloadDigest }, false)).status).toBe(401);
    expect((await send({ expectedDigest: action.payloadDigest, actionId: action.id })).status).toBe(400);
    expect((await send({ expectedDigest: action.payloadDigest, text: "replacement" })).status).toBe(400);
    const response = await send({ expectedDigest: action.payloadDigest });
    expect(response.status).toBe(200); expect((await response.json()).data).toMatchObject({ id: action.id, state: "executing" });
    const { backendExecution } = await import("@/lib/control/execution-backend"); const worker = backendExecution(f.root, f.credential.token); services.push(worker);
    await worker.settled(); expect(f.current(action.id).action.state).toBe("succeeded"); expect(providers.bluesky).toHaveBeenCalledOnce();
  });
  it("shares one durable execution across concurrent commits while a fifteen-minute-equivalent upload runs", async () => {
    const f = await fixture(); const gate = pending<void>(); let calls = 0;
    const service = f.make(async (record, assertCurrent) => {
      f.dispatching(record); assertCurrent(); calls++; await gate.promise; f.succeed(record);
    });
    const action = await f.actions.prepare(input); await f.approve(action); const attempts = [service.commit(f.commit(action)), service.commit(f.commit(action))];
    try {
      const [first, second] = await Promise.all(attempts); await vi.waitFor(() => expect(calls).toBe(1), { timeout: 500 });
      expect(first.id).toBe(second.id); expect(first.state).toBe("executing"); expect(calls).toBe(1); expect(service.active()).toBe(1);
      expect((await f.actions.get(action.id)).outcomes[0].state).toBe("dispatching");
      vi.setSystemTime(new Date(Date.now() + 15 * 60_000));
      expect((await service.commit(f.commit(action))).state).toBe("executing");
      gate.resolve(); await service.settled(); expect((await f.actions.get(action.id)).state).toBe("succeeded");
      vi.setSystemTime(new Date(action.expiresAt)); expect((await service.commit(f.commit(action))).state).toBe("succeeded"); expect(calls).toBe(1);
    } finally { gate.resolve(); await Promise.allSettled(attempts); await service.settled(); }
  });
  it.each(["account", "media", "draft", "deadline", "owner"])("rechecks %s synchronously in the final claim gap", async (kind) => {
    const f = await fixture(); let prepare: unknown = input; let mutate = () => {};
    if (kind === "media") {
      const { saveUploadedMedia } = await import("@/lib/media-store"); const media = await saveUploadedMedia(imageFile(), origin);
      prepare = { ...input, content: { ...input.content, mediaId: media.id } }; mutate = () => fs.writeFileSync(media.path, Buffer.alloc(media.size, 1));
    } else if (kind === "draft") {
      const draft = { ...input.content, targets: [{ id: "bluesky:base", platform: "bluesky" }], updatedAt: new Date().toISOString() };
      fs.writeFileSync(f.filename, JSON.stringify({ ...f.config, draft })); mutate = () => fs.writeFileSync(f.filename, JSON.stringify({ ...f.config, draft: { ...draft, text: "Changed draft" } }));
    } else if (kind === "account") mutate = () => fs.writeFileSync(f.filename, JSON.stringify({ ...f.config, values: { ...f.config.values, BLUESKY_APP_PASSWORD: "changed-in-gap" } }));
    else if (kind === "owner") mutate = () => fs.unlinkSync(path.join(f.root, ".poster-owner.json"));
    const action = await f.actions.prepare(prepare); await f.approve(action);
    if (kind === "deadline") mutate = () => vi.setSystemTime(new Date(action.expiresAt));
    const run = vi.fn(); const service = f.make(run);
    const media = kind === "media" ? await f.deps.readMedia(action.payload.content.mediaId!) : null;
    if (media) vi.spyOn(f.deps, "readMedia").mockResolvedValueOnce(media);
    const attempt = service.commit(f.commit(action)); const observed = attempt.catch((error) => error.code);
    try {
      if (media) queueMicrotask(mutate); else mutate();
      expect(await observed).toBe(kind === "deadline" ? "approval_expired" : kind === "owner" ? "ownership_conflict" : "action_conflict");
      expect(run).not.toHaveBeenCalled(); expect(f.current(action.id).action.state).toBe("approved");
    } finally { await Promise.allSettled([attempt]); if (kind === "owner") expect(() => releaseBackendOwners()).toThrow("Another backend owns this data root."); }
  });
  it.each(["before", "after"])("does not start work when claim storage fails %s replacement", async (boundary) => {
    const f = await fixture(); const action = await f.actions.prepare(input); await f.approve(action); const run = vi.fn();
    const service = f.make(run, { saveRecord: (record, revision) => { if (boundary === "after") f.deps.saveRecord(record, revision); throw new Error("fixture-durability-failure"); } });
    await expect(service.commit(f.commit(action))).rejects.toMatchObject({ actionId: action.id });
    expect(f.current(action.id).action.state).toBe(boundary === "after" ? "executing" : "approved"); expect(run).not.toHaveBeenCalled();
    if (boundary === "before") return;
    const restarted = f.make(run); expect((await restarted.commit(f.commit(action))).state).toBe("uncertain"); expect(run).not.toHaveBeenCalled();
    expect(f.current(action.id).action.outcomes[0].state).toBe("not_dispatched");
  });
  it.each(["account", "shutdown", "deadline"])("refuses %s changed while claim media IO is held", async (change) => {
    const f = await fixture(); const { saveUploadedMedia } = await import("@/lib/media-store"); const media = await saveUploadedMedia(imageFile(), origin);
    const action = await f.actions.prepare({ ...input, content: { ...input.content, mediaId: media.id } }); await f.approve(action);
    const gate = pending<void>(); const read = f.deps.readMedia; let entered = false;
    vi.spyOn(f.deps, "readMedia").mockImplementationOnce(async (id) => { entered = true; await gate.promise; return read(id); });
    const run = vi.fn(); const service = f.make(run); const attempt = service.commit(f.commit(action)); const observed = attempt.catch((error) => error.code);
    try {
      expect(entered).toBe(true);
      if (change === "account") fs.writeFileSync(f.filename, JSON.stringify({ ...f.config, values: { ...f.config.values, BLUESKY_APP_PASSWORD: "changed-during-io" } }));
      if (change === "shutdown") await service.shutdown();
      if (change === "deadline") vi.setSystemTime(new Date(action.expiresAt));
      gate.resolve(); expect(await observed).toBe(({ account: "action_conflict", shutdown: "backend_unavailable", deadline: "approval_expired" })[change]);
      expect(run).not.toHaveBeenCalled(); expect(f.current(action.id).action.state).toBe("approved");
    } finally { gate.resolve(); await Promise.allSettled([attempt]); }
  });
  it("recovers interrupted intent from actual journal bytes without replaying any target", async () => {
    const f = await fixture(); const action = await f.actions.prepare(input); await f.approve(action);
    f.update(action.id, (current) => ({ ...current, state: "executing", outcomes: current.outcomes.map((outcome) => ({ ...outcome, state: "dispatching" })) }));
    releaseBackendOwners(); const run = vi.fn(); const restarted = f.make(run); restarted.recover();
    expect((await restarted.commit(f.commit(action))).state).toBe("uncertain");
    const reloaded = JSON.parse(fs.readFileSync(path.join(f.root, ".poster-actions.json"), "utf8"));
    expect(reloaded.records[0].action.outcomes[0].state).toBe("uncertain"); expect(run).not.toHaveBeenCalled();
  });
  it("stops new claims and dispatch during shutdown, settles the held worker and never retries it", async () => {
    const f = await fixture(); const gate = pending<void>(); let refused = "";
    const service = f.make(async (record, assertCurrent) => {
      f.dispatching(record); assertCurrent(); await gate.promise;
      try { assertCurrent(); } catch (error) { refused = (error as { code: string }).code; }
      f.succeed(record);
    });
    const action = await f.actions.prepare(input); await f.approve(action); let stopped: Promise<void> | undefined;
    try {
      await service.commit(f.commit(action)); await vi.waitFor(() => expect(f.current(action.id).action.outcomes[0].state).toBe("dispatching"), { timeout: 500 });
      stopped = service.shutdown();
      await expect(service.commit(f.commit(action))).rejects.toMatchObject({ code: "backend_unavailable", actionId: action.id });
      expect(service.active()).toBe(1); gate.resolve(); await stopped; expect(refused).toBe("backend_unavailable"); expect(service.active()).toBe(0);
      expect(f.current(action.id).action.state).toBe("succeeded");
    } finally { gate.resolve(); await stopped; await service.settled(); }
  });
});

describe("durable approved target outcomes", () => {
  async function ready(multiple = false) {
    const f = await fixture();
    if (multiple) {
      Object.assign(f.config.values, { MASTODON_INSTANCE: "https://mastodon.example", MASTODON_ACCESS_TOKEN: "fixture-mastodon-secret" });
      fs.writeFileSync(f.filename, JSON.stringify(f.config));
    }
    const { providers } = await import("@/lib/providers");
    vi.mocked(providers.bluesky).mockResolvedValue({ platform: "bluesky", ok: true, message: "Raw provider detail", url: "https://example.test/first?v=identity&token=private" });
    vi.mocked(providers.mastodon).mockResolvedValue({ platform: "mastodon", ok: false, message: "Raw failure with fixture-mastodon-secret" });
    const action = await f.actions.prepare({ ...input, targetIds: multiple ? ["bluesky:base", "mastodon:base"] : input.targetIds }); await f.approve(action);
    return { ...f, providers, action };
  }
  it.each(["succeeded", "failed", "partial", "uncertain"])("retains %s outcomes in actual journal/history and linked post reads without replay", async (expected) => {
    const f = await ready(expected === "partial");
    if (expected === "failed") vi.mocked(f.providers.bluesky).mockResolvedValue({ platform: "bluesky", ok: false, message: "fixture-execution-secret" });
    if (expected === "uncertain") vi.mocked(f.providers.bluesky).mockRejectedValue(Object.assign(new Error(`fixture-execution-secret ${f.root}`), { uncertain: true }));
    const service = f.make(await f.publisher()); await service.commit(f.commit(f.action)); await service.settled();
    const current = f.current(f.action.id).action; expect(current.state).toBe(expected); expect(current.postId).toBe(`action-${f.action.id}`);
    const stored = JSON.parse(fs.readFileSync(path.join(f.root, ".poster-actions.json"), "utf8")).records[0].action;
    expect(stored).toEqual(current); const history = JSON.parse(fs.readFileSync(f.filename, "utf8")).publishedPosts;
    expect(history).toHaveLength(1); expect(history[0].id).toBe(current.postId);
    expect(history[0].results[0].uncertain).toBe(expected === "uncertain" ? true : undefined);
    expect(await f.post(current.postId!)).toMatchObject({ actionId: f.action.id, state: expected, outcomes: current.outcomes });
    for (const secret of ["fixture-execution-secret", "fixture-mastodon-secret", f.root, "Raw provider", "Raw failure"]) expect(JSON.stringify(current) + JSON.stringify(history)).not.toContain(secret);
    if (expected === "succeeded" || expected === "partial") expect(current.outcomes[0].url).toBe("https://example.test/first?v=identity");
    releaseBackendOwners(); const replay = f.make(await f.publisher()); expect((await replay.commit(f.commit(f.action))).state).toBe(expected);
    expect(f.providers.bluesky).toHaveBeenCalledOnce(); expect(f.providers.mastodon).toHaveBeenCalledTimes(expected === "partial" ? 1 : 0);
  });
  it.each(["Error", "TypeError", "non-Error"])("retains uncertainty after fake acceptance followed by an untagged %s rejection", async (kind) => {
    const f = await ready(true); let accepted = 0;
    vi.mocked(f.providers.bluesky).mockImplementation(async () => {
      expect(f.current(f.action.id).action.outcomes[0].state).toBe("dispatching");
      accepted++;
      const detail = `accepted remotely: fixture-execution-secret ${f.root}`;
      if (kind === "Error") throw new Error(detail);
      if (kind === "TypeError") throw new TypeError(detail);
      throw detail;
    });
    const service = f.make(await f.publisher()); await service.commit(f.commit(f.action)); await service.settled();
    const action = await f.actions.get(f.action.id);
    expect(accepted).toBe(1); expect(action.state).toBe("uncertain"); expect(action.outcomes.map((outcome) => outcome.state)).toEqual(["uncertain", "failed"]);
    expect(action.outcomes[0].message).toBe("Publication outcome is uncertain. Inspect the account before another attempt.");
    const retained = JSON.parse(fs.readFileSync(path.join(f.root, ".poster-actions.json"), "utf8")).records[0].action;
    const history = JSON.parse(fs.readFileSync(f.filename, "utf8")).publishedPosts[0];
    expect(retained).toEqual(action); expect(history.results[0].uncertain).toBe(true); expect(history.results[1].uncertain).toBeUndefined();
    expect(await f.post(action.postId!)).toMatchObject({ state: "uncertain", actionId: action.id, outcomes: action.outcomes });
    for (const secret of ["accepted remotely", "fixture-execution-secret", f.root]) expect(JSON.stringify(retained) + JSON.stringify(history)).not.toContain(secret);
    releaseBackendOwners(); const restarted = f.make(await f.publisher());
    expect((await restarted.commit(f.commit(f.action))).state).toBe("uncertain"); expect((await restarted.commit(f.commit(f.action))).id).toBe(action.id);
    expect(accepted).toBe(1); expect(f.providers.bluesky).toHaveBeenCalledOnce(); expect(f.providers.mastodon).toHaveBeenCalledOnce();
  });
  it.each(["before-intent", "after-intent", "after-provider"])("stops at %s storage failure and preserves never-dispatched targets", async (boundary) => {
    const f = await ready(true); const original = f.deps.saveRecord; let injected = false;
    f.deps.saveRecord = (record, revision) => {
      const state = record.action.outcomes[0].state;
      if (!injected && record.action.state === "executing" && (boundary === "after-provider" ? state === "succeeded" : state === "dispatching")) {
        injected = true; if (boundary === "after-intent") original(record, revision);
        throw new Error("fixture-storage-secret");
      }
      return original(record, revision);
    };
    const service = f.make(await f.publisher()); await service.commit(f.commit(f.action)); await service.settled();
    expect(injected).toBe(true); const action = f.current(f.action.id).action;
    expect(action.outcomes.map((outcome) => outcome.state)).toEqual([boundary === "before-intent" ? "not_dispatched" : "uncertain", "not_dispatched"]);
    expect(f.providers.bluesky).toHaveBeenCalledTimes(boundary === "after-provider" ? 1 : 0); expect(f.providers.mastodon).not.toHaveBeenCalled();
    expect(await f.post(action.postId!)).toMatchObject({ outcomes: action.outcomes });
    const replay = f.make(await f.publisher()); await replay.commit(f.commit(f.action)); expect(f.providers.bluesky).toHaveBeenCalledTimes(boundary === "after-provider" ? 1 : 0);
  });
  it("preserves an earlier success when account configuration changes between targets", async () => {
    const f = await ready(true); const gate = pending<void>(); let entered = false;
    vi.mocked(f.providers.bluesky).mockImplementation(async () => { entered = true; await gate.promise; return { platform: "bluesky", ok: true, message: "Succeeded", url: "https://example.test/retained" }; });
    const service = f.make(await f.publisher()); await service.commit(f.commit(f.action));
    try {
      await vi.waitFor(() => expect(entered).toBe(true), { timeout: 500 });
      const config = JSON.parse(fs.readFileSync(f.filename, "utf8")); config.values.MASTODON_ACCESS_TOKEN = "changed-between-targets"; fs.writeFileSync(f.filename, JSON.stringify(config));
      gate.resolve(); await service.settled(); const action = f.current(f.action.id).action;
      expect(action.state).toBe("partial"); expect(action.outcomes.map((item) => item.state)).toEqual(["succeeded", "not_dispatched"]);
      expect(action.outcomes[0].url).toBe("https://example.test/retained"); expect(f.providers.mastodon).not.toHaveBeenCalled();
      expect(await f.post(action.postId!)).toMatchObject({ state: "partial", outcomes: action.outcomes });
    } finally { gate.resolve(); await service.settled(); }
  });
  it.each(["before", "after"])("retains authoritative success and stable post lookup when history storage fails %s replacement", async (boundary) => {
    const f = await ready(); const { appendPublishedPost } = await import("@/lib/local-config");
    const service = f.make(await f.publisher({ appendHistory: (post) => { if (boundary === "after") appendPublishedPost(post); throw new Error("fixture-history-secret"); } }));
    await service.commit(f.commit(f.action)); await service.settled(); const action = f.current(f.action.id).action;
    expect(action.state).toBe("succeeded"); expect(action.outcomes[0].state).toBe("succeeded");
    expect(f.deps.readConfig().publishedPosts).toHaveLength(boundary === "after" ? 1 : 0);
    expect(await f.post(action.postId!)).toMatchObject({ state: "succeeded", actionId: action.id, outcomes: action.outcomes });
    await service.commit(f.commit(f.action)); expect(f.providers.bluesky).toHaveBeenCalledOnce();
  });
  it("rechecks identity synchronously after the final durable intent write", async () => {
    const f = await ready(); const original = f.deps.saveRecord; let changed = false;
    f.deps.saveRecord = (record, revision) => {
      const result = original(record, revision);
      if (!changed && record.action.outcomes[0].state === "dispatching") { changed = true; const config = JSON.parse(fs.readFileSync(f.filename, "utf8")); config.values.BLUESKY_APP_PASSWORD = "changed-in-final-dispatch-boundary"; fs.writeFileSync(f.filename, JSON.stringify(config)); }
      return result;
    };
    const service = f.make(await f.publisher()); await service.commit(f.commit(f.action)); await service.settled();
    expect(changed).toBe(true); expect(f.providers.bluesky).not.toHaveBeenCalled(); expect(f.current(f.action.id).action.outcomes[0].state).toBe("uncertain");
  });
  it("preserves a durable success when ownership is lost before another target", async () => {
    const f = await ready(true); const original = f.deps.saveRecord; let lost = false;
    f.deps.saveRecord = (record, revision) => {
      const result = original(record, revision);
      if (!lost && record.action.state === "executing" && record.action.outcomes[0].state === "succeeded") { lost = true; fs.unlinkSync(path.join(f.root, ".poster-owner.json")); }
      return result;
    };
    const service = f.make(await f.publisher());
    try {
      await service.commit(f.commit(f.action)); await service.settled(); expect(lost).toBe(true);
      const action = await f.actions.get(f.action.id); expect(action.outcomes.map((outcome) => outcome.state)).toEqual(["succeeded", "not_dispatched"]);
      expect(action.outcomes[0].url).toBe("https://example.test/first?v=identity"); expect(f.providers.mastodon).not.toHaveBeenCalled();
      expect(await f.post(action.postId!)).toMatchObject({ outcomes: action.outcomes });
    } finally { await service.settled(); if (lost) expect(() => releaseBackendOwners()).toThrow("Another backend owns this data root."); }
  });
  it("omits a provider URL containing an encoded configured secret without losing known success", async () => {
    const f = await ready(); vi.mocked(f.providers.bluesky).mockResolvedValue({ platform: "bluesky", ok: true, message: "Fixture", url: "https://example.test/post?reference=fixture%2Dexecution%2Dsecret" });
    const service = f.make(await f.publisher()); await service.commit(f.commit(f.action)); await service.settled();
    expect(f.current(f.action.id).action.outcomes[0]).toMatchObject({ state: "succeeded", url: null });
    expect(JSON.stringify(await f.post(`action-${f.action.id}`))).not.toContain("execution%2Dsecret");
  });
  it("uses explicit base/profile values across provider awaits and preserves legacy lookup outside the scope", async () => {
    const f = await fixture(); const config = { ...f.config, profiles: { bluesky: [{ id: "saved", label: "Saved", values: { BLUESKY_IDENTIFIER: "saved.example", BLUESKY_APP_PASSWORD: "saved-provider-secret" } }] }, activeProfiles: { bluesky: "saved" } };
    fs.writeFileSync(f.filename, JSON.stringify(config));
    const action = await f.actions.prepare({ ...input, targetIds: ["bluesky:base", "bluesky:saved"] }); await f.approve(action);
    const { providers } = await import("@/lib/providers"); const { optionalEnv } = await import("@/lib/env"); const observed: unknown[] = [];
    vi.mocked(providers.bluesky).mockImplementation(async (ctx) => { const first = optionalEnv("BLUESKY_IDENTIFIER", ctx.target?.profileId); await Promise.resolve(); observed.push([ctx.target?.id, first, optionalEnv("BLUESKY_IDENTIFIER"), optionalEnv("MASTODON_ACCESS_TOKEN")]); return { platform: "bluesky", ok: true, message: "Fixture" }; });
    const service = f.make(await f.publisher()); await service.commit(f.commit(action)); await service.settled();
    expect(observed).toEqual([["bluesky:base", "fixture.example", "fixture.example", undefined], ["bluesky:saved", "saved.example", "saved.example", undefined]]);
    expect(optionalEnv("BLUESKY_IDENTIFIER")).toBe("saved.example"); expect(f.current(action.id).action.state).toBe("succeeded");
  });
  it("continues an untouched target after a successful browser provider updates its own session", async () => {
    const f = await fixture(); const directory = path.join(f.root, ".x-browser/fixture"); fs.mkdirSync(directory, { recursive: true });
    const cookies = path.join(directory, "Cookies"); fs.writeFileSync(cookies, "original-fixture-session");
    Object.assign(f.config.values, { X_BROWSER_PROFILE_DIR: ".x-browser/fixture" }); fs.writeFileSync(f.filename, JSON.stringify(f.config));
    const action = await f.actions.prepare({ ...input, targetIds: ["x:base", "bluesky:base"] }); await f.approve(action);
    const originalBindings = f.current(action.id).accountBindings;
    const { providers } = await import("@/lib/providers");
    vi.mocked(providers.x).mockImplementation(async () => { fs.writeFileSync(cookies, "updated-by-successful-browser-fixture"); return { platform: "x", ok: true, message: "Fixture", url: "https://example.test/browser-success" }; });
    vi.mocked(providers.bluesky).mockResolvedValue({ platform: "bluesky", ok: true, message: "Fixture", url: "https://example.test/untouched-success" });
    const service = f.make(await f.publisher()); await service.commit(f.commit(action)); await service.settled();
    expect(f.current(action.id).action.state).toBe("succeeded"); expect(providers.x).toHaveBeenCalledOnce(); expect(providers.bluesky).toHaveBeenCalledOnce();
    const retained = f.current(action.id); expect(retained.action.outcomes.map((outcome) => outcome.state)).toEqual(["succeeded", "succeeded"]);
    expect(retained.accountBindings).toEqual(originalBindings);
    expect(await f.post(retained.action.postId!)).toMatchObject({ state: "succeeded", outcomes: retained.action.outcomes });
  });
  it("still rejects a changed pending browser session after another browser target completes", async () => {
    const f = await fixture();
    const base = path.join(f.root, ".x-browser/base"); const saved = path.join(f.root, ".x-browser/saved");
    for (const directory of [base, saved]) { fs.mkdirSync(directory, { recursive: true }); fs.writeFileSync(path.join(directory, "Cookies"), "original-session"); }
    const config = { ...f.config, values: { ...f.config.values, X_BROWSER_PROFILE_DIR: ".x-browser/base" },
      profiles: { x: [{ id: "saved", label: "Saved X", values: { X_BROWSER_PROFILE_DIR: ".x-browser/saved" } }] } };
    fs.writeFileSync(f.filename, JSON.stringify(config));
    const action = await f.actions.prepare({ ...input, targetIds: ["x:base", "x:saved"] }); await f.approve(action); const originalBindings = f.current(action.id).accountBindings;
    const { providers } = await import("@/lib/providers");
    vi.mocked(providers.x).mockImplementation(async () => {
      fs.writeFileSync(path.join(base, "Cookies"), "updated-by-completed-provider"); fs.writeFileSync(path.join(saved, "Cookies"), "changed-pending-session");
      return { platform: "x", ok: true, message: "Fixture", url: "https://example.test/retained" };
    });
    const service = f.make(await f.publisher()); await service.commit(f.commit(action)); await service.settled();
    const retained = f.current(action.id); expect(retained.action.state).toBe("partial"); expect(retained.action.outcomes.map((outcome) => outcome.state)).toEqual(["succeeded", "not_dispatched"]);
    expect(providers.x).toHaveBeenCalledOnce(); expect(retained.accountBindings).toEqual(originalBindings);
  });
  it("still checks the current browser session after persisting its dispatch intent", async () => {
    const f = await fixture(); const directory = path.join(f.root, ".x-browser/current"); fs.mkdirSync(directory, { recursive: true }); const cookies = path.join(directory, "Cookies"); fs.writeFileSync(cookies, "original-session");
    Object.assign(f.config.values, { X_BROWSER_PROFILE_DIR: ".x-browser/current" }); fs.writeFileSync(f.filename, JSON.stringify(f.config));
    const action = await f.actions.prepare({ ...input, targetIds: ["x:base", "bluesky:base"] }); await f.approve(action);
    const original = f.deps.saveRecord; let changed = false;
    f.deps.saveRecord = (record, revision) => {
      const saved = original(record, revision);
      if (!changed && record.action.outcomes[0].state === "dispatching") { changed = true; fs.writeFileSync(cookies, "changed-before-current-call"); }
      return saved;
    };
    const { providers } = await import("@/lib/providers"); const service = f.make(await f.publisher()); await service.commit(f.commit(action)); await service.settled();
    expect(changed).toBe(true); expect(providers.x).not.toHaveBeenCalled(); expect(providers.bluesky).not.toHaveBeenCalled();
    expect(f.current(action.id).action.outcomes.map((outcome) => outcome.state)).toEqual(["uncertain", "not_dispatched"]);
  });
  it("fails closed on cached machine-token rotation without creating another worker", async () => {
    const f = await ready(); const { backendExecution } = await import("@/lib/control/execution-backend");
    const worker = backendExecution(f.root, f.credential.token); services.push(worker);
    const next = { ...f.credential, token: "ac".repeat(32) }; fs.writeFileSync(path.join(f.root, ".poster-control.json"), JSON.stringify(next), { mode: 0o600 });
    expect(() => backendExecution(f.root, next.token)).toThrow("Backend instance does not match.");
    await expect(worker.commit(f.commit(f.action))).rejects.toMatchObject({ code: "instance_mismatch" });
    expect(f.current(f.action.id).action.state).toBe("approved"); expect(f.providers.bluesky).not.toHaveBeenCalled();
  });
  it("purely explains an interrupted production action/post before recovery persistence", async () => {
    const f = await ready(true); f.update(f.action.id, (action) => ({ ...action, state: "executing", postId: `action-${action.id}`,
      outcomes: action.outcomes.map((outcome, index) => ({ ...outcome, state: index ? "not_dispatched" : "dispatching" })) }));
    const before = fs.readFileSync(path.join(f.root, ".poster-actions.json"), "utf8"); const files = fs.readdirSync(f.root);
    expect((await f.actions.get(f.action.id)).outcomes.map((item) => item.state)).toEqual(["uncertain", "not_dispatched"]);
    expect(await f.post(`action-${f.action.id}`)).toMatchObject({ state: "uncertain", actionId: f.action.id });
    expect(fs.readFileSync(path.join(f.root, ".poster-actions.json"), "utf8")).toBe(before); expect(fs.readdirSync(f.root)).toEqual(files);
  });
});
