import "server-only";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { Readable } from "node:stream";
import { imageSize } from "image-size";
import { formatLimitBytes, xPremiumVideoMediaSizeLimit, youtubeVideoMediaSizeLimit } from "@/lib/platform-limits";
import type { MediaStorage } from "./media-storage";
import type { MediaKind, UploadedMedia, StoredMedia } from "./media-types";

const maxMediaSize = Math.max(xPremiumVideoMediaSizeLimit, youtubeVideoMediaSizeLimit);

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
    saveUploadedMedia,
    getUploadedMedia,
    openUploadedMedia,
    deleteUploadedMedia: (id: string) => storage.delete(id),
    deleteAllUploadedMedia: () => storage.deleteAll(),
    getUploadedMediaStorageStats: () => storage.stats()
  };
}
