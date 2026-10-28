import { test as base, expect } from "@playwright/test";
import { settingsFixture, settingsPanels } from "../app/support/settings-fixture";
import type { ComposeDraft } from "@/lib/types";

export const test = base.extend<{ settingsState: { config: ReturnType<typeof settingsFixture> } }>({
  settingsState: async ({ context }, runFixture) => {
    const state = { config: settingsFixture() };
    let draft: ComposeDraft = { title: "", text: "", linkUrl: "", platforms: [], targets: [] };
    const unexpected: string[] = [];
    await context.route("**/*", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin !== "http://127.0.0.1:4173") {
        unexpected.push(`${request.method()} ${url.origin}${url.pathname}`);
        await route.abort(); return;
      }
      if (!url.pathname.startsWith("/api/")) { await route.continue(); return; }
      if (url.pathname === "/api/config" && ["GET", "PUT"].includes(request.method())) {
        if (request.method() === "PUT") state.config = { ...state.config, ...request.postDataJSON() };
        await route.fulfill({ json: state.config }); return;
      }
      if (request.method() === "GET" && url.pathname in settingsPanels) {
        await route.fulfill({ json: settingsPanels[url.pathname as keyof typeof settingsPanels] }); return;
      }
      if (url.pathname === "/api/draft" && ["GET", "PUT"].includes(request.method())) {
        if (request.method() === "PUT") draft = request.postDataJSON().draft;
        await route.fulfill({ json: { draft, publishedPosts: [] } }); return;
      }
      unexpected.push(`${request.method()} ${url.pathname}`);
      await route.abort();
    });
    await context.routeWebSocket(/.*/, (socket) => {
      unexpected.push(`WebSocket ${socket.url()}`); socket.close();
    });
    await runFixture(state);
    expect(unexpected, "All settings API/outbound actions require explicit fixtures").toEqual([]);
  }
});
export { expect };
