import { configFields } from "@/lib/config-spec";
import { isPlatform } from "@/lib/platform-catalog";
import type { ComposeDraft, Platform, ProviderProfile, PublishedPost, ScheduledPost } from "@/lib/types";
import type { NormalizationDefaults } from "./codec-helpers";
import { normalizeComposeDraft, normalizePublishedPosts } from "./content-codec";
import { normalizeScheduledPosts } from "./schedule-codec";

export type LocalConfigValues = Record<string, string>;

export type LocalConfigFile = {
  values: LocalConfigValues;
  profiles: Partial<Record<Platform, ProviderProfile[]>>;
  activeProfiles: Partial<Record<Platform, string>>;
  draft: ComposeDraft;
  publishedPosts: PublishedPost[];
  scheduledPosts: ScheduledPost[];
};

const allowedFields = new Set(configFields.map((field) => field.name));

export function normalizeValues(value: unknown): LocalConfigValues {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value)
      .filter(([key, item]) => allowedFields.has(key) && typeof item === "string")
      .map(([key, item]) => [key, item.trim()])
  );
}

export function normalizeProfiles(value: unknown, defaults: Pick<NormalizationDefaults, "createId">): Partial<Record<Platform, ProviderProfile[]>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value)
      .map(([platform, profiles]) => {
        if (!isPlatform(platform)) {
          return [platform, []];
        }

        if (!Array.isArray(profiles)) {
          return [platform, []];
        }

        return [
          platform,
          profiles
            .filter((profile) => profile && typeof profile === "object" && !Array.isArray(profile))
            .map((profile) => {
              const item = profile as Record<string, unknown>;

              return {
                id: typeof item.id === "string" && item.id.trim() ? item.id.trim() : defaults.createId(),
                label:
                  typeof item.label === "string" && item.label.trim()
                    ? item.label.trim()
                    : "Untitled profile",
                values: normalizeValues(item.values)
              };
            })
        ];
      })
      .filter(([, profiles]) => (profiles as ProviderProfile[]).length > 0)
  ) as Partial<Record<Platform, ProviderProfile[]>>;
}

export function normalizeActiveProfiles(value: unknown): Partial<Record<Platform, string>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value)
      .filter(([platform, item]) => isPlatform(platform) && typeof item === "string")
      .map(([key, item]) => [key, item.trim()])
  ) as Partial<Record<Platform, string>>;
}

export function normalizeConfig(value: unknown, defaults: NormalizationDefaults): LocalConfigFile {
  const raw = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const record = raw as Record<string, unknown>;

  return {
    values: {
      ...normalizeValues(record),
      ...normalizeValues(record.values)
    },
    profiles: normalizeProfiles(record.profiles, defaults),
    activeProfiles: normalizeActiveProfiles(record.activeProfiles),
    draft: normalizeComposeDraft(record.draft),
    publishedPosts: normalizePublishedPosts(record.publishedPosts, defaults),
    scheduledPosts: normalizeScheduledPosts(record.scheduledPosts, defaults)
  };
}

