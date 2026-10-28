import { isPlatform } from "@/lib/platform-catalog";
import type { Platform, PublishedMedia, PublishResult, PublishTarget } from "@/lib/types";

// Defaults are called only for missing IDs/timestamps; decoding itself has no IO.
export type NormalizationDefaults = {
  createId: () => string;
  now: () => string;
};

export const storedPostTextLimit = 100_000;

export function stringValue(value: unknown, maxLength: number): string {
  return typeof value === "string" ? value.slice(0, maxLength) : "";
}

export function normalizePlatforms(value: unknown): Platform[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter(isPlatform)
    .slice(0, 30);
}

export function normalizePublishTargets(value: unknown): PublishTarget[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((item) => item && typeof item === "object" && !Array.isArray(item))
    .map((item) => {
      const record = item as Record<string, unknown>;
      const platform = record.platform;

      if (!isPlatform(platform)) {
        return null;
      }

      const profileId = stringValue(record.profileId, 120);
      const id = stringValue(record.id, 180) || `${platform}:${profileId || "base"}`;
      const profileLabel = stringValue(record.profileLabel, 180);

      return {
        id,
        platform,
        ...(profileId ? { profileId } : {}),
        ...(profileLabel ? { profileLabel } : {})
      };
    })
    .filter((item): item is PublishTarget => Boolean(item))
    .slice(0, 30);
}

export function normalizePublishResult(value: unknown): PublishResult | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;
  const platform = record.platform;

  if (!isPlatform(platform)) {
    return null;
  }

  return {
    platform,
    ...(typeof record.targetId === "string" && record.targetId ? { targetId: record.targetId.slice(0, 180) } : {}),
    ...(typeof record.profileId === "string" && record.profileId ? { profileId: record.profileId.slice(0, 120) } : {}),
    ...(typeof record.profileLabel === "string" && record.profileLabel ? { profileLabel: record.profileLabel.slice(0, 180) } : {}),
    ok: record.ok === true,
    message: stringValue(record.message, 1000),
    ...(typeof record.url === "string" && record.url ? { url: record.url.slice(0, 2048) } : {})
  };
}

export function normalizePublishedMedia(value: unknown): PublishedMedia | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const mediaKind = record.kind;

  if (
    typeof record.id !== "string" ||
    typeof record.filename !== "string" ||
    !["image", "video", "audio", "file"].includes(mediaKind as string)
  ) {
    return undefined;
  }

  return {
    id: record.id.slice(0, 120),
    filename: record.filename.slice(0, 240),
    contentType: stringValue(record.contentType, 160),
    size: typeof record.size === "number" ? record.size : 0,
    kind: mediaKind as "image" | "video" | "audio" | "file",
    url: stringValue(record.url, 2048)
  };
}

