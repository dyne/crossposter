import "server-only";
import { configFields } from "@/lib/config-spec";
import { validatePlatformConfig } from "@/lib/config-validation";
import type { Platform, ProviderProfile, PublishedPost, ScheduledPost } from "@/lib/types";
import type { NormalizationDefaults } from "./codec-helpers";
import { normalizeConfig } from "./config-codec";
import type { LocalConfigFile } from "./config-codec";
import { emptyComposeDraft } from "./content-codec";
import type { ConfigStorage } from "./json-storage";

const fieldDefaults = new Map(
  configFields
    .filter((field) => field.defaultValue)
    .map((field) => [field.name, field.defaultValue as string])
);
const fieldPlatform = new Map<string, Platform>(
  configFields.flatMap((field) =>
    [...(field.requiredFor || []), ...(field.showFor || [])].map(
      (platform) => [field.name, platform] as const
    )
  )
);

export function createLocalConfigStore(
  storage: ConfigStorage,
  defaults: NormalizationDefaults,
  environmentValue: (name: string) => string | undefined
) {
  function readLocalConfig(): LocalConfigFile {
    if (!storage.exists()) {
      return {
        values: {},
        profiles: {},
        activeProfiles: {},
        draft: { ...emptyComposeDraft },
        publishedPosts: [],
        scheduledPosts: []
      };
    }

    try {
      return normalizeConfig(storage.read(), defaults);
    } catch {
      return {
        values: {},
        profiles: {},
        activeProfiles: {},
        draft: { ...emptyComposeDraft },
        publishedPosts: [],
        scheduledPosts: []
      };
    }
  }

  function writeLocalConfig(config: LocalConfigFile): LocalConfigFile {
    const normalized = normalizeConfig(config, defaults);

    storage.write(normalized);

    return normalized;
  }

  function appendPublishedPost(post: PublishedPost): PublishedPost | undefined {
    const localConfig = readLocalConfig();

    const [saved] = writeLocalConfig({
      ...localConfig,
      publishedPosts: [post, ...localConfig.publishedPosts]
    }).publishedPosts;

    return saved;
  }

  function getScheduledPosts(): ScheduledPost[] {
    return readLocalConfig().scheduledPosts;
  }

  function upsertScheduledPost(post: ScheduledPost): ScheduledPost {
    const localConfig = readLocalConfig();
    const existing = new Set(localConfig.scheduledPosts.map((item) => item.id));
    const scheduledPosts = existing.has(post.id)
      ? localConfig.scheduledPosts.map((item) => (item.id === post.id ? post : item))
      : [post, ...localConfig.scheduledPosts];

    const saved = writeLocalConfig({
      ...localConfig,
      scheduledPosts
    });

    return saved.scheduledPosts.find((item) => item.id === post.id) || post;
  }

  function updateScheduledPost(
    id: string,
    update: (post: ScheduledPost) => ScheduledPost
  ): ScheduledPost | undefined {
    const localConfig = readLocalConfig();
    let updated: ScheduledPost | undefined;
    const scheduledPosts = localConfig.scheduledPosts.map((post) => {
      if (post.id !== id) {
        return post;
      }

      updated = update(post);
      return updated;
    });

    if (!updated) {
      return undefined;
    }

    const saved = writeLocalConfig({
      ...localConfig,
      scheduledPosts
    });

    return saved.scheduledPosts.find((post) => post.id === id);
  }

  function removeScheduledPost(id: string): ScheduledPost[] {
    const localConfig = readLocalConfig();
    const saved = writeLocalConfig({
      ...localConfig,
      scheduledPosts: localConfig.scheduledPosts.filter((post) => post.id !== id)
    });

    return saved.scheduledPosts;
  }

  function getConfigValue(name: string, profileId?: string): string | undefined {
    const localConfig = readLocalConfig();
    const platform = fieldPlatform.get(name);
    const activeProfileId = platform ? profileId || localConfig.activeProfiles[platform] : undefined;
    const activeProfile = platform && activeProfileId
      ? localConfig.profiles[platform]?.find((profile: ProviderProfile) => profile.id === activeProfileId)
      : undefined;

    if (platform && profileId) {
      return activeProfile?.values[name] || fieldDefaults.get(name) || undefined;
    }

    return (
      activeProfile?.values[name] ||
      localConfig.values[name] ||
      environmentValue(name) ||
      fieldDefaults.get(name) ||
      undefined
    );
  }

  function getProfileConfigIssues(platform: Platform, profileId?: string) {
    if (!profileId) {
      return [];
    }

    const localConfig = readLocalConfig();
    const profile = localConfig.profiles[platform]?.find((item) => item.id === profileId);

    if (!profile) {
      return [
        {
          field: "profile",
          label: "Profile",
          message: "Selected profile no longer exists",
          kind: "missing" as const
        }
      ];
    }

    return validatePlatformConfig(platform, profile.values);
  }

  return { readLocalConfig, writeLocalConfig, appendPublishedPost, getScheduledPosts, upsertScheduledPost, updateScheduledPost, removeScheduledPost, getConfigValue, getProfileConfigIssues };
}
