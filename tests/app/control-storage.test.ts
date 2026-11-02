import * as fs from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDataRoot, useDataRoot } from "./support/sandbox";
import { imageFile, publishPayload, successfulProviders } from "./support/fixtures";
import { payloadDigest } from "@/lib/control/canonical";
import { acquireBackendOwner, releaseBackendOwners, ownerFilename } from "@/lib/control/backend-ownership";
import { actionRevision, createActionStore, readActionJournal, actionJournalFilename, type ActionRecord } from "@/lib/control/action-store";

const hash = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
function enable(root: string) {
  const rootBinding = hash(fs.realpathSync(root));
  const backendId = randomUUID();
  fs.writeFileSync(path.join(root, ".poster-control.json"), JSON.stringify({ version: 1, rootBinding, backendId,
    instanceId: hash(`crossposter-control-v1\n${rootBinding}\n${backendId}`), token: "a".repeat(64), origin: "http://127.0.0.1:2004" }), { mode: 0o600 });
}
function record(key = "request-1"): ActionRecord {
  const target = { id: "bluesky:base", platform: "bluesky" as const, profileId: null, label: "Bluesky" };
  const payload = { mode: "publish" as const, content: { title: "", text: "Fixture", linkUrl: "", mediaId: null },
    targets: [{ ...target, identityRevision: hash("identity") }], media: null, draftRevision: null };
  const action = { id: `action-${key}`, payload, payloadDigest: payloadDigest(payload), revision: hash("placeholder"),
    state: "prepared" as const, createdAt: "2026-11-02T10:00:00.000Z", expiresAt: "2026-11-02T10:30:00.000Z",
    approvalUrl: `/approvals/action-${key}`, timezone: "Europe/Berlin", scheduledLocal: null, warnings: [],
    outcomes: [{ target, state: "not_dispatched" as const, message: "Not dispatched.", url: null }], postId: null, scheduleId: null };
  action.revision = actionRevision(action);
  return { requestKey: key, inputDigest: hash(key), action, accountBindings: { [target.id]: hash("private-binding") } };
}
afterEach(() => { releaseBackendOwners(); });

describe("durable backend ownership", () => {
  it("uses the canonical root, refuses live/reused PIDs and releases cleanly", () => {
    const root = createDataRoot(); const alias = `${root}-alias`; fs.symlinkSync(root, alias);
    const owner = acquireBackendOwner(alias);
    expect(owner.root).toBe(fs.realpathSync(root));
    expect(fs.statSync(path.join(root, ownerFilename)).mode & 0o777).toBe(0o600);
    expect(() => acquireBackendOwner(root)).toThrow("Another backend");
    owner.release(); owner.release();
    const restarted = acquireBackendOwner(root); restarted.assert(); restarted.release();
  });

  it("recovers a confirmed-dead owner but refuses malformed claims and abandoned recovery gates", () => {
    const root = createDataRoot(); const filename = path.join(root, ownerFilename);
    fs.writeFileSync(filename, JSON.stringify({ version: 1, root, pid: 12345, token: randomUUID() }), { mode: 0o600 });
    const alive = vi.fn(() => false); const recovered = acquireBackendOwner(root, alive);
    expect(alive).toHaveBeenCalledTimes(2); recovered.release();
    fs.writeFileSync(filename, "{truncated", { mode: 0o600 });
    expect(() => acquireBackendOwner(root, alive)).toThrow("Another backend");
    expect(fs.readFileSync(filename, "utf8")).toBe("{truncated");
    fs.unlinkSync(filename); fs.mkdirSync(path.join(root, ".poster-owner-recovery"));
    expect(() => acquireBackendOwner(root, alive)).toThrow("Another backend");
  });

  it("detects replacement and missing ownership and never removes a replacement claim", () => {
    const root = createDataRoot(); const owner = acquireBackendOwner(root); const filename = path.join(root, ownerFilename);
    const replacement = `${filename}.replacement`; fs.writeFileSync(replacement, fs.readFileSync(filename), { mode: 0o600 });
    fs.renameSync(replacement, filename);
    expect(() => owner.assert()).toThrow("Another backend");
    expect(() => owner.release()).toThrow("Another backend");
    fs.unlinkSync(filename); expect(() => owner.assert()).toThrow("Another backend");
  });

  it("does not acquire authority after a claim flush failure", () => {
    const root = createDataRoot();
    vi.spyOn(fs, "fsyncSync").mockImplementationOnce(() => { throw new Error("flush fault"); });
    expect(() => acquireBackendOwner(root)).toThrow();
    expect(fs.readdirSync(root)).toEqual([]);
  });
});

describe("versioned action journal", () => {
  it("retains final outcomes and post links across owner restart", () => {
    const root = createDataRoot(); const owner = acquireBackendOwner(root); const store = createActionStore(root, owner);
    const prepared = store.save(record(), null);
    const approved: ActionRecord = { ...prepared, action: { ...prepared.action, state: "approved" } }; approved.action.revision = actionRevision(approved.action);
    store.save(approved, prepared.action.revision);
    const executing: ActionRecord = { ...approved, action: { ...approved.action, state: "executing" } }; executing.action.revision = actionRevision(executing.action);
    store.save(executing, approved.action.revision);
    const finished: ActionRecord = { ...executing, action: { ...executing.action, state: "succeeded", postId: "retained-post",
      outcomes: executing.action.outcomes.map((outcome) => ({ ...outcome, state: "succeeded", message: "Publication succeeded." })) } };
    finished.action.revision = actionRevision(finished.action);
    store.save(finished, executing.action.revision); owner.release();
    const nextOwner = acquireBackendOwner(root);
    try {
      const restarted = createActionStore(root, nextOwner);
      expect(restarted.save(record(), null)).toEqual(finished);
      expect(restarted.read()).toEqual([finished]);
      expect(() => restarted.save({ ...finished, inputDigest: hash("changed") }, null)).toThrow("request key");
      expect(() => restarted.save(finished, finished.action.revision)).toThrow("preconditions");
      expect(fs.statSync(path.join(root, actionJournalFilename)).mode & 0o777).toBe(0o600);
    } finally { nextOwner.release(); }
  });

  it("counts serialized UTF-8 journal bytes, accepts the exact limit and preserves records on overflow", () => {
    const root = createDataRoot(); const owner = acquireBackendOwner(root); const initial = record();
    initial.action.payload.content.text = "雪🙂";
    initial.action.payloadDigest = payloadDigest(initial.action.payload); initial.action.revision = actionRevision(initial.action);
    const serialized = `${JSON.stringify({ version: 1, records: [initial] })}\n`;
    const limit = Buffer.byteLength(serialized, "utf8");
    expect(limit).toBeGreaterThan(serialized.length);
    try {
      const store = createActionStore(root, owner, undefined, limit);
      expect(store.save(initial, null)).toEqual(initial);
      expect(fs.statSync(path.join(root, actionJournalFilename)).size).toBe(limit);
      expect(readActionJournal(root, limit).records).toEqual([initial]);
      const bytes = fs.readFileSync(path.join(root, actionJournalFilename), "utf8");
      expect(() => store.save(record("second"), null)).toThrow(expect.objectContaining({ code: "storage_unavailable" }));
      expect(fs.readFileSync(path.join(root, actionJournalFilename), "utf8")).toBe(bytes);
      expect(store.save(initial, null)).toEqual(initial);
    } finally { owner.release(); }
  });

  it("rejects an oversized first journal before creating its journal or initialization anchor", () => {
    const root = createDataRoot(); const owner = acquireBackendOwner(root); const initial = record();
    initial.action.payload.content.text = "雪🙂".repeat(5);
    initial.action.payloadDigest = payloadDigest(initial.action.payload); initial.action.revision = actionRevision(initial.action);
    const serialized = `${JSON.stringify({ version: 1, records: [initial] })}\n`;
    try {
      const store = createActionStore(root, owner, undefined, serialized.length);
      expect(() => store.save(initial, null)).toThrow(expect.objectContaining({ code: "storage_unavailable" }));
      expect(fs.readdirSync(root)).toEqual([ownerFilename]);
    } finally { owner.release(); }
  });

  it.each(["schedule", "reschedule"] as const)("retains one %s action from queue acceptance through later dispatch and terminal replay", (mode) => {
    const root = createDataRoot(); const owner = acquireBackendOwner(root); const store = createActionStore(root, owner); const initial = record(mode);
    const publication = initial.action.payload;
    initial.action.payload = mode === "schedule" ? { ...publication, mode, scheduledFor: "2099-01-01T12:00:00.000Z" }
      : { ...publication, mode, scheduledFor: "2099-01-01T12:00:00.000Z", scheduleId: "existing-schedule", expectedRevision: hash("schedule-revision") };
    initial.action.payloadDigest = payloadDigest(initial.action.payload); initial.action.revision = actionRevision(initial.action);
    try {
      let current = store.save(initial, null);
      const transition = (state: ActionRecord["action"]["state"], changes: Partial<ActionRecord["action"]> = {}) => {
        const next = { ...current, action: { ...current.action, ...changes, state } };
        next.action.revision = actionRevision(next.action);
        current = store.save(next, current.action.revision); return current;
      };
      transition("approved"); transition("executing");
      transition(mode === "schedule" ? "scheduled" : "rescheduled", { scheduleId: "existing-schedule" });
      const accepted = current;
      expect(store.save(initial, null)).toEqual(accepted);
      for (const changes of [{ state: "approved" as const }, { state: "executing" as const, scheduleId: "replacement" }]) {
        const replacement = { ...accepted, action: { ...accepted.action, ...changes } }; replacement.action.revision = actionRevision(replacement.action);
        expect(() => store.save(replacement, accepted.action.revision)).toThrow("preconditions");
      }
      const changedPayload = { ...accepted.action.payload, content: { ...accepted.action.payload.content, text: "Changed" } };
      const immutableChanges: ActionRecord[] = [
        { ...accepted, action: { ...accepted.action, state: "executing", payload: changedPayload, payloadDigest: payloadDigest(changedPayload) } },
        { ...accepted, action: { ...accepted.action, state: "executing", expiresAt: "2026-11-02T11:00:00.000Z" } },
        { ...accepted, action: { ...accepted.action, state: "executing" }, accountBindings: { [accepted.action.payload.targets[0].id]: hash("changed-account") } }
      ];
      for (const replacement of immutableChanges) {
        replacement.action.revision = actionRevision(replacement.action);
        expect(() => store.save(replacement, accepted.action.revision)).toThrow("preconditions");
      }
      // Queue authorization survives the preparation deadline. The saved action
      // continues with dispatch intent/results under this identity and payload.
      vi.useFakeTimers(); vi.setSystemTime(new Date("2099-01-01T12:00:00.000Z"));
      transition("executing");
      transition("executing", { outcomes: current.action.outcomes.map((outcome) => ({ ...outcome, state: "dispatching" })) });
      transition("succeeded", { postId: "retained-post", outcomes: current.action.outcomes.map((outcome) => ({ ...outcome, state: "succeeded" })) });
      expect(current.action.id).toBe(initial.action.id); expect(current.action.payload).toEqual(initial.action.payload);
      expect(current.action.expiresAt).toBe(initial.action.expiresAt); expect(current.accountBindings).toEqual(initial.accountBindings);
      expect(store.save(initial, null)).toEqual(current);
      const rewind = { ...current, action: { ...current.action, state: "executing" as const } }; rewind.action.revision = actionRevision(rewind.action);
      expect(() => store.save(rewind, current.action.revision)).toThrow("preconditions");
    } finally { owner.release(); }
  });

  it("rejects stale writes and immutable payload/account-binding changes", () => {
    const root = createDataRoot(); const owner = acquireBackendOwner(root);
    try {
      const store = createActionStore(root, owner); const initial = store.save(record(), null);
      expect(() => store.save(initial, hash("stale"))).toThrow("revision changed");
      expect(() => store.save({ ...initial, action: { ...initial.action, id: "replacement" } }, initial.action.revision)).toThrow("preconditions");
      expect(() => store.save({ ...initial, accountBindings: {} }, initial.action.revision)).toThrow("preconditions");
      const changed = { ...initial, action: { ...initial.action, payload: { ...initial.action.payload, content: { ...initial.action.payload.content, text: "Changed" } } } };
      expect(() => store.save(changed, initial.action.revision)).toThrow("preconditions");
      expect(store.read()).toEqual([initial]);
    } finally { owner.release(); }
  });

  it("refuses a foreign root and a disappeared journal after restart", () => {
    const root = createDataRoot(); const other = createDataRoot(); const owner = acquireBackendOwner(root);
    try {
      expect(() => createActionStore(other, owner).save(record(), null)).toThrow("Another backend");
      createActionStore(root, owner).save(record(), null);
    } finally { owner.release(); }
    fs.unlinkSync(path.join(root, actionJournalFilename));
    const restarted = acquireBackendOwner(root);
    try { expect(() => createActionStore(root, restarted).save(record(), null)).toThrow("invalid data"); }
    finally { restarted.release(); }
  });

  it.each(["{truncated", "null", '{"version":2,"records":[]}', '{"version":1,"records":[{}]}'])("fails closed on malformed journal %s", (bytes) => {
    const root = createDataRoot(); const filename = path.join(root, actionJournalFilename);
    fs.writeFileSync(filename, bytes, { mode: 0o600 });
    expect(() => readActionJournal(root)).toThrow("invalid data");
    expect(fs.readFileSync(filename, "utf8")).toBe(bytes);
  });

  it("rejects duplicate replay keys, changed digests, symlink and world-readable journals", () => {
    const root = createDataRoot(); const filename = path.join(root, actionJournalFilename);
    const first = record();
    for (const records of [[first, first], [{ ...first, action: { ...first.action, payloadDigest: hash("wrong") } }]]) {
      fs.writeFileSync(filename, JSON.stringify({ version: 1, records }), { mode: 0o600 });
      expect(() => readActionJournal(root)).toThrow("invalid data");
    }
    fs.chmodSync(filename, 0o644); expect(() => readActionJournal(root)).toThrow("invalid data");
    fs.unlinkSync(filename); fs.symlinkSync(path.join(root, "absent"), filename);
    expect(() => readActionJournal(root)).toThrow("invalid data");
  });

  it.each(["write", "file-flush", "rename", "directory-flush"])("reports %s faults without replay loss or partial JSON", (phase) => {
    const root = createDataRoot(); const owner = acquireBackendOwner(root);
    try {
      const first = createActionStore(root, owner).save(record(), null);
      let flushes = 0;
      const io = { ...fs,
        writeFileSync: vi.fn<typeof fs.writeFileSync>((...args) => { if (phase === "write") throw new Error("fault"); fs.writeFileSync(...args); }),
        fsyncSync: vi.fn((fd: number) => { flushes++; if ((phase === "file-flush" && flushes === 1) || (phase === "directory-flush" && flushes === 2)) throw new Error("fault"); fs.fsyncSync(fd); }),
        renameSync: vi.fn((from: fs.PathLike, to: fs.PathLike) => { if (phase === "rename") throw new Error("fault"); fs.renameSync(from, to); }) };
      expect(() => createActionStore(root, owner, io).save(record("second"), null)).toThrow("unavailable");
      const recovered = readActionJournal(root);
      expect(recovered.records[0]).toEqual(first);
      expect(recovered.records).toHaveLength(phase === "directory-flush" ? 2 : 1);
      expect(fs.readdirSync(root).filter((name) => name.endsWith(".tmp"))).toEqual([]);
      expect(createActionStore(root, owner).save(record(), null)).toEqual(first);
    } finally { owner.release(); }
  });
});

describe("control-enabled legacy mutation guards", () => {
  it("counts exact UTF-8 config bytes and never replaces readable state with oversized output", async () => {
    const root = useDataRoot(); enable(root);
    const { createJsonConfigStorage } = await import("@/lib/storage/json-storage");
    const { readControlConfig } = await import("@/lib/control/read-storage");
    const initial = { values: { BLUESKY_IDENTIFIER: "雪🙂" } };
    const serialized = `${JSON.stringify(initial)}\n`; const limit = Buffer.byteLength(serialized, "utf8");
    expect(limit).toBeGreaterThan(serialized.length);
    const storage = createJsonConfigStorage(root, limit); storage.write(initial);
    expect(fs.statSync(storage.path).size).toBe(limit);
    expect(readControlConfig(root, limit).values).toEqual(initial.values);
    expect(() => storage.write({ values: { BLUESKY_IDENTIFIER: "雪🙂!" } })).toThrow(expect.objectContaining({ code: "storage_unavailable" }));
    expect(fs.readFileSync(storage.path, "utf8")).toBe(serialized);
    expect(() => createJsonConfigStorage(root, serialized.length).write(initial)).toThrow(expect.objectContaining({ code: "storage_unavailable" }));
    expect(storage.read()).toEqual(initial);
  });
  it("fails before provider dispatch, queue writes and media mutation on a competing owner", async () => {
    const root = useDataRoot(); enable(root); const foreign = acquireBackendOwner(root);
    try {
      await successfulProviders();
      const { runPublish } = await import("@/lib/publish-runner");
      const { upsertScheduledPost } = await import("@/lib/local-config");
      const { scheduledPost } = await import("./support/fixtures");
      const { saveUploadedMedia, deleteAllUploadedMedia } = await import("@/lib/media-store");
      await expect(runPublish(publishPayload())).rejects.toThrow("Another backend");
      expect(() => upsertScheduledPost(scheduledPost())).toThrow("Another backend");
      await expect(saveUploadedMedia(imageFile(), "http://localhost")).rejects.toThrow("Another backend");
      await expect(deleteAllUploadedMedia()).rejects.toThrow("Another backend");
      const { providers } = await import("@/lib/providers"); expect(providers.bluesky).not.toHaveBeenCalled();
      expect(fs.existsSync(path.join(root, "poster.config.local.json"))).toBe(false);
      expect(fs.existsSync(path.join(root, ".poster-uploads"))).toBe(false);
    } finally { foreign.release(); }
  });

  it.each(["config", "journal"])("does not overwrite unreadable %s state or dispatch providers", async (kind) => {
    const root = useDataRoot(); enable(root); const filename = path.join(root, kind === "config" ? "poster.config.local.json" : actionJournalFilename);
    fs.writeFileSync(filename, "{truncated", { mode: 0o600 });
    const { readLocalConfig, writeLocalConfig, emptyComposeDraft } = await import("@/lib/local-config");
    const empty = { values: {}, profiles: {}, activeProfiles: {}, draft: emptyComposeDraft, publishedPosts: [], scheduledPosts: [] };
    expect(() => readLocalConfig()).toThrow("invalid data");
    expect(() => writeLocalConfig(empty)).toThrow("invalid data");
    const { runPublish } = await import("@/lib/publish-runner");
    await expect(runPublish(publishPayload())).rejects.toThrow("invalid data");
    const { providers } = await import("@/lib/providers"); expect(providers.bluesky).not.toHaveBeenCalled();
    expect(fs.readFileSync(filename, "utf8")).toBe("{truncated");
  });

  it("refuses an unreadable existing config rather than replacing it with defaults", async () => {
    const root = useDataRoot(); enable(root); const filename = path.join(root, "poster.config.local.json");
    fs.writeFileSync(filename, '{}', { mode: 0o000 });
    const { readLocalConfig } = await import("@/lib/local-config");
    try { expect(() => readLocalConfig()).toThrow("unavailable"); }
    finally { fs.chmodSync(filename, 0o600); }
    expect(fs.readFileSync(filename, "utf8")).toBe('{}');
  });

  it("a file disappearing after stat is an unavailable read, never an absent initial config", async () => {
    const root = useDataRoot(); enable(root); const filename = path.join(root, "poster.config.local.json");
    fs.writeFileSync(filename, '{}');
    const original = fs.readFileSync;
    vi.spyOn(fs, "readFileSync").mockImplementation((file, options) => {
      if (file === filename) throw Object.assign(new Error("read raced removal"), { code: "ENOENT" });
      return Reflect.apply(original, fs, [file, options]);
    });
    const { readLocalConfig } = await import("@/lib/local-config");
    expect(() => readLocalConfig()).toThrow("unavailable");
  });

  it("rechecks ownership after awaited media lookup before any provider call", async () => {
    const root = useDataRoot();
    const mediaStore = await import("@/lib/media-store");
    const media = await mediaStore.saveUploadedMedia(imageFile(), "http://localhost");
    enable(root);
    vi.spyOn(mediaStore, "getUploadedMedia").mockImplementationOnce(async () => {
      fs.unlinkSync(path.join(root, ownerFilename));
      return media;
    });
    const { runPublish } = await import("@/lib/publish-runner");
    await expect(runPublish(publishPayload({ mediaId: media.id }))).rejects.toThrow("Another backend");
    const { providers } = await import("@/lib/providers"); expect(providers.bluesky).not.toHaveBeenCalled();
    expect(() => releaseBackendOwners()).toThrow("Another backend");
  });

  it.each(["malformed", "symlink", "unreadable"])("never treats %s control setup as absent", async (kind) => {
    const root = useDataRoot(); const filename = path.join(root, ".poster-control.json");
    if (kind === "symlink") fs.symlinkSync(path.join(root, "absent"), filename);
    else { fs.writeFileSync(filename, "broken", { mode: 0o600 }); if (kind === "unreadable") fs.chmodSync(filename, 0o000); }
    const { assertBackendMutation } = await import("@/lib/control/backend-mutation");
    expect(() => assertBackendMutation(root)).toThrow();
    expect(fs.existsSync(path.join(root, ownerFilename))).toBe(false);
  });

  it("detects removed setup and lost ownership without silently reacquiring", async () => {
    const root = useDataRoot(); enable(root);
    const { assertBackendMutation } = await import("@/lib/control/backend-mutation");
    assertBackendMutation(root);
    const filename = path.join(root, ownerFilename); const ownerBytes = fs.readFileSync(filename);
    fs.unlinkSync(filename); expect(() => assertBackendMutation(root)).toThrow("Another backend");
    fs.writeFileSync(filename, ownerBytes, { mode: 0o600 });
    // The replacement has a different inode and cannot restore this owner's lease.
    expect(() => assertBackendMutation(root)).toThrow("Another backend");
    // Remove the invalid cached owner from the test lifetime without touching its replacement.
    const { releaseBackendOwners } = await import("@/lib/control/backend-ownership");
    expect(() => releaseBackendOwners()).toThrow("Another backend");
    fs.unlinkSync(filename);
    expect(() => assertBackendMutation(root)).toThrow("Another backend");
    expect(fs.existsSync(filename)).toBe(false);
    fs.unlinkSync(path.join(root, ".poster-control.json"));
    expect(() => assertBackendMutation(root)).toThrow("Another backend");
  });

  it("an existing on-disk owner prevents a fresh backend from treating missing setup as legacy mode", async () => {
    const root = useDataRoot(); const incumbent = acquireBackendOwner(root);
    try {
      const { writeLocalConfig, emptyComposeDraft } = await import("@/lib/local-config");
      expect(() => writeLocalConfig({ values: {}, profiles: {}, activeProfiles: {}, draft: emptyComposeDraft, publishedPosts: [], scheduledPosts: [] })).toThrow("Another backend");
      expect(fs.existsSync(path.join(root, "poster.config.local.json"))).toBe(false);
    } finally { incumbent.release(); }
  });
});
