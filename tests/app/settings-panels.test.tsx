// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { settingsFixture, settingsPanels } from "./support/settings-fixture";
import type { ConfigResponse, SettingsView } from "@/lib/settings/contracts";
import type { Platform } from "@/lib/types";

let config: ConfigResponse;
let failures: Set<string>;
let actionThrows = false;
let updateAvailable = false;
let installed = false;
const requests: Array<{ url: string; method: string; body?: unknown }> = [];
const clipboard = vi.fn();
function json(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status }); }

beforeEach(() => {
  config = settingsFixture(); failures = new Set(); requests.length = 0;
  actionThrows = false; updateAvailable = false; installed = false;
  clipboard.mockReset().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: clipboard } });
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method || "GET";
    requests.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (failures.has(`${method} ${url}`)) return json({ error: "Fixture action denied" }, 500);
    if (url === "/api/config") {
      if (method === "PUT") config = { ...config, ...JSON.parse(String(init?.body)) };
      return json(config);
    }
    if (url === "/api/local-service") {
      if (method !== "GET") installed = method === "POST";
      return json({ ...settingsPanels["/api/local-service"], installed, running: installed });
    }
    if (url === "/api/app-version") return json({ ...settingsPanels["/api/app-version"], updateAvailable,
      ...(method === "POST" ? { message: "Fixture update ready" } : {}) });
    if (method === "GET" && url in settingsPanels) return json(settingsPanels[url as keyof typeof settingsPanels]);
    if (url === "/api/storage" && method === "DELETE") return json({ ...settingsPanels["/api/storage"], uploads: { path: "/fixture/uploads", files: 0, bytes: 0 }, totalBytes: 0 });
    if (["/api/config/open", "/api/storage/open", "/api/auth/x/login", "/api/auth/instagram/login", "/api/auth/youtube/import-cookie", "/api/auth/hackernews/import-cookie"].includes(url) && method === "POST") {
      if (actionThrows) throw new Error("Fixture action disconnected");
      return json({ message: "Fixture connection saved" });
    }
    throw new Error(`Unexpected settings panel request ${method} ${url}`);
  }));
});
afterEach(() => { cleanup(); localStorage.clear(); });

function addProvider(platform: Platform, values: Record<string, string> = {}) {
  config.profiles[platform] = [{ id: `fixture-${platform}`, label: `Fixture ${platform}`, values }];
}
async function mount(view: SettingsView) {
  const { default: Settings } = await import("@/app/settings/settings-client");
  render(<Settings initialView={view} />);
  await screen.findByText(view === "socials" ? "Fixture Bluesky" : view === "storage" ? "/fixture/uploads" : "Crossposter 1.1.16", { exact: true });
}
function button(name: string) { return screen.getByRole("button", { name }); }
function actions() { return requests.filter((r) => r.method !== "GET"); }

it.each([
  ["x", "Log in to X", "/api/auth/x/login"],
  ["instagram", "Log in to Instagram", "/api/auth/instagram/login"],
  ["hackernews", "Import Chrome cookie", "/api/auth/hackernews/import-cookie"],
  ["youtube", "Import Chrome cookies", "/api/auth/youtube/import-cookie"]
] as const)("saves before mocked %s connection, reloads and releases busy state", async (provider, label, endpoint) => {
  addProvider(provider);
  await mount("socials");
  fireEvent.click(button(label));
  await screen.findByText("Fixture connection saved");
  expect(actions().map((r) => `${r.method} ${r.url}`)).toEqual(["PUT /api/config", `POST ${endpoint}`]);
  expect(actions()[1].body).toEqual({ profileId: `fixture-${provider}` });
  expect(requests.filter((r) => r.url === "/api/config" && r.method === "GET")).toHaveLength(2);
  expect(button(label)).toBeEnabled();
});

it.each(["http", "transport", "save"])("reports %s connection failure without real browser actions", async (failure) => {
  addProvider("x"); await mount("socials");
  if (failure === "http") failures.add("POST /api/auth/x/login");
  if (failure === "save") failures.add("PUT /api/config");
  if (failure === "transport") actionThrows = true;
  fireEvent.click(button("Log in to X"));
  await screen.findByText(failure === "transport" ? "Fixture action disconnected" : "Fixture action denied");
  expect(button("Log in to X")).toBeEnabled();
  if (failure === "save") expect(actions().map((r) => r.url)).toEqual(["/api/config"]);
});

it("keeps a failed post-login config reload visible instead of replacing it with success", async () => {
  addProvider("instagram"); await mount("socials");
  failures.add("GET /api/config"); fireEvent.click(button("Log in to Instagram"));
  await screen.findByText("Fixture action denied");
  await waitFor(() => expect(button("Log in to Instagram")).toBeEnabled());
  expect(screen.queryByText("Fixture connection saved")).not.toBeInTheDocument();
  expect(screen.getByText("Fixture Bluesky", { exact: true })).toBeVisible();
});

it.each(["linkedin", "dribbble"] as const)("saves before mocked %s OAuth navigation", async (provider) => {
  addProvider(provider, provider === "linkedin" ? { LINKEDIN_CLIENT_ID: "fixture-id", LINKEDIN_CLIENT_SECRET: "fixture-secret" } : { DRIBBBLE_CLIENT_ID: "fixture-id", DRIBBBLE_CLIENT_SECRET: "fixture-secret", DRIBBBLE_OAUTH_SCOPES: "public upload" });
  const client = await import("@/lib/settings/client");
  const navigate = vi.spyOn(client, "startProviderOAuth").mockImplementation(() => undefined);
  await mount("socials"); fireEvent.click(button(provider === "linkedin" ? "Connect LinkedIn" : "Connect Dribbble"));
  await waitFor(() => expect(navigate).toHaveBeenCalledWith(provider, `fixture-${provider}`));
  expect(actions().map((r) => r.url)).toEqual(["/api/config"]);
});

it("keeps OAuth validation local and blocks navigation when saving fails", async () => {
  addProvider("dribbble", { DRIBBBLE_CLIENT_ID: "fixture-id", DRIBBBLE_CLIENT_SECRET: "fixture-secret", DRIBBBLE_OAUTH_SCOPES: "public" });
  const client = await import("@/lib/settings/client");
  const navigate = vi.spyOn(client, "startProviderOAuth").mockImplementation(() => undefined);
  await mount("socials"); fireEvent.click(button("Connect Dribbble"));
  await screen.findByText("Dribbble OAuth scopes must include upload.");
  expect(actions()).toEqual([]);
  fireEvent.change(screen.getByPlaceholderText("DRIBBBLE_OAUTH_SCOPES"), { target: { value: "public upload" } });
  failures.add("PUT /api/config"); fireEvent.click(button("Connect Dribbble"));
  await screen.findByText("Fixture action denied"); expect(navigate).not.toHaveBeenCalled();
});

it("saves before enabling auto-start and disables without saving, through intercepted requests", async () => {
  await mount("settings"); fireEvent.click(button("Enable auto-start"));
  await screen.findByText("Auto-start enabled for http://localhost:2004.");
  expect(button("Disable auto-start")).toHaveAttribute("aria-pressed", "true");
  fireEvent.click(button("Disable auto-start")); await screen.findByText("Auto-start disabled.");
  expect(actions().map((r) => `${r.method} ${r.url}`)).toEqual(["PUT /api/config", "POST /api/local-service", "DELETE /api/local-service"]);
});

it("does not install a service after config save failure", async () => {
  await mount("settings"); failures.add("PUT /api/config");
  fireEvent.click(button("Enable auto-start")); await screen.findByText("Fixture action denied");
  expect(actions().map((r) => r.url)).toEqual(["/api/config"]);
  expect(button("Enable auto-start")).toBeEnabled();
});

it("opens a mocked storage folder and clears only after confirmation, retaining config", async () => {
  localStorage.setItem("crossposter:compose-draft:v1", "fixture draft");
  await mount("storage"); fireEvent.click(button("Open folder")); await screen.findByText("Opened storage folder.");
  fireEvent.click(button("Copy path")); await screen.findByText("Copied storage path."); expect(clipboard).toHaveBeenCalledWith("/fixture/uploads");
  fireEvent.click(button("Clear storage")); await screen.findByText("Confirm storage clear first.");
  expect(actions().some((r) => r.method === "DELETE")).toBe(false);
  fireEvent.click(button("Confirm clear storage")); await screen.findByText("Storage cleared. Config keys and profiles were kept.");
  expect(localStorage.getItem("crossposter:compose-draft:v1")).toBeNull();
  expect(config.profiles.bluesky).toHaveLength(1);
});

it("retains browser data when storage clear fails", async () => {
  localStorage.setItem("crossposter:compose-draft:v1", "fixture draft"); await mount("storage");
  failures.add("DELETE /api/storage"); fireEvent.click(button("Clear storage")); fireEvent.click(button("Confirm clear storage"));
  await screen.findByText("Fixture action denied"); expect(localStorage.getItem("crossposter:compose-draft:v1")).toBe("fixture draft");
  expect(button("Confirm clear storage")).toBeEnabled();
});

it("exposes filesystem-open errors and copies config path with clipboard fallback", async () => {
  await mount("settings"); failures.add("POST /api/config/open"); fireEvent.click(button("Open file"));
  await screen.findByText("Fixture action denied"); fireEvent.click(button("Copy path")); await screen.findByText("Copied config path.");
  expect(clipboard).toHaveBeenCalledWith("/fixture/poster.config.local.json");
  clipboard.mockRejectedValueOnce(new Error("Fixture clipboard unavailable")); fireEvent.click(button("Copy path"));
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("/fixture/poster.config.local.json"));
});

it("updates the package through a mocked action and saves the auto-update preference", async () => {
  updateAvailable = true; await mount("settings"); fireEvent.click(button("Update now"));
  await screen.findByText("Fixture update ready"); expect(actions().map((r) => r.url)).toEqual(["/api/app-version"]);
  fireEvent.click(button("Disable auto-update")); await screen.findByText("Auto-update disabled.");
  expect(config.values.POSTER_AUTO_UPDATE).toBe("false"); expect(button("Enable auto-update")).toHaveAttribute("aria-pressed", "false");
});

it("retains network help and derives the copied phone URL from unsaved host and port", async () => {
  await mount("settings"); fireEvent.click(button("Show Tailscale connection help")); await screen.findByText("Fix phone access");
  fireEvent.change(screen.getByPlaceholderText("100.x.x.x or macbook.tailnet.ts.net"), { target: { value: "https://fixture.tailnet.ts.net:2004/path" } });
  fireEvent.change(screen.getByPlaceholderText("POSTER_LOCAL_PORT"), { target: { value: "4100" } });
  fireEvent.click(button("Copy phone URL")); await screen.findByText("Copied Tailscale URL.");
  expect(clipboard).toHaveBeenCalledWith("http://fixture.tailnet.ts.net:4100"); expect(actions()).toEqual([]);
  const panel = screen.getByText("Fix phone access").closest(".tailscale-panel")!;
  fireEvent.click(within(panel as HTMLElement).getByRole("button", { name: "Refresh Tailscale" }));
  await waitFor(() => expect(requests.filter((r) => r.url === "/api/network/tailscale")).toHaveLength(2));
});
