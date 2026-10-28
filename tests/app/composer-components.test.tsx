// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Platform, ProviderProfile, PublishedPost, PublishResult } from "@/lib/types";

vi.mock("@/lib/local-config", () => { throw new Error("Server configuration reached composer views"); });
const bluesky = (id: string): ProviderProfile => ({ id, label: `Fixture ${id}`, values: { BLUESKY_IDENTIFIER: "fixture.example", BLUESKY_APP_PASSWORD: "fixture-only-token" } });
let profiles: Partial<Record<Platform, ProviderProfile[]>>;
let configResponse: Promise<Response> | undefined;
let publishResponse: Promise<Response> | undefined;
let history: PublishedPost[];
const mixedResults: PublishResult[] = [
  { platform: "bluesky", targetId: "bluesky:one", profileLabel: "Fixture one", ok: true, message: "Fixture published", url: "https://fixture.example/post" },
  { platform: "bluesky", targetId: "bluesky:two", profileLabel: "Fixture two", ok: false, uncertain: true, message: "Fixture unknown; check profile" },
  { platform: "bluesky", targetId: "bluesky:three", profileLabel: "Fixture three", ok: false, message: "Fixture rejected" }
];
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

beforeEach(() => {
  localStorage.clear();
  configResponse = undefined;
  publishResponse = undefined;
  profiles = { bluesky: [bluesky("one"), bluesky("two")] };
  history = [];
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (input === "/api/config") return configResponse || json({ profiles });
    if (input === "/api/draft") return json({ draft: { title: "", text: "", linkUrl: "", platforms: [] }, publishedPosts: history });
    if (input === "/api/draft?scope=history" && init?.method === "DELETE") { history = []; return json({ publishedPosts: [] }); }
    if (input === "/api/publish") return publishResponse || json({ results: [] });
    throw new Error(`Unexpected component fixture request: ${String(input)}`);
  }));
});
afterEach(() => { cleanup(); localStorage.clear(); });

async function mount() {
  const { default: Home } = await import("@/app/page");
  return render(<Home />);
}
const postInput = () => screen.getByLabelText("Post", { exact: true });

describe("composed profile and editor flows", () => {
  it("loads connected profiles and selects all/none/individual target IDs", async () => {
    const held = deferred<Response>();
    configResponse = held.promise;
    await mount();
    expect(screen.getByText("Loading connected socials...")).toBeVisible();
    expect(screen.getByRole("button", { name: "Publish draft" })).toBeDisabled();
    await act(async () => held.resolve(json({ profiles })));
    const one = within(screen.getByText("Profile: Fixture one").closest("label")!).getByRole("checkbox");
    const two = within(screen.getByText("Profile: Fixture two").closest("label")!).getByRole("checkbox");
    await waitFor(() => expect(one).toBeChecked());
    expect(two).not.toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "All" }));
    expect(two).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "None" }));
    expect(one).not.toBeChecked();
    expect(two).not.toBeChecked();
    fireEvent.click(two);
    fireEvent.change(postInput(), { target: { value: "Fixture selected profile" } });
    fireEvent.click(screen.getByRole("button", { name: "Publish draft" }));
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([url]) => url === "/api/publish")).toBe(true));
    const request = vi.mocked(fetch).mock.calls.find(([url]) => url === "/api/publish")!;
    expect(JSON.parse(String(request[1]?.body)).targets).toEqual([{ id: "bluesky:two", platform: "bluesky", profileId: "two", profileLabel: "Fixture two" }]);
  });

  it("uses per-profile X limits while preserving the first-target validation contract", async () => {
    profiles = { x: [
      { id: "premium", label: "Fixture Premium", values: { X_PREMIUM_LONG_POSTS: "true" } },
      { id: "free", label: "Fixture Free", values: { X_PREMIUM_LONG_POSTS: "false" } }
    ] };
    await mount();
    const premium = within((await screen.findByText("Profile: Fixture Premium")).closest("label")!).getByRole("checkbox");
    const free = within(screen.getByText("Profile: Fixture Free").closest("label")!).getByRole("checkbox");
    await waitFor(() => expect(premium).toBeChecked());
    fireEvent.change(postInput(), { target: { value: "a".repeat(281) } });
    expect(screen.getByRole("button", { name: "Publish draft" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "None" }));
    fireEvent.click(free);
    expect(screen.getByText("X / Twitter · Fixture Free: 281/280 characters.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Publish draft" })).toBeDisabled();
    fireEvent.click(premium);
    expect(screen.getByRole("button", { name: "Publish draft" })).toBeDisabled();
    fireEvent.click(free);
    expect(screen.getByRole("button", { name: "Publish draft" })).toBeEnabled();
  });

  it("keeps title-only Hacker News editing and title warnings", async () => {
    profiles = { hackernews: [{ id: "fixture", label: "Fixture News", values: { HACKERNEWS_USERNAME: "fixture", HACKERNEWS_PASSWORD: "fixture-only-token" } }] };
    await mount();
    await screen.findByText("Profile: Fixture News");
    fireEvent.change(screen.getByLabelText("Title", { exact: true }), { target: { value: "Fixture title" } });
    expect(postInput()).toHaveValue("");
    expect(screen.getByText("For Hacker News, Post is optional. Title is required.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Publish draft" })).toBeEnabled();
    fireEvent.change(screen.getByLabelText("Title", { exact: true }), { target: { value: "a".repeat(81) } });
    expect(screen.getByText("Hacker News: 81/80 characters.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Publish draft" })).toBeDisabled();
  });

  it("shows config loading failure and disables publishing", async () => {
    const held = deferred<Response>();
    configResponse = held.promise;
    await mount();
    await act(async () => held.reject(new Error("Fixture config unavailable")));
    expect(await screen.findByText("Could not load connected socials.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Publish draft" })).toBeDisabled();
  });

  it("links an empty profile list to Settings", async () => {
    profiles = {};
    await mount();
    expect(await screen.findByText("No connected socials yet.")).toBeVisible();
    const empty = screen.getByText("No connected socials yet.").parentElement!;
    expect(within(empty).getByRole("link", { name: "Settings" })).toHaveAttribute("href", "/settings");
    expect(screen.getByRole("button", { name: "Publish draft" })).toBeDisabled();
  });
});

describe("composed publish output", () => {
  it("retains the original fallback label for an unknown result platform", async () => {
    const { PublishPanel } = await import("@/components/composer/publish-panel");
    const result = { platform: "__proto__", ok: false, message: "Fixture unknown platform" } as unknown as PublishResult;
    const post: PublishedPost = { id: "fixture-legacy", createdAt: "2026-10-28T12:00:00Z", text: "Fixture legacy", platforms: [], results: [result] };
    render(<PublishPanel results={[result]} publishedPosts={[post]} error="" isPublishing={false} isUploadingMedia={false} onClearHistory={async () => undefined} />);
    expect(within(screen.getByLabelText("Latest publish result")).getByText("__proto__")).toBeVisible();
    expect(within(screen.getByLabelText("Published posts")).getByText("__proto__")).toBeVisible();
  });

  it("shows loading then independent successful, failed and uncertain live results", async () => {
    const held = deferred<Response>();
    publishResponse = held.promise;
    await mount();
    await screen.findByText("Profile: Fixture one");
    fireEvent.change(postInput(), { target: { value: "Fixture results" } });
    fireEvent.click(screen.getByRole("button", { name: "Publish draft" }));
    await screen.findByText("Publishing post");
    expect(screen.getByRole("button", { name: "Publishing..." })).toBeDisabled();
    try {
      await act(async () => held.resolve(json({ results: mixedResults })));
      const results = screen.getByLabelText("Latest publish result");
      expect(within(results).getByText("ok")).toHaveClass("ok");
      expect(within(results).getByText("check")).toHaveClass("unknown");
      expect(within(results).getByText("error")).toHaveClass("err");
      expect(results).toHaveTextContent("Bluesky · Fixture two");
      expect(results).toHaveTextContent("Fixture unknown; check profile");
      expect(within(results).getByRole("link")).toHaveAttribute("rel", "noreferrer");
    } finally {
      held.resolve(json({ results: mixedResults }));
      await act(async () => held.promise);
    }
  });

  it("renders transport validation errors and releases publishing controls", async () => {
    publishResponse = Promise.resolve(json({ error: { fieldErrors: { linkUrl: ["invalid"] } } }, 400));
    await mount();
    await screen.findByText("Profile: Fixture one");
    fireEvent.change(postInput(), { target: { value: "Fixture error" } });
    fireEvent.click(screen.getByRole("button", { name: "Publish draft" }));
    expect(await screen.findByText("Publish failed")).toBeVisible();
    expect(screen.getByText("Link is invalid. Use a URL like https://example.com, or leave Link empty.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Publish draft" })).toBeEnabled();
  });

  it("renders mixed history summaries and clears history through the fixture boundary", async () => {
    history = [{ id: "fixture-post", createdAt: "2026-10-28T12:00:00Z", title: " Fixture history ", text: " Fixture history body ", platforms: ["bluesky"], results: mixedResults, linkUrl: "https://fixture.example/article" }];
    await mount();
    const historyList = await screen.findByLabelText("Published posts");
    expect(within(historyList).getByText("Fixture history")).toBeVisible();
    expect(within(historyList).getByText("Fixture history body")).toBeVisible();
    expect(within(historyList).getByText("1/3 ok · 1 check")).toHaveClass("ok");
    expect(within(historyList).getByTitle("Fixture unknown; check profile")).toHaveClass("unknown");
    fireEvent.click(screen.getByRole("button", { name: "Clear history" }));
    await screen.findByText("No published post yet");
    expect(vi.mocked(fetch)).toHaveBeenCalledWith("/api/draft?scope=history", { method: "DELETE" });
  });
});
