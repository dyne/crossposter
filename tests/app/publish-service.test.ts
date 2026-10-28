import { describe, expect, it, vi } from "vitest";
import { createPublishService, type PublishDependencies } from "@/lib/publishing/service";
import type { ProviderContext, PublishResult } from "@/lib/types";
import { publishPayload } from "./support/fixtures";

const instant = new Date("2026-01-17T12:00:00.000Z");

function provider() {
  return vi.fn(async (context: ProviderContext): Promise<PublishResult> => ({
    platform: context.platforms[0], ok: true, message: "Published fixture"
  }));
}

function fixture() {
  const dependencies = {
    providers: {
      x: provider(), linkedin: provider(), bluesky: provider(), mastodon: provider(),
      instagram: provider(), youtube: provider(), dribbble: provider(),
      pinterest: provider(), devto: provider(), hackernews: provider(), nostr: provider()
    },
    getConfigValue: vi.fn<PublishDependencies["getConfigValue"]>(() => undefined),
    getProfileConfigIssues: vi.fn<PublishDependencies["getProfileConfigIssues"]>(() => []),
    getUploadedMedia: vi.fn<PublishDependencies["getUploadedMedia"]>(),
    appendPublishedPost: vi.fn<PublishDependencies["appendPublishedPost"]>((post) => post),
    now: vi.fn(() => instant),
    createId: vi.fn(() => "fixture-post-id")
  } satisfies PublishDependencies;
  return { ...dependencies, run: createPublishService(dependencies) };
}

describe("publishing service with injected edges", () => {
  it.each([undefined, []])("defaults targets from platforms when targets is %j", async (targets) => {
    const f = fixture();
    const result = await f.run(publishPayload({ targets, platforms: ["bluesky", "x"] }));
    expect(result.results.map((item) => item.targetId)).toEqual(["bluesky", "x"]);
    expect(result.publishedPost).toMatchObject({
      id: "fixture-post-id", createdAt: instant.toISOString(), platforms: ["bluesky", "x"],
      targets: [{ id: "bluesky", platform: "bluesky" }, { id: "x", platform: "x" }]
    });
    expect(f.now).toHaveBeenCalledOnce();
    expect(f.createId).toHaveBeenCalledOnce();
    expect(f.getUploadedMedia).not.toHaveBeenCalled();
  });

  it("prefers explicit targets, deduplicates history platforms and normalizes context", async () => {
    const f = fixture();
    const now = new Date("2026-01-18T12:00:00.000Z");
    const targets = [
      { id: "one", platform: "bluesky" as const, profileId: "one", profileLabel: "One" },
      { id: "two", platform: "bluesky" as const, profileId: "two", profileLabel: "Two" }
    ];
    const result = await f.run({ ...publishPayload({ platforms: ["x"], targets, text: " Text ", title: " Title ", linkUrl: " https://fixture.example ", mediaUrl: "https://fixture.example/media" }), now });
    expect(f.providers.x).not.toHaveBeenCalled();
    expect(f.providers.bluesky).toHaveBeenCalledTimes(2);
    for (const target of targets) {
      expect(f.providers.bluesky).toHaveBeenCalledWith({
        title: "Title", text: "Text", linkUrl: "https://fixture.example", mediaId: undefined,
        mediaUrl: "https://fixture.example/media", media: undefined,
        platforms: ["bluesky"], targets, target, now
      });
      expect(f.getProfileConfigIssues).toHaveBeenCalledWith("bluesky", target.profileId);
    }
    expect(f.now).not.toHaveBeenCalled();
    expect(result.publishedPost).toMatchObject({ platforms: ["bluesky"], targets });
    expect(result.results.map(({ targetId, profileId, profileLabel }) => ({ targetId, profileId, profileLabel })))
      .toEqual(targets.map(({ id, profileId, profileLabel }) => ({ targetId: id, profileId, profileLabel })));
  });

  it("returns profile failures without calling their provider and limits messages to two", async () => {
    const f = fixture();
    f.getProfileConfigIssues.mockImplementation((_platform, profileId) => profileId === "missing"
      ? [{ message: "Selected profile no longer exists" }]
      : [{ message: "Missing handle" }, { message: "Missing password" }, { message: "Hidden third issue" }]);
    const result = await f.run(publishPayload({ targets: [
      { id: "missing", platform: "bluesky", profileId: "missing", profileLabel: "Missing" },
      { id: "invalid", platform: "bluesky", profileId: "invalid" }
    ] }));
    expect(f.providers.bluesky).not.toHaveBeenCalled();
    expect(result.results).toEqual([
      { platform: "bluesky", targetId: "missing", profileId: "missing", profileLabel: "Missing", ok: false, message: "Selected profile no longer exists" },
      { platform: "bluesky", targetId: "invalid", profileId: "invalid", profileLabel: undefined, ok: false, message: "Missing handle; Missing password" }
    ]);
    expect(f.appendPublishedPost).toHaveBeenCalledWith(expect.objectContaining({ results: result.results }));
  });

  it("rejects missing media before provider/config checks or history", async () => {
    const f = fixture();
    const missing = new Error("Missing fixture media");
    f.getUploadedMedia.mockRejectedValue(missing);
    await expect(f.run({ ...publishPayload({ mediaId: "missing" }), requestUrl: "https://fixture.example" })).rejects.toBe(missing);
    expect(f.getUploadedMedia).toHaveBeenCalledWith("missing", "https://fixture.example");
    expect(f.providers.bluesky).not.toHaveBeenCalled();
    expect(f.getProfileConfigIssues).not.toHaveBeenCalled();
    expect(f.appendPublishedPost).not.toHaveBeenCalled();
    expect(f.createId).not.toHaveBeenCalled();
  });

  it.each([
    { platforms: ["bluesky"] as const, text: "x".repeat(301), title: "", message: "Bluesky post is 301/300" },
    { platforms: ["hackernews"] as const, text: "", title: "x".repeat(81), message: "Hacker News title is 81/80" }
  ])("rejects $message before IO", async ({ platforms, text, title, message }) => {
    const f = fixture();
    await expect(f.run(publishPayload({ platforms: [...platforms], text, title, mediaId: "missing" }))).rejects.toThrow(message);
    expect(f.getUploadedMedia).not.toHaveBeenCalled();
    expect(f.getProfileConfigIssues).not.toHaveBeenCalled();
    expect(Object.values(f.providers).every((item) => item.mock.calls.length === 0)).toBe(true);
    expect(f.appendPublishedPost).not.toHaveBeenCalled();
  });

  it("uses each X profile for limit lookup and preserves first-target limit precedence", async () => {
    const f = fixture();
    f.getConfigValue.mockImplementation((_name, profileId) => profileId === "premium" ? "true" : "false");
    const targets = [
      { id: "premium", platform: "x" as const, profileId: "premium", profileLabel: "Premium" },
      { id: "free", platform: "x" as const, profileId: "free", profileLabel: "Free" }
    ];
    await f.run(publishPayload({ targets, text: "x".repeat(281) }));
    expect(f.getConfigValue.mock.calls).toEqual([["X_PREMIUM_LONG_POSTS", "premium"], ["X_PREMIUM_LONG_POSTS", "free"]]);
    expect(f.providers.x).toHaveBeenCalledTimes(2);
    await expect(f.run(publishPayload({ targets: [...targets].reverse(), text: "x".repeat(281) })))
      .rejects.toThrow("X / Twitter · Free post is 281/280");
    expect(f.providers.x).toHaveBeenCalledTimes(2);
    expect(f.appendPublishedPost).toHaveBeenCalledOnce();
  });

  it("passes private media context to providers and only public fields to history/results", async () => {
    const f = fixture();
    const media = {
      id: "fixture-media", filename: "fixture.png", contentType: "image/png", size: 1,
      kind: "image" as const, path: "/fixture/private.png", url: "https://fixture.example/media",
      width: 1, height: 1
    };
    f.getUploadedMedia.mockResolvedValue(media);
    const result = await f.run(publishPayload({ mediaId: media.id }));
    const publicMedia = {
      id: media.id, filename: media.filename, contentType: media.contentType,
      size: media.size, kind: media.kind, url: media.url
    };
    expect(f.providers.bluesky).toHaveBeenCalledWith(expect.objectContaining({ media }));
    expect(result.media).toEqual(publicMedia);
    expect(result.publishedPost?.media).toEqual(publicMedia);
    expect(f.appendPublishedPost).toHaveBeenCalledWith(expect.objectContaining({ media: publicMedia }));
  });

  it("keeps concurrent dispatch, ordered mixed results and writes history after all completions", async () => {
    const f = fixture();
    let release = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let inFlight = 0;
    f.providers.bluesky.mockImplementation(async () => {
      inFlight += 1;
      try {
        await gate;
        return { platform: "bluesky", ok: true, message: "First target finished last" };
      } finally { inFlight -= 1; }
    });
    f.providers.x.mockResolvedValue({ platform: "x", ok: false, message: "Second target rejected" });
    const run = f.run(publishPayload({ platforms: ["bluesky", "x"] }));
    let result;
    try {
      expect(inFlight).toBe(1);
      expect(f.providers.x).toHaveBeenCalledOnce();
      expect(f.appendPublishedPost).not.toHaveBeenCalled();
    } finally {
      release();
      result = await run;
    }
    expect(inFlight).toBe(0);
    expect(result.results.map(({ ok, message }) => ({ ok, message }))).toEqual([
      { ok: true, message: "First target finished last" }, { ok: false, message: "Second target rejected" }
    ]);
    expect(f.appendPublishedPost).toHaveBeenCalledOnce();
  });

  it.each([
    { thrown: new Error("Rejected fixture"), message: "Rejected fixture", uncertain: undefined },
    { thrown: "Rejected string", message: "Unknown error", uncertain: undefined },
    { thrown: { message: "Not an Error", uncertain: true }, message: "Unknown error", uncertain: undefined },
    { thrown: Object.assign(new Error("Check account"), { uncertain: true }), message: "Check account", uncertain: true }
  ])("records thrown outcomes: $message / $uncertain", async ({ thrown, message, uncertain }) => {
    const f = fixture();
    f.providers.bluesky.mockRejectedValue(thrown);
    const result = await f.run(publishPayload());
    expect(result.results[0]).toMatchObject({ platform: "bluesky", ok: false, message, targetId: "bluesky" });
    expect(result.results[0].uncertain).toBe(uncertain);
    expect(f.appendPublishedPost).toHaveBeenCalledWith(expect.objectContaining({ results: result.results }));
  });

  it("preserves returned uncertainty and provider annotations while filling empty annotations", async () => {
    const f = fixture();
    f.providers.bluesky.mockResolvedValue({
      platform: "x", ok: false, uncertain: true, message: "Unknown", url: "https://fixture.example/post",
      targetId: "provider-target", profileId: "provider-profile", profileLabel: ""
    });
    const result = await f.run(publishPayload({ targets: [
      { id: "request-target", platform: "bluesky", profileId: "request-profile", profileLabel: "Request label" }
    ] }));
    expect(result.results).toEqual([{
      platform: "bluesky", ok: false, uncertain: true, message: "Unknown", url: "https://fixture.example/post",
      targetId: "provider-target", profileId: "provider-profile", profileLabel: "Request label"
    }]);
    expect(result.publishedPost?.results).toEqual(result.results);
  });

  it("returns the history writer's normalized post without changing live results", async () => {
    const f = fixture();
    f.providers.bluesky.mockResolvedValue({ platform: "bluesky", ok: false, uncertain: true, message: "Unknown" });
    f.appendPublishedPost.mockImplementation((post) => ({
      ...post, results: post.results.map(({ platform, ok, message, targetId }) => ({ platform, ok, message, targetId }))
    }));
    const result = await f.run(publishPayload());
    expect(result.results[0].uncertain).toBe(true);
    expect(result.publishedPost?.results[0]).not.toHaveProperty("uncertain");
  });

  it("preserves an absent history post returned by the writer", async () => {
    const f = fixture();
    f.appendPublishedPost.mockReturnValue(undefined);
    const result = await f.run(publishPayload());
    expect(result.publishedPost).toBeUndefined();
    expect(result.results[0].ok).toBe(true);
  });

  it("propagates history failure after provider completion without retrying", async () => {
    const f = fixture();
    const failure = new Error("History unavailable");
    f.appendPublishedPost.mockImplementation(() => { throw failure; });
    await expect(f.run(publishPayload())).rejects.toBe(failure);
    expect(f.providers.bluesky).toHaveBeenCalledOnce();
    expect(f.appendPublishedPost).toHaveBeenCalledOnce();
    expect(f.appendPublishedPost).toHaveBeenCalledWith(expect.objectContaining({
      results: [expect.objectContaining({ ok: true })]
    }));
  });
});
