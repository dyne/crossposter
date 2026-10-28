import { test as base, expect } from "@playwright/test";
import { calendarPosts } from "../app/support/scheduled-fixture";
import type { ScheduledPost } from "@/lib/types";

type ScheduleState = {
  posts: ScheduledPost[];
  writes: Array<{ method: string; path: string; body: unknown }>;
  error: string;
  loadError: string;
  transportError: "" | "GET" | "PATCH" | "DELETE";
};
export const test = base.extend<{ scheduleState: ScheduleState }>({
  scheduleState: async ({ context }, runFixture) => {
    const state: ScheduleState = { posts: calendarPosts(), writes: [], error: "", loadError: "", transportError: "" };
    const unexpected: string[] = [];
    await context.route("**/*", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin !== "http://127.0.0.1:4173") {
        unexpected.push(`${request.method()} ${url.origin}${url.pathname}`);
        await route.abort(); return;
      }
      if (!url.pathname.startsWith("/api/")) { await route.continue(); return; }
      if (url.pathname === "/api/scheduled" && request.method() === "GET") {
        if (state.transportError === "GET") { await route.abort("failed"); return; }
        if (state.loadError) { await route.fulfill({ status: 500, json: { error: state.loadError } }); return; }
        await route.fulfill({ json: { scheduledPosts: state.posts } }); return;
      }
      if (url.pathname.startsWith("/api/scheduled/") && ["PATCH", "DELETE"].includes(request.method())) {
        const body: unknown = request.method() === "PATCH" ? request.postDataJSON() : null;
        state.writes.push({ method: request.method(), path: url.pathname, body });
        if (state.transportError === request.method()) { await route.abort("failed"); return; }
        if (state.error) { await route.fulfill({ status: 500, json: { error: state.error } }); return; }
        const id = decodeURIComponent(url.pathname.slice("/api/scheduled/".length));
        state.posts = request.method() === "DELETE" ? state.posts.filter((post) => post.id !== id)
          : state.posts.map((post) => post.id === id ? { ...post, scheduledFor: (body as { scheduledFor: string }).scheduledFor, status: "scheduled" } : post);
        await route.fulfill({ json: { scheduledPosts: state.posts } }); return;
      }
      unexpected.push(`${request.method()} ${url.pathname}`); await route.abort();
    });
    await context.routeWebSocket(/.*/, (socket) => { unexpected.push(`WebSocket ${socket.url()}`); socket.close(); });
    await runFixture(state);
    expect(unexpected, "Every scheduler API/outbound action requires an explicit fixture").toEqual([]);
  }
});
export { expect };
