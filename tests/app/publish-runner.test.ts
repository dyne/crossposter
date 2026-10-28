import { beforeEach, describe, expect, it, vi } from "vitest";
import { imageFile, publishPayload, saveConfig, successfulProviders } from "./support/fixtures";
import { freezeClock } from "./support/sandbox";

beforeEach(async () => { freezeClock(); await successfulProviders(); });

describe("runPublish public entry point", () => {
  it("uses the explicit clock and normalized payload for target-specific dispatch", async () => {
    const { providers } = await import("@/lib/providers");
    const { runPublish } = await import("@/lib/publish-runner");
    const target = { id: "fixture-target", platform: "bluesky" as const, profileLabel: "Fixture label" };
    const now = new Date("2026-01-17T12:00:00.000Z");
    const result = await runPublish({
      ...publishPayload({ title: " Title ", text: " Text ", platforms: ["x"], targets: [target], linkUrl: " https://example.com " }),
      now
    });
    expect(providers.x).not.toHaveBeenCalled();
    expect(providers.bluesky).toHaveBeenCalledWith(expect.objectContaining({ title: "Title", text: "Text", linkUrl: "https://example.com", platforms: ["bluesky"], target, now }));
    expect(result.publishedPost).toMatchObject({ createdAt: now.toISOString(), title: "Title", text: "Text", platforms: ["bluesky"], targets: [target] });
    expect(result.results).toEqual([{ platform: "bluesky", ok: true, targetId: target.id, profileId: undefined, profileLabel: "Fixture label", message: "Fixture published" }]);
  });

  it("dispatches multiple profiles with their own target and configuration", async () => {
    await saveConfig({ profiles: { bluesky: [
      { id: "one", label: "One", values: { BLUESKY_IDENTIFIER: "one.example", BLUESKY_APP_PASSWORD: "fixture-token-one" } },
      { id: "two", label: "Two", values: { BLUESKY_IDENTIFIER: "two.example", BLUESKY_APP_PASSWORD: "fixture-token-two" } }
    ] } });
    const { getConfigValue } = await import("@/lib/local-config");
    const { providers } = await import("@/lib/providers");
    vi.mocked(providers.bluesky).mockImplementation(async (context) => ({ platform: "bluesky", ok: true, message: getConfigValue("BLUESKY_IDENTIFIER", context.target?.profileId) || "missing" }));
    const targets = [
      { id: "one-target", platform: "bluesky" as const, profileId: "one", profileLabel: "One" },
      { id: "two-target", platform: "bluesky" as const, profileId: "two", profileLabel: "Two" }
    ];
    const { runPublish } = await import("@/lib/publish-runner");
    const result = await runPublish(publishPayload({ targets }));
    expect(result.results).toEqual([
      { platform: "bluesky", ok: true, message: "one.example", targetId: "one-target", profileId: "one", profileLabel: "One" },
      { platform: "bluesky", ok: true, message: "two.example", targetId: "two-target", profileId: "two", profileLabel: "Two" }
    ]);
  });

  it("does not dispatch a missing or invalid selected profile", async () => {
    await saveConfig({ profiles: { bluesky: [{ id: "incomplete", label: "Incomplete", values: {} }] } });
    const { providers } = await import("@/lib/providers");
    const { runPublish } = await import("@/lib/publish-runner");
    const result = await runPublish(publishPayload({ targets: [
      { id: "missing-target", platform: "bluesky", profileId: "missing" },
      { id: "bad-target", platform: "bluesky", profileId: "incomplete" }
    ] }));
    expect(result.results.map(({ ok, message }) => ({ ok, message }))).toEqual([
      { ok: false, message: "Selected profile no longer exists" },
      { ok: false, message: "Missing Bluesky handle; Missing Bluesky app password" }
    ]);
    expect(providers.bluesky).not.toHaveBeenCalled();
    expect(result.publishedPost?.results).toHaveLength(2);
  });

  it("validates limits before media lookup, providers and history", async () => {
    const { runPublish } = await import("@/lib/publish-runner");
    await expect(runPublish(publishPayload({ text: "a".repeat(301), mediaId: "invalid" }))).rejects.toThrow("Bluesky post is 301/300 characters.");
    const { providers } = await import("@/lib/providers");
    const { readLocalConfig } = await import("@/lib/local-config");
    expect(providers.bluesky).not.toHaveBeenCalled();
    expect(readLocalConfig().publishedPosts).toEqual([]);
  });

  it("rejects missing media without dispatch or history", async () => {
    const { runPublish } = await import("@/lib/publish-runner");
    await expect(runPublish(publishPayload({ mediaId: "00000000-0000-0000-0000-000000000000.png" }))).rejects.toMatchObject({ code: "ENOENT" });
    const { providers } = await import("@/lib/providers");
    const { readLocalConfig } = await import("@/lib/local-config");
    expect(providers.bluesky).not.toHaveBeenCalled();
    expect(readLocalConfig().publishedPosts).toEqual([]);
  });

  it("passes fixture media to providers while history exposes only public media fields", async () => {
    const { saveUploadedMedia } = await import("@/lib/media-store");
    const media = await saveUploadedMedia(imageFile(), "http://localhost");
    const { runPublish } = await import("@/lib/publish-runner");
    const result = await runPublish({ ...publishPayload({ mediaId: media.id }), requestUrl: "https://fixture.example" });
    const { providers } = await import("@/lib/providers");
    expect(providers.bluesky).toHaveBeenCalledWith(expect.objectContaining({ media: expect.objectContaining({ path: media.path, url: `https://fixture.example/api/media/${media.id}` }) }));
    expect(result.media).toEqual({ id: media.id, filename: "fixture.png", contentType: "image/png", size: media.size, kind: "image", url: `https://fixture.example/api/media/${media.id}` });
    expect(result.publishedPost?.media).toEqual(result.media);
    expect(result.publishedPost?.media).not.toHaveProperty("path");
  });

  it("returns mixed outcomes in target order and preserves live uncertainty", async () => {
    const { providers } = await import("@/lib/providers");
    vi.mocked(providers.x).mockRejectedValue(Object.assign(new Error("Outcome unknown"), { uncertain: true }));
    vi.mocked(providers.mastodon).mockResolvedValue({ platform: "mastodon", ok: false, message: "Fixture rejected" });
    const { runPublish } = await import("@/lib/publish-runner");
    const result = await runPublish(publishPayload({ platforms: ["x", "bluesky", "mastodon"] }));
    expect(result.results.map(({ platform, ok, uncertain, message }) => ({ platform, ok, uncertain, message }))).toEqual([
      { platform: "x", ok: false, uncertain: true, message: "Outcome unknown" },
      { platform: "bluesky", ok: true, uncertain: undefined, message: "Fixture published" },
      { platform: "mastodon", ok: false, uncertain: undefined, message: "Fixture rejected" }
    ]);
    expect(result.publishedPost?.results[0]).not.toHaveProperty("uncertain");
    const { readLocalConfig } = await import("@/lib/local-config");
    expect(readLocalConfig().publishedPosts).toEqual([result.publishedPost]);
  });

  it.each([
    { thrown: new Error("Fixture error"), message: "Fixture error" },
    { thrown: "Fixture string", message: "Unknown error" }
  ])("records all-failed provider outcome as $message", async ({ thrown, message }) => {
    const { providers } = await import("@/lib/providers");
    vi.mocked(providers.bluesky).mockRejectedValue(thrown);
    const { runPublish } = await import("@/lib/publish-runner");
    const result = await runPublish(publishPayload());
    expect(result.results).toEqual([{ platform: "bluesky", targetId: "bluesky", profileId: undefined, profileLabel: undefined, ok: false, message }]);
    expect(result.publishedPost?.results).toEqual([{ platform: "bluesky", targetId: "bluesky", ok: false, message }]);
  });

  it("honors provider-supplied result annotations and fills omitted target annotations", async () => {
    const { providers } = await import("@/lib/providers");
    vi.mocked(providers.bluesky).mockResolvedValue({ platform: "x", ok: true, message: "Fixture", targetId: "provider-target", profileLabel: "Provider label", url: "https://fixture.example/post" });
    const { runPublish } = await import("@/lib/publish-runner");
    const result = await runPublish(publishPayload({ targets: [{ id: "request-target", platform: "bluesky", profileLabel: "Request label" }] }));
    expect(result.results[0]).toMatchObject({ platform: "bluesky", targetId: "provider-target", profileLabel: "Provider label", url: "https://fixture.example/post" });
  });

  it("surfaces history-write failure after provider completion", async () => {
    const { mkdirSync } = await import("node:fs");
    const { localConfigPath } = await import("@/lib/local-config");
    mkdirSync(localConfigPath);
    const { runPublish } = await import("@/lib/publish-runner");
    await expect(runPublish(publishPayload())).rejects.toMatchObject({ code: "EISDIR" });
    const { providers } = await import("@/lib/providers");
    expect(providers.bluesky).toHaveBeenCalledOnce();
  });
});
