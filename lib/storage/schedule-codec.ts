import type { PublishResult, ScheduledPost, ScheduledPostStatus } from "@/lib/types";
import { normalizePlatforms, normalizePublishedMedia, normalizePublishResult, normalizePublishTargets, storedPostTextLimit, stringValue } from "./codec-helpers";
import type { NormalizationDefaults } from "./codec-helpers";

export function normalizeScheduledPostStatus(value: unknown): ScheduledPostStatus {
  return value === "publishing" ||
    value === "published" ||
    value === "failed" ||
    value === "canceled"
    ? value
    : "scheduled";
}

export function normalizeScheduledPost(value: unknown, defaults: NormalizationDefaults): ScheduledPost | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;
  const targets = normalizePublishTargets(record.targets);
  const platforms = targets.length ? normalizePlatforms(targets.map((target) => target.platform)) : normalizePlatforms(record.platforms);
  const scheduledFor = stringValue(record.scheduledFor, 40);
  const scheduledAt = Date.parse(scheduledFor);
  const title = stringValue(record.title, 300);
  const text = stringValue(record.text, storedPostTextLimit);
  const isHackerNewsOnly = platforms.length === 1 && platforms[0] === "hackernews";
  const media = normalizePublishedMedia(record.media);
  const results = Array.isArray(record.results)
    ? record.results.map(normalizePublishResult).filter((item): item is PublishResult => Boolean(item))
    : [];

  if (
    !Number.isFinite(scheduledAt) ||
    (!text.trim() && !(isHackerNewsOnly && title.trim())) ||
    platforms.length === 0
  ) {
    return null;
  }

  return {
    id: stringValue(record.id, 120) || defaults.createId(),
    createdAt: stringValue(record.createdAt, 40) || defaults.now(),
    updatedAt: stringValue(record.updatedAt, 40) || defaults.now(),
    scheduledFor: new Date(scheduledAt).toISOString(),
    ...(title ? { title } : {}),
    text,
    ...(stringValue(record.linkUrl, 2048) || stringValue(record.url, 2048)
      ? { linkUrl: stringValue(record.linkUrl, 2048) || stringValue(record.url, 2048) }
      : {}),
    platforms,
    targets,
    ...(media ? { media } : {}),
    status: normalizeScheduledPostStatus(record.status),
    attempts: typeof record.attempts === "number" && record.attempts > 0 ? Math.floor(record.attempts) : 0,
    ...(typeof record.lastError === "string" && record.lastError
      ? { lastError: record.lastError.slice(0, 1000) }
      : {}),
    ...(results.length ? { results } : {}),
    ...(typeof record.publishedPostId === "string" && record.publishedPostId
      ? { publishedPostId: record.publishedPostId.slice(0, 120) }
      : {}),
    ...(typeof record.publishedAt === "string" && record.publishedAt
      ? { publishedAt: record.publishedAt.slice(0, 40) }
      : {})
  };
}

export function normalizeScheduledPosts(value: unknown, defaults: NormalizationDefaults): ScheduledPost[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((post) => normalizeScheduledPost(post, defaults))
    .filter((item): item is ScheduledPost => Boolean(item));
}

