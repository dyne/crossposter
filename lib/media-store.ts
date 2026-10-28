import "server-only";
import { dataRoot } from "@/lib/runtime-paths";
import { createMediaStore } from "@/lib/storage/media-service";
import { createMediaStorage } from "@/lib/storage/media-storage";

export type { MediaKind, UploadedMedia } from "@/lib/storage/media-types";
export { mediaKind, resolveContentType } from "@/lib/storage/media-service";

export const {
  saveUploadedMedia,
  getUploadedMedia,
  openUploadedMedia,
  deleteUploadedMedia,
  deleteAllUploadedMedia,
  getUploadedMediaStorageStats
} = createMediaStore(createMediaStorage(dataRoot()));
