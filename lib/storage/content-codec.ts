import type { ComposeDraft, PublishedPost, PublishResult } from "@/lib/types";
import { normalizePlatforms, normalizePublishedMedia, normalizePublishResult, normalizePublishTargets, storedPostTextLimit, stringValue } from "./codec-helpers";
import type { NormalizationDefaults } from "./codec-helpers";

export const emptyComposeDraft: ComposeDraft = {
  title: "",
  text: "",
  linkUrl: "",
  platforms: [],
  targets: []
};

export function normalizeComposeDraft(value: unknown): ComposeDraft {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ...emptyComposeDraft };
  }

  const record = value as Record<string, unknown>;
  const updatedAt = stringValue(record.updatedAt, 40);
  const media = normalizePublishedMedia(record.media);

  return {
    title: stringValue(record.title, 300),
    text: stringValue(record.text, storedPostTextLimit),
    linkUrl: stringValue(record.linkUrl, 2048) || stringValue(record.url, 2048),
    platforms: normalizePlatforms(record.platforms),
    targets: normalizePublishTargets(record.targets),
    ...(media ? { media } : {}),
    ...(updatedAt ? { updatedAt } : {})
  };
}

export function normalizePublishedPost(value: unknown, defaults: NormalizationDefaults): PublishedPost | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;
  const results = Array.isArray(record.results)
    ? record.results.map(normalizePublishResult).filter((item): item is PublishResult => Boolean(item))
    : [];

  if (results.length === 0) {
    return null;
  }

  const media = normalizePublishedMedia(record.media);

  return {
    id: stringValue(record.id, 120) || defaults.createId(),
    createdAt: stringValue(record.createdAt, 40) || defaults.now(),
    ...(typeof record.title === "string" && record.title
      ? { title: record.title.slice(0, 300) }
      : {}),
    text: stringValue(record.text, storedPostTextLimit),
    ...(stringValue(record.linkUrl, 2048) || stringValue(record.url, 2048)
      ? { linkUrl: stringValue(record.linkUrl, 2048) || stringValue(record.url, 2048) }
      : {}),
    platforms: normalizePlatforms(record.platforms),
    targets: normalizePublishTargets(record.targets),
    results,
    ...(media ? { media } : {})
  };
}

export function normalizePublishedPosts(value: unknown, defaults: NormalizationDefaults): PublishedPost[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((post) => normalizePublishedPost(post, defaults))
    .filter((item): item is PublishedPost => Boolean(item));
}

