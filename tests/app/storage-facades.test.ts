import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { ReadStream } from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { composeDraft, imageFile, scheduledPost } from "./support/fixtures";
import { createDataRoot, useDataRoot } from "./support/sandbox";

const history = { id: "history", createdAt: "2026-01-15T12:00:00.000Z", text: "posted", platforms: ["bluesky" as const], results: [{ platform: "bluesky" as const, ok: true, message: "sent" }] };
const missingId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.png";

describe("configuration facade disk behavior", () => {
  it("defaults missing, corrupt and unreadable files without rewriting them", async () => {
    const config = await import("@/lib/local-config");
    expect(config.readLocalConfig().values).toEqual({});
    expect(existsSync(config.localConfigPath)).toBe(false);
    writeFileSync(config.localConfigPath, "{broken");
    expect(config.readLocalConfig().publishedPosts).toEqual([]);
    expect(readFileSync(config.localConfigPath, "utf8")).toBe("{broken");
    await fs.unlink(config.localConfigPath);
    mkdirSync(config.localConfigPath);
    expect(config.readLocalConfig().values).toEqual({});
    expect(() => config.writeLocalConfig(config.readLocalConfig())).toThrow();
  });

  it("does not create a missing data root and propagates write failures", async () => {
    const root = useDataRoot(path.join(createDataRoot(), "absent"));
    const config = await import("@/lib/local-config");
    expect(config.readLocalConfig().values).toEqual({});
    expect(() => config.writeLocalConfig(config.readLocalConfig())).toThrow("ENOENT");
    expect(existsSync(root)).toBe(false);
  });

  it("preserves unrelated known sections while appending history and updating/removing schedules", async () => {
    const config = await import("@/lib/local-config");
    const initial = config.writeLocalConfig({
      ...config.readLocalConfig(), values: { BLUESKY_IDENTIFIER: "local" }, profiles: { bluesky: [{ id: "p", label: "Profile", values: { BLUESKY_IDENTIFIER: "profile" } }] },
      activeProfiles: { bluesky: "p" }, draft: composeDraft(), scheduledPosts: [scheduledPost()]
    });
    expect(config.appendPublishedPost(history)).toMatchObject(history);
    config.appendPublishedPost({ ...history, id: "latest" });
    config.upsertScheduledPost(scheduledPost({ text: "changed" }));
    config.upsertScheduledPost(scheduledPost({ id: "second", text: "second" }));
    expect(config.getScheduledPosts().map(post => post.id)).toEqual(["second", "fixture-schedule"]);
    expect(config.updateScheduledPost("fixture-schedule", post => ({ ...post, attempts: 2, status: "failed" }))).toMatchObject({ text: "changed", attempts: 2, status: "failed" });
    expect(config.updateScheduledPost("missing", () => { throw new Error("must not run"); })).toBeUndefined();
    expect(config.removeScheduledPost("second").map(post => post.id)).toEqual(["fixture-schedule"]);
    expect(config.readLocalConfig()).toMatchObject({
      values: initial.values, profiles: initial.profiles, activeProfiles: initial.activeProfiles, draft: initial.draft,
      publishedPosts: [{ id: "latest" }, { id: "history" }], scheduledPosts: [{ id: "fixture-schedule", attempts: 2 }]
    });
    expect(readFileSync(config.localConfigPath, "utf8")).toBe(`${JSON.stringify(config.readLocalConfig(), null, 2)}\n`);
  });

  it("does not persist failed update callbacks and retains invalid-upsert fallback", async () => {
    const config = await import("@/lib/local-config");
    config.upsertScheduledPost(scheduledPost());
    const before = readFileSync(config.localConfigPath, "utf8");
    expect(() => config.updateScheduledPost("fixture-schedule", () => { throw new Error("callback failure"); })).toThrow("callback failure");
    expect(readFileSync(config.localConfigPath, "utf8")).toBe(before);
    const invalid = scheduledPost({ id: "invalid", text: "", platforms: ["pinterest"], title: "title" });
    expect(config.upsertScheduledPost(invalid)).toEqual(invalid);
    expect(config.getScheduledPosts().map(post => post.id)).toEqual(["fixture-schedule"]);
  });

  it("uses data-root precedence and captures the configured root at facade import", async () => {
    const root = useDataRoot();
    vi.stubEnv("CROSSPOSTER_APP_ROOT", createDataRoot());
    const config = await import("@/lib/local-config");
    expect(config.localConfigPath).toBe(path.join(root, "poster.config.local.json"));
    vi.stubEnv("CROSSPOSTER_DATA_DIR", createDataRoot());
    config.writeLocalConfig({ ...config.readLocalConfig(), values: { BLUESKY_IDENTIFIER: "captured" } });
    expect(config.readLocalConfig().values.BLUESKY_IDENTIFIER).toBe("captured");
    expect(existsSync(path.join(root, "poster.config.local.json"))).toBe(true);
  });
});

describe("media facade disk behavior", () => {
  it("writes existing metadata, recomputes paths/types/sizes, and opens the original bytes", async () => {
    const root = useDataRoot();
    const media = await import("@/lib/media-store");
    const saved = await media.saveUploadedMedia(imageFile(), "https://fixture.test/base");
    const metadataPath = `${saved.path}.json`;
    const metadata = JSON.parse(await fs.readFile(metadataPath, "utf8"));
    expect(metadata).toEqual({ id: saved.id, filename: "fixture.png", contentType: "image/png", size: saved.size, kind: "image", path: path.join(root, ".poster-uploads", saved.id), width: 1, height: 1 });
    await fs.writeFile(saved.path, "changed");
    await fs.writeFile(metadataPath, JSON.stringify({ ...metadata, path: "/ignored/legacy/path", contentType: "application/octet-stream", kind: "file", size: 999 }));
    expect(await media.getUploadedMedia(saved.id, "https://other.test/a")).toMatchObject({ path: saved.path, size: 7, contentType: "image/png", kind: "image", url: `https://other.test/api/media/${saved.id}` });
    const opened = await media.openUploadedMedia(saved.id, "http://localhost");
    const stream: ReadStream = opened.stream;
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks).toString()).toBe("changed");
  });

  it("keeps missing/corrupt media errors and invalid-ID deletion behavior", async () => {
    const media = await import("@/lib/media-store");
    await expect(media.getUploadedMedia(missingId)).rejects.toThrow("ENOENT");
    await expect(media.getUploadedMedia("../bad")).rejects.toThrow("Invalid media id");
    expect(await media.deleteUploadedMedia("../bad")).toBe(false);
    expect(await media.deleteUploadedMedia(missingId)).toBe(false);
    expect(await media.deleteAllUploadedMedia()).toBe(0);
    expect(await media.getUploadedMediaStorageStats()).toMatchObject({ files: 0, bytes: 0 });
    const saved = await media.saveUploadedMedia(imageFile(), "http://localhost");
    await fs.writeFile(`${saved.path}.json`, "{broken");
    await expect(media.getUploadedMedia(saved.id)).rejects.toBeInstanceOf(SyntaxError);
    await fs.writeFile(`${saved.path}.json`, JSON.stringify({ id: "../bad" }));
    await expect(media.getUploadedMedia(saved.id)).rejects.toThrow("Invalid media id");
  });

  it("deletes partial pairs and reports whether either unlink succeeded", async () => {
    const media = await import("@/lib/media-store");
    const first = await media.saveUploadedMedia(imageFile(), "http://localhost");
    await fs.unlink(first.path);
    expect(await media.deleteUploadedMedia(first.id)).toBe(true);
    const second = await media.saveUploadedMedia(imageFile(), "http://localhost");
    await fs.unlink(`${second.path}.json`);
    expect(await media.deleteUploadedMedia(second.id)).toBe(true);
    expect(await media.deleteUploadedMedia(second.id)).toBe(false);
  });

  it("counts metadata and nested files in stats but top-level entries in delete-all", async () => {
    const root = useDataRoot();
    const media = await import("@/lib/media-store");
    const saved = await media.saveUploadedMedia(imageFile(), "http://localhost");
    const directory = path.join(root, ".poster-uploads");
    await fs.mkdir(path.join(directory, "nested"));
    await fs.writeFile(path.join(directory, "nested", "leftover"), "abc");
    const metadataSize = (await fs.stat(`${saved.path}.json`)).size;
    expect(await media.getUploadedMediaStorageStats()).toEqual({ path: directory, files: 3, bytes: saved.size + metadataSize + 3 });
    expect(await media.deleteAllUploadedMedia()).toBe(3);
    expect(await fs.readdir(directory)).toEqual([]);
  });

  it("retains best-effort image dimensions and non-atomic upload failure behavior", async () => {
    const media = await import("@/lib/media-store");
    const invalidImage = await media.saveUploadedMedia(new File(["invalid"], "fake.png", { type: "image/png" }), "http://localhost");
    expect(invalidImage).not.toHaveProperty("width");
    await media.deleteAllUploadedMedia();
    vi.spyOn(fs, "writeFile").mockRejectedValueOnce(new Error("metadata write failed"));
    await expect(media.saveUploadedMedia(imageFile(), "http://localhost")).rejects.toThrow("metadata write failed");
    expect((await media.getUploadedMediaStorageStats()).files).toBe(1);
  });

  it("rejects empty and oversized uploads before creating the media directory", async () => {
    const media = await import("@/lib/media-store");
    await expect(media.saveUploadedMedia(new File([], "empty"), "http://localhost")).rejects.toThrow("Choose a non-empty media file");
    const file = new File(["x"], "huge.mp4");
    Object.defineProperty(file, "size", { value: Number.MAX_SAFE_INTEGER });
    await expect(media.saveUploadedMedia(file, "http://localhost")).rejects.toThrow("Media file is larger than");
    expect((await media.getUploadedMediaStorageStats()).files).toBe(0);
  });
});
