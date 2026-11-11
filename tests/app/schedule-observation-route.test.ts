import { readFileSync, writeFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { freezeClock } from "./support/sandbox";
import { saveConfig, scheduledPost, successfulProviders } from "./support/fixtures";

const due = "2026-01-15T11:00:00.000Z";
const tickRequest = () => new Request("http://localhost/api/scheduled/tick", { method: "POST" });

beforeEach(() => {
  freezeClock();
  vi.stubEnv("POSTER_DISABLE_SCHEDULER", "false");
  vi.stubGlobal("__crossposterScheduler", undefined);
});

describe.each(["collection", "tick"] as const)("scheduled %s GET observation", (endpoint) => {
  it.each(["overdue", "provider outage", "corrupt storage", "read error"] as const)("never starts timers, dispatches or mutates queue during %s", async (scenario) => {
    const providers = await successfulProviders();
    if (scenario === "provider outage") {
      vi.mocked(providers.bluesky).mockRejectedValue(new Error("Fixture provider is unavailable"));
    }
    await saveConfig({ scheduledPosts: [
      scheduledPost({ id: "overdue", scheduledFor: due }),
      scheduledPost({ id: "interrupted", status: "publishing", scheduledFor: due, attempts: 1 })
    ] });
    const config = await import("@/lib/local-config");
    if (scenario === "corrupt storage") writeFileSync(config.localConfigPath, "{broken queue");
    const before = readFileSync(config.localConfigPath, "utf8");
    const readError = new Error("Fixture queue cannot be read");
    const read = vi.spyOn(config, "getScheduledPosts");
    if (scenario === "read error") read.mockImplementation(() => { throw readError; });
    const mutations = ["upsertScheduledPost", "updateScheduledPost", "removeScheduledPost", "appendPublishedPost", "writeLocalConfig"] as const;
    const writes = mutations.map((name) => vi.spyOn(config, name));
    const lifecycle = await import("@/lib/scheduling/lifecycle");
    const start = vi.spyOn(lifecycle, "startSchedulerTimer");
    const route = endpoint === "collection"
      ? await import("@/app/api/scheduled/route")
      : await import("@/app/api/scheduled/tick/route");

    if (endpoint === "collection" && scenario === "read error") {
      await expect(route.GET()).rejects.toBe(readError);
    } else {
      const response = await route.GET();
      expect(response.status).toBe(endpoint === "collection" ? 200 : 405);
      if (endpoint === "collection") {
        expect((await response.json()).scheduledPosts.map((post: { id: string }) => post.id))
          .toEqual(scenario === "corrupt storage" ? [] : ["overdue", "interrupted"]);
      } else {
        expect(response.headers.get("allow")).toBe("POST");
        expect(await response.json()).toEqual({ error: "Method not allowed" });
        expect(read).not.toHaveBeenCalled();
      }
    }

    expect(start).not.toHaveBeenCalled();
    expect(Reflect.get(globalThis, "__crossposterScheduler")).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(Object.values(providers).every((provider) => vi.mocked(provider).mock.calls.length === 0)).toBe(true);
    expect(writes.every((write) => write.mock.calls.length === 0)).toBe(true);
    expect(readFileSync(config.localConfigPath, "utf8")).toBe(before);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("explicit POST tick", () => {
  it("retains provider failures without retrying when automatic scheduling is disabled", async () => {
    vi.stubEnv("POSTER_DISABLE_SCHEDULER", "true");
    const providers = await successfulProviders();
    vi.mocked(providers.bluesky).mockRejectedValue(new Error("Fixture provider is unavailable"));
    await saveConfig({ scheduledPosts: [scheduledPost({ scheduledFor: due })] });
    const { POST } = await import("@/app/api/scheduled/tick/route");
    expect(await (await POST(tickRequest())).json()).toEqual({ ok: true, processed: 1, skipped: false });
    const { getScheduledPosts } = await import("@/lib/local-config");
    expect(getScheduledPosts()[0]).toMatchObject({ status: "failed", attempts: 1,
      results: [{ platform: "bluesky", ok: false, message: "Fixture provider is unavailable" }] });
    expect(await (await POST(tickRequest())).json()).toEqual({ ok: true, processed: 0, skipped: false });
    expect(providers.bluesky).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("propagates queue read errors and releases the running guard for the next POST", async () => {
    vi.stubEnv("POSTER_DISABLE_SCHEDULER", "true");
    const config = await import("@/lib/local-config");
    const read = vi.spyOn(config, "getScheduledPosts").mockImplementationOnce(() => { throw new Error("Fixture read failed"); });
    const { POST } = await import("@/app/api/scheduled/tick/route");
    await expect(POST(tickRequest())).rejects.toThrow("Fixture read failed");
    const { schedulerState } = await import("@/lib/scheduling/lifecycle");
    expect(schedulerState().running).toBe(false);
    read.mockRestore();
    expect(await (await POST(tickRequest())).json()).toEqual({ ok: true, processed: 0, skipped: false });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("starts one timer across repeated POST requests and permits shutdown", async () => {
    const { POST } = await import("@/app/api/scheduled/tick/route");
    const { schedulerState, stopSchedulerTimer } = await import("@/lib/scheduling/lifecycle");
    try {
      for (let request = 0; request < 2; request++) {
        expect(await (await POST(tickRequest())).json()).toEqual({ ok: true, processed: 0, skipped: false });
        expect(vi.getTimerCount()).toBe(1);
      }
    } finally {
      stopSchedulerTimer(schedulerState());
      expect(schedulerState().running).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    }
  });
});
