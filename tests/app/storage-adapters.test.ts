import { readFileSync, writeFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { composeDraft, imageFile, scheduledPost } from "./support/fixtures";
import { createDataRoot } from "./support/sandbox";
import { memoryConfigStorage, memoryMediaStorage } from "./support/storage";

const now = "2026-01-15T12:00:00.000Z";
const history = { id: "posted", createdAt: now, text: "post", platforms: ["bluesky" as const], results: [{ platform: "bluesky" as const, ok: true, message: "sent" }] };
const missingId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.png";

async function configFixture(kind: string, root = createDataRoot()) {
  const { createLocalConfigStore } = await import("@/lib/storage/config-store");
  const { createJsonConfigStorage } = await import("@/lib/storage/json-storage");
  const storage = createJsonConfigStorage(root);
  const io = kind === "memory" ? memoryConfigStorage(root) : {
    storage, readRaw: () => readFileSync(storage.path, "utf8"), writeRaw: (raw: string) => writeFileSync(storage.path, raw)
  };
  const environment: Record<string, string | undefined> = {};
  const defaults = { createId: () => "generated", now: () => now };
  const store = createLocalConfigStore(io.storage, defaults, name => environment[name]);
  return { ...io, store, environment, defaults };
}

async function mediaFixture(kind: string, root = createDataRoot()) {
  const { createMediaStore } = await import("@/lib/storage/media-service");
  const { createMediaStorage } = await import("@/lib/storage/media-storage");
  const io = kind === "memory" ? memoryMediaStorage(root) : {
    storage: createMediaStorage(root), readRaw: (name: string) => fs.readFile(name, "utf8"),
    writeRaw: (name: string, value: string) => fs.writeFile(name, value), removeRaw: (name: string) => fs.unlink(name)
  };
  return { ...io, store: createMediaStore(io.storage) };
}

describe.each(["memory", "filesystem"])("%s configuration storage contract", (kind) => {
  it("returns defaults for absent/corrupt data without rewriting it", async () => {
    const { store, storage, writeRaw, readRaw } = await configFixture(kind);
    expect(store.readLocalConfig()).toMatchObject({ values: {}, profiles: {}, publishedPosts: [], scheduledPosts: [] });
    expect(storage.exists()).toBe(false);
    writeRaw("{broken");
    expect(store.readLocalConfig().values).toEqual({});
    expect(readRaw()).toBe("{broken");
  });

  it("reads legacy config and writes the same normalized single-file JSON", async () => {
    const { store, storage, writeRaw, readRaw } = await configFixture(kind);
    writeRaw(JSON.stringify({ BLUESKY_IDENTIFIER: " legacy ", values: { POSTER_LOCAL_PORT: " 3000 " }, unknown: "drop" }));
    expect(store.readLocalConfig().values).toEqual({ BLUESKY_IDENTIFIER: "legacy", POSTER_LOCAL_PORT: "3000" });
    const saved = store.writeLocalConfig({ ...store.readLocalConfig(), draft: composeDraft() });
    expect(readRaw()).toBe(`${JSON.stringify(saved, null, 2)}\n`);
    expect(storage.read()).toEqual(saved);
    expect(store.readLocalConfig()).toEqual(saved);
  });

  it("keeps profile/local/environment/default precedence and explicit-profile exclusions", async () => {
    const { store, environment } = await configFixture(kind);
    environment.BLUESKY_IDENTIFIER = "environment";
    environment.POSTER_LOCAL_PORT = "4321";
    environment.X_PREMIUM_LONG_POSTS = "true";
    expect(store.getConfigValue("POSTER_LOCAL_PORT")).toBe("4321");
    expect(store.getConfigValue("X_PREMIUM_LONG_POSTS", "missing")).toBe("false");
    expect(store.getConfigValue("BLUESKY_IDENTIFIER")).toBe("environment");
    store.writeLocalConfig({ ...store.readLocalConfig(), values: { BLUESKY_IDENTIFIER: "local" }, profiles: { bluesky: [
      { id: "selected", label: "Selected", values: { BLUESKY_IDENTIFIER: "profile" } }, { id: "empty", label: "Empty", values: {} }
    ] }, activeProfiles: { bluesky: "selected" } });
    expect(store.getConfigValue("BLUESKY_IDENTIFIER")).toBe("profile");
    expect(store.getConfigValue("BLUESKY_IDENTIFIER", "empty")).toBeUndefined();
    expect(store.getConfigValue("BLUESKY_IDENTIFIER", "missing")).toBeUndefined();
    store.writeLocalConfig({ ...store.readLocalConfig(), activeProfiles: { bluesky: "empty" } });
    expect(store.getConfigValue("BLUESKY_IDENTIFIER")).toBe("local");
    expect(store.getProfileConfigIssues("bluesky", "missing")).toMatchObject([{ field: "profile", kind: "missing" }]);
  });

  it("preserves configuration/draft/history while updating, removing and reloading schedules", async () => {
    const { store } = await configFixture(kind);
    const initial = store.writeLocalConfig({ ...store.readLocalConfig(), values: { BLUESKY_IDENTIFIER: "local" }, draft: composeDraft(), profiles: { x: [{ id: "p", label: "Profile", values: {} }] }, activeProfiles: { x: "p" } });
    store.appendPublishedPost(history);
    store.appendPublishedPost({ ...history, id: "latest" });
    store.upsertScheduledPost(scheduledPost());
    store.upsertScheduledPost(scheduledPost({ text: "changed" }));
    store.upsertScheduledPost(scheduledPost({ id: "second" }));
    expect(store.getScheduledPosts().map(post => post.id)).toEqual(["second", "fixture-schedule"]);
    expect(store.updateScheduledPost("fixture-schedule", post => ({ ...post, attempts: 3, status: "publishing" }))).toMatchObject({ text: "changed", attempts: 3, status: "publishing" });
    expect(store.updateScheduledPost("missing", () => { throw new Error("must not execute"); })).toBeUndefined();
    store.removeScheduledPost("second");
    expect(store.readLocalConfig()).toMatchObject({ values: initial.values, profiles: initial.profiles, activeProfiles: initial.activeProfiles, draft: initial.draft, publishedPosts: [{ id: "latest" }, { id: "posted" }], scheduledPosts: [{ id: "fixture-schedule", status: "publishing" }] });
  });

  it("swallows read failures, propagates exists/write errors and avoids missing-update writes", async () => {
    const { store, storage } = await configFixture(kind);
    store.writeLocalConfig(store.readLocalConfig());
    vi.spyOn(storage, "read").mockImplementationOnce(() => { throw new Error("read failed"); });
    expect(store.readLocalConfig().values).toEqual({});
    const readFailure = vi.spyOn(storage, "exists").mockImplementationOnce(() => { throw new Error("exists failed"); });
    expect(() => store.readLocalConfig()).toThrow("exists failed");
    readFailure.mockRestore();
    const write = vi.spyOn(storage, "write").mockImplementation(() => { throw new Error("write failed"); });
    expect(store.updateScheduledPost("missing", post => post)).toBeUndefined();
    expect(write).not.toHaveBeenCalled();
    expect(() => store.writeLocalConfig(store.readLocalConfig())).toThrow("write failed");
  });

  it("catches normalization errors while reading and propagates them while writing", async () => {
    const { store, defaults, writeRaw } = await configFixture(kind);
    writeRaw(JSON.stringify({ profiles: { x: [{}] } }));
    vi.spyOn(defaults, "createId").mockImplementation(() => { throw new Error("ID generation failed"); });
    expect(store.readLocalConfig().profiles).toEqual({});
    expect(() => store.writeLocalConfig({ ...store.readLocalConfig(), profiles: { x: [{ id: "", label: "Profile", values: {} }] } })).toThrow("ID generation failed");
  });

  it("keeps explicit roots independent from each other and ambient environment", async () => {
    const first = await configFixture(kind);
    const second = await configFixture(kind);
    vi.stubEnv("CROSSPOSTER_DATA_DIR", createDataRoot());
    first.store.writeLocalConfig({ ...first.store.readLocalConfig(), values: { BLUESKY_IDENTIFIER: "first" } });
    expect(second.store.readLocalConfig().values).toEqual({});
    expect(first.storage.path).not.toBe(second.storage.path);
    expect(first.store.readLocalConfig().values.BLUESKY_IDENTIFIER).toBe("first");
  });
});

describe.each(["memory", "filesystem"])("%s media storage contract", (kind) => {
  it("has empty stats/deletion results and preserves lookup errors before first upload", async () => {
    const { store } = await mediaFixture(kind);
    expect(await store.getUploadedMediaStorageStats()).toMatchObject({ files: 0, bytes: 0 });
    expect(await store.deleteAllUploadedMedia()).toBe(0);
    expect(await store.deleteUploadedMedia(missingId)).toBe(false);
    expect(await store.deleteUploadedMedia("../bad")).toBe(false);
    await expect(store.getUploadedMedia(missingId)).rejects.toThrow("ENOENT");
    await expect(store.getUploadedMedia("../bad")).rejects.toThrow("Invalid media id");
  });

  it("saves bytes/metadata and reloads/opens media with the caller's origin", async () => {
    const { store, readRaw } = await mediaFixture(kind);
    const file = imageFile();
    const saved = await store.saveUploadedMedia(file, "https://fixture.test/a");
    const metadata = JSON.parse(await readRaw(`${saved.path}.json`));
    expect(metadata).toEqual({ id: saved.id, filename: "fixture.png", contentType: "image/png", size: file.size, kind: "image", path: saved.path, width: 1, height: 1 });
    const loaded = await store.getUploadedMedia(saved.id, "https://other.test/b");
    expect(loaded).toEqual({ ...saved, url: `https://other.test/api/media/${saved.id}` });
    const { stream } = await store.openUploadedMedia(saved.id, "http://localhost");
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks)).toEqual(Buffer.from(await file.arrayBuffer()));
    expect(await store.getUploadedMediaStorageStats()).toEqual({ path: path.dirname(saved.path), files: 2, bytes: file.size + Buffer.byteLength(await readRaw(`${saved.path}.json`)) });
  });

  it("retains malformed metadata errors and uses metadata ID plus actual file size", async () => {
    const { store, writeRaw } = await mediaFixture(kind);
    const first = await store.saveUploadedMedia(imageFile(), "http://localhost");
    const second = await store.saveUploadedMedia(new File(["bytes"], "video.mp4"), "http://localhost");
    await writeRaw(`${first.path}.json`, "{broken");
    await expect(store.getUploadedMedia(first.id)).rejects.toBeInstanceOf(SyntaxError);
    await writeRaw(`${first.path}.json`, JSON.stringify({ id: "../bad" }));
    await expect(store.getUploadedMedia(first.id)).rejects.toThrow("Invalid media id");
    await writeRaw(`${first.path}.json`, JSON.stringify({ ...first, id: second.id, path: "/ignored", size: 999, filename: "fallback.mp4", contentType: "application/octet-stream" }));
    expect(await store.getUploadedMedia(first.id)).toMatchObject({ id: second.id, path: second.path, size: 5, filename: "fallback.mp4", contentType: "video/mp4", kind: "video", url: `http://localhost/api/media/${second.id}` });
  });

  it("deletes complete/partial pairs and counts files when deleting all", async () => {
    const { store, removeRaw } = await mediaFixture(kind);
    const first = await store.saveUploadedMedia(imageFile(), "http://localhost");
    expect(await store.deleteUploadedMedia(first.id)).toBe(true);
    expect(await store.deleteUploadedMedia(first.id)).toBe(false);
    const second = await store.saveUploadedMedia(imageFile(), "http://localhost");
    await removeRaw(second.path);
    await expect(store.getUploadedMedia(second.id)).rejects.toThrow("ENOENT");
    expect(await store.deleteUploadedMedia(second.id)).toBe(true);
    const third = await store.saveUploadedMedia(imageFile(), "http://localhost");
    await removeRaw(`${third.path}.json`);
    expect(await store.deleteUploadedMedia(third.id)).toBe(true);
    await store.saveUploadedMedia(imageFile(), "http://localhost");
    await store.saveUploadedMedia(imageFile(), "http://localhost");
    expect(await store.deleteAllUploadedMedia()).toBe(4);
    expect(await store.getUploadedMediaStorageStats()).toMatchObject({ files: 0, bytes: 0 });
  });

  it("swallows image-inspection errors but propagates metadata failure leaving written bytes", async () => {
    const { store, storage } = await mediaFixture(kind);
    vi.spyOn(storage, "readFile").mockRejectedValueOnce(new Error("image read failed"));
    const saved = await store.saveUploadedMedia(imageFile(), "http://localhost");
    expect(saved).not.toHaveProperty("width");
    await store.deleteAllUploadedMedia();
    vi.spyOn(storage, "writeMetadata").mockRejectedValueOnce(new Error("metadata write failed"));
    await expect(store.saveUploadedMedia(imageFile(), "http://localhost")).rejects.toThrow("metadata write failed");
    expect(await store.getUploadedMediaStorageStats()).toMatchObject({ files: 1 });
  });

  it("rejects invalid uploads before IO and propagates directory/upload/lookup failures", async () => {
    const { store, storage } = await mediaFixture(kind);
    const prepare = vi.spyOn(storage, "prepare");
    await expect(store.saveUploadedMedia(new File([], "empty"), "http://localhost")).rejects.toThrow("Choose a non-empty media file");
    expect(prepare).not.toHaveBeenCalled();
    prepare.mockRejectedValueOnce(new Error("prepare failed"));
    await expect(store.saveUploadedMedia(imageFile(), "http://localhost")).rejects.toThrow("prepare failed");
    vi.spyOn(storage, "writeFile").mockRejectedValueOnce(new Error("upload failed"));
    await expect(store.saveUploadedMedia(imageFile(), "http://localhost")).rejects.toThrow("upload failed");
    vi.spyOn(storage, "read").mockRejectedValueOnce(new Error("lookup failed"));
    await expect(store.getUploadedMedia(missingId)).rejects.toThrow("lookup failed");
  });
});

describe("filesystem adapter failure surfaces", () => {
  it("keeps media listing/stat/unlink failures best-effort", async () => {
    const { createMediaStorage } = await import("@/lib/storage/media-storage");
    const storage = createMediaStorage(createDataRoot());
    vi.spyOn(fs, "readdir").mockRejectedValue(new Error("listing denied"));
    expect(await storage.deleteAll()).toBe(0);
    expect(await storage.stats()).toMatchObject({ files: 0, bytes: 0 });
    vi.spyOn(fs, "unlink").mockRejectedValue(new Error("unlink denied"));
    expect(await storage.delete(missingId)).toBe(false);
  });

  it("ignores unstatable files in stats and propagates recursive deletion failures", async () => {
    const { store, storage } = await mediaFixture("filesystem");
    await store.saveUploadedMedia(imageFile(), "http://localhost");
    vi.spyOn(fs, "stat").mockRejectedValue(new Error("stat denied"));
    expect(await storage.stats()).toMatchObject({ files: 0, bytes: 0 });
    vi.spyOn(fs, "rm").mockRejectedValue(new Error("remove denied"));
    await expect(storage.deleteAll()).rejects.toThrow("remove denied");
  });

  it("retains cwd fallback when CROSSPOSTER_DATA_DIR is absent", async () => {
    const { dataRoot } = await import("@/lib/runtime-paths");
    const root = createDataRoot();
    vi.stubEnv("CROSSPOSTER_DATA_DIR", undefined);
    vi.stubEnv("CROSSPOSTER_APP_ROOT", "ignored-for-data");
    vi.spyOn(process, "cwd").mockReturnValue(root);
    expect(dataRoot()).toBe(root);
  });
});
