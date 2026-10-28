// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { calendarPosts } from "./support/scheduled-fixture";
import { useScheduledPosts } from "@/components/scheduled/use-scheduled-posts";

afterEach(cleanup);
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

it("exposes a pending item's busy state, filters mutation responses and preserves its local edit", async () => {
  const posts = calendarPosts();
  let finish!: (response: Response) => void;
  const pending = new Promise<Response>((resolve) => { finish = resolve; });
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/api/scheduled" && !init?.method) return json({ scheduledPosts: posts });
    if (url === "/api/scheduled/failed%2Fid" && init?.method === "PATCH") return pending;
    throw new Error(`Unexpected scheduler fixture ${url}`);
  }));
  const { result } = renderHook(useScheduledPosts);
  await waitFor(() => expect(result.current.isLoading).toBe(false));
  act(() => result.current.setEdits((edits) => ({ ...edits, [posts[0].id]: "2026-11-01T12:00" })));
  let mutation!: Promise<void>;
  act(() => { mutation = result.current.reschedule(posts[0]); });
  try {
    expect(result.current.busyId).toBe(posts[0].id); expect(result.current.status).toBe("");
  } finally {
    await act(async () => {
      finish(json({ scheduledPosts: [{ ...posts[0], scheduledFor: "2026-11-02T12:00:00Z", status: "scheduled" }, posts[4]] }));
      await mutation;
    });
  }
  expect(result.current.busyId).toBe(""); expect(result.current.status).toBe("Schedule timing updated.");
  expect(result.current.sortedPosts.map((post) => post.id)).toEqual([posts[0].id]);
  expect(result.current.counts).toEqual({ scheduled: 1, publishing: 0, failed: 0 });
  expect(result.current.edits[posts[0].id]).toBe("2026-11-01T12:00");
});

it("keeps the previous queue on malformed JSON and releases discard busy state", async () => {
  let malformed = false;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (!url.startsWith("/api/scheduled")) throw new Error(`Unexpected fixture ${url}`);
    return malformed || init?.method === "DELETE" ? new Response("not JSON") : json({ scheduledPosts: calendarPosts() });
  }));
  const { result } = renderHook(useScheduledPosts);
  await waitFor(() => expect(result.current.isLoading).toBe(false));
  const ids = result.current.sortedPosts.map((post) => post.id);
  malformed = true;
  await act(async () => { await result.current.loadScheduled(true); });
  expect(result.current.status).toMatch(/JSON/); expect(result.current.sortedPosts.map((post) => post.id)).toEqual(ids);
  await act(async () => { await result.current.discard(calendarPosts()[0]); });
  expect(result.current.status).toMatch(/JSON/); expect(result.current.busyId).toBe("");
  expect(result.current.sortedPosts.map((post) => post.id)).toEqual(ids);
});

it("treats an absent scheduledPosts field as an empty queue on refresh and mutation", async () => {
  let empty = false;
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (!url.startsWith("/api/scheduled")) throw new Error(`Unexpected fixture ${url}`);
    return json(empty ? {} : { scheduledPosts: calendarPosts() });
  }));
  const { result } = renderHook(useScheduledPosts);
  await waitFor(() => expect(result.current.isLoading).toBe(false));
  empty = true;
  await act(async () => { await result.current.discard(calendarPosts()[0]); });
  expect(result.current.sortedPosts).toEqual([]); expect(result.current.status).toBe("Scheduled post discarded.");
  await act(async () => { await result.current.loadScheduled(true); });
  expect(result.current.sortedPosts).toEqual([]); expect(result.current.status).toBe("Scheduler refreshed.");
});
