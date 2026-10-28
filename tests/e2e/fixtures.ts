import { test as base, expect } from "@playwright/test";
import type { ComposeDraft, PublishedPost, ScheduledPost } from "@/lib/types";
import type { PublishResponse } from "@/lib/compose/client";

// Small generated fixture; contains no user media.
export const fixturePng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a4x8AAAAASUVORK5CYII=", "base64");

type FixtureState = {
  draft: ComposeDraft;
  scheduledPosts: ScheduledPost[];
  publishRequests: unknown[];
  publishedPosts: PublishedPost[];
  publishResponse?: PublishResponse;
  mediaUploads: number;
};

export const test = base.extend<{ fixtureState: FixtureState }>({
  fixtureState: async ({ context }, runFixture) => {
    const state: FixtureState = {
      draft: { title: "", text: "", linkUrl: "", platforms: [], targets: [] },
      scheduledPosts: [], publishRequests: [], publishedPosts: [], mediaUploads: 0
    };
    const unexpected: string[] = [];
    await context.route("**/*", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin !== "http://127.0.0.1:4173") {
        unexpected.push(`${request.method()} ${url.origin}${url.pathname}`);
        await route.abort();
        return;
      }
      if (!url.pathname.startsWith("/api/")) { await route.continue(); return; }
      let json: unknown;
      if (url.pathname === "/api/config" && request.method() === "GET") {
        json = { profiles: { bluesky: [{ id: "fixture", label: "Fixture Bluesky", values: { BLUESKY_IDENTIFIER: "fixture.example", BLUESKY_APP_PASSWORD: "fixture-only-token" } }] } };
      } else if (url.pathname === "/api/draft") {
        if (request.method() === "PUT") state.draft = request.postDataJSON().draft;
        if (request.method() === "DELETE" && url.searchParams.get("scope") === "history") state.publishedPosts = [];
        json = { draft: state.draft, publishedPosts: state.publishedPosts };
      } else if (url.pathname === "/api/publish" && request.method() === "POST") {
        state.publishRequests.push(request.postDataJSON());
        json = state.publishResponse || { results: [{ platform: "bluesky", targetId: "bluesky:fixture", profileLabel: "Fixture Bluesky", ok: false, uncertain: true, message: "Fixture outcome unknown; check profile before retrying." }] };
        if (state.publishResponse?.publishedPost) state.publishedPosts.unshift(state.publishResponse.publishedPost);
      } else if (url.pathname === "/api/media" && request.method() === "POST") {
        state.mediaUploads++;
        json = { media: { id: "fixture-media", filename: "fixture.png", contentType: "image/png", size: fixturePng.length, kind: "image", url: "/api/media/fixture-media" } };
      } else if (url.pathname === "/api/media/fixture-media" && request.method() === "GET") {
        await route.fulfill({ body: fixturePng, contentType: "image/png" });
        return;
      } else if (url.pathname === "/api/scheduled") {
        if (request.method() === "POST") {
          const body = request.postDataJSON();
          const post: ScheduledPost = { ...body, id: "fixture-scheduled", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), status: "scheduled", attempts: 0 };
          state.scheduledPosts.push(post);
          json = { scheduledPost: post, scheduledPosts: state.scheduledPosts };
        } else if (request.method() === "GET") json = { scheduledPosts: state.scheduledPosts };
      }
      if (json === undefined) {
        unexpected.push(`${request.method()} ${url.pathname}`);
        await route.abort();
      } else await route.fulfill({ json });
    });
    await context.routeWebSocket(/.*/, (socket) => {
      unexpected.push(`WebSocket ${socket.url()}`);
      socket.close();
    });
    await runFixture(state);
    expect(unexpected, "Every API/outbound browser request must have an explicit fixture").toEqual([]);
  }
});
export { expect };
