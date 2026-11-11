import * as fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { freezeClock, useDataRoot as isolatedDataRoot } from "./support/sandbox";
import { imageFile } from "./support/fixtures";
import { releaseBackendOwners } from "@/lib/control/backend-ownership";
import type { ActionRecord, StoredAction } from "@/lib/control/action-store";
import type { ExecutionService } from "@/lib/control/execution-service";
import type { ScheduledPost } from "@/lib/types";

const origin = "http://127.0.0.1:2004";
const input = { mode: "schedule", requestKey: "schedule", content: { title: "", text: "Frozen queued content", linkUrl: "", mediaId: null as string | null },
  targetIds: ["bluesky:base"], scheduledFor: "2026-01-16T12:00:00Z" };
const services: ExecutionService[] = [];
async function within<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([operation, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Controlled operation did not settle")), 1000); })]); }
  finally { clearTimeout(timer); }
}
beforeEach(() => { freezeClock(); });
afterEach(async () => { await Promise.allSettled(services.splice(0).map((service) => service.shutdown())); releaseBackendOwners(); });

async function fixture() {
  const root = isolatedDataRoot(); const filename = path.join(root, "poster.config.local.json");
  fs.writeFileSync(filename, JSON.stringify({ values: { BLUESKY_IDENTIFIER: "fixture.example", BLUESKY_APP_PASSWORD: "queue-fixture-secret", POSTER_ADMIN_PASSWORD: "independent-fixture-password" } }));
  const { controlInstanceId } = await import("@/lib/control/auth");
  const rootBinding = `sha256:${createHash("sha256").update(fs.realpathSync(root)).digest("hex")}`; const backendId = randomUUID();
  const credential = { version: 1, rootBinding, backendId, instanceId: controlInstanceId(rootBinding, backendId), token: "fe".repeat(32), origin };
  fs.writeFileSync(path.join(root, ".poster-control.json"), JSON.stringify(credential), { mode: 0o600 });
  const { backendActionDependencies } = await import("@/lib/control/action-backend");
  const { createActionService } = await import("@/lib/control/action-service");
  const { createExecutionService } = await import("@/lib/control/execution-service");
  const { createApprovedQueue } = await import("@/lib/control/queue-service");
  const { upsertScheduledPost, removeScheduledPost, getScheduledPosts, updateScheduledPost, appendPublishedPost } = await import("@/lib/local-config");
  const { createApprovedPublisher } = await import("@/lib/control/approved-publisher");
  const { getUploadedMedia } = await import("@/lib/media-store"); const { providers } = await import("@/lib/providers");
  const { executionBackends } = await import("@/lib/control/execution-state");
  const deps = backendActionDependencies(root, credential.token); const actions = createActionService(deps);
  const config = () => JSON.parse(fs.readFileSync(filename, "utf8"));
  const change = (mutate: (value: ReturnType<typeof config>) => void) => { const value = config(); mutate(value); fs.writeFileSync(filename, JSON.stringify(value)); };
  const current = (id: string) => deps.readRecords().find((record) => record.action.id === id)!;
  const approve = (action: StoredAction) => actions.decide(action.id, { decision: "approve", expectedRevision: action.revision, expectedDigest: action.payloadDigest, expiresAt: action.expiresAt }, () => {});
  const commit = (action: StoredAction) => ({ actionId: action.id, expectedDigest: action.payloadDigest });
  const replace = vi.fn((id: string, post: ScheduledPost | null) => { if (post) upsertScheduledPost(post); else removeScheduledPost(id); });
  const make = (overrides: { saveRecord?: typeof deps.saveRecord; publishSaveRecord?: typeof deps.saveRecord; replace?: typeof replace; appendHistory?: typeof appendPublishedPost; readUploadedMedia?: typeof getUploadedMedia } = {}) => {
    const saveRecord = overrides.saveRecord ?? deps.saveRecord;
    const queue = createApprovedQueue({ ...deps, saveRecord, replace: overrides.replace ?? replace });
    const run = createApprovedPublisher({ ...deps, saveRecord: overrides.publishSaveRecord ?? deps.saveRecord, providers, readUploadedMedia: overrides.readUploadedMedia ?? getUploadedMedia, appendHistory: overrides.appendHistory ?? appendPublishedPost, assertContext: () => {} });
    const service = createExecutionService({ ...deps, saveRecord: (record, revision) => saveRecord(record, revision), snapshot: actions.executionSnapshot, queue, run });
    services.push(service); executionBackends.set(root, { token: credential.token, service }); return service;
  };
  const revision = async (id: string) => {
    const { projectControlConfig, projectControlSchedule } = await import("@/lib/control/read-projections"); const c = deps.readConfig();
    return projectControlSchedule(c.scheduledPosts.find((post) => post.id === id)!, projectControlConfig(c, deps.environmentValue)).revision;
  };
  const queued = async () => { const action = await actions.prepare(input); await approve(action); const saved = await make().commit(commit(action)); return { action: saved, id: saved.scheduleId! }; };
  const { createControlReadService } = await import("@/lib/control/read-service");
  const reads = createControlReadService({ ...deps, instanceId: credential.instanceId, backendVersion: "fixture", schedulerEnabled: false });
  return { root, filename, credential, deps, actions, current, approve, commit, make, replace, config, change, providers, revision, queued,
    getScheduledPosts, updateScheduledPost, reads, appendPublishedPost };
}

describe("approved queue mutations", () => {
  it.each([false, true])("dispatches approved recovery with retained proof after replacement pre-dispatch failure=%s", async (replacementFails) => {
    const f = await fixture(); const { saveUploadedMedia } = await import("@/lib/media-store"); const media = await saveUploadedMedia(imageFile(), origin);
    const prepared = await f.actions.prepare({ ...input, content: { ...input.content, mediaId: media.id } }); await f.approve(prepared);
    const service = f.make({ readUploadedMedia: async () => { throw new Error("Pre-dispatch media validation failed"); } });
    const queued = await service.commit(f.commit(prepared)); vi.setSystemTime(new Date(input.scheduledFor));
    const { runScheduledTick } = await import("@/lib/scheduler"); await runScheduledTick();
    const before = f.getScheduledPosts()[0]; const original = f.current(prepared.id);
    expect(before).toMatchObject({ status: "failed", attempts: 1, results: [{ ok: false }] });
    expect(original.action).toMatchObject({ state: "failed", outcomes: [{ state: "not_dispatched" }] });
    const history = f.config().publishedPosts;
    const { GET: readQueue } = await import("@/app/api/scheduled/route"); const { GET: readDraft } = await import("@/app/api/draft/route");
    const bytesBeforeRead = fs.readFileSync(f.filename, "utf8");
    expect((await (await readQueue()).json()).scheduledPosts[0].outcomes[0].state).toBe("not_dispatched");
    expect((await (await readDraft()).json()).publishedPosts[0].outcomes[0].state).toBe("not_dispatched");
    expect(fs.readFileSync(f.filename, "utf8")).toBe(bytesBeforeRead);
    const action = await f.actions.prepare({ mode: "reschedule", requestKey: "safe-failure", scheduleId: queued.scheduleId!, expectedRevision: await f.revision(queued.scheduleId!), scheduledFor: "2026-01-17T12:00:00Z" });
    await f.approve(action); expect((await f.make().commit(f.commit(action))).state).toBe("rescheduled");
    expect(f.getScheduledPosts()[0]).toMatchObject({ results: before.results, lastError: before.lastError, attempts: 1, publishedPostId: before.publishedPostId });
    expect(f.current(prepared.id)).toEqual(original); expect(f.config().publishedPosts).toEqual(history); expect(f.providers.bluesky).not.toHaveBeenCalled();
    const next = await f.actions.prepare({ mode: "reschedule", requestKey: "safe-second-timing", scheduleId: queued.scheduleId!, expectedRevision: await f.revision(queued.scheduleId!), scheduledFor: "2026-01-18T12:00:00Z" });
    await f.approve(next); expect((await f.make().commit(f.commit(next))).state).toBe("rescheduled");
    expect(f.getScheduledPosts()[0]).toMatchObject({ results: before.results, attempts: 1 });
    expect(f.current(prepared.id)).toEqual(original); expect(f.config().publishedPosts).toEqual(history);
    const intent = f.current(next.id).queueIntent;
    expect(intent).toMatchObject({ results: before.results, lastError: before.lastError, attempts: 1 });
    vi.mocked(f.providers.bluesky).mockResolvedValue({ platform: "bluesky", ok: true, message: "Recovered fixture published" });
    f.make(replacementFails ? { readUploadedMedia: async () => { throw new Error("Replacement pre-dispatch media failure"); } } : {});
    vi.setSystemTime(new Date("2026-01-18T12:00:00Z"));
    await runScheduledTick();
    if (replacementFails) {
      const replacement = f.current(next.id);
      expect(replacement.action).toMatchObject({ state: "failed", outcomes: [{ state: "not_dispatched" }] });
      expect(f.getScheduledPosts()[0]).toMatchObject({ status: "failed", attempts: 2 });
      expect(f.providers.bluesky).not.toHaveBeenCalled();
      const final = await f.actions.prepare({ mode: "reschedule", requestKey: "safe-after-replacement-failure", scheduleId: queued.scheduleId!, expectedRevision: await f.revision(queued.scheduleId!), scheduledFor: "2026-01-19T12:00:00Z" });
      await f.approve(final); await f.make().commit(f.commit(final));
      vi.setSystemTime(new Date("2026-01-19T12:00:00Z"));
      await runScheduledTick();
      expect(f.current(next.id)).toEqual(replacement);
    }
    expect(f.providers.bluesky).toHaveBeenCalledOnce();
    expect(f.getScheduledPosts()).toEqual([]);
    await runScheduledTick();
    expect(f.providers.bluesky).toHaveBeenCalledOnce();
    expect(f.current(prepared.id)).toEqual(original);
    expect(f.current(next.id).queueIntent).toEqual(intent);
    for (const post of history) expect(f.config().publishedPosts).toContainEqual(post);
  });

  it.each(["attempt-without-results", "failed-without-terminal-proof", "unexpected-attempt-count", "results-without-attempt"] as const)("refuses control timing edits for %s", async (kind) => {
    const f = await fixture(); const { id } = await f.queued();
    f.updateScheduledPost(id, (post) => ({ ...post, status: kind === "failed-without-terminal-proof" ? "failed" : "scheduled", attempts: kind === "results-without-attempt" ? 0 : kind === "unexpected-attempt-count" ? 4 : 1,
      ...(kind === "results-without-attempt" ? { results: [{ platform: "bluesky", ok: false, message: "Unexplained result" }] } : {}) }));
    const before = fs.readFileSync(f.filename, "utf8"); const journal = fs.readFileSync(path.join(f.root, ".poster-actions.json"), "utf8");
    await expect(f.actions.prepare({ mode: "reschedule", requestKey: "unproven", scheduleId: id, expectedRevision: await f.revision(id), scheduledFor: "2026-01-17T12:00:00Z" })).rejects.toMatchObject({ code: "revision_conflict" });
    expect(fs.readFileSync(f.filename, "utf8")).toBe(before); expect(fs.readFileSync(path.join(f.root, ".poster-actions.json"), "utf8")).toBe(journal); expect(f.providers.bluesky).not.toHaveBeenCalled();
  });

  it("requires fresh independent approval instead of changing an approved schedule through PATCH", async () => {
    const f = await fixture(); const { id } = await f.queued(); const { PATCH } = await import("@/app/api/scheduled/[id]/route");
    const before = fs.readFileSync(f.filename, "utf8"); const journal = fs.readFileSync(path.join(f.root, ".poster-actions.json"), "utf8");
    const response = await PATCH(new Request(`${origin}/api/scheduled/${id}`, { method: "PATCH", body: "{" }), { params: Promise.resolve({ id }) });
    expect(response.status).toBe(400); expect((await response.json()).error).toMatch(/owner approval/);
    expect(fs.readFileSync(f.filename, "utf8")).toBe(before); expect(fs.readFileSync(path.join(f.root, ".poster-actions.json"), "utf8")).toBe(journal); expect(f.providers.bluesky).not.toHaveBeenCalled();
  });

  it("rejects a held preparation when its previously safe journal evidence changes", async () => {
    const f = await fixture(); const { saveUploadedMedia } = await import("@/lib/media-store"); const media = await saveUploadedMedia(imageFile(), origin);
    const prepared = await f.actions.prepare({ ...input, content: { ...input.content, mediaId: media.id } }); await f.approve(prepared);
    const queued = await f.make().commit(f.commit(prepared)); const id = queued.scheduleId!;
    let release!: () => void; const held = new Promise<void>((resolve) => { release = resolve; });
    const read = f.deps.readMedia; vi.spyOn(f.deps, "readMedia").mockImplementation(async (mediaId) => { await held; return read(mediaId); });
    const preparation = f.actions.prepare({ mode: "reschedule", requestKey: "held-proof", scheduleId: id, expectedRevision: await f.revision(id), scheduledFor: "2026-01-17T12:00:00Z" });
    const settled = Promise.allSettled([preparation]);
    try {
      await vi.waitFor(() => expect(f.deps.readMedia).toHaveBeenCalledOnce());
      const { actionRevision } = await import("@/lib/control/action-store"); const record = f.current(prepared.id); const canceled = { ...record.action, state: "canceled" as const }; canceled.revision = actionRevision(canceled);
      f.deps.saveRecord({ ...record, action: canceled }, record.action.revision); const before = fs.readFileSync(f.filename, "utf8");
      release(); await expect(within(preparation)).rejects.toMatchObject({ code: "revision_conflict" }); expect(fs.readFileSync(f.filename, "utf8")).toBe(before); expect(f.providers.bluesky).not.toHaveBeenCalled();
    } finally { release(); await within(settled); }
  });

  it.each(["returned-failure", "uncertain-exception", "success-history-failure", "mixed-targets"] as const)("blocks legacy and control timing edits after %s", async (scenario) => {
    const f = await fixture();
    if (scenario === "mixed-targets") f.change((c) => { c.profiles = { bluesky: [{ id: "second", label: "Second", values: c.values }] }; });
    const prepared = await f.actions.prepare({ ...input, targetIds: scenario === "mixed-targets" ? ["bluesky:base", "bluesky:second"] : input.targetIds }); await f.approve(prepared);
    const service = f.make(scenario === "success-history-failure" ? { appendHistory: () => { throw new Error("History failed after publication"); } } : {});
    const queued = await service.commit(f.commit(prepared)); vi.setSystemTime(new Date(input.scheduledFor));
    vi.mocked(f.providers.bluesky).mockImplementation(async (ctx) => {
      if (scenario === "uncertain-exception") throw new Error("Response failed after possible acceptance");
      return { platform: "bluesky", ok: scenario === "success-history-failure" || (scenario === "mixed-targets" && !ctx.target?.profileId), message: "Fixture result" };
    });
    f.updateScheduledPost(queued.scheduleId!, (post) => ({ ...post, status: "publishing", updatedAt: new Date().toISOString() }));
    await service.dispatchScheduled(f.getScheduledPosts()[0]);
    // Retain a failed queue label even for success; it cannot erase the journal.
    f.updateScheduledPost(queued.scheduleId!, (post) => ({ ...post, status: "failed", attempts: 1 }));
    const before = fs.readFileSync(f.filename, "utf8"); const journal = fs.readFileSync(path.join(f.root, ".poster-actions.json"), "utf8"); const calls = vi.mocked(f.providers.bluesky).mock.calls.length;
    const { PATCH } = await import("@/app/api/scheduled/[id]/route");
    const response = await PATCH(new Request(`${origin}/api/scheduled/${queued.scheduleId}`, { method: "PATCH", body: JSON.stringify({ scheduledFor: "2026-01-17T12:00:00Z" }) }), { params: Promise.resolve({ id: queued.scheduleId! }) });
    expect(response.status).toBe(400);
    await expect(f.actions.prepare({ mode: "reschedule", requestKey: "unsafe", scheduleId: queued.scheduleId!, expectedRevision: await f.revision(queued.scheduleId!), scheduledFor: "2026-01-17T12:00:00Z" })).rejects.toMatchObject({ code: "revision_conflict" });
    expect(fs.readFileSync(f.filename, "utf8")).toBe(before); expect(fs.readFileSync(path.join(f.root, ".poster-actions.json"), "utf8")).toBe(journal); expect(f.providers.bluesky).toHaveBeenCalledTimes(calls);
  });

  it.each(["missing", "corrupt", "dispatching", "changed-safe-evidence"] as const)("revalidates %s journal evidence at reschedule commit", async (kind) => {
    const f = await fixture(); const { id, action: original } = await f.queued();
    const action = await f.actions.prepare({ mode: "reschedule", requestKey: "journal-race", scheduleId: id, expectedRevision: await f.revision(id), scheduledFor: "2026-01-17T12:00:00Z" }); await f.approve(action);
    const filename = path.join(f.root, ".poster-actions.json");
    if (kind === "missing") fs.unlinkSync(filename);
    else if (kind === "corrupt") fs.writeFileSync(filename, "{broken journal");
    else {
      const { actionRevision } = await import("@/lib/control/action-store"); const record = f.current(original.id);
      const changed: StoredAction = { ...record.action, ...(kind === "dispatching" ? { state: "executing", postId: `action-${original.id}`, outcomes: record.action.outcomes.map((outcome) => ({ ...outcome, state: "dispatching" as const })) }
        : { state: "canceled" }) }; changed.revision = actionRevision(changed); f.deps.saveRecord({ ...record, action: changed }, record.action.revision);
    }
    const before = fs.readFileSync(f.filename, "utf8"); f.replace.mockClear();
    await expect(f.make().commit(f.commit(action))).rejects.toMatchObject({ code: kind === "missing" || kind === "corrupt" ? "storage_corrupt" : "action_conflict" });
    expect(f.replace).not.toHaveBeenCalled(); expect(fs.readFileSync(f.filename, "utf8")).toBe(before); expect(f.providers.bluesky).not.toHaveBeenCalled();
    // Restore a readable journal for owned teardown when corruption was injected.
    if (kind === "missing" || kind === "corrupt") fs.writeFileSync(filename, JSON.stringify({ version: 1, records: [] }), { mode: 0o600 });
  });

  it("retains a deterministic authorized queue entry across replay/restart and executes after approval expiry", async () => {
    const f = await fixture(); const prepared = await f.actions.prepare(input); await f.approve(prepared); const service = f.make();
    const [first, replay] = await Promise.all([service.commit(f.commit(prepared)), service.commit(f.commit(prepared))]);
    expect(first.state).toBe("scheduled"); expect(replay.scheduleId).toBe(first.scheduleId); expect(first.postId).toBeNull();
    expect(f.replace).toHaveBeenCalledOnce(); expect(f.getScheduledPosts()).toHaveLength(1);
    expect(f.getScheduledPosts()[0]).toMatchObject({ id: first.scheduleId, text: input.content.text, status: "scheduled", authorization: { actionId: first.id, payloadDigest: first.payloadDigest } });
    expect(f.providers.bluesky).not.toHaveBeenCalled();
    releaseBackendOwners(); const restarted = f.make(); vi.setSystemTime(new Date(input.scheduledFor));
    expect((await restarted.commit(f.commit(prepared))).state).toBe("scheduled"); expect(f.replace).toHaveBeenCalledOnce();
    // Editing the singleton draft after enqueue cannot alter frozen job content.
    f.change((config) => { config.draft = { text: "The next unrelated draft", platforms: [] }; });
    f.updateScheduledPost(first.scheduleId!, (post) => ({ ...post, status: "publishing", updatedAt: new Date().toISOString() }));
    vi.mocked(f.providers.bluesky).mockResolvedValue({ platform: "bluesky", ok: true, message: "Fixture success" });
    const result = await restarted.dispatchScheduled(f.getScheduledPosts()[0]);
    expect(result).toMatchObject({ id: first.id, scheduleId: first.scheduleId, state: "succeeded", postId: `action-${first.id}` });
    expect(f.providers.bluesky).toHaveBeenCalledOnce(); expect(vi.mocked(f.providers.bluesky).mock.calls[0][0].text).toBe(input.content.text);
  });

  it.each(["time", "content", "target", "media", "publishing", "published"])("rejects a reschedule approval after the queue %s changes", async (kind) => {
    const f = await fixture(); const { id } = await f.queued(); const action = await f.actions.prepare({ mode: "reschedule", requestKey: "reschedule", scheduleId: id,
      expectedRevision: await f.revision(id), scheduledFor: "2026-01-17T12:00:00Z" }); await f.approve(action);
    f.change((c) => { const post = c.scheduledPosts[0];
      if (kind === "time") post.scheduledFor = "2026-01-18T12:00:00Z";
      if (kind === "content") post.text = "Changed content";
      if (kind === "target") post.targets[0].profileLabel = "Changed account";
      if (kind === "media") post.media = { id: "changed-media" };
      if (kind === "publishing" || kind === "published") post.status = kind;
    });
    const before = fs.readFileSync(f.filename, "utf8");
    await expect(f.make().commit(f.commit(action))).rejects.toMatchObject({ code: "action_conflict" });
    expect(fs.readFileSync(f.filename, "utf8")).toBe(before); expect(f.providers.bluesky).not.toHaveBeenCalled();
  });

  it.each(["account", "media"])("refuses changed frozen %s at dispatch without provider IO", async (kind) => {
    const f = await fixture(); let media: Awaited<ReturnType<typeof import("@/lib/media-store").saveUploadedMedia>> | undefined;
    if (kind === "media") { const { saveUploadedMedia } = await import("@/lib/media-store"); media = await saveUploadedMedia(imageFile(), origin); }
    const prepared = await f.actions.prepare({ ...input, content: { ...input.content, mediaId: media?.id ?? null } }); await f.approve(prepared);
    const service = f.make(); const action = await service.commit(f.commit(prepared)); vi.setSystemTime(new Date(input.scheduledFor));
    if (kind === "account") f.change((c) => { c.values.BLUESKY_APP_PASSWORD = "replaced-queue-secret"; });
    else fs.writeFileSync(media!.path, Buffer.alloc(media!.size, 1));
    f.updateScheduledPost(action.scheduleId!, (post) => ({ ...post, status: "publishing", updatedAt: new Date().toISOString() }));
    const result = await service.dispatchScheduled(f.getScheduledPosts()[0]);
    expect(result.state).toBe("uncertain"); expect(result.outcomes[0].state).toBe("not_dispatched"); expect(f.providers.bluesky).not.toHaveBeenCalled();
  });

  it("reschedules the same queue ID, preserves frozen content and cancels without live account/media readiness", async () => {
    const f = await fixture(); const { id, action: original } = await f.queued();
    const reschedule = await f.actions.prepare({ mode: "reschedule", requestKey: "reschedule", scheduleId: id, expectedRevision: await f.revision(id), scheduledFor: "2026-01-17T12:00:00+01:00" });
    await f.approve(reschedule); const saved = await f.make().commit(f.commit(reschedule));
    expect(saved).toMatchObject({ state: "rescheduled", scheduleId: id, postId: null });
    expect(f.current(original.id).action.state).toBe("canceled");
    expect(f.getScheduledPosts()[0]).toMatchObject({ id, text: input.content.text, scheduledFor: "2026-01-17T11:00:00.000Z", authorization: { actionId: saved.id } });
    f.change((c) => { c.values = {}; c.scheduledPosts[0].media = { id: "missing-media", filename: "missing", contentType: "image/png", size: 1, kind: "image", url: "/api/media/missing-media" }; });
    const cancel = await f.actions.prepare({ mode: "cancel", requestKey: "cancel", scheduleId: id, expectedRevision: await f.revision(id) }); await f.approve(cancel);
    expect(await f.make().commit(f.commit(cancel))).toMatchObject({ state: "canceled", scheduleId: id, postId: null });
    expect(f.current(saved.id).action.state).toBe("canceled");
    expect(f.getScheduledPosts()).toEqual([]); expect(f.config().publishedPosts ?? []).toEqual([]); expect(f.providers.bluesky).not.toHaveBeenCalled();
  });

  it.each(["deadline", "past-time"])("rejects %s at commit before any queue write", async (kind) => {
    const f = await fixture(); const action = await f.actions.prepare({ ...input, scheduledFor: "2026-01-15T12:10:00Z" }); await f.approve(action);
    vi.setSystemTime(new Date(kind === "deadline" ? action.expiresAt : "2026-01-15T12:10:00Z"));
    await expect(f.make().commit(f.commit(action))).rejects.toMatchObject({ code: "approval_expired" }); expect(f.replace).not.toHaveBeenCalled();
  });

  it("binds raw reschedule queue changes hidden by public redaction", async () => {
    const f = await fixture(); const { id } = await f.queued();
    f.change((c) => { c.scheduledPosts[0].targets[0].profileLabel = "queue-fixture-secret first"; });
    const before = await f.revision(id);
    const action = await f.actions.prepare({ mode: "reschedule", requestKey: "redacted", scheduleId: id, expectedRevision: before, scheduledFor: "2026-01-17T12:00:00Z" });
    await f.approve(action); f.change((c) => { c.scheduledPosts[0].targets[0].profileLabel = "queue-fixture-secret changed"; });
    expect(await f.revision(id)).toBe(before);
    await expect(f.make().commit(f.commit(action))).rejects.toMatchObject({ code: "action_conflict" });
  });

  it.each(["reschedule", "cancel"])("refuses %s once the due item is claimed during commit media IO", async (mode) => {
    const f = await fixture(); const { saveUploadedMedia } = await import("@/lib/media-store"); const media = await saveUploadedMedia(imageFile(), origin);
    const prepared = await f.actions.prepare({ ...input, content: { ...input.content, mediaId: media.id } }); await f.approve(prepared);
    const service = f.make(); const queued = await service.commit(f.commit(prepared));
    const action = await f.actions.prepare({ mode, requestKey: "due-race", scheduleId: queued.scheduleId!, expectedRevision: await f.revision(queued.scheduleId!),
      ...(mode === "reschedule" ? { scheduledFor: "2026-01-17T12:00:00Z" } : {}) }); await f.approve(action);
    // Cancellation has no media await; place its competing claim in the final
    // synchronous snapshot check. Reschedule holds the real media boundary.
    if (mode === "cancel") {
      const snapshot = f.actions.executionSnapshot;
      vi.spyOn(f.actions, "executionSnapshot").mockImplementationOnce(async (record) => {
        const result = await snapshot(record); f.updateScheduledPost(queued.scheduleId!, (post) => ({ ...post, status: "publishing" })); return result;
      });
      await expect(f.make().commit(f.commit(action))).rejects.toMatchObject({ code: "action_conflict" });
    } else {
      let release!: () => void; const held = new Promise<void>((resolve) => { release = resolve; }); const read = f.deps.readMedia; let entered = false;
      vi.spyOn(f.deps, "readMedia").mockImplementationOnce(async (id) => { entered = true; await held; return read(id); });
      const attempt = service.commit(f.commit(action)); const observed = attempt.catch((error) => error.code);
      try { expect(entered).toBe(true); f.updateScheduledPost(queued.scheduleId!, (post) => ({ ...post, status: "publishing" })); release(); expect(await observed).toBe("action_conflict"); }
      finally { release(); await Promise.allSettled([attempt]); }
    }
    expect(f.getScheduledPosts()[0].status).toBe("publishing"); expect(f.current(action.id).action.state).toBe("approved"); expect(f.providers.bluesky).not.toHaveBeenCalled();
  });

  it.each([
    ["schedule", "scheduled-time"], ["schedule", "approval-deadline"],
    ["reschedule", "scheduled-time"], ["reschedule", "approval-deadline"], ["cancel", "approval-deadline"]
  ] as const)("terminalizes unapplied %s intent at %s without mutating the queue", async (mode, deadline) => {
    const f = await fixture(); const id = mode === "schedule" ? null : (await f.queued()).id; f.replace.mockClear();
    const action = await f.actions.prepare(mode === "schedule" ? { ...input, scheduledFor: "2026-01-15T12:05:00Z" }
      : { mode, requestKey: "unapplied", scheduleId: id!, expectedRevision: await f.revision(id!), ...(mode === "reschedule" ? { scheduledFor: "2026-01-15T12:05:00Z" } : {}) });
    await f.approve(action); const beforeQueue = fs.readFileSync(f.filename, "utf8");
    const service = f.make({ saveRecord: (record, revision) => { f.deps.saveRecord(record, revision); throw new Error("intent acknowledgement lost"); } });
    await expect(service.commit(f.commit(action))).rejects.toMatchObject({ actionId: action.id });
    expect((await f.actions.get(action.id)).state).toBe("executing");
    vi.setSystemTime(new Date(deadline === "scheduled-time" ? "2026-01-15T12:05:00Z" : action.expiresAt));
    const journal = path.join(f.root, ".poster-actions.json"); const beforeRead = fs.readFileSync(journal, "utf8");
    expect(await f.actions.get(action.id)).toMatchObject({ id: action.id, state: "expired", payload: action.payload, payloadDigest: action.payloadDigest,
      outcomes: [{ state: "not_dispatched", message: expect.stringContaining("expired before") }] });
    expect(fs.readFileSync(journal, "utf8")).toBe(beforeRead);
    releaseBackendOwners(); const restarted = f.make(); restarted.recover();
    expect(f.current(action.id).action.state).toBe("expired");
    const terminal = await f.actions.get(action.id); releaseBackendOwners(); f.make();
    expect(await f.actions.get(action.id)).toEqual(terminal);
    await expect(restarted.commit(f.commit(action))).rejects.toMatchObject({ code: "approval_expired", actionId: action.id });
    expect(fs.readFileSync(f.filename, "utf8")).toBe(beforeQueue); expect(f.replace).not.toHaveBeenCalled(); expect(f.providers.bluesky).not.toHaveBeenCalled();
  });

  it.each(["schedule", "reschedule", "cancel"] as const)("recovers accepted %s queue bytes beyond expiry after its final journal write failed", async (mode) => {
    const f = await fixture(); const id = mode === "schedule" ? null : (await f.queued()).id; f.replace.mockClear();
    const action = await f.actions.prepare(mode === "schedule" ? input : { mode, requestKey: "accepted", scheduleId: id!, expectedRevision: await f.revision(id!),
      ...(mode === "reschedule" ? { scheduledFor: "2026-01-17T12:00:00Z" } : {}) }); await f.approve(action);
    const expected = mode === "schedule" ? "scheduled" : mode === "reschedule" ? "rescheduled" : "canceled";
    const service = f.make({ saveRecord: (record, revision) => { if (record.action.id === action.id && record.action.state === expected) throw new Error("final journal failure"); return f.deps.saveRecord(record, revision); } });
    await expect(service.commit(f.commit(action))).rejects.toMatchObject({ actionId: action.id }); expect(f.replace).toHaveBeenCalledOnce();
    vi.setSystemTime(new Date("2026-01-18T12:00:00Z"));
    const before = fs.readFileSync(path.join(f.root, ".poster-actions.json"), "utf8");
    expect((await f.actions.get(action.id)).state).toBe(expected); expect(fs.readFileSync(path.join(f.root, ".poster-actions.json"), "utf8")).toBe(before);
    releaseBackendOwners(); const restarted = f.make(); restarted.recover();
    expect((await f.actions.get(action.id)).state).toBe(expected); expect((await restarted.commit(f.commit(action))).state).toBe(expected); expect(f.replace).toHaveBeenCalledOnce();
  });

  it.each(["schedule", "reschedule", "cancel"] as const)("retains conflict precedence for changed unapplied %s queue bytes after expiry", async (mode) => {
    const f = await fixture(); const id = mode === "schedule" ? null : (await f.queued()).id; f.replace.mockClear();
    const action = await f.actions.prepare(mode === "schedule" ? input : { mode, requestKey: "conflicting-intent", scheduleId: id!, expectedRevision: await f.revision(id!),
      ...(mode === "reschedule" ? { scheduledFor: "2026-01-17T12:00:00Z" } : {}) }); await f.approve(action);
    await expect(f.make({ saveRecord: (record, revision) => { f.deps.saveRecord(record, revision); throw new Error("intent acknowledgement lost"); } }).commit(f.commit(action))).rejects.toMatchObject({ actionId: action.id });
    f.change((c) => {
      if (mode === "schedule") c.scheduledPosts = [{ id: f.current(action.id).action.scheduleId!, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        scheduledFor: input.scheduledFor, text: "Changed queue bytes", platforms: ["bluesky"], status: "scheduled", attempts: 0 }];
      else c.scheduledPosts[0].text = "Changed queue bytes";
    });
    vi.setSystemTime(new Date(action.expiresAt)); const queueBefore = fs.readFileSync(f.filename, "utf8"); const journal = path.join(f.root, ".poster-actions.json");
    const journalBefore = fs.readFileSync(journal, "utf8");
    expect(await f.actions.get(action.id)).toMatchObject({ id: action.id, state: "conflicting", payloadDigest: action.payloadDigest });
    expect(fs.readFileSync(journal, "utf8")).toBe(journalBefore);
    releaseBackendOwners(); const restarted = f.make(); expect(() => restarted.recover()).toThrow("The action preconditions changed.");
    expect(f.current(action.id).action.state).toBe("conflicting"); await expect(restarted.commit(f.commit(action))).rejects.toMatchObject({ code: "action_conflict" });
    expect(fs.readFileSync(f.filename, "utf8")).toBe(queueBefore); expect(f.replace).not.toHaveBeenCalled(); expect(f.providers.bluesky).not.toHaveBeenCalled();
  });

  it("keeps an overdue unapplied cancellation legal until its approval deadline", async () => {
    const f = await fixture(); const { id } = await f.queued(); f.replace.mockClear();
    f.change((c) => { c.scheduledPosts[0].scheduledFor = "2026-01-15T11:00:00Z"; });
    const action = await f.actions.prepare({ mode: "cancel", requestKey: "overdue-cancel", scheduleId: id, expectedRevision: await f.revision(id) }); await f.approve(action);
    await expect(f.make({ saveRecord: (record, revision) => { f.deps.saveRecord(record, revision); throw new Error("intent acknowledgement lost"); } }).commit(f.commit(action))).rejects.toMatchObject({ actionId: action.id });
    vi.setSystemTime(new Date("2026-01-15T12:05:00Z")); expect((await f.actions.get(action.id)).state).toBe("executing");
    expect((await f.make().commit(f.commit(action))).state).toBe("canceled"); expect(f.replace).toHaveBeenCalledOnce(); expect(f.getScheduledPosts()).toEqual([]);
  });

  it.each([
    ["schedule", "scheduled-time"], ["schedule", "approval-deadline"],
    ["reschedule", "scheduled-time"], ["reschedule", "approval-deadline"], ["cancel", "approval-deadline"]
  ] as const)("terminalizes %s when %s passes during the intent write", async (mode, deadline) => {
    const f = await fixture(); const id = mode === "schedule" ? null : (await f.queued()).id; f.replace.mockClear();
    const action = await f.actions.prepare(mode === "schedule" ? { ...input, scheduledFor: "2026-01-15T12:05:00Z" }
      : { mode, requestKey: "intent-clock-gap", scheduleId: id!, expectedRevision: await f.revision(id!), ...(mode === "reschedule" ? { scheduledFor: "2026-01-15T12:05:00Z" } : {}) }); await f.approve(action);
    const before = fs.readFileSync(f.filename, "utf8"); const service = f.make({ saveRecord: (record, revision) => {
      const saved = f.deps.saveRecord(record, revision);
      if (record.action.id === action.id && record.action.state === "executing") vi.setSystemTime(new Date(deadline === "scheduled-time" ? "2026-01-15T12:05:00Z" : action.expiresAt));
      return saved;
    } });
    await expect(service.commit(f.commit(action))).rejects.toMatchObject({ code: "approval_expired", actionId: action.id });
    expect(f.current(action.id).action.state).toBe("expired"); expect(f.replace).not.toHaveBeenCalled(); expect(fs.readFileSync(f.filename, "utf8")).toBe(before);
  });

  it("never falls back to legacy publishing if an approved queue binding disappears", async () => {
    const f = await fixture(); const { id, action } = await f.queued();
    f.change((c) => { delete c.scheduledPosts[0].authorization; }); vi.setSystemTime(new Date(input.scheduledFor));
    const { runScheduledTick } = await import("@/lib/scheduler");
    expect(await runScheduledTick()).toEqual({ processed: 1, skipped: false });
    expect(f.getScheduledPosts()[0]).toMatchObject({ id, status: "failed" }); expect(f.current(action.id).action.state).toBe("scheduled"); expect(f.providers.bluesky).not.toHaveBeenCalled();
  });

  it("executes an accepted reschedule after expiry without reusing its old queue precondition", async () => {
    const f = await fixture(); const { id, action: original } = await f.queued(); const old = f.getScheduledPosts()[0];
    const action = await f.actions.prepare({ mode: "reschedule", requestKey: "new-time", scheduleId: id, expectedRevision: await f.revision(id), scheduledFor: "2026-01-17T12:00:00Z" });
    await f.approve(action); const service = f.make(); await service.commit(f.commit(action));
    vi.setSystemTime(new Date("2026-01-17T12:00:00Z"));
    f.updateScheduledPost(id, (post) => ({ ...post, status: "publishing", updatedAt: new Date().toISOString() }));
    vi.mocked(f.providers.bluesky).mockResolvedValue({ platform: "bluesky", ok: true, message: "Fixture" });
    expect((await service.dispatchScheduled(f.getScheduledPosts()[0])).state).toBe("succeeded");
    // Even restoring the old retained queue bytes cannot revive its revoked
    // authorization. Its original action and identity stay inspectable.
    await expect(service.dispatchScheduled({ ...old, status: "publishing" })).rejects.toMatchObject({ code: "action_conflict" });
    expect(f.current(original.id).action.state).toBe("canceled"); expect(f.providers.bluesky).toHaveBeenCalledOnce();
  });

  it("keeps Berlin repeated local times as distinct offset-bearing instants", async () => {
    const f = await fixture();
    for (const [index, offset] of ["+02:00", "+01:00"].entries()) {
      const action = await f.actions.prepare({ ...input, requestKey: `dst-${index}`, scheduledFor: `2026-10-25T02:30:00${offset}` }); await f.approve(action);
      expect((await f.make().commit(f.commit(action))).state).toBe("scheduled");
    }
    expect(f.getScheduledPosts().map((post) => post.scheduledFor).sort()).toEqual(["2026-10-25T00:30:00.000Z", "2026-10-25T01:30:00.000Z"]);
    await expect(f.actions.prepare({ ...input, requestKey: "offset-free", scheduledFor: "2026-10-25T02:30:00" })).rejects.toMatchObject({ code: "validation_failed" });
  });

  for (const mode of ["schedule", "reschedule", "cancel"] as const) {
    for (const boundary of (mode === "schedule" ? ["intent", "queue", "final"] : ["intent", "queue", "supersession", "final"]) as ("intent" | "queue" | "supersession" | "final")[]) {
      it.each(["before", "after"])(`reconciles ${mode} ${boundary} write failure %s replacement without a second queue mutation`, async (position) => {
        const f = await fixture(); const id = mode === "schedule" ? null : (await f.queued()).id; f.replace.mockClear();
        const action = await f.actions.prepare(mode === "schedule" ? input : { mode, requestKey: `failure-${mode}`, scheduleId: id!, expectedRevision: await f.revision(id!),
          ...(mode === "reschedule" ? { scheduledFor: "2026-01-17T12:00:00Z" } : {}) }); await f.approve(action);
        let failed = false;
        const fail = (effect: () => void) => { if (position === "after") effect(); failed = true; throw new Error("fixture-write-failure"); };
        const saveRecord = (record: ActionRecord, revision?: string | null) => {
          if (!failed && ((boundary === "intent" && record.action.state === "executing")
            || (boundary === "final" && record.action.id === action.id && ["scheduled", "rescheduled", "canceled"].includes(record.action.state))
            || (boundary === "supersession" && record.action.id !== action.id && record.action.state === "canceled"))) return fail(() => { f.deps.saveRecord(record, revision); });
          return f.deps.saveRecord(record, revision);
        };
        const replace = vi.fn((queueId: string, post: ScheduledPost | null) => { if (!failed && boundary === "queue") return fail(() => { f.replace(queueId, post); }); f.replace(queueId, post); });
        await expect(f.make({ saveRecord, replace }).commit(f.commit(action))).rejects.toMatchObject({ actionId: action.id });
        releaseBackendOwners(); const restarted = f.make(); const result = await restarted.commit(f.commit(action));
        expect(result.state).toBe(mode === "schedule" ? "scheduled" : mode === "reschedule" ? "rescheduled" : "canceled");
        expect(f.replace).toHaveBeenCalledOnce();
        expect(f.getScheduledPosts()).toHaveLength(mode === "cancel" ? 0 : 1); expect(f.providers.bluesky).not.toHaveBeenCalled();
        expect((await restarted.commit(f.commit(action))).scheduleId).toBe(result.scheduleId); expect(f.replace).toHaveBeenCalledOnce();
      });
    }
  }
});

describe("scheduled target ownership and restart recovery", () => {
  it.each(["text", "attempts", "results", "lastError"] as const)("rejects changed %s on the claimed queue before dispatch", async (field) => {
    const f = await fixture(); const { id } = await f.queued(); vi.setSystemTime(new Date(input.scheduledFor));
    const { claimScheduledPost } = await import("@/lib/scheduling/service");
    const store = await import("@/lib/local-config");
    expect(claimScheduledPost(store, id, new Date()).kind).toBe("claimed");
    f.updateScheduledPost(id, (post) => ({ ...post, ...(field === "text" ? { text: "Changed content" }
      : field === "attempts" ? { attempts: 1 } : field === "lastError" ? { lastError: "Unexpected error" }
        : { results: [{ platform: "bluesky", ok: true, message: "Unexpected outcome" }] }) }));
    await expect(f.make().dispatchScheduled(f.getScheduledPosts()[0])).rejects.toMatchObject({ code: "action_conflict" });
    expect(f.providers.bluesky).not.toHaveBeenCalled();
  });

  it.each(["missing-record", "changed-content"] as const)("stops orphaned publishing work with %s instead of invoking a legacy provider", async (kind) => {
    const f = await fixture(); const { id } = await f.queued(); vi.setSystemTime(new Date(input.scheduledFor));
    f.updateScheduledPost(id, (post) => ({ ...post, status: "publishing", ...(kind === "missing-record"
      ? { authorization: { ...post.authorization!, actionId: "missing-action" } } : { text: "Changed frozen content" }) }));
    releaseBackendOwners(); f.make(); const { runScheduledTick } = await import("@/lib/scheduler");
    expect(await runScheduledTick()).toEqual({ processed: 0, skipped: false });
    expect(f.getScheduledPosts()[0]).toMatchObject({ status: "failed", results: [{ ok: false, uncertain: true }] });
    expect(f.providers.bluesky).not.toHaveBeenCalled();
  });

  it("does not let a conflicting orphaned queue intent stop independent approved due work", async () => {
    const f = await fixture(); const healthy = await f.actions.prepare({ ...input, requestKey: "healthy", content: { ...input.content, text: "Healthy queued content" } });
    await f.approve(healthy); await f.make().commit(f.commit(healthy));
    const orphan = await f.actions.prepare(input); await f.approve(orphan);
    await expect(f.make({ saveRecord: (record, revision) => { f.deps.saveRecord(record, revision); throw new Error("intent acknowledgement lost"); } }).commit(f.commit(orphan))).rejects.toMatchObject({ actionId: orphan.id });
    f.change((c) => c.scheduledPosts.push({ id: f.current(orphan.id).action.scheduleId, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      scheduledFor: input.scheduledFor, text: "Conflicting orphan", platforms: ["bluesky"], status: "publishing", attempts: 0,
      authorization: { actionId: orphan.id, payloadDigest: orphan.payloadDigest } }));
    vi.setSystemTime(new Date(input.scheduledFor)); releaseBackendOwners(); f.make();
    vi.mocked(f.providers.bluesky).mockResolvedValue({ platform: "bluesky", ok: true, message: "Fixture" });
    const { runScheduledTick } = await import("@/lib/scheduler"); expect(await runScheduledTick()).toEqual({ processed: 1, skipped: false });
    expect(f.current(orphan.id).action.state).toBe("conflicting"); expect(f.current(healthy.id).action.state).toBe("succeeded");
    expect(f.providers.bluesky).toHaveBeenCalledOnce(); expect(vi.mocked(f.providers.bluesky).mock.calls[0][0].text).toBe("Healthy queued content");
  });

  it("fails closed on a recovery journal write failure and later recovers without dispatch", async () => {
    const f = await fixture(); const { id, action } = await f.queued(); vi.setSystemTime(new Date(input.scheduledFor));
    f.updateScheduledPost(id, (post) => ({ ...post, status: "publishing" }));
    const { actionRevision } = await import("@/lib/control/action-store"); const record = f.current(action.id);
    const claim: StoredAction = { ...record.action, state: "executing", postId: `action-${action.id}`, outcomes: record.action.outcomes.map((outcome) => ({ ...outcome, state: "dispatching" })) };
    claim.revision = actionRevision(claim); f.deps.saveRecord({ ...record, action: claim }, record.action.revision);
    const { ControlError } = await import("@/lib/control/errors"); f.make({ saveRecord: () => { throw new ControlError("storage_unavailable"); } });
    const before = fs.readFileSync(f.filename, "utf8"); const { runScheduledTick } = await import("@/lib/scheduler");
    await expect(runScheduledTick()).rejects.toMatchObject({ code: "storage_unavailable" }); expect(fs.readFileSync(f.filename, "utf8")).toBe(before);
    f.make(); expect(await runScheduledTick()).toEqual({ processed: 0, skipped: false }); expect(f.current(action.id).action.outcomes[0].state).toBe("uncertain"); expect(f.providers.bluesky).not.toHaveBeenCalled();
  });

  it("leaves a backend-owned scheduled provider active when a different tick guard observes it", async () => {
    const f = await fixture(); const { id, action } = await f.queued(); vi.setSystemTime(new Date(input.scheduledFor));
    f.updateScheduledPost(id, (post) => ({ ...post, status: "publishing" }));
    let release!: () => void; const held = new Promise<void>((resolve) => { release = resolve; }); let inFlight = 0;
    vi.mocked(f.providers.bluesky).mockImplementation(async () => { inFlight++; try { await held; return { platform: "bluesky", ok: true, message: "Fixture" }; } finally { inFlight--; } });
    const service = f.make(); const operation = service.dispatchScheduled(f.getScheduledPosts()[0]);
    try {
      await vi.waitFor(() => expect(inFlight).toBe(1), { timeout: 500 }); const { runScheduledTick } = await import("@/lib/scheduler");
      expect(await runScheduledTick()).toEqual({ processed: 0, skipped: false }); expect(f.current(action.id).action.outcomes[0].state).toBe("dispatching");
      release(); expect((await within(operation)).state).toBe("succeeded"); expect(f.providers.bluesky).toHaveBeenCalledOnce();
    } finally { release(); await within(Promise.allSettled([operation])); expect(inFlight).toBe(0); }
  });

  it("keeps timer and ping overlap from recovering a live provider or claiming it again", async () => {
    const f = await fixture(); const { action } = await f.queued(); vi.setSystemTime(new Date(input.scheduledFor));
    let release!: () => void; const held = new Promise<void>((resolve) => { release = resolve; }); let inFlight = 0;
    vi.mocked(f.providers.bluesky).mockImplementation(async () => { inFlight++; try { await held; return { platform: "bluesky", ok: true, message: "Fixture" }; } finally { inFlight--; } });
    const { runScheduledTick } = await import("@/lib/scheduler"); const operation = runScheduledTick();
    try {
      await vi.waitFor(() => expect(inFlight).toBe(1), { timeout: 500 });
      expect(f.current(action.id).action.outcomes[0].state).toBe("dispatching"); expect(f.getScheduledPosts()[0].status).toBe("publishing");
      const before = fs.readFileSync(path.join(f.root, ".poster-actions.json"), "utf8");
      expect(await runScheduledTick()).toEqual({ processed: 0, skipped: true }); expect(fs.readFileSync(path.join(f.root, ".poster-actions.json"), "utf8")).toBe(before);
      release(); expect(await within(operation)).toEqual({ processed: 1, skipped: false }); expect(f.current(action.id).action.state).toBe("succeeded");
    } finally { release(); await within(Promise.allSettled([operation])); expect(inFlight).toBe(0); }
    expect(f.providers.bluesky).toHaveBeenCalledOnce();
  });

  for (const boundary of ["intent", "result"] as const) {
    it.each(["before", "after"] as const)(`stops scheduled dispatch at ${boundary} journal failure %s replacement`, async (position) => {
      const f = await fixture(); f.change((c) => Object.assign(c.values, { MASTODON_INSTANCE: "https://fixture.example", MASTODON_ACCESS_TOKEN: "fixture-mastodon-secret" }));
      const action = await f.actions.prepare({ ...input, targetIds: ["bluesky:base", "mastodon:base"] }); await f.approve(action); let injected = false;
      const service = f.make({ publishSaveRecord: (record, revision) => {
        const state = record.action.outcomes[0].state;
        if (!injected && record.action.state === "executing" && state === (boundary === "intent" ? "dispatching" : "succeeded")) {
          injected = true; if (position === "after") f.deps.saveRecord(record, revision); throw new Error("fixture scheduled journal boundary");
        }
        return f.deps.saveRecord(record, revision);
      } }); await service.commit(f.commit(action));
      vi.mocked(f.providers.bluesky).mockResolvedValue({ platform: "bluesky", ok: true, message: "Fixture accepted" });
      vi.setSystemTime(new Date(input.scheduledFor)); const { runScheduledTick } = await import("@/lib/scheduler");
      expect(await runScheduledTick()).toEqual({ processed: 1, skipped: false }); expect(injected).toBe(true);
      const current = f.current(action.id).action;
      expect(current.outcomes[0].state).toBe(boundary === "intent" ? position === "before" ? "not_dispatched" : "uncertain" : position === "before" ? "uncertain" : "succeeded");
      expect(current.outcomes[1].state).toBe("not_dispatched");
      releaseBackendOwners(); f.make(); expect(await runScheduledTick()).toEqual({ processed: 0, skipped: false });
      expect(f.providers.bluesky).toHaveBeenCalledTimes(boundary === "result" ? 1 : 0); expect(f.providers.mastodon).not.toHaveBeenCalled();
      expect(await f.reads.read("get_post", { postId: current.postId })).toMatchObject({ outcomes: current.outcomes });
    });
  }

  it.each(["partial", "failed", "uncertain"] as const)("retains complete %s target outcomes through history failure, queue removal and reconnect", async (expected) => {
    const f = await fixture(); f.change((c) => Object.assign(c.values, { MASTODON_INSTANCE: "https://fixture.example", MASTODON_ACCESS_TOKEN: "fixture-mastodon-secret" }));
    const prepared = await f.actions.prepare({ ...input, targetIds: ["bluesky:base", "mastodon:base"] }); await f.approve(prepared);
    const history = vi.fn(() => { throw new Error("fixture history unavailable"); }); const service = f.make({ appendHistory: history }); await service.commit(f.commit(prepared));
    vi.mocked(f.providers.bluesky).mockImplementation(async () => {
      expect(f.current(prepared.id).action.outcomes.map((outcome) => outcome.state)).toEqual(["dispatching", "not_dispatched"]);
      return { platform: "bluesky", ok: expected !== "failed", message: "Fixture result", url: "https://example.test/first" };
    });
    vi.mocked(f.providers.mastodon).mockImplementation(async () => {
      expect(f.current(prepared.id).action.outcomes.map((outcome) => outcome.state)).toEqual([expected === "failed" ? "failed" : "succeeded", "dispatching"]);
      if (expected === "uncertain") throw new TypeError("untagged failure after fixture acceptance");
      return { platform: "mastodon", ok: false, message: "Fixture rejection" };
    });
    vi.setSystemTime(new Date(input.scheduledFor)); const { runScheduledTick } = await import("@/lib/scheduler");
    expect(await runScheduledTick()).toEqual({ processed: 1, skipped: false });
    const action = f.current(prepared.id).action; expect(action.state).toBe(expected); expect(history).toHaveBeenCalledOnce();
    expect(f.getScheduledPosts()).toHaveLength(expected === "failed" ? 1 : 0); expect(f.config().publishedPosts ?? []).toEqual([]);
    if (expected === "failed") expect(f.getScheduledPosts()[0]).toMatchObject({ status: "failed", attempts: 1, publishedPostId: action.postId, results: [{ ok: false }, { ok: false }] });
    const before = [f.filename, path.join(f.root, ".poster-actions.json")].map((filename) => fs.readFileSync(filename, "utf8"));
    expect(await f.reads.read("get_post", { postId: action.postId })).toMatchObject({ id: action.postId, actionId: action.id, state: expected, outcomes: action.outcomes });
    expect(await f.reads.read("list_posts", { limit: 25 })).toMatchObject({ items: [{ id: action.postId, actionId: action.id, state: expected }] });
    expect([f.filename, path.join(f.root, ".poster-actions.json")].map((filename) => fs.readFileSync(filename, "utf8"))).toEqual(before);
    releaseBackendOwners(); f.make({ appendHistory: history });
    expect(await runScheduledTick()).toEqual({ processed: 0, skipped: false });
    expect(await f.reads.read("get_post", { postId: action.postId })).toMatchObject({ state: expected, outcomes: action.outcomes });
    expect(f.providers.bluesky).toHaveBeenCalledOnce(); expect(f.providers.mastodon).toHaveBeenCalledOnce();
  });

  it.each(["queue-claim", "execution-claim", "dispatch-intent", "returned-success", "returned-failure"] as const)("recovers durable %s without automatic provider replay", async (phase) => {
    const f = await fixture(); const { action, id } = await f.queued(); vi.setSystemTime(new Date(input.scheduledFor));
    f.updateScheduledPost(id, (post) => ({ ...post, status: "publishing", updatedAt: new Date().toISOString() }));
    if (phase !== "queue-claim") {
      const { actionRevision } = await import("@/lib/control/action-store"); const current = f.current(action.id);
      const claim: StoredAction = { ...current.action, state: "executing", postId: `action-${action.id}`, outcomes: current.action.outcomes.map((outcome) => ({ ...outcome,
        state: phase === "execution-claim" ? "not_dispatched" : phase === "dispatch-intent" ? "dispatching" : phase === "returned-success" ? "succeeded" : "failed",
        message: "Retained fixture boundary", url: phase === "returned-success" ? "https://example.test/accepted" : null })) };
      claim.revision = actionRevision(claim); f.deps.saveRecord({ ...current, action: claim }, current.action.revision);
    }
    const journal = path.join(f.root, ".poster-actions.json"); const beforeRead = fs.readFileSync(journal, "utf8");
    if (phase !== "queue-claim") expect((await f.actions.get(action.id)).state).toBe("uncertain");
    expect(fs.readFileSync(journal, "utf8")).toBe(beforeRead);
    releaseBackendOwners(); f.make(); const { runScheduledTick } = await import("@/lib/scheduler");
    expect(await runScheduledTick()).toEqual({ processed: 0, skipped: false });
    const current = await f.actions.get(action.id); expect(current.state).toBe("uncertain");
    expect(current.outcomes[0].state).toBe(phase === "dispatch-intent" ? "uncertain" : phase === "returned-success" ? "succeeded" : phase === "returned-failure" ? "failed" : "not_dispatched");
    expect(f.getScheduledPosts()).toHaveLength(phase === "returned-success" ? 0 : 1);
    if (phase !== "returned-success") expect(f.getScheduledPosts()[0].status).toBe("failed");
    expect(await f.reads.read("get_post", { postId: current.postId })).toMatchObject({ actionId: current.id, outcomes: current.outcomes });
    expect(await runScheduledTick()).toEqual({ processed: 0, skipped: false }); expect(f.providers.bluesky).not.toHaveBeenCalled();
  });

  it("catches up overdue work which has never acquired queue or dispatch ownership", async () => {
    const f = await fixture(); const { action } = await f.queued(); vi.setSystemTime(new Date("2026-01-18T12:00:00Z")); releaseBackendOwners(); f.make();
    vi.mocked(f.providers.bluesky).mockResolvedValue({ platform: "bluesky", ok: true, message: "Fixture accepted" });
    const { runScheduledTick } = await import("@/lib/scheduler"); expect(await runScheduledTick()).toEqual({ processed: 1, skipped: false });
    expect((await f.actions.get(action.id)).state).toBe("succeeded"); expect(f.providers.bluesky).toHaveBeenCalledOnce(); expect(f.getScheduledPosts()).toEqual([]);
    expect(await runScheduledTick()).toEqual({ processed: 0, skipped: false });
  });

  it.each(["missing", "corrupt"] as const)("fails closed on a %s action journal before claiming an overdue job", async (kind) => {
    const f = await fixture(); await f.queued(); vi.setSystemTime(new Date(input.scheduledFor));
    const journal = path.join(f.root, ".poster-actions.json"); if (kind === "missing") fs.unlinkSync(journal); else fs.writeFileSync(journal, "{broken");
    const queueBefore = fs.readFileSync(f.filename, "utf8"); const { runScheduledTick } = await import("@/lib/scheduler");
    await expect(runScheduledTick()).rejects.toMatchObject({ code: "storage_corrupt" });
    expect(fs.readFileSync(f.filename, "utf8")).toBe(queueBefore); expect(f.providers.bluesky).not.toHaveBeenCalled();
  });
});
