import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { composeDraft, imageFile, publishPayload } from "./support/fixtures";
import { assertNoBlockedCalls, createDataRoot, freezeClock, takeBlockedCalls, useDataRoot } from "./support/sandbox";

describe("isolated application harness", () => {
  it("executes actual TypeScript modules through the application alias", async () => {
    const root = useDataRoot();
    const { dataPath } = await import("@/lib/runtime-paths");
    const { compactText } = await import("@/lib/http");
    expect(dataPath("example.json")).toBe(path.join(root, "example.json"));
    expect(compactText(["First", undefined, "Second"])).toBe("First\n\nSecond");
  });

  it("keeps config, drafts and uploaded media in two independent data roots", async () => {
    const firstRoot = useDataRoot();
    const firstConfig = await import("@/lib/local-config");
    const firstMedia = await import("@/lib/media-store");
    firstConfig.writeLocalConfig({
      ...firstConfig.readLocalConfig(),
      values: { BLUESKY_IDENTIFIER: "fixture.example" },
      draft: composeDraft({ text: "Only in the first root" })
    });
    const media = await firstMedia.saveUploadedMedia(imageFile(), "http://localhost");

    const secondRoot = useDataRoot(createDataRoot());
    const secondConfig = await import("@/lib/local-config");
    const secondMedia = await import("@/lib/media-store");
    expect(secondRoot).not.toBe(firstRoot);
    expect(secondConfig.localConfigPath).toBe(path.join(secondRoot, "poster.config.local.json"));
    expect(secondConfig.readLocalConfig()).toMatchObject({ values: {}, draft: { text: "" } });
    await expect(secondMedia.getUploadedMedia(media.id)).rejects.toThrow("ENOENT");
    secondConfig.writeLocalConfig({ ...secondConfig.readLocalConfig(), draft: composeDraft({ text: "Second root" }) });

    expect(firstConfig.readLocalConfig().draft.text).toBe("Only in the first root");
    expect(firstConfig.getConfigValue("BLUESKY_IDENTIFIER")).toBe("fixture.example");
    expect(secondConfig.readLocalConfig().draft.text).toBe("Second root");
    expect(await firstMedia.getUploadedMedia(media.id)).toMatchObject({ path: path.join(firstRoot, ".poster-uploads", media.id), size: media.size });
  });

  it("blocks fetch, HTTP, sockets and WebSockets before any outbound call", async () => {
    const http = await import("node:http");
    const net = await import("node:net");
    expect(() => fetch("https://example.invalid")).toThrow("Unexpected test IO: fetch");
    expect(() => http.get("http://example.invalid")).toThrow("node:http.get");
    expect(() => net.connect(443, "example.invalid")).toThrow("node:net.connect");
    expect(() => new WebSocket("wss://example.invalid")).toThrow("WebSocket");
    expect(takeBlockedCalls()).toEqual(["fetch", "node:http.get", "node:net.connect", "WebSocket"]);
  });

  it("requires explicit process and provider fakes", async () => {
    const { spawn } = await import("node:child_process");
    const { providers } = await import("@/lib/providers");
    expect(() => spawn("must-not-run")).toThrow("process.spawn");
    await expect(providers.bluesky({ ...publishPayload(), now: new Date() })).rejects.toThrow("provider.bluesky");
    expect(takeBlockedCalls()).toEqual(["process.spawn", "provider.bluesky"]);
    vi.mocked(providers.bluesky).mockResolvedValue({ platform: "bluesky", ok: true, message: "Fixture only" });
    await expect(providers.bluesky({ ...publishPayload(), now: new Date() })).resolves.toMatchObject({ ok: true });
  });

  it("fails the guard check even if application code catches forbidden IO", () => {
    try { fetch("https://example.invalid"); } catch { /* Simulate a provider catching an IO error. */ }
    expect(assertNoBlockedCalls).toThrow("Unexpected test IO was caught by application code: fetch");
    expect(takeBlockedCalls()).toEqual([]);
  });

  it("blocks filesystem reads outside disposable fixture roots", async () => {
    const { readFileSync } = await import("node:fs");
    expect(() => readFileSync("/outside-test-root/fixture.json")).toThrow("filesystem outside sandbox");
    expect(takeBlockedCalls()).toEqual(["filesystem outside sandbox"]);
  });

  it("supports deterministic clocks and timers", async () => {
    freezeClock();
    const callback = vi.fn();
    setTimeout(callback, 1000);
    expect(new Date().toISOString()).toBe("2026-01-15T12:00:00.000Z");
    await vi.advanceTimersByTimeAsync(1000);
    expect(callback).toHaveBeenCalledOnce();
    expect(new Date().toISOString()).toBe("2026-01-15T12:00:01.000Z");
  });
});
