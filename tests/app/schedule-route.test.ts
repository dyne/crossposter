import { beforeEach, describe, expect, it, vi } from "vitest";
import { imageFile, jsonRequest, publishPayload, saveConfig, scheduledPost, successfulProviders } from "./support/fixtures";
import { freezeClock } from "./support/sandbox";
import { invalidRequests, linkCases } from "./support/request-cases";

const future = "2026-01-16T12:00:00.000Z";
function scheduleRequest(overrides: Record<string, unknown> = {}) {
  return jsonRequest({ ...publishPayload(), scheduledFor: future, ...overrides }, "/api/scheduled");
}

beforeEach(() => { freezeClock(); });

describe("POST /api/scheduled", () => {
  it("stores normalized content without dispatching providers", async () => {
    const { POST } = await import("@/app/api/scheduled/route");
    const response = await POST(scheduleRequest({ title: " A title ", text: " Fixture text ", scheduledFor: "2026-01-16T13:00:00+01:00" }));
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.scheduledPost).toEqual({
      id: expect.any(String), createdAt: "2026-01-15T12:00:00.000Z", updatedAt: "2026-01-15T12:00:00.000Z",
      scheduledFor: future, title: "A title", text: "Fixture text", platforms: ["bluesky"],
      targets: [{ id: "bluesky", platform: "bluesky" }], status: "scheduled", attempts: 0
    });
    expect(body.scheduledPosts).toEqual([body.scheduledPost]);
    const { getScheduledPosts } = await import("@/lib/local-config");
    expect(getScheduledPosts()).toEqual(body.scheduledPosts);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(invalidRequests)("rejects $name", async ({ body, error }) => {
    const { POST } = await import("@/app/api/scheduled/route");
    const response = await POST(scheduleRequest(body));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error });
    const { getScheduledPosts } = await import("@/lib/local-config");
    expect(getScheduledPosts()).toEqual([]);
  });

  it.each(linkCases)("normalizes or rejects Link $input", async ({ input, normalized, error }) => {
    const { POST } = await import("@/app/api/scheduled/route");
    const response = await POST(scheduleRequest({ linkUrl: input }));
    expect(response.status).toBe(error ? 400 : 200);
    const body = await response.json();
    if (error) expect(body).toEqual({ error });
    else expect(body.scheduledPost.linkUrl).toBe(normalized);
  });

  it.each([
    { platform: "hackernews", persisted: true },
    { platform: "dribbble", persisted: false },
    { platform: "pinterest", persisted: false }
  ])("accepts title-only $platform but persisted=$persisted", async ({ platform, persisted }) => {
    const { POST } = await import("@/app/api/scheduled/route");
    const response = await POST(scheduleRequest({ title: "A title", text: "", platforms: [platform] }));
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.scheduledPost).toMatchObject({ title: "A title", text: "", platforms: [platform] });
    expect(body.scheduledPosts).toHaveLength(persisted ? 1 : 0);
    const { getScheduledPosts } = await import("@/lib/local-config");
    expect(getScheduledPosts()).toEqual(body.scheduledPosts);
  });

  it.each([
    { name: "just over one minute in the past", time: "2026-01-15T11:58:59.999Z", status: 400, error: "Choose a scheduled time in the future." },
    { name: "exactly one minute in the past", time: "2026-01-15T11:59:00.000Z", status: 200 },
    { name: "now", time: "2026-01-15T12:00:00.000Z", status: 200 },
    { name: "invalid date", time: "not-a-date", status: 400, error: "Choose a valid scheduled time." }
  ])("handles $name", async ({ time, status, error }) => {
    const { POST } = await import("@/app/api/scheduled/route");
    const response = await POST(scheduleRequest({ scheduledFor: time }));
    expect(response.status).toBe(status);
    if (error) expect(await response.json()).toEqual({ error });
  });

  it("uses targets over platforms and keeps separate targets for the same platform", async () => {
    const targets = [
      { id: "blue-one", platform: "bluesky", profileId: "fixture-one", profileLabel: "One" },
      { id: "blue-two", platform: "bluesky", profileId: "fixture-two", profileLabel: "Two" }
    ];
    const { POST } = await import("@/app/api/scheduled/route");
    const response = await POST(scheduleRequest({ text: "a".repeat(281), platforms: ["x"], targets }));
    expect(response.status).toBe(200);
    // Storage re-derives platforms from targets without deduplicating them.
    expect((await response.json()).scheduledPost).toMatchObject({ platforms: ["bluesky", "bluesky"], targets });
  });

  it("uses per-profile premium limits and first X target determines duplicate-platform validation", async () => {
    await saveConfig({ profiles: { x: [
      { id: "premium", label: "Premium fixture", values: { X_PREMIUM_LONG_POSTS: "true" } },
      { id: "free", label: "Free fixture", values: { X_PREMIUM_LONG_POSTS: "false" } }
    ] } });
    const premium = { id: "premium-target", platform: "x", profileId: "premium", profileLabel: "Premium fixture" };
    const free = { id: "free-target", platform: "x", profileId: "free", profileLabel: "Free fixture" };
    const { POST } = await import("@/app/api/scheduled/route");
    const accepted = await POST(scheduleRequest({ text: "a".repeat(281), targets: [premium, free] }));
    expect(accepted.status).toBe(200);
    const rejected = await POST(scheduleRequest({ text: "a".repeat(281), targets: [free, premium] }));
    expect(rejected.status).toBe(400);
    expect((await rejected.json()).error).toBe("X / Twitter · Free fixture post is 281/280 characters. Shorten the post or deselect X / Twitter · Free fixture.");
  });

  it("attaches actual fixture media using the request origin", async () => {
    const { saveUploadedMedia } = await import("@/lib/media-store");
    const media = await saveUploadedMedia(imageFile(), "http://localhost");
    const { POST } = await import("@/app/api/scheduled/route");
    const request = scheduleRequest({ mediaId: media.id });
    request.headers.set("host", "fixture.example:2004");
    const response = await POST(request);
    expect(response.status).toBe(200);
    expect((await response.json()).scheduledPost.media).toMatchObject({ id: media.id, url: `http://fixture.example:2004/api/media/${media.id}` });
  });

  it("returns its stable media-not-found error", async () => {
    const { POST } = await import("@/app/api/scheduled/route");
    const response = await POST(scheduleRequest({ mediaId: "00000000-0000-0000-0000-000000000000.png" }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Uploaded media was not found" });
  });

  it("does not apply immediate-publish password checks to scheduling", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("POSTER_REQUIRE_ADMIN_PASSWORD", "true");
    const { POST } = await import("@/app/api/scheduled/route");
    expect((await POST(scheduleRequest())).status).toBe(200);
  });

  it("rejects malformed JSON outside its validation response", async () => {
    const { POST } = await import("@/app/api/scheduled/route");
    await expect(POST(new Request("http://localhost/api/scheduled", { method: "POST", body: "{" }))).rejects.toBeInstanceOf(SyntaxError);
  });

  it.each([
    { platforms: ["unsupported"] },
    { platforms: Array.from({ length: 31 }, () => "bluesky") },
    { targets: [{ id: "", platform: "bluesky" }] }
  ])("rejects malformed channel selections with the generic schedule error", async (selection) => {
    const { POST } = await import("@/app/api/scheduled/route");
    const response = await POST(scheduleRequest(selection));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Schedule request is invalid. Check the fields and try again." });
  });

  it("rejects storage-write failure outside its validation response", async () => {
    const { mkdirSync } = await import("node:fs");
    const { localConfigPath } = await import("@/lib/local-config");
    mkdirSync(localConfigPath);
    const { POST } = await import("@/app/api/scheduled/route");
    await expect(POST(scheduleRequest())).rejects.toMatchObject({ code: "EISDIR" });
  });
});

describe("GET /api/scheduled", () => {
  it("lists scheduled, publishing and failed records newest first", async () => {
    await successfulProviders();
    await saveConfig({ scheduledPosts: [
      scheduledPost({ id: "old", createdAt: "2026-01-12T12:00:00.000Z" }),
      scheduledPost({ id: "failed", status: "failed", createdAt: "2026-01-14T12:00:00.000Z" }),
      scheduledPost({ id: "busy", status: "publishing", createdAt: "2026-01-13T12:00:00.000Z" }),
      scheduledPost({ id: "hidden", status: "published" })
    ] });
    const { GET } = await import("@/app/api/scheduled/route");
    const response = await GET(new Request("http://localhost/api/scheduled"));
    expect(response.status).toBe(200);
    expect((await response.json()).scheduledPosts.map((post: { id: string }) => post.id)).toEqual(["failed", "busy", "old"]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
