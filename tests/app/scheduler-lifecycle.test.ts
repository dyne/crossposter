import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { PublishRunInput, PublishRunResult } from "@/lib/publishing/service";
import { schedulerState, startSchedulerTimer, stopSchedulerTimer, type SchedulerState } from "@/lib/scheduling/lifecycle";
import { createScheduledTickService } from "@/lib/scheduling/service";
import { saveConfig, scheduledPost } from "./support/fixtures";
import { freezeClock } from "./support/sandbox";

const realSetTimeout = setTimeout;
const realClearTimeout = clearTimeout;
const now = "2026-01-15T12:00:00.000Z";
const success: PublishRunResult = { results: [{ platform: "bluesky", ok: true, message: "Published" }] };

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
      new Promise<never>((_, reject) => { timer = realSetTimeout(() => reject(new Error("Controlled operation did not settle")), 1000); })
    ]);
  } finally { realClearTimeout(timer); }
}

beforeEach(() => {
  freezeClock();
  vi.stubGlobal("__crossposterScheduler", undefined);
});
afterEach(() => {
  stopSchedulerTimer(schedulerState());
  expect(vi.getTimerCount()).toBe(0);
  vi.doUnmock("@/lib/publish-runner");
});

async function scheduler(publish = vi.fn<(input: PublishRunInput) => Promise<PublishRunResult>>().mockResolvedValue(success)) {
  vi.doMock("@/lib/publish-runner", () => ({ runPublish: publish }));
  return { ...await import("@/lib/scheduler"), publish };
}

describe("scheduler lifecycle", () => {
  it("shares one unref'd 30-second timer across repeated starts and module reloads, then cleans up", async () => {
    vi.stubEnv("POSTER_DISABLE_SCHEDULER", "false");
    await saveConfig({ scheduledPosts: [scheduledPost({ scheduledFor: now })] });
    const first = await scheduler();
    expect(schedulerState()).toBe(schedulerState());
    first.ensureSchedulerStarted("https://first.test/api/scheduled/tick");
    const state = schedulerState();
    const timer = state.timer;
    expect(timer?.hasRef()).toBe(false);
    first.ensureSchedulerStarted("https://ignored.test/api/scheduled/tick");
    vi.resetModules();
    const reloaded = await import("@/lib/scheduler");
    reloaded.ensureSchedulerStarted("https://reloaded.test/api/scheduled/tick");
    expect(schedulerState()).toBe(state);
    expect(state.timer).toBe(timer);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(first.publish).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(first.publish).toHaveBeenCalledTimes(1);
    expect(first.publish.mock.calls[0][0].requestUrl).toBe("https://first.test/api/scheduled/tick");
    expect(state.running).toBe(false);
    stopSchedulerTimer(state);
    expect(state.timer).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(first.publish).toHaveBeenCalledTimes(1);
  });

  it("does not allocate lifecycle state or a timer when disabled", async () => {
    const { ensureSchedulerStarted, publish } = await scheduler();
    ensureSchedulerStarted();
    expect(Reflect.get(globalThis, "__crossposterScheduler")).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(publish).not.toHaveBeenCalled();
  });

  it.each(["false", "TRUE", undefined])("starts unless the disable flag is exactly true: %s", async (flag) => {
    vi.stubEnv("POSTER_DISABLE_SCHEDULER", flag);
    const { ensureSchedulerStarted } = await scheduler();
    ensureSchedulerStarted();
    expect(vi.getTimerCount()).toBe(1);
  });

  it("preserves an existing timer when the disable flag later becomes true", async () => {
    vi.stubEnv("POSTER_DISABLE_SCHEDULER", "false");
    const { ensureSchedulerStarted } = await scheduler();
    ensureSchedulerStarted();
    const timer = schedulerState().timer;
    vi.stubEnv("POSTER_DISABLE_SCHEDULER", "true");
    ensureSchedulerStarted();
    expect(schedulerState().timer).toBe(timer);
    expect(vi.getTimerCount()).toBe(1);
  });

  it("skips timer and manual overlap across reloads without releasing an active guard during cleanup", async () => {
    vi.stubEnv("POSTER_DISABLE_SCHEDULER", "false");
    await saveConfig({ scheduledPosts: [scheduledPost({ scheduledFor: now })] });
    const entered = gate();
    const held = gate();
    let inFlight = 0;
    const publish = vi.fn<(input: PublishRunInput) => Promise<PublishRunResult>>(async () => {
      inFlight += 1;
      try { entered.release(); await held.promise; return success; }
      finally { inFlight -= 1; }
    });
    const first = await scheduler(publish);
    const active = first.runScheduledTick();
    const state = schedulerState();
    try {
      await within(entered.promise);
      expect(state.running).toBe(true);
      expect(inFlight).toBe(1);
      first.ensureSchedulerStarted();
      await vi.advanceTimersByTimeAsync(90_000);
      vi.resetModules();
      const reloaded = await import("@/lib/scheduler");
      reloaded.ensureSchedulerStarted();
      expect(vi.getTimerCount()).toBe(1);
      expect(await reloaded.runScheduledTick()).toEqual({ processed: 0, skipped: true });
      expect(publish).toHaveBeenCalledTimes(1);
      stopSchedulerTimer(state);
      expect(state.running).toBe(true);
      expect(await reloaded.runScheduledTick()).toEqual({ processed: 0, skipped: true });
      held.release();
      expect(await within(active)).toEqual({ processed: 1, skipped: false });
      expect(state.running).toBe(false);
      expect(inFlight).toBe(0);
      await saveConfig({ scheduledPosts: [scheduledPost({ id: "next", scheduledFor: now })] });
      expect(await within(reloaded.runScheduledTick())).toEqual({ processed: 1, skipped: false });
      expect(publish).toHaveBeenCalledTimes(2);
    } finally {
      held.release();
      stopSchedulerTimer(state);
      const settled = await within(Promise.allSettled([active]));
      expect(settled[0].status).toBe("fulfilled");
      expect(inFlight).toBe(0);
      expect(state.running).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    }
  });

  it("contains a rejected timer tick and permits the following interval to reenter", async () => {
    const state: SchedulerState = { running: false };
    const getScheduledPosts = vi.fn().mockImplementationOnce(() => { throw new Error("List failed"); }).mockReturnValue([]);
    const tick = createScheduledTickService({
      state, now: () => new Date(now),
      store: { getScheduledPosts, updateScheduledPost: () => undefined, removeScheduledPost: () => [] },
      publish: async () => { throw new Error("No entries should dispatch"); }
    });
    const operations: Promise<unknown>[] = [];
    const runTick = vi.fn((url: string) => { const operation = tick(url); operations.push(operation); return operation; });
    try {
      startSchedulerTimer(state, runTick, "http://localhost/api/scheduled/tick");
      await vi.advanceTimersByTimeAsync(30_000);
      expect(await Promise.allSettled(operations)).toMatchObject([{ status: "rejected", reason: new Error("List failed") }]);
      expect(state.running).toBe(false);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(await Promise.allSettled(operations)).toMatchObject([
        { status: "rejected" }, { status: "fulfilled", value: { processed: 0, skipped: false } }
      ]);
      expect(runTick).toHaveBeenCalledTimes(2);
      expect(state.running).toBe(false);
    } finally {
      stopSchedulerTimer(state);
      await within(Promise.allSettled(operations));
      expect(vi.getTimerCount()).toBe(0);
    }
  });

  it("allows an isolated timer to stop repeatedly and restart with the new request URL", async () => {
    const state: SchedulerState = { running: false };
    const tick = vi.fn(async () => ({ processed: 0, skipped: false }));
    try {
      startSchedulerTimer(state, tick, "https://old.test/tick");
      stopSchedulerTimer(state);
      stopSchedulerTimer(state);
      expect(vi.getTimerCount()).toBe(0);
      startSchedulerTimer(state, tick, "https://new.test/tick");
      await vi.advanceTimersByTimeAsync(30_000);
      expect(tick).toHaveBeenCalledExactlyOnceWith("https://new.test/tick");
    } finally { stopSchedulerTimer(state); }
  });
});
