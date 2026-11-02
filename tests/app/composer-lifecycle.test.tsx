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

  it("keeps legacy browser recovery when IndexedDB reading fails", async () => {
    const fixture = await draftHook();
    localStorage.setItem("crossposter:compose-draft:v1", JSON.stringify({ ...empty, text: "Browser recovery" }));
    vi.mocked(fixture.composeClient.readDraft).mockResolvedValue({ draft: { ...empty, text: "Server" } });
    vi.mocked(fixture.storage.readStoredDraftMedia).mockRejectedValue(new Error("Fixture IndexedDB read failed"));
    const view = fixture.mount();
    await waitFor(() => expect(view.result.current.draftHydrated).toBe(true));
    expect(view.result.current.text).toBe("Browser recovery");
    expect(view.result.current.loadError).toBe("Fixture IndexedDB read failed");
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
      act(() => view.result.current.setText("Keep this edit"));
      await act(async () => { await vi.advanceTimersByTimeAsync(250); });
      expect(f.composeClient.saveDraft).toHaveBeenCalledTimes(1);
      expect(view.result.current.text).toBe("Keep this edit");
      expect(localStorage.getItem("crossposter:compose-draft:v1")).toContain("Keep this edit");
    } finally { held.resolve(new Response("{}")); await act(async () => held.promise); view.unmount(); expect(vi.getTimerCount()).toBe(0); }
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

  it("retains the existing completion order when conversion overlaps a newer media selection", async () => {
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
      expect(view.result.current.mediaFile?.name).toBe("older-compressed.jpg");
    } finally {
      held.resolve(new File(["converted"], "older-compressed.jpg", { type: "image/jpeg" }));
      await act(async () => operation);
      view.unmount();
    }
  });
});
