// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComposeDraft, PublishTarget } from "@/lib/types";

const target: PublishTarget = { id: "bluesky:fixture", platform: "bluesky", profileId: "fixture", profileLabel: "Fixture" };
const availableTargets = [target];
const empty: ComposeDraft = { title: "", text: "", linkUrl: "", platforms: [], targets: [] };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

beforeEach(() => { localStorage.clear(); });
afterEach(() => { cleanup(); localStorage.clear(); });

async function draftHook() {
  const { composeClient } = await import("@/lib/compose/client");
  const storage = await import("@/lib/compose/draft-storage");
  vi.spyOn(composeClient, "readDraft").mockResolvedValue({ draft: empty });
  vi.spyOn(composeClient, "saveDraft").mockImplementation(async () => new Response("{}"));
  vi.spyOn(storage, "readStoredDraftMedia").mockResolvedValue(null);
  const hydrateMedia = vi.fn();
  const clearMedia = vi.fn(async () => undefined);
  const { useComposerDraft } = await import("@/components/composer/use-composer-draft");
  return { composeClient, storage, hydrateMedia, clearMedia,
    mount: () => renderHook(() => useComposerDraft({ availableTargets, configHydrated: true, hydrateMedia, clearMedia })) };
}

describe("composer draft lifecycle", () => {
  it("exposes loading and restores selected targets and history with a server draft", async () => {
    const fixture = await draftHook();
    const restored = { ...empty, title: "Server", text: "Server fixture", targets: [target], updatedAt: "2026-01-01T00:00:00Z" };
    vi.mocked(fixture.composeClient.readDraft).mockResolvedValue({ draft: restored });
    const view = fixture.mount();
    expect(view.result.current.isLoadingDraft).toBe(true);
    await waitFor(() => expect(view.result.current.draftHydrated).toBe(true));
    expect(view.result.current.title).toBe("Server");
    expect(view.result.current.selected).toEqual([target.id]);
    expect(fixture.hydrateMedia).toHaveBeenCalledWith(null);
    expect(view.result.current.loadError).toBe("");
  });

  it("preserves a valid server draft and revision when IndexedDB reading fails", async () => {
    const fixture = await draftHook();
    localStorage.setItem("crossposter:compose-draft:v1", JSON.stringify({ ...empty, text: "Browser recovery" }));
    vi.mocked(fixture.composeClient.readDraft).mockResolvedValue({ draft: { ...empty, text: "Server" }, revision: "server-base" });
    vi.mocked(fixture.storage.readStoredDraftMedia).mockRejectedValue(new Error("Fixture IndexedDB read failed"));
    const view = fixture.mount();
    await waitFor(() => expect(view.result.current.draftHydrated).toBe(true));
    expect(view.result.current.text).toBe("Server");
    expect(view.result.current.loadError).toBe("Fixture IndexedDB read failed");
    await waitFor(() => expect(fixture.composeClient.saveDraft).toHaveBeenCalledWith(expect.objectContaining({ text: "Server" }), "server-base"));
  });

  it("keeps meaningful title, text, link and target edits made before the draft response", async () => {
    const f = await draftHook();
    const held = deferred<{ draft: ComposeDraft; revision: string }>();
    vi.mocked(f.composeClient.readDraft).mockReturnValue(held.promise);
    const view = f.mount();
    try {
      expect(view.result.current.isLoadingDraft).toBe(true);
      act(() => {
        view.result.current.setTitle("My title");
        view.result.current.setText("Typed then cleared");
        view.result.current.setLinkUrl("https://my.example");
        view.result.current.setSelected([target.id]);
      });
      act(() => { view.result.current.setText(""); view.result.current.setSelected([]); });
      expect(f.composeClient.saveDraft).not.toHaveBeenCalled();
      await act(async () => held.resolve({ draft: { ...empty, title: "Old title", text: "Old text", linkUrl: "https://old.example", targets: [target], updatedAt: "2026-01-01T00:00:00Z" }, revision: "loaded" }));
      await waitFor(() => expect(view.result.current.draftHydrated).toBe(true));
      expect(view.result.current.title).toBe("My title");
      expect(view.result.current.text).toBe("");
      expect(view.result.current.linkUrl).toBe("https://my.example");
      expect(view.result.current.selected).toEqual([]);
      await waitFor(() => expect(f.composeClient.saveDraft).toHaveBeenCalledWith(expect.objectContaining({ title: "My title", text: "", linkUrl: "https://my.example", targets: [] }), "loaded"));
    } finally { held.resolve({ draft: empty, revision: "loaded" }); await act(async () => held.promise); view.unmount(); }
  });

  it("restores untouched fields while retaining text edited before the response", async () => {
    const f = await draftHook();
    const held = deferred<{ draft: ComposeDraft }>();
    vi.mocked(f.composeClient.readDraft).mockReturnValue(held.promise);
    const view = f.mount();
    try {
      act(() => view.result.current.setText("My post"));
      await act(async () => held.resolve({ draft: { ...empty, title: "Restored title", text: "Old post", linkUrl: "https://fixture.example", targets: [target] } }));
      await waitFor(() => expect(view.result.current.draftHydrated).toBe(true));
      expect(view.result.current).toMatchObject({ title: "Restored title", text: "My post", linkUrl: "https://fixture.example", selected: [target.id] });
    } finally { held.resolve({ draft: empty }); await act(async () => held.promise); view.unmount(); }
  });

  it("retains edits during a held media read and skips media replaced during loading", async () => {
    const f = await draftHook();
    const held = deferred<File | null>();
    vi.mocked(f.storage.readStoredDraftMedia).mockReturnValue(held.promise);
    vi.mocked(f.composeClient.readDraft).mockResolvedValue({ draft: { ...empty, title: "Server title", text: "Server post" }, revision: "server" });
    const view = f.mount();
    try {
      await waitFor(() => expect(f.storage.readStoredDraftMedia).toHaveBeenCalledTimes(1));
      act(() => {
        view.result.current.setTitle("My title"); view.result.current.setText("My post");
        view.result.current.setLinkUrl("https://my.example"); view.result.current.setSelected([target.id]);
        view.result.current.detachMedia();
      });
      await act(async () => held.resolve(new File(["old"], "old.png", { type: "image/png" })));
      await waitFor(() => expect(view.result.current.draftHydrated).toBe(true));
      expect(view.result.current).toMatchObject({ title: "My title", text: "My post", linkUrl: "https://my.example", selected: [target.id] });
      expect(f.hydrateMedia).toHaveBeenCalledWith(null);
    } finally { held.resolve(null); await act(async () => held.promise); view.unmount(); }
  });

  it("does not hydrate or save a held media result after unmount", async () => {
    const f = await draftHook();
    const held = deferred<File | null>();
    vi.mocked(f.storage.readStoredDraftMedia).mockReturnValue(held.promise);
    const view = f.mount();
    try {
      await waitFor(() => expect(f.storage.readStoredDraftMedia).toHaveBeenCalledTimes(1));
      view.unmount();
      await act(async () => held.resolve(new File(["old"], "old.png")));
      expect(f.hydrateMedia).not.toHaveBeenCalled(); expect(f.composeClient.saveDraft).not.toHaveBeenCalled();
    } finally { held.resolve(null); await act(async () => held.promise); view.unmount(); }
  });

  it("retains server text and its attachment identity when media import fails", async () => {
    const f = await draftHook();
    const media = { id: "missing", filename: "missing.png", contentType: "image/png", size: 7, kind: "image" as const, url: "/api/media/missing" };
    vi.stubGlobal("fetch", vi.fn(async () => new Response("unavailable", { status: 500 })));
    vi.mocked(f.composeClient.readDraft).mockResolvedValue({ draft: { ...empty, title: "Valid title", text: "Valid server text", media, updatedAt: "2026-01-01T00:00:00Z" }, revision: "base" });
    const view = f.mount();
    await waitFor(() => expect(view.result.current.draftHydrated).toBe(true));
    expect(view.result.current.text).toBe("Valid server text");
    expect(view.result.current.loadError).toContain("Attached media could not be restored");
    expect(f.hydrateMedia).toHaveBeenCalledWith(null);
    act(() => view.result.current.setText("My edit"));
    await waitFor(() => expect(f.composeClient.saveDraft).toHaveBeenCalledWith(expect.objectContaining({ text: "My edit", media }), "base"));
  });

  it("keeps browser recovery local-only when no server revision can be loaded", async () => {
    const f = await draftHook();
    localStorage.setItem("crossposter:compose-draft:v1", JSON.stringify({ ...empty, text: "Browser recovery" }));
    vi.mocked(f.composeClient.readDraft).mockRejectedValue(new Error("Fixture offline"));
    const view = f.mount();
    await waitFor(() => expect(view.result.current.draftHydrated).toBe(true));
    vi.useFakeTimers();
    act(() => view.result.current.setText("Keep this local edit"));
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(view.result.current.isLocalOnly).toBe(true);
    expect(f.composeClient.saveDraft).not.toHaveBeenCalled();
    expect(localStorage.getItem("crossposter:compose-draft:v1")).toContain("Keep this local edit");
    view.unmount(); expect(vi.getTimerCount()).toBe(0);
  });

  it("preserves a deliberate clear during loading and waits for its server revision", async () => {
    const f = await draftHook();
    const held = deferred<{ draft: ComposeDraft; revision: string }>();
    vi.mocked(f.composeClient.readDraft).mockReturnValue(held.promise);
    const view = f.mount();
    try {
      await act(async () => view.result.current.clearDraft());
      expect(f.composeClient.saveDraft).not.toHaveBeenCalled();
      await act(async () => held.resolve({ draft: { ...empty, text: "Old server text", title: "Old title", targets: [target] }, revision: "loaded" }));
      await waitFor(() => expect(view.result.current.draftHydrated).toBe(true));
      expect(view.result.current).toMatchObject({ text: "", title: "", selected: [] });
      await waitFor(() => expect(f.composeClient.saveDraft).toHaveBeenCalledWith(expect.objectContaining({ title: "", text: "", targets: [] }), "loaded"));
    } finally { held.resolve({ draft: empty, revision: "loaded" }); await act(async () => held.promise); view.unmount(); }
  });

  it("keeps edits and exposes local storage failure without blocking the server save", async () => {
    const fixture = await draftHook();
    const view = fixture.mount();
    await waitFor(() => expect(view.result.current.draftHydrated).toBe(true));
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("Fixture quota"); });
    act(() => view.result.current.setText("Still editable"));
    expect(view.result.current.storageError).toBe("Fixture quota");
    await waitFor(() => expect(fixture.composeClient.saveDraft).toHaveBeenCalledWith(expect.objectContaining({ text: "Still editable" }), undefined));
    expect(view.result.current.text).toBe("Still editable");
  });

  it("serializes delayed saves and advances the expected server revision without replacing newer edits", async () => {
    const fixture = await draftHook();
    vi.mocked(fixture.composeClient.readDraft).mockResolvedValue({ draft: empty, revision: "initial" });
    const view = fixture.mount();
    await waitFor(() => expect(view.result.current.draftHydrated).toBe(true));
    vi.useFakeTimers();
    const older = deferred<Response>();
    const newer = deferred<Response>();
    vi.mocked(fixture.composeClient.saveDraft).mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
    try {
      act(() => view.result.current.setText("Earlier save"));
      await act(async () => { await vi.advanceTimersByTimeAsync(250); });
      expect(view.result.current.isSavingDraft).toBe(true);
      act(() => view.result.current.setText("Newer edit"));
      await act(async () => { await vi.advanceTimersByTimeAsync(250); });
      expect(fixture.composeClient.saveDraft).toHaveBeenCalledTimes(1);
      expect(fixture.composeClient.saveDraft).toHaveBeenLastCalledWith(expect.objectContaining({ text: "Earlier save" }), "initial");
      await act(async () => older.resolve(Response.json({ revision: "after-first" })));
      expect(fixture.composeClient.saveDraft).toHaveBeenCalledTimes(2);
      expect(fixture.composeClient.saveDraft).toHaveBeenLastCalledWith(expect.objectContaining({ text: "Newer edit" }), "after-first");
      await act(async () => newer.resolve(Response.json({ revision: "after-second" })));
      expect(view.result.current.text).toBe("Newer edit");
      expect(view.result.current.saveError).toBe("");
      expect(view.result.current.isSavingDraft).toBe(false);
      expect(localStorage.getItem("crossposter:compose-draft:v1")).toContain("Newer edit");
    } finally {
      older.resolve(new Response("{}")); newer.resolve(new Response("{}"));
      await act(async () => { await Promise.allSettled([older.promise, newer.promise]); });
      view.unmount();
      expect(vi.getTimerCount()).toBe(0);
    }
  });

  it("does not apply a held initial response after unmount", async () => {
    const fixture = await draftHook();
    const held = deferred<{ draft: ComposeDraft }>();
    vi.mocked(fixture.composeClient.readDraft).mockReturnValue(held.promise);
    const view = fixture.mount();
    view.unmount();
    await act(async () => held.resolve({ draft: { ...empty, text: "Too late" } }));
    expect(fixture.hydrateMedia).not.toHaveBeenCalled();
  });

  it("clears compatible browser/server draft data and attached media", async () => {
    const fixture = await draftHook();
    const view = fixture.mount();
    await waitFor(() => expect(view.result.current.draftHydrated).toBe(true));
    act(() => view.result.current.setText("To clear"));
    await act(async () => view.result.current.clearDraft());
    expect(view.result.current.text).toBe("");
    expect(view.result.current.selected).toEqual([]);
    expect(fixture.clearMedia).toHaveBeenCalledTimes(1);
    expect(fixture.composeClient.saveDraft).toHaveBeenCalledWith(expect.objectContaining({ text: "", targets: [], platforms: [] }), undefined);
    expect(JSON.parse(localStorage.getItem("crossposter:compose-draft:v1")!).text).toBe("");
  });

  it("retains edits and stops queued and future saves after a conflict", async () => {
    const f = await draftHook();
    vi.mocked(f.composeClient.readDraft).mockResolvedValue({ draft: empty, revision: "loaded" });
    const view = f.mount(); await waitFor(() => expect(view.result.current.draftHydrated).toBe(true));
    vi.useFakeTimers(); const held = deferred<Response>();
    vi.mocked(f.composeClient.saveDraft).mockReturnValueOnce(held.promise);
    try {
      act(() => view.result.current.setText("First"));
      await act(async () => { await vi.advanceTimersByTimeAsync(250); });
      act(() => view.result.current.setText("Queued"));
      await act(async () => { await vi.advanceTimersByTimeAsync(250); });
      await act(async () => held.resolve(new Response("{}", { status: 409 })));
      expect(f.composeClient.saveDraft).toHaveBeenCalledTimes(1);
      expect(view.result.current.saveError).toContain("Draft changed elsewhere");
      expect(view.result.current.saveConflict).toBe(true);
      expect(view.result.current.isLocalOnly).toBe(true);
      act(() => view.result.current.setText("Keep this edit"));
      await act(async () => { await vi.advanceTimersByTimeAsync(250); });
      expect(f.composeClient.saveDraft).toHaveBeenCalledTimes(1);
      expect(view.result.current.text).toBe("Keep this edit");
      expect(localStorage.getItem("crossposter:compose-draft:v1")).toContain("Keep this edit");
    } finally { held.resolve(new Response("{}")); await act(async () => held.promise); view.unmount(); expect(vi.getTimerCount()).toBe(0); }
  });

  it("keeps non-OK saves local-only and does not replay queued edits", async () => {
    const f = await draftHook();
    const view = f.mount(); await waitFor(() => expect(view.result.current.draftHydrated).toBe(true));
    vi.useFakeTimers(); const held = deferred<Response>();
    vi.mocked(f.composeClient.saveDraft).mockReturnValueOnce(held.promise);
    try {
      act(() => view.result.current.setText("First"));
      await act(async () => { await vi.advanceTimersByTimeAsync(250); });
      act(() => view.result.current.setText("Queued local edit"));
      await act(async () => { await vi.advanceTimersByTimeAsync(250); });
      await act(async () => held.resolve(new Response("{}", { status: 500 })));
      expect(f.composeClient.saveDraft).toHaveBeenCalledTimes(1);
      expect(view.result.current.isLocalOnly).toBe(true);
      expect(view.result.current.saveConflict).toBe(false);
      expect(view.result.current.saveError).toContain("Draft could not be saved");
      expect(view.result.current.text).toBe("Queued local edit");
      expect(view.result.current.isSavingDraft).toBe(false);
    } finally { held.resolve(new Response("{}")); await act(async () => held.promise); view.unmount(); expect(vi.getTimerCount()).toBe(0); }
  });

  it("stops queued saves after unmount while the active save settles", async () => {
    const f = await draftHook();
    const view = f.mount(); await waitFor(() => expect(view.result.current.draftHydrated).toBe(true));
    vi.useFakeTimers(); const held = deferred<Response>();
    vi.mocked(f.composeClient.saveDraft).mockReturnValueOnce(held.promise);
    try {
      act(() => view.result.current.setText("First"));
      await act(async () => { await vi.advanceTimersByTimeAsync(250); });
      act(() => view.result.current.setText("Queued local edit"));
      await act(async () => { await vi.advanceTimersByTimeAsync(250); });
      view.unmount();
      await act(async () => held.resolve(Response.json({ revision: "settled" })));
      expect(f.composeClient.saveDraft).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally { held.resolve(new Response("{}")); await act(async () => held.promise); view.unmount(); }
  });

  it("uses a versioned server draft over newer browser recovery and retains its attachment on text edits", async () => {
    const f = await draftHook();
    localStorage.setItem("crossposter:compose-draft:v1", JSON.stringify({ ...empty, text: "Obsolete browser", updatedAt: "2099-01-01T00:00:00Z" }));
    const media = { id: "fixture-media", filename: "fixture.png", contentType: "image/png", size: 7, kind: "image" as const, url: "/api/media/fixture-media" };
    vi.stubGlobal("fetch", vi.fn(async () => new Response("fixture", { headers: { "content-type": "image/png" } })));
    vi.mocked(f.composeClient.readDraft).mockResolvedValue({ draft: { ...empty, text: "MCP", media, updatedAt: "2026-01-01T00:00:00Z" }, revision: "server" });
    const view = f.mount(); await waitFor(() => expect(view.result.current.draftHydrated).toBe(true));
    expect(view.result.current.text).toBe("MCP"); expect(f.hydrateMedia.mock.calls[0][0]).toBeInstanceOf(File);
    act(() => view.result.current.setText("Edited"));
    await waitFor(() => expect(f.composeClient.saveDraft).toHaveBeenCalledWith(expect.objectContaining({ text: "Edited", media }), "server"));
  });

  it.each([true, false])("recovers local-only media only when its server revision still matches: %s", async (matches) => {
    const f = await draftHook();
    const file = new File(["fixture"], "browser.png", { type: "image/png" });
    localStorage.setItem("crossposter:compose-draft-server-revision:v1", "previous");
    vi.mocked(f.storage.readStoredDraftMedia).mockResolvedValue(file);
    vi.mocked(f.composeClient.readDraft).mockResolvedValue({ draft: { ...empty, updatedAt: "2026-01-01T00:00:00Z" }, revision: matches ? "previous" : "MCP-clear" });
    const view = f.mount(); await waitFor(() => expect(view.result.current.draftHydrated).toBe(true));
    expect(f.hydrateMedia).toHaveBeenCalledWith(matches ? file : null);
  });
});

async function mediaHook() {
  const storage = await import("@/lib/compose/draft-storage");
  const { composeClient } = await import("@/lib/compose/client");
  vi.spyOn(composeClient, "upload").mockRejectedValue(new Error("Unexpected fixture upload"));
  vi.spyOn(storage, "saveStoredDraftMedia").mockResolvedValue();
  const urls: string[] = [];
  const revoke = vi.fn();
  const images: Array<{ onload: (() => void) | null; onerror: (() => void) | null; naturalWidth: number; naturalHeight: number }> = [];
  vi.stubGlobal("URL", class extends URL {
    static createObjectURL = vi.fn(() => { const url = `blob:fixture-${urls.length}`; urls.push(url); return url; });
    static revokeObjectURL = revoke;
  });
  vi.stubGlobal("Image", class {
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    naturalWidth = 800;
    naturalHeight = 600;
    constructor() { images.push(this); }
    set src(_value: string) { /* Held until the test explicitly completes or aborts it. */ }
  });
  const options = { onEdit: vi.fn(), onReplace: vi.fn(), setError: vi.fn(), setProgress: vi.fn(), videoTargetBytes: (_platforms: unknown, _file: File, requested: number) => requested };
  const { useComposerMedia } = await import("@/components/composer/use-composer-media");
  const view = renderHook(() => useComposerMedia(options));
  return { view, options, storage, composeClient, urls, revoke, images };
}

describe("composer media lifecycle", () => {
  it("restores fixture media and reports storage failure while allowing replacement/removal", async () => {
    const { view, storage, options } = await mediaHook();
    expect(view.result.current.isLoadingMedia).toBe(true);
    const file = new File(["fixture"], "fixture.txt", { type: "text/plain" });
    vi.mocked(storage.saveStoredDraftMedia).mockRejectedValue(new Error("Fixture IndexedDB quota"));
    act(() => view.result.current.hydrateMedia(file));
    await waitFor(() => expect(view.result.current.storageError).toBe("Fixture IndexedDB quota"));
    expect(view.result.current.mediaFile).toBe(file);
    expect(view.result.current.isLoadingMedia).toBe(false);
    expect(options.onReplace).not.toHaveBeenCalled();
    await act(async () => view.result.current.clearMedia());
    expect(view.result.current.mediaFile).toBe(null);
    expect(options.onEdit).toHaveBeenCalledTimes(1);
  });

  it("discards stale image dimensions and releases pending image/preview URLs", async () => {
    const { view, images, urls, revoke } = await mediaHook();
    act(() => view.result.current.setDraftMedia(new File(["first"], "first.png", { type: "image/png" })));
    const lateOldLoad = images[0].onload!;
    act(() => view.result.current.setDraftMedia(new File(["second"], "second.png", { type: "image/png" })));
    await act(async () => lateOldLoad());
    expect(view.result.current.mediaDimensions).toBe(null);
    await act(async () => images[1].onload?.());
    expect(view.result.current.mediaDimensions).toEqual({ width: 800, height: 600 });
    await act(async () => view.result.current.clearMedia());
    expect(view.result.current.mediaDimensions).toBe(null);
    view.unmount();
    expect([...new Set(revoke.mock.calls.map(([url]) => url))].sort()).toEqual([...urls].sort());
    expect(revoke).toHaveBeenCalledTimes(urls.length);
  });

  it("exposes upload progress/error and retains the chosen fixture after failure", async () => {
    const { view, composeClient } = await mediaHook();
    const held = deferred<never>();
    vi.spyOn(composeClient, "upload").mockReturnValue(held.promise);
    const file = new File(["fixture"], "fixture.txt", { type: "text/plain" });
    act(() => view.result.current.setDraftMedia(file));
    let operation!: Promise<unknown>;
    act(() => { operation = view.result.current.uploadSelectedMedia(new AbortController().signal).catch((error: unknown) => error); });
    expect(view.result.current.isUploadingMedia).toBe(true);
    await act(async () => { held.reject(new Error("Fixture upload failed")); await operation; });
    expect(view.result.current.isUploadingMedia).toBe(false);
    expect(view.result.current.uploadError).toBe("Fixture upload failed");
    expect(view.result.current.mediaFile).toBe(file);
  });

  it("cancels owned conversion work and estimation timers on unmount", async () => {
    vi.useFakeTimers();
    const { view, urls, revoke, options } = await mediaHook();
    act(() => view.result.current.setDraftMedia(new File(["fixture"], "fixture.bmp", { type: "image/bmp" })));
    let operation!: Promise<void>;
    act(() => { operation = view.result.current.compressSelectedMedia(["bluesky"]); });
    expect(view.result.current.isCompressingMedia).toBe(true);
    const progressBeforeUnmount = options.setProgress.mock.calls.length;
    view.unmount();
    await act(async () => operation);
    expect(options.setProgress).toHaveBeenCalledTimes(progressBeforeUnmount);
    expect(revoke).toHaveBeenCalledTimes(urls.length);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels a pending upload on unmount and settles its caller", async () => {
    const { view, composeClient, options } = await mediaHook();
    let uploadedSignal: AbortSignal | undefined;
    vi.spyOn(composeClient, "upload").mockImplementation((_file, signal) => new Promise((_resolve, reject) => {
      uploadedSignal = signal;
      signal.addEventListener("abort", () => reject(new DOMException("Fixture aborted", "AbortError")), { once: true });
    }));
    act(() => view.result.current.setDraftMedia(new File(["fixture"], "fixture.txt")));
    let operation!: Promise<unknown>;
    act(() => { operation = view.result.current.uploadSelectedMedia(new AbortController().signal).catch((error: unknown) => error); });
    const progressAtUnmount = options.setProgress.mock.calls.length;
    view.unmount();
    await act(async () => { expect(await operation).toMatchObject({ name: "AbortError" }); });
    expect(uploadedSignal?.aborted).toBe(true);
    expect(options.setProgress).toHaveBeenCalledTimes(progressAtUnmount);
  });

  it("cleans the progress delay after a completed conversion", async () => {
    vi.useFakeTimers();
    const { view } = await mediaHook();
    const conversion = await import("@/lib/compose/media-conversion");
    vi.spyOn(conversion, "compressImageMedia").mockResolvedValue(new File(["fixture-jpeg"], "fixture-compressed.jpg", { type: "image/jpeg" }));
    act(() => view.result.current.setDraftMedia(new File(["fixture"], "fixture.bmp", { type: "image/bmp" })));
    await act(async () => view.result.current.compressSelectedMedia(["bluesky"]));
    expect(view.result.current.mediaFile?.name).toBe("fixture-compressed.jpg");
    expect(view.result.current.isCompressingMedia).toBe(false);
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps a newer media selection when an older conversion finishes", async () => {
    const { view } = await mediaHook();
    const conversion = await import("@/lib/compose/media-conversion");
    const held = deferred<File>();
    vi.spyOn(conversion, "compressImageMedia").mockReturnValue(held.promise);
    act(() => view.result.current.setDraftMedia(new File(["older"], "older.bmp", { type: "image/bmp" })));
    let operation!: Promise<void>;
    act(() => { operation = view.result.current.compressSelectedMedia(["bluesky"]); });
    try {
      act(() => view.result.current.setDraftMedia(new File(["newer"], "newer.png", { type: "image/png" })));
      await act(async () => { held.resolve(new File(["converted"], "older-compressed.jpg", { type: "image/jpeg" })); await operation; });
      expect(view.result.current.mediaFile?.name).toBe("newer.png");
    } finally {
      held.resolve(new File(["converted"], "older-compressed.jpg", { type: "image/jpeg" }));
      await act(async () => operation);
      view.unmount();
    }
  });

  for (const kind of ["compression", "crop"] as const) {
    it.each(["selection", "removal", "clear", "unmount"] as const)(`discards late ${kind} results after %s and releases resources`, async (change) => {
      vi.useFakeTimers();
      const f = await mediaHook();
      const conversion = await import("@/lib/compose/media-conversion");
      const held = deferred<File>(); let signal: AbortSignal | undefined;
      vi.spyOn(conversion, kind === "compression" ? "compressImageMedia" : "cropImageForDribbble")
        .mockImplementation((_file: File, _options: unknown, owner?: AbortSignal) => { signal = owner; return held.promise; });
      act(() => f.view.result.current.setDraftMedia(new File(["A"], "A.bmp", { type: "image/bmp" })));
      let operation!: Promise<void>;
      act(() => { operation = kind === "compression" ? f.view.result.current.compressSelectedMedia(["bluesky"]) : f.view.result.current.cropSelectedMediaForDribbble(); });
      expect(signal?.aborted).toBe(false);
      expect(kind === "compression" ? f.view.result.current.isCompressingMedia : f.view.result.current.isCroppingMedia).toBe(true);
      const newer = new File(["B"], "B.png", { type: "image/png" });
      try {
        if (change === "selection") act(() => f.view.result.current.setDraftMedia(newer));
        else if (change === "removal") act(() => f.view.result.current.setDraftMedia(null));
        else if (change === "clear") await act(async () => f.view.result.current.clearMedia());
        else f.view.unmount();
        const progressCount = f.options.setProgress.mock.calls.length;
        const errorCount = f.options.setError.mock.calls.length;
        const editCount = f.options.onEdit.mock.calls.length;
        const preview = f.view.result.current.mediaPreviewUrl;
        expect(signal?.aborted).toBe(true);
        if (change !== "unmount") {
          expect(f.view.result.current.isCompressingMedia).toBe(false);
          expect(f.view.result.current.isCroppingMedia).toBe(false);
        }
        await act(async () => { held.resolve(new File(["old output"], "A-output.jpg", { type: "image/jpeg" })); await operation; });
        if (change !== "unmount") {
          expect(f.view.result.current.mediaFile).toBe(change === "selection" ? newer : null);
          expect(f.view.result.current.mediaPreviewUrl).toBe(preview);
          expect(f.view.result.current.mediaDimensions).toBe(null);
        }
        expect(f.options.setProgress).toHaveBeenCalledTimes(progressCount);
        expect(f.options.setError).toHaveBeenCalledTimes(errorCount);
        expect(f.options.onEdit).toHaveBeenCalledTimes(editCount);
        expect(f.composeClient.upload).not.toHaveBeenCalled();
      } finally {
        held.resolve(new File(["old output"], "A-output.jpg", { type: "image/jpeg" }));
        await act(async () => operation); f.view.unmount();
        expect(vi.getTimerCount()).toBe(0);
        expect(f.revoke).toHaveBeenCalledTimes(f.urls.length);
        expect(new Set(f.revoke.mock.calls.map(([url]) => url))).toEqual(new Set(f.urls));
      }
    });

    it(`ignores an obsolete ${kind} error after replacement`, async () => {
      const f = await mediaHook(); const held = deferred<File>();
      const conversion = await import("@/lib/compose/media-conversion");
      vi.spyOn(conversion, kind === "compression" ? "compressImageMedia" : "cropImageForDribbble").mockReturnValue(held.promise);
      act(() => f.view.result.current.setDraftMedia(new File(["A"], "A.bmp", { type: "image/bmp" })));
      let operation!: Promise<void>;
      act(() => { operation = kind === "compression" ? f.view.result.current.compressSelectedMedia(["bluesky"]) : f.view.result.current.cropSelectedMediaForDribbble(); });
      try {
        act(() => f.view.result.current.setDraftMedia(new File(["B"], "B.png", { type: "image/png" })));
        const errors = f.options.setError.mock.calls.length;
        await act(async () => { held.reject(new Error("Obsolete failure")); await operation; });
        expect(f.options.setError).toHaveBeenCalledTimes(errors);
        expect(f.view.result.current.mediaFile?.name).toBe("B.png");
      } finally { held.resolve(new File(["old"], "A.jpg")); await act(async () => operation); f.view.unmount(); }
    });
  }

  it.each(["compression", "crop"] as const)("keeps the latest overlapping %s task busy when its predecessor settles", async (kind) => {
    vi.useFakeTimers();
    const f = await mediaHook(); const older = deferred<File>(); const newer = deferred<File>();
    const conversion = await import("@/lib/compose/media-conversion");
    const spy = vi.spyOn(conversion, kind === "compression" ? "compressImageMedia" : "cropImageForDribbble");
    spy.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
    act(() => f.view.result.current.setDraftMedia(new File(["A"], "A.bmp", { type: "image/bmp" })));
    let first!: Promise<void>; let second!: Promise<void>;
    act(() => { first = kind === "compression" ? f.view.result.current.compressSelectedMedia(["bluesky"]) : f.view.result.current.cropSelectedMediaForDribbble(); });
    act(() => { second = kind === "compression" ? f.view.result.current.compressSelectedMedia(["bluesky"]) : f.view.result.current.cropSelectedMediaForDribbble(); });
    try {
      const progress = f.options.setProgress.mock.calls.length;
      await act(async () => { older.resolve(new File(["old"], "old.jpg", { type: "image/jpeg" })); await first; });
      expect(f.view.result.current.mediaFile?.name).toBe("A.bmp");
      expect(kind === "compression" ? f.view.result.current.isCompressingMedia : f.view.result.current.isCroppingMedia).toBe(true);
      expect(f.options.setProgress).toHaveBeenCalledTimes(progress);
      await act(async () => { newer.resolve(new File(["new"], "new.jpg", { type: "image/jpeg" })); await second; });
      expect(f.view.result.current.mediaFile?.name).toBe("new.jpg");
      expect(f.view.result.current.isCompressingMedia).toBe(false); expect(f.view.result.current.isCroppingMedia).toBe(false);
    } finally {
      older.resolve(new File(["old"], "old.jpg")); newer.resolve(new File(["new"], "new.jpg"));
      await act(async () => { await Promise.allSettled([first, second]); }); f.view.unmount(); expect(vi.getTimerCount()).toBe(0);
    }
  });

  it("suppresses late video progress after a different media selection", async () => {
    const f = await mediaHook(); const held = deferred<File>();
    const conversion = await import("@/lib/compose/media-conversion");
    let report!: (value: { label: string; value: number }) => void;
    vi.spyOn(conversion, "compressVideoMedia").mockImplementation((_file, _options, progress) => { report = progress!; return held.promise; });
    act(() => f.view.result.current.setDraftMedia(new File(["A"], "A.mov", { type: "video/quicktime" })));
    let operation!: Promise<void>; act(() => { operation = f.view.result.current.compressSelectedMedia(["bluesky"]); });
    try {
      act(() => f.view.result.current.setDraftMedia(new File(["B"], "B.txt", { type: "text/plain" })));
      const progressCount = f.options.setProgress.mock.calls.length;
      act(() => report({ label: "Obsolete video progress", value: 90 }));
      await act(async () => { held.resolve(new File(["old"], "A.mp4", { type: "video/mp4" })); await operation; });
      expect(f.options.setProgress).toHaveBeenCalledTimes(progressCount);
      expect(f.view.result.current.mediaFile?.name).toBe("B.txt");
    } finally { held.resolve(new File(["old"], "A.mp4")); await act(async () => operation); f.view.unmount(); }
  });

  it("does not let a completed conversion timer clear a later upload's progress", async () => {
    vi.useFakeTimers(); const f = await mediaHook();
    const conversion = await import("@/lib/compose/media-conversion");
    vi.spyOn(conversion, "compressImageMedia").mockResolvedValue(new File(["jpeg"], "converted.jpg", { type: "image/jpeg" }));
    const held = deferred<never>(); vi.spyOn(f.composeClient, "upload").mockReturnValue(held.promise);
    act(() => f.view.result.current.setDraftMedia(new File(["A"], "A.bmp", { type: "image/bmp" })));
    await act(async () => f.view.result.current.compressSelectedMedia(["bluesky"]));
    let operation!: Promise<unknown>;
    act(() => { operation = f.view.result.current.uploadSelectedMedia(new AbortController().signal).catch((error: unknown) => error); });
    try {
      const progressCount = f.options.setProgress.mock.calls.length;
      await act(async () => { await vi.advanceTimersByTimeAsync(500); });
      expect(f.options.setProgress).toHaveBeenCalledTimes(progressCount);
      expect(f.view.result.current.isUploadingMedia).toBe(true);
    } finally { held.reject(new Error("Fixture upload settled")); await act(async () => operation); f.view.unmount(); expect(vi.getTimerCount()).toBe(0); }
  });

  it("refuses an obsolete captured upload function after selection changes", async () => {
    const f = await mediaHook(); vi.spyOn(f.composeClient, "upload").mockResolvedValue({ id: "current", url: "/api/media/current", kind: "file", filename: "B.txt", contentType: "text/plain", size: 1 });
    act(() => f.view.result.current.setDraftMedia(new File(["A"], "A.txt", { type: "text/plain" })));
    const obsoleteUpload = f.view.result.current.uploadSelectedMedia;
    const newer = new File(["B"], "B.txt", { type: "text/plain" });
    act(() => f.view.result.current.setDraftMedia(newer));
    await act(async () => expect(obsoleteUpload(new AbortController().signal)).rejects.toMatchObject({ name: "AbortError" }));
    expect(f.composeClient.upload).not.toHaveBeenCalled();
    await act(async () => f.view.result.current.uploadSelectedMedia(new AbortController().signal));
    expect(f.composeClient.upload).toHaveBeenCalledWith(newer, expect.any(AbortSignal));
  });

  it("does not cache dimensions from a preflight read for a replaced selection", async () => {
    const f = await mediaHook();
    const old = new File(["A"], "A.png", { type: "image/png" });
    act(() => f.view.result.current.setDraftMedia(old));
    let operation!: Promise<unknown>;
    act(() => { operation = f.view.result.current.mediaDimensionsForPreflight(old); });
    const heldImage = f.images[1];
    expect(heldImage.onload).toBeTypeOf("function");
    try {
      act(() => f.view.result.current.setDraftMedia(new File(["B"], "B.png", { type: "image/png" })));
      await act(async () => { heldImage.onload?.(); await operation; });
      expect(f.view.result.current.mediaDimensions).toBe(null);
    } finally { heldImage.onload?.(); await act(async () => operation); f.view.unmount(); expect(f.revoke).toHaveBeenCalledTimes(f.urls.length); }
  });

  it("lets a crop supersede compression without stale completion changing crop progress", async () => {
    const f = await mediaHook(); const compression = deferred<File>(); const crop = deferred<File>();
    const conversion = await import("@/lib/compose/media-conversion");
    vi.spyOn(conversion, "compressImageMedia").mockReturnValue(compression.promise);
    vi.spyOn(conversion, "cropImageForDribbble").mockReturnValue(crop.promise);
    act(() => f.view.result.current.setDraftMedia(new File(["A"], "A.bmp", { type: "image/bmp" })));
    let first!: Promise<void>; let second!: Promise<void>;
    act(() => { first = f.view.result.current.compressSelectedMedia(["bluesky"]); });
    act(() => { second = f.view.result.current.cropSelectedMediaForDribbble(); });
    try {
      const progress = f.options.setProgress.mock.calls.length;
      await act(async () => { compression.resolve(new File(["stale"], "stale.jpg", { type: "image/jpeg" })); await first; });
      expect(f.view.result.current.isCroppingMedia).toBe(true);
      expect(f.view.result.current.isCompressingMedia).toBe(false);
      expect(f.options.setProgress).toHaveBeenCalledTimes(progress);
      await act(async () => { crop.resolve(new File(["crop"], "crop.jpg", { type: "image/jpeg" })); await second; });
      expect(f.view.result.current.mediaFile?.name).toBe("crop.jpg");
      expect(f.view.result.current.mediaDimensions).toEqual({ width: 800, height: 600 });
    } finally {
      compression.resolve(new File(["old"], "old.jpg")); crop.resolve(new File(["new"], "new.jpg"));
      await act(async () => { await Promise.allSettled([first, second]); }); f.view.unmount(); expect(f.revoke).toHaveBeenCalledTimes(f.urls.length);
    }
  });
});
