import * as fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { crc32, deflateSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { freezeClock, useDataRoot as isolatedDataRoot } from "./support/sandbox";
import { imageFile } from "./support/fixtures";
import { payloadDigest } from "@/lib/control/canonical";
import { releaseBackendOwners } from "@/lib/control/backend-ownership";
import type { ActionDependencies } from "@/lib/control/action-service";

const targetId = "bluesky:main";
const content = { title: "Title", text: "Fixture text", linkUrl: "", mediaId: null as string | null };
const publication = (overrides: Record<string, unknown> = {}) => ({ mode: "publish", requestKey: "stable-key", content, targetIds: [targetId], ...overrides });
const hash = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
function shotImage() {
  const header = Buffer.alloc(13); header.writeUInt32BE(400, 0); header.writeUInt32BE(300, 4); header[8] = 8; header[9] = 2;
  const chunk = (name: string, data: Buffer) => {
    const value = Buffer.alloc(data.length + 12); value.writeUInt32BE(data.length, 0); value.write(name, 4); data.copy(value, 8);
    value.writeUInt32BE(crc32(value.subarray(4, value.length - 4)), value.length - 4); return value;
  };
  return new File([Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.alloc((400 * 3 + 1) * 300))), chunk("IEND", Buffer.alloc(0))])], "shot.png", { type: "image/png" });
}
beforeEach(() => { freezeClock(); });
afterEach(() => { releaseBackendOwners(); });

async function fixture() {
  const root = isolatedDataRoot(); const filename = path.join(root, "poster.config.local.json");
  fs.writeFileSync(filename, JSON.stringify({ values: { BLUESKY_IDENTIFIER: "base.example", BLUESKY_APP_PASSWORD: "base-fixture-password" }, profiles: { bluesky: [
    { id: "main", label: "Main account", values: { BLUESKY_IDENTIFIER: "main.example", BLUESKY_APP_PASSWORD: "main-fixture-password" } }
  ] }, activeProfiles: { bluesky: "main" } }));
  const { controlInstanceId } = await import("@/lib/control/auth");
  const rootBinding = hash(fs.realpathSync(root)); const backendId = randomUUID(); const token = "ab".repeat(32);
  const credential = { version: 1, rootBinding, backendId, instanceId: controlInstanceId(rootBinding, backendId), token, origin: "http://127.0.0.1:2004" };
  fs.writeFileSync(path.join(root, ".poster-control.json"), JSON.stringify(credential), { mode: 0o600 });
  const { readControlConfig, readControlMedia, controlMediaRevision } = await import("@/lib/control/read-storage");
  const { readActionJournal, createActionStore } = await import("@/lib/control/action-store");
  const { createActionService } = await import("@/lib/control/action-service");
  const { bindControlAccount } = await import("@/lib/control/account-binding");
  const { assertBackendMutation } = await import("@/lib/control/backend-mutation");
  const owner = () => { const claim = assertBackendMutation(root); if (!claim) throw new Error("fixture setup missing"); return claim; };
  const deps: ActionDependencies = { readConfig: () => readControlConfig(root), readRecords: () => readActionJournal(root).records,
    saveRecord: (record) => createActionStore(root, owner()).save(record, null), assertMutation: () => { owner(); },
    readMedia: (id) => readControlMedia(root, id), mediaRevision: (id) => controlMediaRevision(root, id), bindAccount: (target) => bindControlAccount(root, token, target),
    environmentValue: (name) => process.env[name], timezone: () => process.env.CROSSPOSTER_TIMEZONE || "Europe/Berlin", now: () => new Date(), createId: randomUUID };
  const write = (value: unknown) => fs.writeFileSync(filename, JSON.stringify(value));
  const config = () => JSON.parse(fs.readFileSync(filename, "utf8"));
  const headers = { authorization: `Bearer ${token}`, "x-crossposter-instance": credential.instanceId, "content-type": "application/json" };
  const request = (body: unknown, route = "/api/mcp/v1/actions") => new Request(`${credential.origin}${route}`, { method: "POST", headers, body: JSON.stringify(body) });
  async function media() { const { saveUploadedMedia } = await import("@/lib/media-store"); return saveUploadedMedia(imageFile(), credential.origin); }
  function schedule(status = "scheduled") {
    const value = config(); value.scheduledPosts = [{ id: "queue-1", createdAt: "2026-01-15T10:00:00Z", updatedAt: "2026-01-15T10:00:00Z", scheduledFor: "2026-10-25T01:30:00Z",
      title: "Scheduled title", text: "Scheduled body", targets: [{ id: targetId, platform: "bluesky", profileId: "main", profileLabel: "Main account" }], platforms: ["bluesky"], status, attempts: 0 }]; write(value);
  }
  async function scheduleRevision() { const { projectControlConfig, projectControlSchedule } = await import("@/lib/control/read-projections"); const c = deps.readConfig(); return projectControlSchedule(c.scheduledPosts[0], projectControlConfig(c, deps.environmentValue)).revision; }
  return { root, filename, deps, service: createActionService(deps), restart: () => createActionService(deps), write, config, headers, request, media, schedule, scheduleRevision };
}

describe("immutable action preparation", () => {
  it("normalizes the exact executable content, persists its digest/deadline and never dispatches or enqueues", async () => {
    const f = await fixture(); const before = fs.readFileSync(f.filename, "utf8");
    const action = await f.service.prepare(publication({ content: { ...content, title: " Title ", text: " Text \n", linkUrl: " example.com/path?q=1#part " } }));
    expect(action.payload.content).toEqual({ ...content, title: "Title", text: "Text", linkUrl: "https://example.com/path?q=1#part" });
    expect(action.payloadDigest).toBe(payloadDigest(action.payload)); expect(action.createdAt).toBe("2026-01-15T12:00:00.000Z");
    expect(action.expiresAt).toBe("2026-01-15T12:30:00.000Z"); expect(action.approvalUrl).toBe(`/approvals/${action.id}`);
    expect(action).toMatchObject({ state: "prepared", timezone: "Europe/Berlin", scheduledLocal: null, postId: null, scheduleId: null });
    expect(action.outcomes).toMatchObject([{ state: "not_dispatched", target: { id: targetId } }]);
    expect(fs.readFileSync(f.filename, "utf8")).toBe(before); expect(vi.getTimerCount()).toBe(0);
    const { providers } = await import("@/lib/providers"); for (const provider of Object.values(providers)) expect(provider).not.toHaveBeenCalled();
  });

  it("replays canonical-equivalent requests after service/owner restart and rejects changed input", async () => {
    const f = await fixture(); const action = await f.service.prepare(publication({ content: { ...content, text: " Fixture text ", linkUrl: "example.com" } }));
    releaseBackendOwners();
    expect(await f.restart().prepare(publication({ content: { ...content, linkUrl: "https://example.com" } }))).toEqual(action);
    await expect(f.service.prepare(publication({ content: { ...content, text: "Changed" } }))).rejects.toMatchObject({ code: "idempotency_conflict" });
    expect(f.deps.readRecords()).toHaveLength(1);
    const distinct = await f.service.prepare(publication({ requestKey: "distinct-key", content: { ...content, text: "Changed" } }));
    expect(distinct.id).not.toBe(action.id); expect(f.deps.readRecords()).toHaveLength(2);
    expect((await f.service.get(action.id)).payloadDigest).toBe(action.payloadDigest);
  });

  it("concurrent same-key preparations share the retained action", async () => {
    const f = await fixture(); const media = await f.media(); const input = publication({ content: { ...content, mediaId: media.id } });
    const actions = await Promise.all(Array.from({ length: 5 }, () => f.service.prepare(input)));
    expect(new Set(actions.map((action) => action.id)).size).toBe(1); expect(f.deps.readRecords()).toHaveLength(1);
  });

  it("expires purely and never replaces an expired request key with a new attempt", async () => {
    const f = await fixture(); const action = await f.service.prepare(publication());
    const before = fs.readFileSync(path.join(f.root, ".poster-actions.json"), "utf8");
    vi.setSystemTime(new Date("2026-01-15T12:30:00Z"));
    expect(await f.service.get(action.id)).toMatchObject({ id: action.id, state: "expired", payloadDigest: action.payloadDigest });
    expect(await f.restart().prepare(publication())).toMatchObject({ id: action.id, state: "expired" });
    expect(fs.readFileSync(path.join(f.root, ".poster-actions.json"), "utf8")).toBe(before);
  });

  it("retains rejected actions without requiring the deleted live profile", async () => {
    const f = await fixture(); const action = await f.service.prepare(publication()); const record = f.deps.readRecords()[0];
    const { createActionStore, actionRevision } = await import("@/lib/control/action-store"); const { assertBackendMutation } = await import("@/lib/control/backend-mutation");
    const rejected = { ...record, ownerDecision: { actionId: action.id, payloadDigest: action.payloadDigest, preparationRevision: action.revision,
      expiresAt: action.expiresAt, decision: "reject" as const, decidedAt: action.createdAt }, action: { ...action, state: "rejected" as const } }; rejected.action.revision = actionRevision(rejected.action);
    createActionStore(f.root, assertBackendMutation(f.root)!).save(rejected, action.revision);
    const config = f.config(); config.profiles = {}; f.write(config);
    const before = fs.readFileSync(path.join(f.root, ".poster-actions.json"), "utf8");
    expect(await f.service.get(action.id)).toMatchObject({ id: action.id, state: "rejected" });
    expect(fs.readFileSync(path.join(f.root, ".poster-actions.json"), "utf8")).toBe(before);
  });

  it.each(["changed", "missing"])("invalidates a %s profile without altering the immutable preview", async (change) => {
    const f = await fixture(); const action = await f.service.prepare(publication()); const config = f.config();
    if (change === "missing") config.profiles.bluesky = []; else config.profiles.bluesky[0].values.BLUESKY_APP_PASSWORD = "rotated-fixture-password";
    f.write(config); const current = await f.service.get(action.id);
    expect(current).toMatchObject({ id: action.id, state: "conflicting", payload: action.payload, payloadDigest: action.payloadDigest });
    expect(await f.service.prepare(publication())).toMatchObject({ id: action.id, state: "conflicting" });
  });

  it("keeps explicit base configuration independent of active profiles and freezes the real binding privately", async () => {
    const f = await fixture(); const { resolveControlTarget } = await import("@/lib/control/account-binding");
    expect(resolveControlTarget(f.deps.readConfig(), "bluesky:base", f.deps.environmentValue).values.BLUESKY_IDENTIFIER).toBe("base.example");
    const action = await f.service.prepare(publication({ targetIds: ["bluesky:base"] })); const config = f.config(); config.activeProfiles.bluesky = "other";
    config.profiles.bluesky.push({ id: "other", label: "Other", values: { BLUESKY_IDENTIFIER: "other.example", BLUESKY_APP_PASSWORD: "other-fixture-password" } }); f.write(config);
    expect(await f.service.get(action.id)).toMatchObject({ state: "prepared", payload: action.payload });
    expect(action.payload.targets).toMatchObject([{ id: "bluesky:base", profileId: null }]);
    const privateBinding = f.deps.readRecords()[0].accountBindings["bluesky:base"];
    expect(JSON.stringify(action)).not.toContain(privateBinding); expect(JSON.stringify(action)).not.toContain("base-fixture-password");
    const { identityRevision, ...identity } = action.payload.targets[0]; expect(identityRevision).toBe(payloadDigest({ actionId: action.id, target: identity }));
  });

  it("does not fill an explicit profile from base/environment credentials", async () => {
    const f = await fixture(); const config = f.config(); config.profiles.bluesky[0].values = {}; f.write(config);
    vi.stubEnv("BLUESKY_IDENTIFIER", "environment.example"); vi.stubEnv("BLUESKY_APP_PASSWORD", "environment-fixture-password");
    await expect(f.service.prepare(publication())).rejects.toMatchObject({ code: "validation_failed" }); expect(f.deps.readRecords()).toEqual([]);
  });

  it("resolves persisted configuration with the same trim/default normalization as the legacy facade", async () => {
    const f = await fixture(); const config = f.config(); config.profiles.bluesky[0].values.BLUESKY_IDENTIFIER = " main.example ";
    config.values.BLUESKY_IDENTIFIER = " base.example "; f.write(config);
    const { resolveControlTarget } = await import("@/lib/control/account-binding");
    expect(resolveControlTarget(f.deps.readConfig(), targetId, f.deps.environmentValue).values.BLUESKY_IDENTIFIER).toBe("main.example");
    expect(resolveControlTarget(f.deps.readConfig(), "bluesky:base", f.deps.environmentValue).values.BLUESKY_IDENTIFIER).toBe("base.example");
    expect(await f.service.prepare(publication())).toMatchObject({ state: "prepared" });
  });

  it.each(["bluesky:missing", "invented:profile"])("rejects absent server-resolved target %s", async (id) => {
    const f = await fixture(); await expect(f.service.prepare(publication({ targetIds: [id] }))).rejects.toMatchObject({ code: "target_missing" }); expect(f.deps.readRecords()).toEqual([]);
  });

  it("validates every same-platform profile, including a nonpremium second X target", async () => {
    const f = await fixture(); const config = f.config(); fs.mkdirSync(path.join(f.root, ".x-browser/default"), { recursive: true });
    config.profiles.x = [{ id: "premium", label: "Premium", values: { X_PREMIUM_LONG_POSTS: "true" } }, { id: "free", label: "Free", values: { X_PREMIUM_LONG_POSTS: "false" } }]; f.write(config);
    await expect(f.service.prepare(publication({ content: { ...content, text: "a".repeat(281) }, targetIds: ["x:premium", "x:free"] }))).rejects.toMatchObject({ code: "validation_failed" });
    expect(await f.service.prepare(publication({ content: { ...content, text: "a".repeat(281) }, targetIds: ["x:premium"] }))).toMatchObject({ state: "prepared" });
  });

  it("binds actual local session state and rejects a missing session", async () => {
    const f = await fixture(); const config = f.config(); config.profiles.x = [{ id: "session", label: "X", values: {} }]; f.write(config);
    await expect(f.service.prepare(publication({ targetIds: ["x:session"] }))).rejects.toMatchObject({ code: "action_conflict" });
    const directory = path.join(f.root, ".x-browser/default"); fs.mkdirSync(directory, { recursive: true }); fs.writeFileSync(path.join(directory, "Cookies"), "session-one");
    const action = await f.service.prepare(publication({ targetIds: ["x:session"] }));
    fs.writeFileSync(path.join(directory, "Cookies"), "session-two");
    expect(await f.service.get(action.id)).toMatchObject({ state: "conflicting", payloadDigest: action.payloadDigest });
  });

  it.each(["missing", "changed"])("binds stored media bytes and invalidates %s media", async (change) => {
    const f = await fixture(); const media = await f.media(); const action = await f.service.prepare(publication({ content: { ...content, mediaId: media.id } }));
    expect(action.payload.media).toMatchObject({ id: media.id });
    expect(action.payload.media?.digest).toBe(`sha256:${createHash("sha256").update(Buffer.from(await imageFile().arrayBuffer())).digest("hex")}`);
    if (change === "missing") fs.unlinkSync(media.path); else fs.writeFileSync(media.path, Buffer.alloc(media.size, 1));
    expect(await f.service.get(action.id)).toMatchObject({ state: "conflicting" });
  });

  it("requires existing media and applies shared media constraints without conversion", async () => {
    const f = await fixture();
    await expect(f.service.prepare(publication({ content: { ...content, mediaId: "00000000-0000-0000-0000-000000000000.png" } }))).rejects.toMatchObject({ code: "media_missing" });
    const config = f.config(); config.profiles.dribbble = [{ id: "shot", label: "Shot", values: { DRIBBBLE_ACCESS_TOKEN: "fixture-dribbble-token" } }]; f.write(config);
    const media = await f.media();
    await expect(f.service.prepare(publication({ targetIds: ["dribbble:shot"], content: { ...content, text: "", mediaId: null } }))).rejects.toMatchObject({ code: "validation_failed" });
    await expect(f.service.prepare(publication({ targetIds: ["dribbble:shot"], content: { ...content, text: "", mediaId: media.id } }))).rejects.toMatchObject({ code: "validation_failed" });
    expect(f.deps.readRecords()).toEqual([]);
  });

  it.each(["dribbble", "pinterest"] as const)("prepares a valid title-only %s schedule without enqueuing it", async (platform) => {
    const f = await fixture(); const config = f.config();
    config.profiles[platform] = [{ id: "title-only", label: "Title only", values: platform === "dribbble" ? { DRIBBBLE_ACCESS_TOKEN: "fixture-dribbble-token" }
      : { PINTEREST_EMAIL: "fixture@example.com", PINTEREST_USERNAME: "fixture", PINTEREST_PASSWORD: "fixture-password", PINTEREST_BOARD_ID: "42" } }]; f.write(config);
    if (platform === "pinterest") fs.mkdirSync(path.join(f.root, ".pinterest-sessions/default"), { recursive: true });
    const { saveUploadedMedia } = await import("@/lib/media-store"); const media = await saveUploadedMedia(shotImage(), "http://127.0.0.1:2004");
    const action = await f.service.prepare(publication({ mode: "schedule", scheduledFor: "2026-10-25T01:30:00Z", targetIds: [`${platform}:title-only`], content: { ...content, text: "", mediaId: media.id } }));
    expect(action.payload).toMatchObject({ mode: "schedule", content: { title: "Title", text: "", mediaId: media.id } }); expect(f.config().scheduledPosts).toBeUndefined();
    expect(action.payload.media).not.toHaveProperty("dimensions");
  });

  it.each(["manual", "chrome"])("binds the existing YouTube %s/stored-cookie path without importing credentials", async (source) => {
    const f = await fixture(); const browser = await import("@/lib/youtube-browser-cookie");
    vi.spyOn(browser, "chromeCookieDbCandidates").mockImplementation(() => { throw new Error("fixture Chrome unavailable"); });
    const config = f.config(); config.profiles.youtube = [{ id: "video", label: "Video", values: { YOUTUBE_COOKIE_SOURCE: source, YOUTUBE_COOKIE: "SAPISID=fixture-video-cookie" } }]; f.write(config);
    const { saveUploadedMedia } = await import("@/lib/media-store"); const media = await saveUploadedMedia(new File(["video"], "fixture.mp4", { type: "video/mp4" }), "http://127.0.0.1:2004");
    const action = await f.service.prepare(publication({ targetIds: ["youtube:video"], content: { ...content, mediaId: media.id } }));
    expect(action.state).toBe("prepared"); expect(JSON.stringify(action)).not.toContain("fixture-video-cookie");
    config.profiles.youtube[0].values.YOUTUBE_COOKIE = "SAPISID=changed-video-cookie"; f.write(config);
    expect(await f.service.get(action.id)).toMatchObject({ state: "conflicting" });
  });

  it("binds the matching draft revision and invalidates subsequent edits", async () => {
    const f = await fixture(); const config = f.config(); config.draft = { ...content, platforms: ["bluesky"], targets: [{ id: targetId, platform: "bluesky", profileId: "main" }], updatedAt: "2026-01-15T11:00:00Z" }; f.write(config);
    const action = await f.service.prepare(publication()); expect(action.payload.draftRevision).toMatch(/^sha256:/);
    config.draft.updatedAt = "2026-01-15T11:30:00Z"; f.write(config);
    expect(await f.service.get(action.id)).toMatchObject({ state: "conflicting" });
  });
});

describe("cancellation of invalid or unavailable publication resources", () => {
  it.each(["scheduled", "failed"].flatMap((status) => ["profile-removed", "profile-incomplete", "session-unavailable", "media-missing", "content-invalid"].map((condition) => ({ status, condition }))))
    ("keeps $status/$condition cancellation reviewable without publication readiness", async ({ status, condition }) => {
      const f = await fixture(); f.schedule(status); const config = f.config(); const post = config.scheduledPosts[0];
      if (condition === "profile-removed") config.profiles.bluesky = [];
      if (condition === "profile-incomplete") config.profiles.bluesky[0].values = {};
      if (condition === "session-unavailable") {
        config.profiles.x = [{ id: "unavailable", label: "Unavailable session", values: {} }];
        post.platforms = ["x"]; post.targets = [{ id: "x:unavailable", platform: "x", profileId: "unavailable", profileLabel: "Retained X" }];
      }
      if (condition === "media-missing") post.media = { id: "00000000-0000-0000-0000-000000000000.png" };
      if (condition === "content-invalid") { post.title = ""; post.text = ""; }
      f.write(config); const revision = await f.scheduleRevision(); const before = fs.readFileSync(f.filename, "utf8");
      const mediaRead = vi.spyOn(f.deps, "readMedia"); const mediaVersion = vi.spyOn(f.deps, "mediaRevision"); const binding = vi.spyOn(f.deps, "bindAccount");
      const action = await f.service.prepare({ mode: "cancel", requestKey: "cancel-invalid", scheduleId: "queue-1", expectedRevision: revision });
      expect(action).toMatchObject({ state: "prepared", scheduleId: "queue-1", payload: { mode: "cancel", scheduleId: "queue-1", expectedRevision: revision, media: null, draftRevision: null } });
      expect(action.payload.content).toMatchObject({ title: post.title, text: post.text, mediaId: post.media?.id ?? null });
      expect(action.warnings.join(" ")).toMatch(/not verified/i);
      expect(mediaRead).not.toHaveBeenCalled(); expect(mediaVersion).not.toHaveBeenCalled(); expect(binding).not.toHaveBeenCalled();
      const journal = fs.readFileSync(path.join(f.root, ".poster-actions.json"), "utf8");
      expect(await f.service.get(action.id)).toEqual(action);
      expect(await f.restart().prepare({ mode: "cancel", requestKey: "cancel-invalid", scheduleId: "queue-1", expectedRevision: revision })).toEqual(action);
      expect(mediaRead).not.toHaveBeenCalled(); expect(mediaVersion).not.toHaveBeenCalled(); expect(binding).not.toHaveBeenCalled();
      expect(fs.readFileSync(f.filename, "utf8")).toBe(before); expect(fs.readFileSync(path.join(f.root, ".poster-actions.json"), "utf8")).toBe(journal);
      expect(vi.getTimerCount()).toBe(0);
      const { providers } = await import("@/lib/providers"); for (const provider of Object.values(providers)) expect(provider).not.toHaveBeenCalled();
      const expected = condition === "profile-removed" ? "target_missing" : condition === "session-unavailable" ? "action_conflict" : condition === "media-missing" ? "media_missing" : "validation_failed";
      await expect(f.service.prepare({ mode: "reschedule", requestKey: "strict-reschedule", scheduleId: "queue-1", expectedRevision: revision, scheduledFor: "2026-12-01T12:00:00Z" })).rejects.toMatchObject({ code: expected });
      expect(f.deps.readRecords()).toHaveLength(1);
    });

  it("keeps a frozen cancellation reviewable when its live profile disappears after preparation", async () => {
    const f = await fixture(); f.schedule(); const config = f.config(); delete config.scheduledPosts[0].targets[0].profileLabel; f.write(config);
    const revision = await f.scheduleRevision(); const action = await f.service.prepare({ mode: "cancel", requestKey: "retained-cancel", scheduleId: "queue-1", expectedRevision: revision });
    config.profiles = {}; f.write(config);
    expect(await f.scheduleRevision()).not.toBe(revision); // read projection's live label fallback changed, not the queued record
    expect(await f.service.get(action.id)).toMatchObject({ id: action.id, state: "prepared", payload: action.payload });
  });

  it.each(["publishing", "published"])("conflicts a prepared cancellation and rejects a new cancellation once %s starts", async (status) => {
    const f = await fixture(); f.schedule(); const action = await f.service.prepare({ mode: "cancel", requestKey: "before-state-change", scheduleId: "queue-1", expectedRevision: await f.scheduleRevision() });
    const config = f.config(); config.scheduledPosts[0].status = status; f.write(config);
    const journal = fs.readFileSync(path.join(f.root, ".poster-actions.json"), "utf8");
    expect(await f.service.get(action.id)).toMatchObject({ state: "conflicting" });
    await expect(f.service.prepare({ mode: "cancel", requestKey: "after-state-change", scheduleId: "queue-1", expectedRevision: await f.scheduleRevision() })).rejects.toMatchObject({ code: "revision_conflict" });
    expect(fs.readFileSync(path.join(f.root, ".poster-actions.json"), "utf8")).toBe(journal);
  });

  it("omits unsafe retained links while privately detecting queue changes hidden by public redaction", async () => {
    const f = await fixture(); f.schedule("failed"); const config = f.config(); config.scheduledPosts[0].linkUrl = "https://user:main-fixture-password@example.com/old";
    config.scheduledPosts[0].targets[0].profileLabel = "main-fixture-password"; f.write(config);
    const revision = await f.scheduleRevision(); const action = await f.service.prepare({ mode: "cancel", requestKey: "safe-cancel", scheduleId: "queue-1", expectedRevision: revision });
    expect(action.payload.content.linkUrl).toBe(""); expect(action.payload.targets[0].label).toBe("Account"); expect(JSON.stringify(action)).not.toContain("main-fixture-password");
    config.scheduledPosts[0].linkUrl = "https://user:main-fixture-password@example.com/changed"; f.write(config);
    expect(await f.scheduleRevision()).toBe(revision);
    expect(await f.service.get(action.id)).toMatchObject({ state: "conflicting" });
  });
});

describe("absolute times and existing schedule revisions", () => {
  it.each([
    ["2026-10-25T02:30:00+02:00", "2026-10-25T00:30:00.000Z", "GMT+02:00"],
    ["2026-10-25T02:30:00+01:00", "2026-10-25T01:30:00.000Z", "GMT+01:00"],
    ["2026-03-29T03:30:00+02:00", "2026-03-29T01:30:00.000Z", "GMT+02:00"]
  ])("normalizes %s and renders Berlin DST", async (input, utc, offset) => {
    const f = await fixture(); const action = await f.service.prepare(publication({ mode: "schedule", scheduledFor: input }));
    expect(action.payload).toMatchObject({ mode: "schedule", scheduledFor: utc }); expect(action.scheduledLocal).toContain(offset); expect(action.scheduledLocal).toContain("Europe/Berlin");
    expect(await f.service.prepare(publication({ mode: "schedule", scheduledFor: utc }))).toEqual(action);
  });

  it.each(["2026-01-15T11:59:59Z", "2026-01-15T12:00:00Z", "2026-10-25T02:30:00", "2026-02-30T12:00:00Z", "tomorrow"])("rejects past, ambiguous or invalid time %s", async (scheduledFor) => {
    const f = await fixture(); await expect(f.service.prepare(publication({ mode: "schedule", scheduledFor }))).rejects.toMatchObject({ code: "validation_failed" }); expect(f.deps.readRecords()).toEqual([]);
  });

  it("uses configured IANA time and rejects invalid server timezones", async () => {
    const f = await fixture(); vi.stubEnv("CROSSPOSTER_TIMEZONE", "America/New_York");
    const action = await f.service.prepare(publication({ mode: "schedule", scheduledFor: "2026-10-25T01:30:00Z" }));
    expect(action).toMatchObject({ timezone: "America/New_York" }); expect(action.scheduledLocal).toContain("24/10/2026");
    vi.stubEnv("CROSSPOSTER_TIMEZONE", "invalid/zone"); await expect(f.service.prepare(publication({ requestKey: "other" }))).rejects.toMatchObject({ code: "storage_corrupt" });
  });

  it.each(["reschedule", "cancel"])("prepares %s from the complete existing queue snapshot without changing it", async (mode) => {
    const f = await fixture(); f.schedule(); const revision = await f.scheduleRevision(); const before = fs.readFileSync(f.filename, "utf8");
    const action = await f.service.prepare({ mode, requestKey: "queue-action", scheduleId: "queue-1", expectedRevision: revision,
      ...(mode === "reschedule" ? { scheduledFor: "2026-12-01T13:00:00+01:00" } : {}) });
    expect(action.payload).toMatchObject({ mode, scheduleId: "queue-1", expectedRevision: revision, content: { title: "Scheduled title", text: "Scheduled body" }, targets: [{ id: targetId }] });
    expect(fs.readFileSync(f.filename, "utf8")).toBe(before); expect(vi.getTimerCount()).toBe(0);
    const config = f.config(); config.scheduledPosts[0].scheduledFor = "2026-11-01T12:00:00Z"; f.write(config);
    expect(await f.service.get(action.id)).toMatchObject({ state: "conflicting" });
  });

  it("rejects missing, stale and publishing schedules", async () => {
    const f = await fixture();
    await expect(f.service.prepare({ mode: "cancel", requestKey: "q", scheduleId: "missing", expectedRevision: hash("missing") })).rejects.toMatchObject({ code: "schedule_missing" });
    f.schedule(); await expect(f.service.prepare({ mode: "cancel", requestKey: "q", scheduleId: "queue-1", expectedRevision: hash("stale") })).rejects.toMatchObject({ code: "revision_conflict" });
    f.schedule("publishing"); await expect(f.service.prepare({ mode: "cancel", requestKey: "q", scheduleId: "queue-1", expectedRevision: await f.scheduleRevision() })).rejects.toMatchObject({ code: "revision_conflict" });
  });
});

describe("asynchronous preparation rechecks", () => {
  it.each(["account", "media", "owner", "clock", "draft", "schedule", "timezone"])("rejects a changed %s after held media IO without persisting an action", async (change) => {
    const f = await fixture(); const media = await f.media(); let entered!: () => void; let release!: () => void;
    if (change === "draft") {
      const config = f.config(); config.draft = { ...content, media: { id: media.id }, targets: [{ id: targetId, platform: "bluesky", profileId: "main" }], updatedAt: "2026-01-15T11:00:00Z" }; f.write(config);
    }
    if (change === "schedule") { f.schedule(); const config = f.config(); config.scheduledPosts[0].media = { id: media.id }; f.write(config); }
    const started = new Promise<void>((resolve) => { entered = resolve; }); const held = new Promise<void>((resolve) => { release = resolve; });
    const original = f.deps.readMedia;
    vi.spyOn(f.deps, "readMedia").mockImplementationOnce(async (id) => { const value = await original(id); entered(); await held; return value; });
    const input = change === "schedule" ? { mode: "reschedule", requestKey: "stable-key", scheduleId: "queue-1", expectedRevision: await f.scheduleRevision(), scheduledFor: "2026-01-16T12:00:00Z" }
      : publication({ mode: "schedule", scheduledFor: "2026-01-16T12:00:00Z", content: { ...content, mediaId: media.id } });
    const pending = f.service.prepare(input);
    try {
      await started;
      if (change === "account") { const config = f.config(); config.profiles.bluesky[0].values.BLUESKY_IDENTIFIER = "changed.example"; f.write(config); }
      if (change === "media") fs.writeFileSync(media.path, Buffer.alloc(media.size, 1));
      if (change === "owner") fs.unlinkSync(path.join(f.root, ".poster-owner.json"));
      if (change === "clock") vi.setSystemTime(new Date("2026-01-16T12:00:00Z"));
      if (change === "draft") { const config = f.config(); config.draft.updatedAt = "2026-01-15T11:30:00Z"; f.write(config); }
      if (change === "schedule") { const config = f.config(); config.scheduledPosts[0].updatedAt = "2026-01-15T11:30:00Z"; f.write(config); }
      if (change === "timezone") vi.stubEnv("CROSSPOSTER_TIMEZONE", "America/New_York");
      release(); await expect(pending).rejects.toMatchObject({ code: change === "owner" ? "ownership_conflict" : change === "clock" ? "validation_failed" : change === "schedule" ? "revision_conflict" : "action_conflict" });
      expect(f.deps.readRecords()).toEqual([]);
    } finally { release(); await pending.catch(() => {}); if (change === "owner") expect(() => releaseBackendOwners()).toThrow(); }
  });
});

describe("authenticated action routes", () => {
  it("GET is pure for missing and expired actions; POST exposes only the declared DTO", async () => {
    const f = await fixture(); const { POST } = await import("@/app/api/mcp/v1/actions/route"); const { GET } = await import("@/app/api/mcp/v1/actions/[actionId]/route");
    const get = (id: string) => GET(new Request(`http://127.0.0.1:2004/api/mcp/v1/actions/${id}`, { headers: f.headers }), { params: Promise.resolve({ actionId: id }) });
    expect((await get("missing")).status).toBe(404); expect(fs.existsSync(path.join(f.root, ".poster-owner.json"))).toBe(false);
    const response = await POST(f.request(publication())); expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json(); expect(body.data.accountBindings).toBeUndefined(); expect(JSON.stringify(body)).not.toContain("main-fixture-password");
    const before = fs.readFileSync(path.join(f.root, ".poster-actions.json"), "utf8"); vi.setSystemTime(new Date("2026-01-15T12:31:00Z"));
    expect((await (await get(body.data.id)).json()).data.state).toBe("expired"); expect(fs.readFileSync(path.join(f.root, ".poster-actions.json"), "utf8")).toBe(before);
  });

  it("rejects unauthenticated, malformed, unknown-field, duplicate-target and oversized requests", async () => {
    const f = await fixture(); const { POST } = await import("@/app/api/mcp/v1/actions/route");
    const unauthorized = new Request("http://127.0.0.1:2004/api/mcp/v1/actions", { method: "POST", body: "{}" }); expect((await POST(unauthorized)).status).toBe(401);
    for (const body of ["{broken", JSON.stringify(publication({ unexpected: true })), JSON.stringify(publication({ targetIds: [targetId, targetId] })), " ".repeat(1024 * 1024 + 1)]) {
      const response = await POST(new Request("http://127.0.0.1:2004/api/mcp/v1/actions", { method: "POST", headers: f.headers, body }));
      expect(response.status).toBe(400); expect((await response.json()).error.code).toBe("validation_failed");
    }
    expect(f.deps.readRecords()).toEqual([]);
  });
});
