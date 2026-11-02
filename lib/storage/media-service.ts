import "server-only";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { imageSize } from "image-size";
import { formatLimitBytes, storedMediaSizeLimit } from "@/lib/platform-limits";
import type { MediaStorage } from "./media-storage";
import type { MediaKind, UploadedMedia, StoredMedia } from "./media-types";

const maxMediaSize = storedMediaSizeLimit;
export class MediaUploadError extends Error {}
export type StreamMediaInput = {
  filename: string; contentType: string; size: number; stream: ReadableStream<Uint8Array>;
  maxBytes: number; timeoutMs: number; signal?: AbortSignal;
};

function cleanFilename(filename: string): string {
  const cleaned = filename.replace(/[^\w.\- ]+/g, "").trim();

  return cleaned || "upload";
}

function extensionFromFilename(filename: string): string {
  const extension = path.extname(filename).toLowerCase().replace(/[^a-z0-9.]/g, "");

  if (extension.length > 13) {
    return "";
  }

  return extension;
}

const extensionContentTypes: Record<string, string> = {
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".heic": "image/heic",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".wav": "audio/wav",
  ".aac": "audio/aac",
  ".ogg": "audio/ogg"
};

// Browsers and some upload clients send no MIME type (or a generic
// "application/octet-stream"), which would file a real video/image as a plain
// "file" and get it rejected by providers. Fall back to the filename extension.
export function resolveContentType(filename: string, contentType: string | undefined): string {
  const trimmed = (contentType || "").trim();

  if (trimmed && trimmed !== "application/octet-stream" && trimmed.includes("/")) {
    return trimmed;
  }

  return extensionContentTypes[extensionFromFilename(filename)] || trimmed || "application/octet-stream";
}

export function mediaKind(contentType: string): MediaKind {
  if (contentType.startsWith("image/")) {
    return "image";
  }

  if (contentType.startsWith("video/")) {
    return "video";
  }

  if (contentType.startsWith("audio/")) {
    return "audio";
  }

  return "file";
}

function mediaUrl(id: string, requestUrl: string): string {
  return new URL(`/api/media/${encodeURIComponent(id)}`, requestUrl).toString();
}

export function createMediaStore<Stream extends Readable>(storage: MediaStorage<Stream>, createId: () => string = randomUUID) {
  async function saveStreamedMedia(input: StreamMediaInput, requestUrl: string): Promise<UploadedMedia> {
    const filename = cleanFilename(input.filename);
    const contentType = resolveContentType(filename, input.contentType);
    const kind = mediaKind(contentType);
    if (!Number.isSafeInteger(input.size) || input.size <= 0 || input.size > Math.min(input.maxBytes, maxMediaSize)
      || kind === "file" || !/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i.test(contentType)
      || !Number.isSafeInteger(input.maxBytes) || input.maxBytes <= 0 || input.maxBytes > maxMediaSize
      || !Number.isSafeInteger(input.timeoutMs) || input.timeoutMs <= 0 || input.signal?.aborted) throw new MediaUploadError("Invalid media upload");
    if (!storage.beginStreamUpload) throw new Error("Streaming storage unavailable");
    const id = `${createId()}${extensionFromFilename(filename)}`;
    const controller = new AbortController();
    const abort = () => controller.abort();
    input.signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, input.timeoutMs);
    let upload: Awaited<ReturnType<NonNullable<MediaStorage["beginStreamUpload"]>>> | undefined;
    let source: Readable | undefined; let bounded: Transform | undefined;
    let feeding: Promise<void> | undefined; let writing: Promise<void> | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      upload = await storage.beginStreamUpload(id);
      if (controller.signal.aborted) throw new MediaUploadError("Interrupted media upload");
      const hash = createHash("sha256"); const header: Buffer[] = []; let headerBytes = 0; let size = 0;
      reader = input.stream.getReader();
      const incoming = reader;
      const body = new ReadableStream<Uint8Array>({
        async pull(target) {
          try { const next = await incoming.read(); if (next.done) target.close(); else target.enqueue(next.value); }
          catch { target.error(new MediaUploadError("Interrupted media upload")); }
        },
        cancel: (reason) => incoming.cancel(reason)
      });
      source = Readable.fromWeb(body as Parameters<typeof Readable.fromWeb>[0], { signal: controller.signal });
      bounded = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          size += chunk.length;
          if (size > input.size || size > input.maxBytes) { callback(new MediaUploadError("Media upload exceeds its bound")); return; }
          hash.update(chunk);
          if (headerBytes < 1024 * 1024) { const part = Buffer.from(chunk).subarray(0, 1024 * 1024 - headerBytes); header.push(part); headerBytes += part.length; }
          callback(null, chunk);
        },
        flush(callback) { callback(size === input.size ? null : new MediaUploadError("Incomplete media upload")); }
      });
      feeding = pipeline(source, bounded, { signal: controller.signal });
      writing = upload.write(bounded);
      await Promise.all([feeding, writing]);
      let dimensions: { width: number; height: number } | undefined;
      if (kind === "image") { try { const found = imageSize(Buffer.concat(header)); dimensions = { width: found.width, height: found.height }; } catch { /* required provider dimensions are checked at preparation */ } }
      const stored: StoredMedia = { id, filename, contentType, size, kind, path: upload.path,
        digest: `sha256:${hash.digest("hex")}`, ...(dimensions ?? {}) };
      if (controller.signal.aborted) throw new MediaUploadError("Interrupted media upload");
      await upload.commit(stored);
      if (controller.signal.aborted) throw new MediaUploadError("Interrupted media upload");
      return { ...stored, url: mediaUrl(id, requestUrl) };
    } catch (error) {
      source?.destroy(); bounded?.destroy();
      await Promise.allSettled([feeding, writing]);
      if (upload) await upload.discard();
      if (controller.signal.aborted) throw new MediaUploadError("Interrupted media upload");
      throw error;
    } finally {
      clearTimeout(timer); input.signal?.removeEventListener("abort", abort);
      if (reader) { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
    }
  }
  async function readImageDimensions(id: string, kind: MediaKind) {
    if (kind !== "image") {
      return {};
    }

    try {
      const dimensions = imageSize(await storage.readFile(id));
      const width = dimensions.width;
      const height = dimensions.height;

      if (!width || !height) {
        return {};
      }

      return { width, height };
    } catch {
      return {};
    }
  }

  async function saveUploadedMedia(file: File, requestUrl: string): Promise<UploadedMedia> {
    if (file.size <= 0) {
      throw new Error("Choose a non-empty media file");
    }

    if (file.size > maxMediaSize) {
      throw new Error(`Media file is larger than ${formatLimitBytes(maxMediaSize)}`);
    }

    await storage.prepare();

    const filename = cleanFilename(file.name);
    const id = `${createId()}${extensionFromFilename(filename)}`;
    const contentType = resolveContentType(filename, file.type);
    const kind = mediaKind(contentType);

    const fileStream = Readable.fromWeb(
      file.stream() as unknown as Parameters<typeof Readable.fromWeb>[0]
    );

    const destination = await storage.writeFile(id, fileStream);

    const stored: StoredMedia = {
      id,
      filename,
      contentType,
      size: file.size,
      kind,
      path: destination,
      ...(await readImageDimensions(id, kind))
    };

    await storage.writeMetadata(id, stored);

    return {
      ...stored,
      url: mediaUrl(id, requestUrl)
    };
  }

  async function getUploadedMedia(id: string, requestUrl = "http://localhost"): Promise<UploadedMedia> {
    const { metadata, path: storedPath, size } = await storage.read(id);
    const contentType = resolveContentType(metadata.filename, metadata.contentType);

    return {
      id: metadata.id,
      filename: metadata.filename,
      contentType,
      size,
      kind: mediaKind(contentType),
      path: storedPath,
      url: mediaUrl(metadata.id, requestUrl),
      width: metadata.width,
      height: metadata.height
    };
  }

  async function openUploadedMedia(id: string, requestUrl: string) {
    const media = await getUploadedMedia(id, requestUrl);

    return {
      media,
      stream: storage.openFile(media.path)
    };
  }

  return {
    saveStreamedMedia,
    saveUploadedMedia,
    getUploadedMedia,
    openUploadedMedia,
    deleteUploadedMedia: (id: string) => storage.delete(id),
    deleteAllUploadedMedia: () => storage.deleteAll(),
    getUploadedMediaStorageStats: () => storage.stats()
  };
}
