import { beforeEach, describe, expect, it, vi } from "vitest";
import { imageFile, jsonRequest, publishPayload, saveConfig, successfulProviders } from "./support/fixtures";
import { freezeClock } from "./support/sandbox";
import { invalidRequests, linkCases } from "./support/request-cases";

beforeEach(async () => { await successfulProviders(); });

describe("POST /api/publish", () => {
  it("publishes normalized content and persists the returned history record", async () => {
    freezeClock();
    const { POST } = await import("@/app/api/publish/route");
    const response = await POST(jsonRequest(publishPayload({ title: " Fixture title ", text: " Fixture text " })));
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body).toEqual({
      results: [{ platform: "bluesky", targetId: "bluesky", ok: true, message: "Fixture published" }],
      publishedPost: {
        id: expect.any(String), createdAt: "2026-01-15T12:00:00.000Z",
        title: "Fixture title", text: "Fixture text", platforms: ["bluesky"],
        targets: [{ id: "bluesky", platform: "bluesky" }],
        results: [{ platform: "bluesky", targetId: "bluesky", ok: true, message: "Fixture published" }]
      }
    });
    const { readLocalConfig } = await import("@/lib/local-config");
    expect(readLocalConfig().publishedPosts).toEqual([body.publishedPost]);
  });

  it.each(invalidRequests)("rejects $name before dispatch", async ({ body, error }) => {
    const { POST } = await import("@/app/api/publish/route");
    const response = await POST(jsonRequest({ ...publishPayload(), ...body }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error });
    const { providers } = await import("@/lib/providers");
    expect(Object.values(providers).every((provider) => vi.mocked(provider).mock.calls.length === 0)).toBe(true);
  });

  it.each(linkCases)("normalizes or rejects Link $input", async ({ input, normalized, error }) => {
    const { POST } = await import("@/app/api/publish/route");
    const response = await POST(jsonRequest(publishPayload({ linkUrl: input as string })));
    expect(response.status).toBe(error ? 400 : 200);
    const body = await response.json();
    if (error) expect(body).toEqual({ error });
    else expect(body.publishedPost.linkUrl).toBe(normalized);
  });

  it.each(["hackernews", "dribbble", "pinterest"] as const)("accepts title-only %s posts", async (platform) => {
    const { POST } = await import("@/app/api/publish/route");
    const response = await POST(jsonRequest({ title: "A title", platforms: [platform] }));
    expect(response.status).toBe(200);
    expect((await response.json()).publishedPost).toMatchObject({ text: "", title: "A title", platforms: [platform] });
  });

  it("uses targets over platforms for validation, dispatch and history", async () => {
    const { POST } = await import("@/app/api/publish/route");
    const target = { id: "blue-base", platform: "bluesky", profileLabel: "Fixture" };
    const response = await POST(jsonRequest({ text: "a".repeat(281), platforms: ["x"], targets: [target] }));
    expect(response.status).toBe(200);
    expect((await response.json()).publishedPost).toMatchObject({ platforms: ["bluesky"], targets: [target] });
    const { providers } = await import("@/lib/providers");
    expect(providers.x).not.toHaveBeenCalled();
    expect(providers.bluesky).toHaveBeenCalledOnce();
  });

  it("keeps duplicate default targets while deduplicating history platforms", async () => {
    const { POST } = await import("@/app/api/publish/route");
    const response = await POST(jsonRequest(publishPayload({ platforms: ["bluesky", "bluesky"], targets: [] })));
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.results).toHaveLength(2);
    expect(body.publishedPost.platforms).toEqual(["bluesky"]);
    expect(body.publishedPost.targets).toEqual([{ id: "bluesky", platform: "bluesky" }, { id: "bluesky", platform: "bluesky" }]);
  });

  it("applies the selected X profile's premium override rather than the base setting", async () => {
    await saveConfig({ values: { X_PREMIUM_LONG_POSTS: "false" }, profiles: { x: [
      { id: "premium", label: "Premium fixture", values: { X_PREMIUM_LONG_POSTS: "true" } },
      { id: "free", label: "Free fixture", values: { X_PREMIUM_LONG_POSTS: "false" } }
    ] } });
    const { POST } = await import("@/app/api/publish/route");
    const premium = await POST(jsonRequest(publishPayload({ text: "a".repeat(281), targets: [{ id: "premium-target", platform: "x", profileId: "premium" }] })));
    expect(premium.status).toBe(200);
    expect((await premium.json()).results[0]).toMatchObject({ profileId: "premium", ok: true });
    const free = await POST(jsonRequest(publishPayload({ text: "a".repeat(281), targets: [{ id: "free-target", platform: "x", profileId: "free" }] })));
    expect(free.status).toBe(400);
    expect((await free.json()).error).toBe("X / Twitter post is 281/280 characters. Shorten the post or deselect X / Twitter.");
  });

  it.each([
    { platforms: ["unsupported"] },
    { platforms: Array.from({ length: 31 }, () => "bluesky") },
    { targets: [{ id: "", platform: "bluesky" }] }
  ])("rejects malformed channel selections with the generic publish error", async (selection) => {
    const { POST } = await import("@/app/api/publish/route");
    const response = await POST(jsonRequest({ ...publishPayload(), ...selection }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Publish request is invalid. Check the highlighted fields and try again." });
  });

  it("normalizes Media URL independently and prioritizes text errors over Media URL", async () => {
    const { POST } = await import("@/app/api/publish/route");
    const { providers } = await import("@/lib/providers");
    const response = await POST(jsonRequest(publishPayload({ mediaUrl: " media.example/image.png " })));
    expect(response.status).toBe(200);
    expect(providers.bluesky).toHaveBeenCalledWith(expect.objectContaining({ mediaUrl: "https://media.example/image.png" }));
    const invalid = await POST(jsonRequest(publishPayload({ text: "a".repeat(301), mediaUrl: "ftp://example.com" })));
    expect(await invalid.json()).toEqual({ error: "Bluesky post is 301/300 characters. Shorten the post or deselect Bluesky." });
    const badMedia = await POST(jsonRequest(publishPayload({ mediaUrl: "ftp://example.com" })));
    expect(await badMedia.json()).toEqual({ error: "Media URL is invalid. Upload a local file instead." });
  });

  it("uses forwarded origin for a real fixture media upload", async () => {
    const { saveUploadedMedia } = await import("@/lib/media-store");
    const media = await saveUploadedMedia(imageFile(), "http://localhost");
    const request = jsonRequest(publishPayload({ mediaId: media.id }));
    request.headers.set("x-forwarded-host", "fixture.example, proxy.internal");
    request.headers.set("x-forwarded-proto", "https, http");
    const { POST } = await import("@/app/api/publish/route");
    const response = await POST(request);
    expect(response.status).toBe(200);
    expect((await response.json()).publishedPost.media.url).toBe(`https://fixture.example/api/media/${media.id}`);
  });

  it.each([
    { mode: "test", setting: undefined, password: undefined, provided: undefined, status: 200 },
    { mode: "production", setting: undefined, password: undefined, provided: undefined, status: 500 },
    { mode: "production", setting: undefined, password: "fixture-secret", provided: undefined, status: 401 },
    { mode: "production", setting: "false", password: undefined, provided: undefined, status: 200 },
    { mode: "test", setting: "true", password: undefined, provided: undefined, status: 500 },
    { mode: "test", setting: "true", password: "fixture-secret", provided: "wrong", status: 401 },
    { mode: "test", setting: "true", password: "fixture-secret", provided: "fixture-secret", status: 200 }
  ])("password mode $mode/$setting with supplied $provided returns $status", async ({ mode, setting, password, provided, status }) => {
    vi.stubEnv("NODE_ENV", mode);
    vi.stubEnv("POSTER_REQUIRE_ADMIN_PASSWORD", setting);
    vi.stubEnv("POSTER_ADMIN_PASSWORD", password);
    const { POST } = await import("@/app/api/publish/route");
    const response = await POST(jsonRequest({ ...publishPayload(), adminPassword: provided }));
    expect(response.status).toBe(status);
    if (status !== 200) expect(await response.json()).toEqual({ error: status === 500 ? "Server is missing POSTER_ADMIN_PASSWORD" : "Unauthorized" });
  });

  it("validates payload before checking a supplied password", async () => {
    await saveConfig({ values: { POSTER_REQUIRE_ADMIN_PASSWORD: "true", POSTER_ADMIN_PASSWORD: "fixture-secret" } });
    const { POST } = await import("@/app/api/publish/route");
    const response = await POST(jsonRequest({ platforms: [], adminPassword: "wrong" }));
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain("Select at least one channel.");
  });

  it("rejects malformed JSON rather than returning its own validation response", async () => {
    const { POST } = await import("@/app/api/publish/route");
    await expect(POST(new Request("http://localhost/api/publish", { method: "POST", body: "{" }))).rejects.toBeInstanceOf(SyntaxError);
  });

  it("reports missing password configuration before attempting malformed JSON", async () => {
    vi.stubEnv("POSTER_REQUIRE_ADMIN_PASSWORD", "true");
    const { POST } = await import("@/app/api/publish/route");
    const response = await POST(new Request("http://localhost/api/publish", { method: "POST", body: "{" }));
    expect(response.status).toBe(500);
  });

  it("returns partial and uncertain outcomes live while stored history drops uncertain", async () => {
    const { providers } = await import("@/lib/providers");
    vi.mocked(providers.x).mockRejectedValue(Object.assign(new Error("Check the fixture profile"), { uncertain: true }));
    const { POST } = await import("@/app/api/publish/route");
    const response = await POST(jsonRequest(publishPayload({ platforms: ["bluesky", "x"] })));
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.results).toEqual([
      { platform: "bluesky", targetId: "bluesky", ok: true, message: "Fixture published" },
      { platform: "x", targetId: "x", ok: false, uncertain: true, message: "Check the fixture profile" }
    ]);
    expect(body.publishedPost.results[1]).not.toHaveProperty("uncertain");
    const { readLocalConfig } = await import("@/lib/local-config");
    expect(readLocalConfig().publishedPosts[0]).toEqual(body.publishedPost);
  });

  it("returns HTTP 400 if fixture media lookup fails", async () => {
    const { POST } = await import("@/app/api/publish/route");
    const response = await POST(jsonRequest(publishPayload({ mediaId: "00000000-0000-0000-0000-000000000000.png" })));
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain("ENOENT");
  });

  it("returns HTTP 200 even if every provider reports failure", async () => {
    const { providers } = await import("@/lib/providers");
    vi.mocked(providers.bluesky).mockResolvedValue({ platform: "bluesky", ok: false, message: "Fixture rejected" });
    const { POST } = await import("@/app/api/publish/route");
    const response = await POST(jsonRequest(publishPayload()));
    expect(response.status).toBe(200);
    expect((await response.json()).results).toEqual([{ platform: "bluesky", targetId: "bluesky", ok: false, message: "Fixture rejected" }]);
  });

  it("maps history-write failure to HTTP 400 after provider completion", async () => {
    const { mkdirSync } = await import("node:fs");
    const { localConfigPath } = await import("@/lib/local-config");
    mkdirSync(localConfigPath);
    const { POST } = await import("@/app/api/publish/route");
    const response = await POST(jsonRequest(publishPayload()));
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain("EISDIR");
    const { providers } = await import("@/lib/providers");
    expect(providers.bluesky).toHaveBeenCalledOnce();
  });
});
