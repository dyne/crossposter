// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PublishedMedia } from "@/lib/types";

// These browser seams must remain independent of server configuration/IO.
vi.mock("@/lib/local-config", () => { throw new Error("Server configuration imported by composer"); });
afterEach(() => localStorage.clear());

describe("compatible browser draft data", () => {
  it("migrates legacy storage keys, normalizes target IDs and preserves timestamps", async () => {
    const { readStoredDraft, normalizeDraft, newestDraft, writeStoredDraft } = await import("@/lib/compose/draft-storage");
    localStorage.setItem("personal-crossposter:compose-draft:v1", JSON.stringify({
      title: "Fixture title", text: "Fixture text", url: "https://fixture.example", selected: ["bluesky", "unknown"],
      targets: [{ platform: "bluesky", profileId: "fixture", profileLabel: "Fixture" }, { platform: "unknown" }, null],
      updatedAt: "2026-01-01T00:00:00Z"
    }));
    const browser = readStoredDraft();
    expect(browser).toEqual({ title: "Fixture title", text: "Fixture text", linkUrl: "https://fixture.example", platforms: ["bluesky"], targets: [{ id: "bluesky:fixture", platform: "bluesky", profileId: "fixture", profileLabel: "Fixture" }], updatedAt: "2026-01-01T00:00:00Z" });
    expect(localStorage.getItem("crossposter:compose-draft:v1")).not.toBe(null);
    const normalized = normalizeDraft(browser);
    expect(newestDraft({ ...normalized, text: "Server wins ties" }, browser).text).toBe("Server wins ties");
    writeStoredDraft(normalized);
    expect(localStorage.getItem("personal-crossposter:compose-draft:v1")).toBe(null);
    expect(JSON.parse(localStorage.getItem("crossposter:compose-draft:v1")!)).toEqual(normalized);
  });

  it("retains malformed/absent storage recovery and target trimming limits", async () => {
    const { readStoredDraft, normalizeDraft, normalizePublishTargets, draftTimestamp } = await import("@/lib/compose/draft-storage");
    expect(readStoredDraft()).toBe(null);
    localStorage.setItem("crossposter:compose-draft:v1", "not-json");
    expect(readStoredDraft()).toBe(null);
    expect(normalizeDraft(null)).toEqual({ title: "", text: "", linkUrl: "", platforms: [], targets: [] });
    expect(draftTimestamp({ updatedAt: "invalid" })).toBe(0);
    const [target] = normalizePublishTargets([{ platform: "x", id: "i".repeat(200), profileId: "p".repeat(200), profileLabel: "l".repeat(200) }]);
    expect(target.id).toHaveLength(180);
    expect(target.profileId).toHaveLength(120);
    expect(target.profileLabel).toHaveLength(180);
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("Fixture storage disabled"); });
    expect(readStoredDraft()).toBe(null);
  });
});

describe("typed composer client", () => {
  it("retains operation-specific HTTP status behavior and publish/schedule request shapes", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: "Fixture failure" }), { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);
    const { composeClient } = await import("@/lib/compose/client");
    expect(await composeClient.readDraft()).toEqual({ error: "Fixture failure" });
    expect((await composeClient.saveDraft({ title: "", text: "Fixture", linkUrl: "", platforms: [] })).status).toBe(500);
    const controller = new AbortController();
    const payload = { text: "Fixture", platforms: ["bluesky" as const], targets: [{ id: "bluesky:fixture", platform: "bluesky" as const }] };
    expect(await composeClient.publish(payload, controller.signal)).toEqual({ ok: false, body: { error: "Fixture failure" } });
    await composeClient.schedule({ ...payload, scheduledFor: "2026-01-01T00:00:00Z" }, controller.signal);
    const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit]>;
    expect(calls[2][0]).toBe("/api/publish");
    expect(calls[2][1].signal).toBe(controller.signal);
    expect(JSON.parse(String(calls[2][1].body))).toEqual(payload);
    expect(JSON.parse(String(calls[3][1].body))).toEqual({ ...payload, scheduledFor: "2026-01-01T00:00:00Z" });
  });

  it("imports server-staged media through the current origin and keeps fallback errors nonfatal", async () => {
    const media: PublishedMedia = { id: "fixture", filename: "fixture.png", contentType: "image/png", kind: "image", size: 7, url: "http://0.0.0.0:3000/api/media/fixture?download=1" };
    const fetchMock = vi.fn(async () => new Response("fixture", { headers: { "content-type": "image/png" } }));
    vi.stubGlobal("fetch", fetchMock);
    const { fileFromDraftMedia } = await import("@/lib/compose/client");
    const file = await fileFromDraftMedia(media);
    expect(fetchMock).toHaveBeenCalledWith("/api/media/fixture?download=1", expect.objectContaining({ cache: "no-store" }));
    expect(file?.name).toBe("fixture.png");
    expect(file?.type).toBe("image/png");
    fetchMock.mockResolvedValueOnce(new Response("", { status: 404 }));
    expect(await fileFromDraftMedia(media)).toBe(null);
    fetchMock.mockRejectedValueOnce(new Error("Fixture offline"));
    expect(await fileFromDraftMedia(media)).toBe(null);
  });

  it("preserves validation error precedence and upload error text", async () => {
    const { composeClient, formatApiError } = await import("@/lib/compose/client");
    expect(formatApiError({ fieldErrors: { linkUrl: ["bad"], title: ["title error"] } })).toBe("Link is invalid. Use a URL like https://example.com, or leave Link empty.");
    expect(formatApiError({ fieldErrors: { title: ["A", "B"] } })).toBe("A B");
    expect(formatApiError({ formErrors: ["Fixture form"] })).toBe("Fixture form");
    expect(formatApiError(null)).toBe("Publish request is invalid. Check the fields and try again.");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "Fixture upload rejected" }), { status: 400 })));
    await expect(composeClient.upload(new File(["fixture"], "fixture.png"), new AbortController().signal)).rejects.toThrow("Fixture upload rejected");
  });
});
