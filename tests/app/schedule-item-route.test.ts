import { beforeEach, describe, expect, it, vi } from "vitest";
import { freezeClock } from "./support/sandbox";
import { imageFile, jsonRequest, saveConfig, scheduledPost, successfulProviders } from "./support/fixtures";
import type { ScheduledPost } from "@/lib/types";

const now = "2026-01-15T12:00:00.000Z";
const future = "2026-01-16T12:00:00.000Z";
const context = (id = "fixture-schedule") => ({ params: Promise.resolve({ id }) });
const patchRequest = (body: unknown) => jsonRequest(body, "/api/scheduled/fixture-schedule");

beforeEach(() => {
  freezeClock();
  vi.stubGlobal("__crossposterScheduler", { running: false });
});

describe("scheduled item routes", () => {
  it.each(["PATCH", "DELETE"] as const)("returns 404 for missing %s entries before parsing the body", async (method) => {
    const route = await import("@/app/api/scheduled/[id]/route");
    const response = await route[method](new Request("http://localhost/api/scheduled/missing", { method, body: "{" }), context("missing"));
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Scheduled post was not found" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    { method: "PATCH" as const, status: "publishing" as const, action: "rescheduled" },
    { method: "PATCH" as const, status: "published" as const, action: "rescheduled" },
    { method: "DELETE" as const, status: "publishing" as const, action: "discarded" },
    { method: "DELETE" as const, status: "published" as const, action: "discarded" }
  ])("rejects $method for $status before parsing a malformed request", async ({ method, status, action }) => {
    await saveConfig({ scheduledPosts: [scheduledPost({ status })] });
    const route = await import("@/app/api/scheduled/[id]/route");
    const response = await route[method](new Request("http://localhost/api/scheduled/fixture-schedule", { method, body: "{" }), context());
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: `This scheduled post can no longer be ${action}.` });
    const { getScheduledPosts } = await import("@/lib/local-config");
    expect(getScheduledPosts()[0].status).toBe(status);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reschedules a failed entry and clears errors/results while retaining attempts and history linkage", async () => {
    const failed = scheduledPost({
      status: "failed", attempts: 4, lastError: "Check the profile before rescheduling",
      results: [{ platform: "bluesky", ok: false, message: "Failed" }],
      publishedPostId: "old-history", publishedAt: "2026-01-14T12:00:00.000Z"
    });
    await saveConfig({ scheduledPosts: [failed,
      scheduledPost({ id: "old", createdAt: "2026-01-14T12:00:00.000Z" }),
      scheduledPost({ id: "hidden", status: "canceled" })
    ] });
    const { PATCH } = await import("@/app/api/scheduled/[id]/route");
    const response = await PATCH(patchRequest({ scheduledFor: "2026-01-17T13:00:00+01:00" }), context());
    expect(response.status).toBe(200);
    const body = await response.json();
    const { getScheduledPosts } = await import("@/lib/local-config");
    const saved = getScheduledPosts().find((post) => post.id === failed.id);
    expect(body.scheduledPost).toEqual(saved);
    expect(saved).toEqual({
      ...failed, status: "scheduled", scheduledFor: "2026-01-17T12:00:00.000Z", updatedAt: now,
      results: undefined, lastError: undefined, targets: []
    });
    expect(body.scheduledPosts.map((post: ScheduledPost) => post.id)).toEqual([failed.id, "old"]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("allows an existing canceled entry to be rescheduled", async () => {
    await saveConfig({ scheduledPosts: [scheduledPost({ status: "canceled" })] });
    const { PATCH } = await import("@/app/api/scheduled/[id]/route");
    const response = await PATCH(patchRequest({ scheduledFor: future }), context());
    expect(response.status).toBe(200);
    expect((await response.json()).scheduledPost.status).toBe("scheduled");
  });

  it.each([
    { time: "2026-01-15T11:58:59.999Z", status: 400, error: "Choose a scheduled time in the future." },
    { time: "2026-01-15T11:59:00.000Z", status: 200 },
    { time: now, status: 200 },
    { time: future, status: 200 }
  ])("preserves the reschedule tolerance for $time", async ({ time, status, error }) => {
    await saveConfig({ scheduledPosts: [scheduledPost()] });
    const { PATCH } = await import("@/app/api/scheduled/[id]/route");
    const response = await PATCH(patchRequest({ scheduledFor: time }), context());
    expect(response.status).toBe(status);
    const body = await response.json();
    if (error) expect(body).toEqual({ error });
    else expect(body.scheduledPost.scheduledFor).toBe(time);
  });

  it.each([{}, { scheduledFor: "" }, { scheduledFor: "invalid" }, { scheduledFor: 4 }, { scheduledFor: "a".repeat(81) }])("rejects invalid reschedule data %j without changing storage", async (body) => {
    await saveConfig({ scheduledPosts: [scheduledPost()] });
    const { PATCH } = await import("@/app/api/scheduled/[id]/route");
    const response = await PATCH(patchRequest(body), context());
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Choose a valid scheduled time." });
    const { getScheduledPosts } = await import("@/lib/local-config");
    expect(getScheduledPosts()[0].scheduledFor).toBe(future);
  });

  it("keeps malformed reschedule JSON outside the validation response", async () => {
    await saveConfig({ scheduledPosts: [scheduledPost()] });
    const { PATCH } = await import("@/app/api/scheduled/[id]/route");
    await expect(PATCH(new Request("http://localhost/api/scheduled/fixture-schedule", { method: "PATCH", body: "{" }), context())).rejects.toBeInstanceOf(SyntaxError);
  });

  it.each(["scheduled", "failed", "canceled"] as const)("discards a %s entry and returns the visible queue newest first", async (status) => {
    const discarded = scheduledPost({ status });
    await saveConfig({ scheduledPosts: [discarded,
      scheduledPost({ id: "old", createdAt: "2026-01-12T12:00:00.000Z" }),
      scheduledPost({ id: "failed", status: "failed", createdAt: "2026-01-14T12:00:00.000Z" }),
      scheduledPost({ id: "publishing", status: "publishing", createdAt: "2026-01-13T12:00:00.000Z" }),
      scheduledPost({ id: "hidden", status: "published" })
    ] });
    const { DELETE } = await import("@/app/api/scheduled/[id]/route");
    const response = await DELETE(new Request("http://localhost/api/scheduled/fixture-schedule", { method: "DELETE" }), context());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.scheduledPost).toEqual({ ...discarded, targets: [] });
    expect(body.scheduledPosts.map((post: ScheduledPost) => post.id)).toEqual(["failed", "publishing", "old"]);
    const { getScheduledPosts } = await import("@/lib/local-config");
    expect(getScheduledPosts().map((post) => post.id)).toEqual(["old", "failed", "publishing", "hidden"]);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("GET-triggered scheduled publishing", () => {
  it("runs due publishing before returning the collection, with timer startup disabled", async () => {
    const providers = await successfulProviders();
    await saveConfig({ scheduledPosts: [scheduledPost({ scheduledFor: now })] });
    const { GET } = await import("@/app/api/scheduled/route");
    const response = await GET(new Request("http://localhost/api/scheduled"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ scheduledPosts: [] });
    expect(providers.bluesky).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["GET", "POST"] as const)("returns stable tick counts for %s and uses the forwarded origin", async (method) => {
    const providers = await successfulProviders();
    const { saveUploadedMedia } = await import("@/lib/media-store");
    const media = await saveUploadedMedia(imageFile(), "http://localhost");
    await saveConfig({ scheduledPosts: [scheduledPost({ scheduledFor: now, media })] });
    const route = await import("@/app/api/scheduled/tick/route");
    const response = await route[method](new Request("http://localhost/api/scheduled/tick", { method, headers: { "x-forwarded-host": "fixture.test:2004", "x-forwarded-proto": "https" } }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, processed: 1, skipped: false });
    expect(providers.bluesky).toHaveBeenCalledTimes(1);
    expect(vi.mocked(providers.bluesky).mock.calls[0][0].media?.url).toBe(`https://fixture.test:2004/api/media/${media.id}`);
    const { getScheduledPosts, readLocalConfig } = await import("@/lib/local-config");
    expect(getScheduledPosts()).toEqual([]);
    expect(readLocalConfig().publishedPosts).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
