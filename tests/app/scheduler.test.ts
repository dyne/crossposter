import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { PublishRunInput, PublishRunResult } from "@/lib/publish-runner";
import { saveConfig, scheduledPost } from "./support/fixtures";

const now = "2026-01-15T12:00:00.000Z";
const due = "2026-01-15T11:00:00.000Z";
const success: PublishRunResult = { results: [{ platform: "bluesky", ok: true, message: "Published" }] };
success.publishedPost = { id: "fixture-history", createdAt: now, text: "Fixture history", platforms: ["bluesky"], results: success.results };

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

async function within<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Controlled operation did not settle")), 1000); })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(now));
  vi.stubGlobal("__crossposterScheduler", { running: false });
});
afterEach(() => { vi.doUnmock("@/lib/publish-runner"); });

async function scheduler(publish = vi.fn<(input: PublishRunInput) => Promise<PublishRunResult>>().mockResolvedValue(success)) {
  vi.doMock("@/lib/publish-runner", () => ({ runPublish: publish }));
  return { ...await import("@/lib/scheduler"), publish };
}

describe("scheduled tick production facade", () => {
  it.each(["profile", "explicit-id", "conflicting-profile", "ambiguous", "duplicate", "contradictory"] as const)("recovers interrupted legacy %s mappings conservatively", async (kind) => {
    const targets = kind === "profile" ? [{ id: "a", platform: "bluesky" as const, profileId: "a" }, { id: "b", platform: "bluesky" as const, profileId: "b" }]
      : [{ id: "a", platform: "bluesky" as const, ...(["explicit-id", "conflicting-profile"].includes(kind) ? { profileId: "a" } : {}) }, ...(kind === "ambiguous" ? [{ id: "b", platform: "bluesky" as const }] : [])];
    const result = { platform: kind === "contradictory" ? "mastodon" as const : "bluesky" as const, ok: true, message: "Retained result",
      ...(kind === "profile" ? { profileId: "a" } : kind === "conflicting-profile" ? { targetId: "a", profileId: "b" }
        : kind === "contradictory" || kind === "explicit-id" ? { targetId: "a" } : {}) };
    await saveConfig({ scheduledPosts: [scheduledPost({ status: "publishing", scheduledFor: due, targets, results: kind === "duplicate" ? [result, result] : [result] })] });
    const { runScheduledTick, publish } = await scheduler(); expect(await runScheduledTick()).toEqual({ processed: 0, skipped: false });
    const { getScheduledPosts } = await import("@/lib/local-config"); const results = getScheduledPosts()[0].results!;
    expect(results).toHaveLength(targets.length);
    expect(results.map((item) => item.ok)).toEqual(targets.map((_, index) => (kind === "profile" || kind === "explicit-id") && index === 0));
    expect(results.filter((item) => !item.ok).every((item) => item.uncertain)).toBe(true); expect(publish).not.toHaveBeenCalled();
  });
  it("keeps interrupted legacy targets failed with every known and uncertain result and never resumes them", async () => {
    await saveConfig({ scheduledPosts: [scheduledPost({ status: "publishing", scheduledFor: due, attempts: 2, platforms: ["bluesky", "mastodon"],
      targets: [{ id: "blue", platform: "bluesky" }, { id: "mastodon", platform: "mastodon" }],
      results: [{ platform: "bluesky", targetId: "blue", ok: true, message: "Known acceptance" }] })] });
    const { runScheduledTick, publish } = await scheduler(); expect(await runScheduledTick()).toEqual({ processed: 0, skipped: false });
    const { getScheduledPosts } = await import("@/lib/local-config");
    expect(getScheduledPosts()[0]).toMatchObject({ status: "failed", attempts: 3,
      results: [{ targetId: "blue", ok: true }, { targetId: "mastodon", ok: false, uncertain: true }] });
    expect(await runScheduledTick()).toEqual({ processed: 0, skipped: false }); expect(getScheduledPosts()[0].attempts).toBe(3); expect(publish).not.toHaveBeenCalled();
  });
  it("processes only due scheduled entries in chronological order and passes saved content", async () => {
    const content = { title: "A title", text: "Saved text", linkUrl: "https://example.test/post", targets: [{ id: "blue", platform: "bluesky" as const }] };
    await saveConfig({ scheduledPosts: [
      scheduledPost({ id: "later", scheduledFor: now }),
      scheduledPost({ id: "earlier", scheduledFor: due, ...content }),
      scheduledPost({ id: "future" }),
      ...(["publishing", "failed", "published", "canceled"] as const).map((status) => scheduledPost({ id: status, status, scheduledFor: due }))
    ] });
    const { runScheduledTick, publish } = await scheduler();
    expect(await runScheduledTick("https://fixture.test/api/scheduled/tick")).toEqual({ processed: 2, skipped: false });
    expect(publish.mock.calls.map(([input]) => input.text)).toEqual(["Saved text", "A fixture scheduled post"]);
    expect(publish.mock.calls[0][0]).toMatchObject({ ...content, requestUrl: "https://fixture.test/api/scheduled/tick", now: new Date(now) });
    const { getScheduledPosts } = await import("@/lib/local-config");
    expect(getScheduledPosts().map((post) => post.id).sort()).toEqual(["canceled", "failed", "future", "published", "publishing"]);
  });

  it("removes partially successful entries and records all-failed/unknown attempts without retrying", async () => {
    await saveConfig({ scheduledPosts: ["partial", "failed", "unknown"].map((id) => scheduledPost({ id, text: id, scheduledFor: due, attempts: 2 })) });
    const publish = vi.fn<(input: PublishRunInput) => Promise<PublishRunResult>>()
      .mockResolvedValueOnce({ results: [...success.results, { platform: "x", ok: false, uncertain: true, message: "Unknown" }], publishedPost: { ...success.publishedPost!, results: [...success.results, { platform: "x", ok: false, uncertain: true, message: "Unknown" }] } })
      .mockResolvedValueOnce({ results: [{ platform: "bluesky", ok: false, message: "Rejected" }] })
      .mockResolvedValueOnce({ results: [{ platform: "bluesky", ok: false, uncertain: true, message: "Unknown" }] });
    const { runScheduledTick } = await scheduler(publish);
    expect(await runScheduledTick()).toEqual({ processed: 3, skipped: false });
    const { getScheduledPosts } = await import("@/lib/local-config");
    expect(getScheduledPosts()).toMatchObject([
      { id: "failed", status: "failed", attempts: 3, lastError: "No selected channel published successfully." },
      { id: "unknown", status: "failed", attempts: 3, lastError: "Publish outcome is unknown. Check the profile before rescheduling; it may already be live." }
    ]);
    // Shared normalization now retains the provider's explicit uncertainty.
    expect(getScheduledPosts()[1].results?.[0].uncertain).toBe(true);
    expect(await runScheduledTick()).toEqual({ processed: 0, skipped: false });
    expect(publish).toHaveBeenCalledTimes(3);
  });

  it.each(["removed", "failed", "publishing", "rescheduled"] as const)("skips a stale snapshot when the next entry is %s during dispatch", async (change) => {
    await saveConfig({ scheduledPosts: [
      scheduledPost({ id: "first", text: "first", scheduledFor: due }),
      scheduledPost({ id: "second", text: "second", scheduledFor: now })
    ] });
    const entered = gate();
    const held = gate();
    let inFlight = 0;
    const publish = vi.fn<(input: PublishRunInput) => Promise<PublishRunResult>>(async (input) => {
      inFlight += 1;
      try {
        if (input.text === "first") {
          entered.release();
          await held.promise;
        }
        return success;
      } finally { inFlight -= 1; }
    });
    const { runScheduledTick } = await scheduler(publish);
    const tick = runScheduledTick();
    try {
      await within(entered.promise);
      expect(inFlight).toBe(1);
      expect(publish).toHaveBeenCalledTimes(1);
      const store = await import("@/lib/local-config");
      expect(store.getScheduledPosts().find((post) => post.id === "second")?.status).toBe("scheduled");
      if (change === "removed") store.removeScheduledPost("second");
      else store.updateScheduledPost("second", (post) => ({
        ...post,
        status: change === "rescheduled" ? "scheduled" : change,
        ...(change === "rescheduled" ? { scheduledFor: "2026-01-16T12:00:00.000Z" } : {})
      }));
      held.release();
      expect(await within(tick)).toEqual({ processed: 1, skipped: false });
      expect(publish.mock.calls.map(([input]) => input.text)).toEqual(["first"]);
    } finally {
      held.release();
      await within(tick);
      expect(inFlight).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    }
  });
});
