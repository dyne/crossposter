import { writeFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { freezeClock } from "./support/sandbox";

const now = "2026-01-15T12:00:00.000Z";
const result = { platform: "bluesky", ok: true, message: "sent" };
const media = { id: "asset", filename: "fixture.png", contentType: "image/png", size: 12, kind: "image", url: "/api/media/asset" };
const schedule = { id: "queued", createdAt: now, updatedAt: now, scheduledFor: "2026-01-16T14:00:00+02:00", text: " hello ", platforms: ["bluesky"] };

// Characterized through the original public facade before moving its codecs.
async function load(value: unknown) {
  freezeClock(now);
  const config = await import("@/lib/local-config");
  writeFileSync(config.localConfigPath, JSON.stringify(value));
  const saved = config.readLocalConfig();
  const { normalizeConfig } = await import("@/lib/storage/config-codec");
  const decoded = normalizeConfig(value, { createId: () => "generated-id", now: () => now });
  // Generated UUID bytes vary; every other byte must match the facade fixtures.
  expect(JSON.stringify(saved).replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "generated-id"))
    .toBe(JSON.stringify(decoded));
  return saved;
}

describe("persisted configuration compatibility", () => {
  it.each([null, false, 17, "bad", [], {}, { values: [] }, { profiles: false }])("defaults malformed or absent sections: %j", async (value) => {
    expect(await load(value)).toEqual({
      values: {}, profiles: {}, activeProfiles: {},
      draft: { title: "", text: "", linkUrl: "", platforms: [], targets: [] },
      publishedPosts: [], scheduledPosts: []
    });
  });

  it("merges legacy values before nested values, trims credentials, and discards unknown keys", async () => {
    expect((await load({
      POSTER_LOCAL_PORT: " 1234 ", BLUESKY_IDENTIFIER: " legacy ", UNKNOWN: "ignored",
      values: { POSTER_LOCAL_PORT: " 2345 ", BLUESKY_IDENTIFIER: false, X_PREMIUM_LONG_POSTS: " true ", UNKNOWN: "ignored" }
    })).values).toEqual({ POSTER_LOCAL_PORT: "2345", BLUESKY_IDENTIFIER: "legacy", X_PREMIUM_LONG_POSTS: "true" });
  });

  it("keeps valid profile entries and active IDs, including empty and dangling active IDs", async () => {
    const saved = await load({
      profiles: {
        unknown: [{ id: "drop" }], x: "bad", mastodon: [],
        bluesky: [null, [], "bad", { id: " p ", label: " Label ", values: { BLUESKY_IDENTIFIER: " name ", UNKNOWN: "drop" } }, { id: " ", label: " ", values: [] }]
      },
      activeProfiles: { bluesky: " missing ", x: " ", unknown: "drop", mastodon: false }
    });
    expect(saved.profiles).toEqual({ bluesky: [
      { id: "p", label: "Label", values: { BLUESKY_IDENTIFIER: "name" } },
      { id: expect.stringMatching(/^[0-9a-f-]{36}$/), label: "Untitled profile", values: {} }
    ] });
    expect(saved.activeProfiles).toEqual({ bluesky: "missing", x: "" });
  });

  it("preserves content whitespace, truncates fields, falls back to legacy URLs, and caps valid targets", async () => {
    const saved = await load({ draft: {
      title: ` ${"t".repeat(400)}`, text: ` ${"x".repeat(100_010)}`, linkUrl: "", url: "u".repeat(2050), updatedAt: "d".repeat(50),
      platforms: ["unknown", ...Array(35).fill("x")],
      targets: [null, [], { platform: "unknown" }, ...Array.from({ length: 35 }, () => ({ platform: "x", profileId: " p ", profileLabel: " Label " }))]
    } });
    expect(saved.draft).toEqual({
      title: ` ${"t".repeat(299)}`, text: ` ${"x".repeat(99_999)}`, linkUrl: "u".repeat(2048), updatedAt: "d".repeat(40),
      platforms: Array(30).fill("x"), targets: Array(30).fill({ id: "x: p ", platform: "x", profileId: " p ", profileLabel: " Label " })
    });
  });

  it("does not infer draft/history targets from platforms or deduplicate them", async () => {
    const saved = await load({ draft: { platforms: ["x", "x"] }, publishedPosts: [{ results: [result], platforms: ["x", "x"] }] });
    expect(saved.draft).toMatchObject({ platforms: ["x", "x"], targets: [] });
    expect(saved.publishedPosts[0]).toMatchObject({ platforms: ["x", "x"], targets: [] });
  });

  it("filters invalid history, defaults IDs/times, and retains existing result coercion and uncertain loss", async () => {
    const saved = await load({ publishedPosts: [null, [], {}, { results: [{ platform: "unknown" }] }, {
      id: " ", title: " ", text: " text ", url: " legacy ", platforms: ["bluesky", "unknown"], media,
      results: [null, [], { platform: "unknown" }, { ...result, ok: 1, uncertain: true, message: 4, targetId: " ", profileId: " p ", profileLabel: " label ", url: " u " }]
    }, { results: [result] }] });
    expect(saved.publishedPosts).toEqual([
      { id: " ", createdAt: now, title: " ", text: " text ", linkUrl: " legacy ", platforms: ["bluesky"], targets: [], media,
        results: [{ platform: "bluesky", ok: false, message: "", targetId: " ", profileId: " p ", profileLabel: " label ", url: " u " }] },
      { id: expect.stringMatching(/^[0-9a-f-]{36}$/), createdAt: now, text: "", platforms: [], targets: [], results: [result] }
    ]);
  });

  it.each(["image", "video", "audio", "file"])("normalizes optional %s metadata without new validity rules", async (kind) => {
    const saved = await load({ draft: { media: { ...media, id: "", filename: "", kind, contentType: false, size: -5, url: null } } });
    expect(saved.draft.media).toEqual({ id: "", filename: "", kind, contentType: "", size: -5, url: "" });
  });

  it.each([null, [], {}, { ...media, kind: "unknown" }, { ...media, id: 1 }, { ...media, filename: false }])("omits malformed media: %j", async (value) => {
    const saved = await load({ draft: { media: value }, publishedPosts: [{ results: [result], media: value }], scheduledPosts: [{ ...schedule, media: value }] });
    expect(saved.draft).not.toHaveProperty("media");
    expect(saved.publishedPosts[0]).not.toHaveProperty("media");
    expect(saved.scheduledPosts[0]).not.toHaveProperty("media");
  });

  it.each(["scheduled", "publishing", "published", "failed", "canceled", "unknown", null])("normalizes scheduled status %j", async (status) => {
    expect((await load({ scheduledPosts: [{ ...schedule, status }] })).scheduledPosts[0]).toMatchObject({
      scheduledFor: "2026-01-16T12:00:00.000Z", status: ["publishing", "published", "failed", "canceled"].includes(status as string) ? status : "scheduled", attempts: 0
    });
  });

  it.each([[undefined, 0], [null, 0], ["2", 0], [-1, 0], [0, 0], [0.5, 0], [2.9, 2]])("normalizes attempts %j to %j", async (attempts, expected) => {
    expect((await load({ scheduledPosts: [{ ...schedule, attempts }] })).scheduledPosts[0].attempts).toBe(expected);
  });

  it.each(["hackernews", "dribbble", "pinterest", "bluesky"])("preserves existing title-only schedule acceptance for %s", async (platform) => {
    const saved = await load({ scheduledPosts: [{ ...schedule, platforms: [platform], title: " title ", text: " " }] });
    expect(saved.scheduledPosts).toHaveLength(platform === "hackernews" ? 1 : 0);
  });

  it("uses valid targets before platform IDs, retains duplicates and drops malformed schedules", async () => {
    const saved = await load({ scheduledPosts: [null, [], { ...schedule, scheduledFor: "bad" }, { ...schedule, platforms: [] }, { ...schedule, text: " " }, {
      ...schedule, platforms: ["hackernews"], targets: [{ platform: "bluesky" }, { platform: "bluesky", profileId: "p" }],
      media, results: [{ ...result, uncertain: true }], lastError: " error ", publishedPostId: "history", publishedAt: "not-validated"
    }] });
    expect(saved.scheduledPosts).toEqual([{
      ...schedule, scheduledFor: "2026-01-16T12:00:00.000Z", platforms: ["bluesky", "bluesky"],
      targets: [{ id: "bluesky:base", platform: "bluesky" }, { id: "bluesky:p", platform: "bluesky", profileId: "p" }],
      media, results: [result], status: "scheduled", attempts: 0, lastError: " error ", publishedPostId: "history", publishedAt: "not-validated"
    }]);
  });

  it("generates missing schedule ID and timestamps, omitting absent optional fields", async () => {
    const saved = await load({ scheduledPosts: [{ scheduledFor: schedule.scheduledFor, text: "post", platforms: ["bluesky"], results: [{ platform: "unknown" }] }] });
    expect(saved.scheduledPosts).toEqual([{
      id: expect.stringMatching(/^[0-9a-f-]{36}$/), createdAt: now, updatedAt: now, scheduledFor: "2026-01-16T12:00:00.000Z", text: "post", platforms: ["bluesky"], targets: [], status: "scheduled", attempts: 0
    }]);
  });

  it("round-trips normalized public data through the existing JSON format", async () => {
    const config = await import("@/lib/local-config");
    const normalized = await load({
      BLUESKY_IDENTIFIER: " legacy ", profiles: { bluesky: [{ id: "p", label: "Profile", values: { BLUESKY_IDENTIFIER: " profile " } }] },
      activeProfiles: { bluesky: "p" }, draft: { text: "draft", media }, publishedPosts: [{ id: "history", createdAt: now, results: [result], media }],
      scheduledPosts: [{ ...schedule, media, results: [result] }]
    });
    expect(config.writeLocalConfig(normalized)).toEqual(normalized);
    expect(config.readLocalConfig()).toEqual(normalized);
  });
});

describe("pure persisted-data codecs", () => {
  it("injects defaults only when needed, in profile/history/schedule order", async () => {
    const { normalizeConfig } = await import("@/lib/storage/config-codec");
    const events: string[] = [];
    const defaults = {
      createId: vi.fn(() => { events.push("id"); return `generated-${events.length}`; }),
      now: vi.fn(() => { events.push("now"); return `${now}:${events.length}`; })
    };
    const input = {
      profiles: { unknown: [{}], bluesky: [{}, { id: "existing", label: "Existing" }] },
      publishedPosts: [{}, { results: [result] }, { id: "existing", createdAt: "preserved", results: [result] }],
      scheduledPosts: [{}, { ...schedule }, { scheduledFor: schedule.scheduledFor, text: "post", platforms: ["bluesky"] }]
    };
    const before = JSON.stringify(input);
    const saved = normalizeConfig(input, defaults);
    expect(events).toEqual(["id", "id", "now", "id", "now", "now"]);
    expect(saved.profiles.bluesky?.[0].id).toBe("generated-1");
    expect(saved.publishedPosts[0]).toMatchObject({ id: "generated-2", createdAt: `${now}:3` });
    expect(saved.scheduledPosts[1]).toMatchObject({ id: "generated-4", createdAt: `${now}:5`, updatedAt: `${now}:6` });
    expect(JSON.stringify(input)).toBe(before);
  });

  it("needs no time source for profiles or defaults for drafts and rejects invalid records before generation", async () => {
    const { normalizeProfiles } = await import("@/lib/storage/config-codec");
    const { normalizeComposeDraft, normalizePublishedPosts } = await import("@/lib/storage/content-codec");
    const { normalizeScheduledPosts } = await import("@/lib/storage/schedule-codec");
    const defaults = { createId: vi.fn(() => "new-profile"), now: vi.fn(() => now) };
    expect(normalizeProfiles({ x: [{}] }, { createId: defaults.createId })).toEqual({ x: [{ id: "new-profile", label: "Untitled profile", values: {} }] });
    expect(normalizeComposeDraft(false)).toEqual({ title: "", text: "", linkUrl: "", platforms: [], targets: [] });
    defaults.createId.mockClear();
    expect(normalizePublishedPosts([null, {}, { results: [null, { platform: "future" }] }], defaults)).toEqual([]);
    expect(normalizeScheduledPosts([null, {}, { ...schedule, text: " " }], defaults)).toEqual([]);
    expect(defaults.createId).not.toHaveBeenCalled();
    expect(defaults.now).not.toHaveBeenCalled();
  });

  it("retains non-finite numeric coercion and truncation instead of applying request validation", async () => {
    const { normalizePublishedPost } = await import("@/lib/storage/content-codec");
    const { normalizeScheduledPost } = await import("@/lib/storage/schedule-codec");
    const defaults = { createId: () => "generated", now: () => now };
    const long = "z".repeat(100_100);
    const input = {
      ...schedule, id: long, createdAt: long, updatedAt: long, title: long, text: long, linkUrl: long,
      targets: [{ id: long, platform: "x", profileId: long, profileLabel: long }],
      results: [{ ...result, targetId: long, profileId: long, profileLabel: long, message: long, url: long }],
      media: { ...media, id: long, filename: long, contentType: long, url: long, size: NaN },
      lastError: long, publishedAt: long, publishedPostId: long, attempts: Infinity
    };
    const saved = normalizeScheduledPost(input, defaults)!;
    const history = normalizePublishedPost(input, defaults)!;
    expect(saved).toMatchObject({
      id: long.slice(0, 120), createdAt: long.slice(0, 40), updatedAt: long.slice(0, 40),
      title: long.slice(0, 300), text: long.slice(0, 100_000), linkUrl: long.slice(0, 2048),
      lastError: long.slice(0, 1000), publishedPostId: long.slice(0, 120), publishedAt: long.slice(0, 40), attempts: Infinity,
      targets: [{ id: long.slice(0, 180), platform: "x", profileId: long.slice(0, 120), profileLabel: long.slice(0, 180) }],
      results: [{ ...result, targetId: long.slice(0, 180), profileId: long.slice(0, 120), profileLabel: long.slice(0, 180), message: long.slice(0, 1000), url: long.slice(0, 2048) }],
      media: { id: long.slice(0, 120), filename: long.slice(0, 240), contentType: long.slice(0, 160), url: long.slice(0, 2048), size: NaN, kind: "image" }
    });
    expect(history).toMatchObject({ id: saved.id, title: saved.title, text: saved.text, createdAt: saved.createdAt, linkUrl: saved.linkUrl, targets: saved.targets, results: saved.results, media: saved.media });
  });

  it("uses platform fallback for wholly invalid targets and preserves direct non-finite attempt behavior", async () => {
    const { normalizeScheduledPost } = await import("@/lib/storage/schedule-codec");
    const defaults = { createId: () => "generated", now: () => now };
    expect(normalizeScheduledPost({ ...schedule, targets: [{ platform: "unknown" }], attempts: NaN }, defaults))
      .toMatchObject({ platforms: ["bluesky"], targets: [], attempts: 0 });
  });

  it("round-trips complete codec output without invoking defaults again", async () => {
    const { normalizeConfig } = await import("@/lib/storage/config-codec");
    const defaults = { createId: vi.fn(() => "generated"), now: vi.fn(() => now) };
    const saved = normalizeConfig({
      profiles: { x: [{}] }, draft: { text: "draft", media }, publishedPosts: [{ results: [result] }],
      scheduledPosts: [{ scheduledFor: schedule.scheduledFor, text: "post", platforms: ["x"] }]
    }, defaults);
    defaults.createId.mockClear();
    defaults.now.mockClear();
    expect(normalizeConfig(JSON.parse(JSON.stringify(saved)), defaults)).toEqual(saved);
    expect(defaults.createId).not.toHaveBeenCalled();
    expect(defaults.now).not.toHaveBeenCalled();
  });
});
