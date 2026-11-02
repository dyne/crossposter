import "server-only";
import { createHash } from "node:crypto";
import { createReadStream, lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod-control";
import { platformSchema, timestampSchema } from "./contracts";
import { ControlError } from "./errors";
import { mediaFilePath } from "@/lib/storage/media-path";
import { resolveContentType, mediaKind } from "@/lib/storage/media-service";
import { configFields } from "@/lib/config-spec";
import { maxJsonStorageBytes } from "@/lib/storage/json-limits";
import { payloadDigest } from "./canonical";
import { imageSize } from "image-size";

const storedTarget = z.object({ id: z.string().max(180), platform: platformSchema,
  profileId: z.string().max(120).optional(), profileLabel: z.string().max(180).optional() });
const storedMedia = z.object({ id: z.string().min(1).max(80) });
const storedContent = {
  title: z.string().max(300).optional(), text: z.string().max(100_000).optional(),
  linkUrl: z.string().max(2048).optional(), url: z.string().max(2048).optional(),
  platforms: z.array(platformSchema).max(30).optional(), targets: z.array(storedTarget).max(30).optional(),
  media: storedMedia.optional()
};
const storedResult = z.object({ platform: platformSchema, targetId: z.string().max(180).optional(),
  profileId: z.string().max(120).optional(), profileLabel: z.string().max(180).optional(),
  ok: z.boolean(), uncertain: z.boolean().optional(), message: z.string().optional(), url: z.string().optional() });
const retainedPost = z.object({ ...storedContent, id: z.string().min(1).max(180),
  createdAt: timestampSchema, results: z.array(storedResult).min(1).max(30) });
const queuedPost = z.object({ ...storedContent, id: z.string().min(1).max(180),
  createdAt: timestampSchema, updatedAt: timestampSchema, scheduledFor: timestampSchema,
  status: z.enum(["scheduled", "publishing", "published", "failed", "canceled"]),
  attempts: z.number().int().nonnegative(), results: z.array(storedResult).max(30).optional(),
  publishedPostId: z.string().min(1).max(180).optional() });
const profile = z.object({ id: z.string().min(1).max(120), label: z.string().min(1).max(180),
  values: z.record(z.string(), z.string()) });
const configSchema = z.object({
  values: z.record(z.string(), z.string()).default({}),
  profiles: z.partialRecord(platformSchema, z.array(profile)).default({}),
  activeProfiles: z.partialRecord(platformSchema, z.string()).default({}),
  draft: z.object({ ...storedContent, updatedAt: timestampSchema.optional() }).default({}),
  publishedPosts: z.array(retainedPost).default([]), scheduledPosts: z.array(queuedPost).default([])
}).passthrough();
export type ControlReadConfig = z.infer<typeof configSchema>;
export type RetainedPost = z.infer<typeof retainedPost>;
export type QueuedPost = z.infer<typeof queuedPost>;

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
function parseJson(source: string): unknown {
  try { return JSON.parse(source); } catch { throw new ControlError("storage_corrupt"); }
}
export function readControlConfig(root: string, maxBytes = maxJsonStorageBytes): ControlReadConfig {
  let raw: unknown;
  try {
    const filename = path.join(root, "poster.config.local.json");
    const stat = lstatSync(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) throw new ControlError("storage_corrupt");
    let source: string;
    try { source = readFileSync(filename, "utf8"); }
    catch { throw new ControlError("storage_unavailable"); }
    if (Buffer.byteLength(source, "utf8") > maxBytes) throw new ControlError("storage_corrupt");
    raw = parseJson(source);
  } catch (error) {
    if (isMissing(error)) raw = {};
    else throw error instanceof ControlError ? error : new ControlError("storage_unavailable");
  }
  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) throw new ControlError("storage_corrupt");
  const config = parsed.data;
  // Older files put recognized settings at the root. Their invalid types must
  // not silently disappear into an apparently empty configuration either.
  if (configFields.some((field) => Object.hasOwn(config, field.name) && typeof config[field.name] !== "string")) {
    throw new ControlError("storage_corrupt");
  }
  const ids = [config.publishedPosts.map((post) => post.id), config.scheduledPosts.map((post) => post.id),
    ...Object.values(config.profiles).map((profiles) => profiles.map((item) => item.id))];
  if (ids.some((values) => new Set(values).size !== values.length)) throw new ControlError("storage_corrupt");
  return config;
}

const metadataSchema = z.object({ id: z.string(), filename: z.string().min(1).max(240),
  contentType: z.string().max(160), size: z.number().int().nonnegative(),
  kind: z.enum(["image", "video", "audio", "file"]),
  digest: z.string().optional() });

export function controlMediaRevision(root: string, id: string, allowMissing = false): string {
  let filename: string;
  try { filename = mediaFilePath(path.join(root, ".poster-uploads"), id); }
  catch { throw new ControlError("media_missing"); }
  try {
    const directory = lstatSync(path.dirname(filename));
    if (!directory.isDirectory() || directory.isSymbolicLink()) throw new ControlError("storage_corrupt");
    const versions = [filename, `${filename}.json`].map((name) => {
      try {
        const stat = lstatSync(name, { bigint: true });
        if (!stat.isFile() || stat.isSymbolicLink()) throw new ControlError("storage_corrupt");
        return [String(stat.dev), String(stat.ino), String(stat.size), String(stat.mtimeNs), String(stat.ctimeNs)];
      } catch (error) {
        if (allowMissing && isMissing(error)) return null;
        throw error;
      }
    });
    return payloadDigest(versions);
  } catch (error) {
    if (allowMissing && isMissing(error)) return payloadDigest({ directory: "missing" });
    throw error instanceof ControlError ? error : new ControlError(isMissing(error) ? "media_missing" : "storage_unavailable");
  }
}
export async function readControlMedia(root: string, id: string) {
  let filename: string;
  try { filename = mediaFilePath(path.join(root, ".poster-uploads"), id); }
  catch { throw new ControlError("media_missing"); }
  try {
    const directory = lstatSync(path.dirname(filename));
    if (!directory.isDirectory() || directory.isSymbolicLink()) throw new ControlError("storage_corrupt");
    const metadataFile = `${filename}.json`;
    const metadataStat = lstatSync(metadataFile);
    const before = lstatSync(filename);
    if (!metadataStat.isFile() || metadataStat.isSymbolicLink() || metadataStat.size > 16384
      || !before.isFile() || before.isSymbolicLink()) throw new ControlError("storage_corrupt");
    const parsed = metadataSchema.safeParse(parseJson(readFileSync(metadataFile, "utf8")));
    if (!parsed.success || parsed.data.id !== id || parsed.data.size !== before.size) throw new ControlError("storage_corrupt");
    const metadata = parsed.data;
    const hash = createHash("sha256");
    const header: Buffer[] = []; let headerBytes = 0;
    for await (const chunk of createReadStream(filename)) {
      hash.update(chunk);
      if (headerBytes < 1024 * 1024) { const bytes = Buffer.from(chunk).subarray(0, 1024 * 1024 - headerBytes); header.push(bytes); headerBytes += bytes.length; }
    }
    const after = lstatSync(filename);
    if (after.ino !== before.ino || after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw new ControlError("storage_unavailable");
    const digest = `sha256:${hash.digest("hex")}`;
    if (metadata.digest !== undefined && metadata.digest !== digest) throw new ControlError("storage_corrupt");
    const contentType = resolveContentType(metadata.filename, metadata.contentType);
    if (!/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i.test(contentType)) throw new ControlError("storage_corrupt");
    // Metadata's path/url are intentionally never authoritative or returned.
    let dimensions: { width: number; height: number } | undefined;
    if (mediaKind(contentType) === "image") { try { const size = imageSize(Buffer.concat(header)); dimensions = { width: size.width, height: size.height }; } catch { /* preparation rejects unverifiable required dimensions */ } }
    return { id, filename: path.basename(metadata.filename.replaceAll("\\", "/")),
      contentType, size: before.size, kind: mediaKind(contentType), digest, url: `/api/media/${id}`, dimensions };
  } catch (error) {
    if (error instanceof ControlError) throw error;
    throw new ControlError(isMissing(error) ? "media_missing" : "storage_unavailable");
  }
}
