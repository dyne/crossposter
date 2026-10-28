export type MediaKind = "image" | "video" | "audio" | "file";

export type UploadedMedia = {
  id: string;
  filename: string;
  contentType: string;
  size: number;
  kind: MediaKind;
  path: string;
  url: string;
  width?: number;
  height?: number;
};

export type StoredMedia = Omit<UploadedMedia, "url">;

export type MediaStorageStats = { path: string; files: number; bytes: number };
