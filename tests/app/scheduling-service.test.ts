import { describe, expect, it, vi } from "vitest";
import type { ScheduledPost } from "@/lib/types";
import type { PublishRunInput, PublishRunResult } from "@/lib/publishing/service";
import { claimScheduledPost, createScheduledTickService, type ScheduledQueueStore } from "@/lib/scheduling/service";
import { scheduledPost } from "./support/fixtures";

const now = new Date("2026-01-15T12:00:00.000Z");
const due = "2026-01-15T11:00:00.000Z";
const success: PublishRunResult = { results: [{ platform: "bluesky", ok: true, message: "Published" }] };
const rejection: PublishRunResult = { results: [{ platform: "bluesky", ok: false, message: "Rejected" }] };

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
  } finally { clearTimeout(timer); }
}

function fixture(posts = [scheduledPost({ scheduledFor: due })]) {
  let records = structuredClone(posts);
  const store = {
    getScheduledPosts: vi.fn(() => structuredClone(records)),
    updateScheduledPost: vi.fn((id: string, update: (post: ScheduledPost) => ScheduledPost) => {
      const index = records.findIndex((post) => post.id === id);
      if (index < 0) return undefined;
      records[index] = update(structuredClone(records[index]));
      return structuredClone(records[index]);
    }),
    removeScheduledPost: vi.fn((id: string) => {
      records = records.filter((post) => post.id !== id);
      return structuredClone(records);
    })
  } satisfies ScheduledQueueStore;
  const state = { running: false };
  const publish = vi.fn<(input: PublishRunInput) => Promise<PublishRunResult>>().mockResolvedValue(success);
  const clock = vi.fn(() => now);
  const tick = createScheduledTickService({ store, publish, now: clock, state });
  return { store, state, publish, clock, tick, records: () => structuredClone(records) };
}

describe("explicit local claim result", () => {
  it.each([
    { status: "scheduled" as const, kind: "claimed" },
    { status: "publishing" as const, kind: "already-publishing" },
    { status: "failed" as const, kind: "skipped" }
  ])("reports $kind for a $status entry without asserting ownership", ({ status, kind }) => {
    const initial = scheduledPost({ status, lastError: "Previous error", attempts: 4 });
    const f = fixture([initial]);
    const claim = claimScheduledPost(f.store, initial.id, now);
    expect(claim.kind).toBe(kind);
    if (claim.kind !== "skipped") {
      expect(claim.post).toEqual(status === "scheduled"
        ? { ...initial, status: "publishing", updatedAt: now.toISOString(), lastError: undefined }
        : initial);
    } else expect(claim.reason).toBe("not-publishing");
    expect(f.publish).not.toHaveBeenCalled();
  });

  it("reports missing records and performs no publish", () => {
    const f = fixture([]);
    expect(claimScheduledPost(f.store, "missing", now)).toEqual({ kind: "skipped", reason: "missing" });
    expect(f.records()).toEqual([]);
  });
});

describe("injected scheduled tick", () => {
  it("reproduces duplicate dispatch with independent running guards and a shared stale snapshot", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const f = fixture([
      scheduledPost({ id: "first", text: "first", scheduledFor: due }),
      scheduledPost({ id: "second", text: "second", scheduledFor: now.toISOString() })
    ]);
    const firstEntered = gate();
    const firstHeld = gate();
    const secondEntered = gate();
    const secondHeld = gate();
    const otherState = { running: false };
    let inFlight = 0;
    f.publish.mockImplementation(async (input) => {
      inFlight += 1;
      try {
        if (input.text === "first") { firstEntered.release(); await firstHeld.promise; }
        return success;
      } finally { inFlight -= 1; }
    });
    const otherPublish = vi.fn<(input: PublishRunInput) => Promise<PublishRunResult>>(async () => {
      inFlight += 1;
      try { secondEntered.release(); await secondHeld.promise; return success; }
      finally { inFlight -= 1; }
    });
    const otherTick = createScheduledTickService({ store: f.store, publish: otherPublish, now: f.clock, state: otherState });
    const firstTick = f.tick();
    let secondTick: ReturnType<typeof otherTick> | undefined;
    try {
      await within(firstEntered.promise);
      expect(f.records().map((post) => post.status)).toEqual(["publishing", "scheduled"]);
      secondTick = otherTick();
      await within(secondEntered.promise);
      expect(f.state.running && otherState.running).toBe(true);
      expect(f.records().map((post) => post.status)).toEqual(["publishing", "publishing"]);
      expect(inFlight).toBe(2);
      firstHeld.release();
      expect(await within(firstTick)).toEqual({ processed: 2, skipped: false });
      expect(f.publish.mock.calls.map(([input]) => input.text)).toEqual(["first", "second"]);
      expect(otherPublish.mock.calls.map(([input]) => input.text)).toEqual(["second"]);
      expect(inFlight).toBe(1);
      secondHeld.release();
      expect(await within(secondTick)).toEqual({ processed: 1, skipped: false });
      expect(f.records()).toEqual([]);
    } finally {
      firstHeld.release();
      secondHeld.release();
      const settled = await within(Promise.allSettled([firstTick, ...(secondTick ? [secondTick] : [])]));
      expect(settled.every((result) => result.status === "fulfilled")).toBe(true);
      expect(inFlight).toBe(0);
      expect(f.state.running || otherState.running).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    }
  });

  it("filters future, invalid and non-scheduled entries and leaves the supplied snapshot unchanged", async () => {
    const posts = [
      scheduledPost({ id: "future" }),
      scheduledPost({ id: "failed", status: "failed", scheduledFor: due }),
      scheduledPost({ id: "invalid", scheduledFor: "invalid" }),
      scheduledPost({ id: "due", scheduledFor: now.toISOString() })
    ];
    const snapshot = structuredClone(posts);
    const f = fixture(posts);
    f.store.getScheduledPosts.mockReturnValue(snapshot);
    expect(await f.tick()).toEqual({ processed: 1, skipped: false });
    expect(f.records().map((post) => post.id)).toEqual(["future", "failed", "invalid"]);
    expect(snapshot).toEqual(posts);
  });

  it("publishes the claimed content, media and target profiles with separate dispatch/completion times", async () => {
    const media = { id: "fixture.png", filename: "image.png", contentType: "image/png", size: 10, kind: "image" as const, url: "/api/media/fixture.png" };
    const post = scheduledPost({ scheduledFor: due, media, targets: [{ id: "selected", platform: "bluesky", profileId: "profile" }] });
    const f = fixture([post]);
    const dispatch = new Date("2026-01-15T12:00:01.000Z");
    const complete = new Date("2026-01-15T12:00:02.000Z");
    f.clock.mockReturnValueOnce(now).mockReturnValueOnce(dispatch).mockReturnValueOnce(complete);
    f.publish.mockImplementation(async (input) => {
      expect(f.records()[0]).toMatchObject({ status: "publishing", updatedAt: now.toISOString() });
      expect(input).toEqual({
        title: post.title, text: post.text, linkUrl: post.linkUrl, mediaId: media.id,
        platforms: post.platforms, targets: post.targets,
        requestUrl: "https://fixture.test/api/scheduled/tick", now: dispatch
      });
      return rejection;
    });
    expect(await f.tick("https://fixture.test/api/scheduled/tick")).toEqual({ processed: 1, skipped: false });
    expect(f.records()[0]).toMatchObject({ status: "failed", updatedAt: complete.toISOString(), attempts: 1 });
  });

  it.each([
    { name: "all failed", result: rejection, warning: "No selected channel published successfully." },
    { name: "unknown", result: { results: [{ platform: "bluesky" as const, ok: false, uncertain: true, message: "Unknown" }] }, warning: "Publish outcome is unknown. Check the profile before rescheduling; it may already be live." },
    { name: "empty results", result: { results: [] }, warning: "No selected channel published successfully." }
  ])("records $name once using the current attempts and leaves retry to the user", async ({ result, warning }) => {
    const post = scheduledPost({ scheduledFor: due, attempts: 3, lastError: "Old error", publishedPostId: "previous-history" });
    const f = fixture([post]);
    f.publish.mockResolvedValue(result);
    expect(await f.tick()).toEqual({ processed: 1, skipped: false });
    expect(f.records()[0]).toEqual({
      ...post, updatedAt: now.toISOString(), status: "failed", attempts: 4,
      lastError: warning, results: result.results
    });
    expect(await f.tick()).toEqual({ processed: 0, skipped: false });
    expect(f.publish).toHaveBeenCalledTimes(1);
    expect(f.publish.mock.calls[0][0].requestUrl).toBe("http://localhost:2004/api/scheduled/tick");
  });

  it("retains the returned history ID and increments the latest stored attempts", async () => {
    const post = scheduledPost({ scheduledFor: due, attempts: 2 });
    const f = fixture([post]);
    const publishedPost = { id: "history-id", createdAt: now.toISOString(), text: post.text, platforms: post.platforms, results: rejection.results };
    f.publish.mockImplementation(async () => {
      f.store.updateScheduledPost(post.id, (current) => ({ ...current, attempts: 8 }));
      return { ...rejection, publishedPost };
    });
    expect(await f.tick()).toEqual({ processed: 1, skipped: false });
    expect(f.records()[0]).toMatchObject({ attempts: 9, publishedPostId: "history-id", results: rejection.results });
  });

  it.each([
    { name: "full success", result: success },
    { name: "partial success", result: { results: [...success.results, { platform: "x" as const, ok: false, uncertain: true, message: "Unknown" }] } }
  ])("removes a $name without incrementing attempts", async ({ result }) => {
    const f = fixture();
    f.publish.mockResolvedValue(result);
    expect(await f.tick()).toEqual({ processed: 1, skipped: false });
    expect(f.records()).toEqual([]);
  });

  it.each([
    { error: new Error("Publisher failed"), message: "Publisher failed" },
    { error: "non-Error rejection", message: "Scheduled publish failed" }
  ])("records a thrown publisher value as $message and continues the sequence", async ({ error, message }) => {
    const f = fixture([scheduledPost({ id: "first", scheduledFor: due, attempts: 2 }), scheduledPost({ id: "second", scheduledFor: due })]);
    f.publish.mockRejectedValueOnce(error);
    expect(await f.tick()).toEqual({ processed: 2, skipped: false });
    expect(f.records()).toMatchObject([{ id: "first", status: "failed", attempts: 3, lastError: message }]);
    expect(f.state.running).toBe(false);
  });

  it("counts a deleted in-flight entry without recreating it on failure", async () => {
    const f = fixture();
    f.publish.mockImplementation(async () => {
      f.store.removeScheduledPost("fixture-schedule");
      return rejection;
    });
    expect(await f.tick()).toEqual({ processed: 1, skipped: false });
    expect(f.records()).toEqual([]);
  });

  it("releases the running flag after a list error and permits the next tick", async () => {
    const f = fixture();
    f.store.getScheduledPosts.mockImplementationOnce(() => { throw new Error("List failed"); });
    await expect(f.tick()).rejects.toThrow("List failed");
    expect(f.state.running).toBe(false);
    expect(f.publish).not.toHaveBeenCalled();
    expect(await f.tick()).toEqual({ processed: 1, skipped: false });
  });

  it("propagates a claim write error before dispatch and releases the running flag", async () => {
    const f = fixture();
    f.store.updateScheduledPost.mockImplementationOnce(() => { throw new Error("Claim write failed"); });
    await expect(f.tick()).rejects.toThrow("Claim write failed");
    expect(f.state.running).toBe(false);
    expect(f.publish).not.toHaveBeenCalled();
    expect(f.records()[0].status).toBe("scheduled");
    expect(await f.tick()).toEqual({ processed: 1, skipped: false });
  });

  it("turns a removal error after successful publishing into a failed attempt", async () => {
    const f = fixture();
    f.store.removeScheduledPost.mockImplementationOnce(() => { throw new Error("Remove failed"); });
    expect(await f.tick()).toEqual({ processed: 1, skipped: false });
    expect(f.records()[0]).toMatchObject({ status: "failed", attempts: 1, lastError: "Remove failed" });
    expect(f.publish).toHaveBeenCalledTimes(1);
    expect(f.state.running).toBe(false);
  });

  it("uses the fallback failure transition if saving the publish results throws", async () => {
    const f = fixture();
    f.publish.mockImplementation(async () => {
      f.store.updateScheduledPost.mockImplementationOnce(() => { throw new Error("Result write failed"); });
      return rejection;
    });
    expect(await f.tick()).toEqual({ processed: 1, skipped: false });
    expect(f.records()[0]).toMatchObject({ status: "failed", attempts: 1, lastError: "Result write failed" });
    expect(f.records()[0].results).toBeUndefined();
  });

  it("rejects when saving the exception also fails, aborts later entries and releases running", async () => {
    const f = fixture([scheduledPost({ id: "first", scheduledFor: due }), scheduledPost({ id: "second", scheduledFor: due })]);
    f.publish.mockImplementationOnce(async () => {
      f.store.updateScheduledPost.mockImplementationOnce(() => { throw new Error("Failure write failed"); });
      throw new Error("Publisher failed");
    });
    await expect(f.tick()).rejects.toThrow("Failure write failed");
    expect(f.state.running).toBe(false);
    expect(f.publish).toHaveBeenCalledTimes(1);
    expect(f.records().map((post) => post.status)).toEqual(["publishing", "scheduled"]);
    expect(await f.tick()).toEqual({ processed: 1, skipped: false });
    expect(f.records().map((post) => post.id)).toEqual(["first"]);
  });

  it("releases running even if the injected clock fails before listing", async () => {
    const f = fixture();
    f.clock.mockImplementationOnce(() => { throw new Error("Clock failed"); });
    await expect(f.tick()).rejects.toThrow("Clock failed");
    expect(f.state.running).toBe(false);
    expect(f.store.getScheduledPosts).not.toHaveBeenCalled();
  });
});
