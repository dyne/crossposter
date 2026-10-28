import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Provider, ProviderRegistry } from "@/lib/providers";
import { createPublishService } from "@/lib/publishing/service";
import { platformIds } from "@/lib/platform-catalog";
import type { PublishedPost, PublishTarget } from "@/lib/types";
import { publishPayload, saveConfig } from "./support/fixtures";

async function service(platform: "devto" | "x", provider: Provider) {
  const config = await import("@/lib/local-config");
  const unselected = vi.fn<Provider>(async () => { throw new Error("Unexpected fixture provider"); });
  const providers: ProviderRegistry = {
    x: unselected, linkedin: unselected, bluesky: unselected, mastodon: unselected,
    instagram: unselected, youtube: unselected, dribbble: unselected,
    pinterest: unselected, devto: unselected, hackernews: unselected, nostr: unselected,
    [platform]: provider
  };
  const history = vi.fn((post: PublishedPost) => post);
  const getMedia = vi.fn(async () => { throw new Error("Unexpected fixture media lookup"); });
  return {
    providers, history, unselected, getMedia,
    run: createPublishService({
      providers,
      getConfigValue: config.getConfigValue,
      getProfileConfigIssues: config.getProfileConfigIssues,
      getUploadedMedia: getMedia,
      appendPublishedPost: history,
      now: () => new Date("2026-01-17T12:00:00.000Z"),
      createId: () => "fixture-adapter-post"
    })
  };
}

const devtoTarget: PublishTarget = { id: "devto-fixture", platform: "devto", profileId: "devto-profile", profileLabel: "Dev.to fixture" };
const xTarget: PublishTarget = { id: "x-fixture", platform: "x", profileId: "x-profile", profileLabel: "X fixture" };

describe("provider registration contract", () => {
  it("accepts an in-memory Provider through the service without a runner branch", async () => {
    const provider = vi.fn<Provider>(async (ctx) => ({ platform: "devto", ok: true, message: `Memory: ${ctx.text}` }));
    await saveConfig({ profiles: { devto: [{ id: "devto-profile", label: "Fixture", values: { DEVTO_API_KEY: "fixture-token" } }] } });
    const f = await service("devto", provider);
    const result = await f.run(publishPayload({ platforms: ["devto"], targets: [devtoTarget], text: " In memory " }));
    expect(Object.keys(f.providers).sort()).toEqual([...platformIds].sort());
    expect(provider).toHaveBeenCalledOnce();
    expect(provider).toHaveBeenCalledWith(expect.objectContaining({ text: "In memory", target: devtoTarget }));
    expect(result.results).toEqual([{
      platform: "devto", targetId: devtoTarget.id, profileId: devtoTarget.profileId,
      profileLabel: devtoTarget.profileLabel, ok: true, message: "Memory: In memory"
    }]);
    expect(f.history).toHaveBeenCalledWith(expect.objectContaining({ results: result.results }));
    expect(f.unselected).not.toHaveBeenCalled();
    expect(f.getMedia).not.toHaveBeenCalled();
  });
});

describe("Dev.to HTTP adapter with intercepted fetch", () => {
  it.each([
    { name: "successful response", status: 201, statusText: "Created", body: { url: "https://dev.to/fixture/post" }, ok: true, message: "Published", url: "https://dev.to/fixture/post", transportError: false },
    { name: "API rejection", status: 422, statusText: "Unprocessable Entity", body: { error: "Fixture rejected" }, ok: false, message: "422 Unprocessable Entity: Fixture rejected", url: undefined, transportError: false },
    { name: "transport outcome without an uncertainty signal", status: 200, statusText: "OK", body: {}, ok: false, message: "Fixture connection closed", url: undefined, transportError: true }
  ])("maps $name through publishing", async (outcome) => {
    await saveConfig({ profiles: { devto: [{
      id: "devto-profile", label: "Dev.to fixture", values: {
        DEVTO_API_KEY: "fixture-profile-token"
      }
    }] } });
    const { publishDevto } = await import("@/lib/providers/devto");
    const f = await service("devto", publishDevto);
    // Only this expected call is allowed; another fetch keeps setup's denyIO default.
    vi.mocked(fetch).mockImplementationOnce(async (url, init) => {
      expect(url).toBe("https://dev.to/api/articles");
      expect(init?.method).toBe("POST");
      expect(init?.headers).toEqual({ "api-key": "fixture-profile-token", "content-type": "application/json" });
      expect(JSON.parse(String(init?.body))).toEqual({ article: {
        title: "Fixture title", body_markdown: "Fixture body", published: true
      } });
      if (outcome.transportError) throw new TypeError("Fixture connection closed");
      return new Response(JSON.stringify(outcome.body), { status: outcome.status, statusText: outcome.statusText });
    });
    const result = await f.run(publishPayload({ platforms: ["devto"], targets: [devtoTarget], title: "Fixture title", text: " Fixture body " }));
    expect(fetch).toHaveBeenCalledOnce();
    expect(result.results[0]).toMatchObject({
      platform: "devto", targetId: devtoTarget.id, profileId: devtoTarget.profileId,
      profileLabel: devtoTarget.profileLabel, ok: outcome.ok, message: outcome.message
    });
    expect(result.results[0].url).toBe(outcome.url);
    expect(result.results[0].uncertain).toBeUndefined();
    expect(f.history).toHaveBeenCalledWith(expect.objectContaining({ results: result.results }));
    expect(f.unselected).not.toHaveBeenCalled();
  });
});

describe("X subprocess adapter with intercepted execFile", () => {
  it.each([
    { name: "verified success", stdout: 'Fixture progress\n{"ok":true,"url":"https://x.com/fixture/status/1"}\n', error: null, ok: true, message: "Published", uncertain: undefined, url: "https://x.com/fixture/status/1" },
    { name: "script rejection", stdout: '{"ok":false,"message":"Fixture rejected"}', error: new Error("Fixture exit 1"), ok: false, message: "Fixture rejected", uncertain: undefined, url: undefined },
    { name: "unknown publish outcome", stdout: '{"ok":false,"uncertain":true,"message":"Check fixture profile"}', error: new Error("Fixture timeout"), ok: false, message: "Check fixture profile", uncertain: true, url: undefined },
    { name: "existing malformed-output fallback", stdout: "not JSON", error: null, ok: true, message: "Published", uncertain: undefined, url: undefined }
  ])("maps $name through publishing", async (outcome) => {
    await saveConfig({ profiles: { x: [{ id: "x-profile", label: "X fixture", values: {
      X_BROWSER_PROFILE_DIR: ".x-browser/fixture", X_PYTHON_COMMAND: "fixture-python",
      X_BROWSER_HEADLESS: "false", X_BROWSER_TIMEOUT_MS: "45000"
    } }] } });
    const { execFile } = await import("node:child_process");
    const { publishX } = await import("@/lib/providers/x");
    const f = await service("x", publishX);
    const dataRoot = process.env.CROSSPOSTER_DATA_DIR!;
    // No process starts: drive the real parser via its one-shot execFile callback.
    vi.mocked(execFile).mockImplementationOnce((...args) => {
      const callback = args.at(-1);
      if (typeof callback !== "function") throw new Error("Missing fixture process callback");
      queueMicrotask(() => callback(outcome.error, outcome.stdout, "Fixture stderr detail"));
      return {} as ReturnType<typeof execFile>;
    });
    const result = await f.run(publishPayload({ platforms: ["x"], targets: [xTarget], text: " Fixture X post " }));
    expect(result.results[0]).toMatchObject({ ok: outcome.ok, message: outcome.message });
    expect(execFile).toHaveBeenCalledOnce();
    expect(execFile).toHaveBeenCalledWith("fixture-python", [
      path.join(process.env.CROSSPOSTER_APP_ROOT!, "scripts", "x_browser_publish.py"),
      "--user-data-dir", path.join(dataRoot, ".x-browser/fixture"),
      "--text", "Fixture X post", "--kind", "none", "--headless", "false", "--timeout-ms", "45000"
    ], expect.objectContaining({ timeout: 75_000, maxBuffer: 1024 * 1024, env: expect.objectContaining({ PYTHONUNBUFFERED: "1" }) }), expect.any(Function));
    expect(result.results[0]).toMatchObject({
      platform: "x", targetId: xTarget.id, profileId: xTarget.profileId,
      profileLabel: xTarget.profileLabel, ok: outcome.ok, message: outcome.message
    });
    expect(result.results[0].uncertain).toBe(outcome.uncertain);
    expect(result.results[0].url).toBe(outcome.url);
    expect(f.history).toHaveBeenCalledWith(expect.objectContaining({ results: result.results }));
    expect(f.unselected).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
});
