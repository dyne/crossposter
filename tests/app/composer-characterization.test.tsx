// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComposeDraft } from "@/lib/types";

let draft: ComposeDraft;
let draftGet: Promise<Response> | undefined;
let uploadFails = false;
let profiles = "bluesky";
const drawImage = vi.fn();
const revoke = vi.fn();
let objectCounter = 0;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => {
  draft = { title: "", text: "", linkUrl: "", platforms: [], targets: [] };
  draftGet = undefined;
  profiles = "bluesky";
  uploadFails = false;
  objectCounter = 0;
  const objectFiles = new Map<string, Blob>();
  localStorage.clear();
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (input === "/api/config") return json({ profiles: profiles === "dribbble" ? {
      dribbble: [{ id: "fixture", label: "Fixture Dribbble", values: { DRIBBBLE_ACCESS_TOKEN: "fixture-token", DRIBBBLE_TAGS: "fixture" } }]
    } : { bluesky: [{ id: "fixture", label: "Fixture Bluesky", values: { BLUESKY_IDENTIFIER: "fixture.example", BLUESKY_APP_PASSWORD: "fixture-token" } }] } });
    if (input === "/api/draft") {
      if (init?.method === "PUT") { draft = JSON.parse(String(init.body)).draft; return json({ draft }); }
      return draftGet || json({ draft, publishedPosts: [] });
    }
    if (input === "/api/media") return uploadFails ? json({ error: "Fixture upload failed" }, 500) : json({ media: { id: "fixture-media" } });
    if (input === "/api/publish") return json({ results: [] });
    throw new Error(`Unexpected fixture request: ${String(input)}`);
  }));
  vi.stubGlobal("Image", class {
    naturalWidth = 1200;
    naturalHeight = 600;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    set src(value: string) {
      const file = objectFiles.get(value);
      if (file instanceof File && file.name.includes("dribbble-800x600")) this.naturalWidth = 800;
      queueMicrotask(() => this.onload?.());
    }
  });
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  vi.stubGlobal("URL", class extends URL {
    static createObjectURL = vi.fn((file: Blob) => {
      const url = `blob:fixture-${++objectCounter}`;
      objectFiles.set(url, file);
      return url;
    });
    static revokeObjectURL = revoke;
  });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage, fillRect: vi.fn(), fillStyle: "" } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((callback) => callback(new Blob(["fixture-jpeg"], { type: "image/jpeg" })));
});

afterEach(() => { cleanup(); localStorage.clear(); });

async function mount() {
  const { default: Home } = await import("@/app/page");
  const view = render(<Home />);
  await screen.findByText(`Profile: Fixture ${profiles === "dribbble" ? "Dribbble" : "Bluesky"}`);
  return view;
}

function selectFile(name = "fixture.png", type = "image/png") {
  const file = new File(["fixture-media"], name, { type, lastModified: 123 });
  fireEvent.change(document.querySelector("#mediaFile")!, { target: { files: [file] } });
  return file;
}

describe("composer behavior before lifecycle extraction", () => {
  it("restores the newest browser draft, including legacy URL and platform selection", async () => {
    draft = { ...draft, text: "Older server", updatedAt: "2025-01-01T00:00:00Z" };
    localStorage.setItem("personal-crossposter:compose-draft:v1", JSON.stringify({ title: "Local title", text: "Newer browser", url: "https://fixture.example", selected: ["bluesky"], updatedAt: "2026-01-01T00:00:00Z" }));
    await mount();
    await waitFor(() => expect(screen.getByLabelText("Post", { exact: true })).toHaveValue("Newer browser"));
    expect(screen.getByLabelText("Link", { exact: true })).toHaveValue("https://fixture.example");
    expect(screen.getByRole("button", { name: "Publish draft" })).toBeEnabled();
    expect(localStorage.getItem("crossposter:compose-draft:v1")).toContain("Newer browser");
  });

  it("characterizes a slow initial response replacing edits made before hydration", async () => {
    const held = deferred<Response>();
    draftGet = held.promise;
    await mount();
    fireEvent.change(screen.getByLabelText("Post", { exact: true }), { target: { value: "Edited while loading" } });
    await act(async () => held.resolve(json({ draft: { ...draft, text: "Initial server response" } })));
    await waitFor(() => expect(screen.getByLabelText("Post", { exact: true })).toHaveValue("Initial server response"));
  });

  it("ignores save response bodies after newer edits", async () => {
    await mount();
    const held = deferred<Response>();
    const fetchMock = vi.mocked(fetch);
    const original = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((input, init) => init?.method === "PUT" ? held.promise : original(input, init));
    fireEvent.change(screen.getByLabelText("Post", { exact: true }), { target: { value: "Earlier save" } });
    await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => String(init?.body).includes("Earlier save"))).toBe(true));
    fireEvent.change(screen.getByLabelText("Post", { exact: true }), { target: { value: "Newer edit" } });
    await act(async () => held.resolve(json({ draft: { ...draft, text: "Earlier save" } })));
    expect(screen.getByLabelText("Post", { exact: true })).toHaveValue("Newer edit");
    expect(localStorage.getItem("crossposter:compose-draft:v1")).toContain("Newer edit");
  });

  it("falls back to the browser draft if loading fails and remains editable if storage fails", async () => {
    localStorage.setItem("crossposter:compose-draft:v1", JSON.stringify({ ...draft, text: "Offline draft" }));
    draftGet = Promise.reject(new Error("Fixture offline"));
    await mount();
    await waitFor(() => expect(screen.getByLabelText("Post", { exact: true })).toHaveValue("Offline draft"));
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("Fixture quota"); });
    fireEvent.change(screen.getByLabelText("Post", { exact: true }), { target: { value: "Still editable" } });
    expect(screen.getByLabelText("Post", { exact: true })).toHaveValue("Still editable");
  });

  it("surfaces upload failure without publishing or removing the selected fixture", async () => {
    await mount();
    fireEvent.change(screen.getByLabelText("Post", { exact: true }), { target: { value: "Fixture publish" } });
    selectFile();
    await waitFor(() => expect(screen.getByAltText("fixture.png")).toBeVisible());
    uploadFails = true;
    fireEvent.click(screen.getByRole("button", { name: "Publish draft" }));
    await screen.findByText("Fixture upload failed");
    expect(vi.mocked(fetch).mock.calls.some(([url]) => url === "/api/publish")).toBe(false);
    expect(screen.getByAltText("fixture.png")).toBeVisible();
  });

  it("releases preview/image object URLs on replacement, removal and unmount", async () => {
    const view = await mount();
    selectFile();
    await waitFor(() => expect(screen.getByAltText("fixture.png")).toBeVisible());
    const first = screen.getByAltText("fixture.png").getAttribute("src");
    selectFile("replacement.png");
    await waitFor(() => expect(screen.getByAltText("replacement.png")).toBeVisible());
    expect(revoke).toHaveBeenCalledWith(first);
    const second = screen.getByAltText("replacement.png").getAttribute("src");
    fireEvent.click(screen.getByRole("button", { name: "Remove media file" }));
    await waitFor(() => expect(screen.queryByAltText("replacement.png")).not.toBeInTheDocument());
    expect(revoke).toHaveBeenCalledWith(second);
    selectFile("unmount.png");
    await waitFor(() => expect(screen.getByAltText("unmount.png")).toBeVisible());
    const last = screen.getByAltText("unmount.png").getAttribute("src");
    view.unmount();
    expect(revoke).toHaveBeenCalledWith(last);
  });

  it("crops a centered 1200x600 source to an 800x600 JPG and replaces the selected file", async () => {
    profiles = "dribbble";
    await mount();
    selectFile("fixture-wide.png");
    fireEvent.click(await screen.findByRole("button", { name: "Crop for Dribbble" }));
    fireEvent.click(screen.getByRole("button", { name: "Apply crop" }));
    await screen.findByAltText("fixture-wide-dribbble-800x600.jpg");
    expect(drawImage).toHaveBeenCalledWith(expect.anything(), 200, 0, 800, 600, 0, 0, 800, 600);
    expect(await screen.findByText(/image\/jpeg · 12 B · 800x600/)).toBeInTheDocument();
  });

  it("converts an unsupported image to JPEG without changing source dimensions", async () => {
    await mount();
    selectFile("fixture.bmp", "image/bmp");
    fireEvent.click(await screen.findByRole("button", { name: "Compress image" }));
    await screen.findByAltText("fixture-compressed.jpg");
    expect(drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0);
    expect(await screen.findByText(/image\/jpeg · 12 B · 1200x600/)).toBeInTheDocument();
  });
});
