// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { settingsFixture, settingsPanels } from "./support/settings-fixture";

let config: ReturnType<typeof settingsFixture>;
let saveError = "";
let saveResponse: Promise<Response> | undefined;
const writes: Array<ReturnType<typeof settingsFixture>> = [];
function json(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status }); }

beforeEach(() => {
  config = settingsFixture(); saveError = ""; saveResponse = undefined; writes.length = 0;
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/api/config") {
      if (init?.method === "PUT") {
        writes.push(JSON.parse(String(init.body)));
        if (saveError) return json({ error: saveError }, 500);
        if (saveResponse) return saveResponse;
        config = { ...config, ...JSON.parse(String(init.body)) };
      }
      return json(config);
    }
    if (!init?.method && url in settingsPanels) return json(settingsPanels[url as keyof typeof settingsPanels]);
    throw new Error(`Unexpected settings fixture request: ${url}`);
  }));
});
afterEach(cleanup);
async function mount(initialView: "socials" | "settings" = "socials") {
  const { default: Settings } = await import("@/app/settings/settings-client");
  render(<Settings initialView={initialView} />);
  await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalledWith("/api/config", { cache: "no-store" }));
  if (initialView === "socials") await screen.findByText("Fixture Bluesky", { exact: true });
  else await screen.findByText("Crossposter 1.1.16");
}
function blueskyPanel() { return screen.getByText("Fixture Bluesky", { exact: true }).closest(".info-panel") as HTMLElement; }
function save() { fireEvent.click(screen.getByRole("button", { name: /^(Save config|Saved locally)$/ })); }

describe("settings observable configuration contract", () => {
  it("keeps secret masking/show-hide and validation without blocking unsaved edits", async () => {
    await mount();
    const password = screen.getByPlaceholderText("BLUESKY_APP_PASSWORD");
    expect(password).toHaveAttribute("type", "password");
    fireEvent.click(within(blueskyPanel()).getByRole("button", { name: "Show secret" }));
    expect(password).toHaveAttribute("type", "text");
    fireEvent.click(within(blueskyPanel()).getByRole("button", { name: "Hide secret" }));
    expect(password).toHaveAttribute("type", "password");
    fireEvent.change(screen.getByPlaceholderText("BLUESKY_IDENTIFIER"), { target: { value: "@invalid" } });
    await screen.findByText("Invalid Bluesky handle: should not include @");
    expect(writes).toHaveLength(0);
    save();
    await screen.findByText("Saved locally.");
    expect(writes[0].profiles.bluesky[0].values.BLUESKY_IDENTIFIER).toBe("@invalid");
  });

  it("adds a profile with field defaults, changes the active ID and confirms removal", async () => {
    await mount();
    fireEvent.click(within(blueskyPanel()).getByRole("button", { name: "Add profile" }));
    expect(within(blueskyPanel()).getAllByPlaceholderText("BLUESKY_IDENTIFIER")).toHaveLength(2);
    await screen.findByText("Missing Bluesky handle");
    save(); await screen.findByText("Saved locally.");
    const added = writes[0].profiles.bluesky[1];
    expect(added.values).toEqual({ BLUESKY_IDENTIFIER: "", BLUESKY_APP_PASSWORD: "" });
    expect(writes[0].activeProfiles.bluesky).toBe(added.id);
    const group = within(blueskyPanel()).getByText("New bluesky profile", { exact: true }).closest("section")!;
    fireEvent.click(within(group).getByRole("button", { name: "Delete profile" }));
    await screen.findByText("Confirm profile delete first.");
    fireEvent.click(within(group).getByRole("button", { name: "Confirm delete" }));
    await screen.findByText("Profile removed. Save config to keep this change.");
    save(); await waitFor(() => expect(writes).toHaveLength(2));
    expect(writes[1].profiles.bluesky.map((p) => p.id)).toEqual(["fixture"]);
    expect(writes[1].activeProfiles.bluesky).toBe("fixture");
  });

  it("keeps edits on save HTTP failure and exposes the server error", async () => {
    await mount(); saveError = "Fixture save denied";
    fireEvent.change(screen.getByPlaceholderText("BLUESKY_IDENTIFIER"), { target: { value: "edited.example" } });
    save(); await screen.findByText("Fixture save denied");
    expect(screen.getByPlaceholderText("BLUESKY_IDENTIFIER")).toHaveValue("edited.example");
    expect(screen.getByRole("button", { name: "Save config" })).toBeEnabled();
  });

  it("keeps save transport failures explicit", async () => {
    await mount();
    const original = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation((url, init) => init?.method === "PUT" ? Promise.reject(new Error("Fixture disconnected")) : original(url, init));
    save(); await screen.findByText("Fixture disconnected");
  });

  it.each(["http", "transport"])("shows an explicit initial load %s error and leaves save available", async (failure) => {
    const original = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation((url, init) => {
      if (url === "/api/config") return failure === "http"
        ? Promise.resolve(json({ error: "Fixture load denied" }, 403))
        : Promise.reject(new Error("Fixture load disconnected"));
      return original(url, init);
    });
    await mount("settings");
    await screen.findByText(failure === "http" ? "Fixture load denied" : "Fixture load disconnected");
    expect(screen.getByRole("button", { name: "Save config" })).toBeEnabled();
  });

  it("characterizes save completion replacing edits made while the request is pending", async () => {
    await mount(); let finish!: (value: Response) => void;
    saveResponse = new Promise((resolve) => { finish = resolve; });
    save(); await waitFor(() => expect(writes).toHaveLength(1));
    fireEvent.change(screen.getByPlaceholderText("BLUESKY_IDENTIFIER"), { target: { value: "pending.example" } });
    await act(async () => finish(json(config)));
    await screen.findByText("Saved locally.");
    expect(screen.getByPlaceholderText("BLUESKY_IDENTIFIER")).toHaveValue("fixture.example");
  });

  it("keeps an absent local port blank and leaves editing local until save", async () => {
    config.values.POSTER_LOCAL_PORT = "";
    await mount("settings");
    const port = screen.getByPlaceholderText("POSTER_LOCAL_PORT");
    expect(port).toHaveValue("");
    fireEvent.change(port, { target: { value: "4000" } });
    expect(writes).toHaveLength(0);
    expect(screen.getAllByText("http://localhost:4000").length).toBeGreaterThan(0);
  });
});
