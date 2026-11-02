import { configFields } from "@/lib/config-spec";
import { validatePlatformConfig } from "@/lib/config-validation";
import { platformIds, platformLabels, type Platform } from "@/lib/platform-catalog";
import type { ControlContent, ControlOutcome, ControlTarget } from "./contracts";
import { controlCapabilities } from "./capabilities";
import { payloadDigest } from "./canonical";
import { ControlError } from "./errors";
import type { ControlReadConfig, QueuedPost, RetainedPost } from "./read-storage";
import type { PublishTarget } from "@/lib/types";
import type { ControlMedia } from "./contracts";

export function projectControlConfig(config: ControlReadConfig, environmentValue: (name: string) => string | undefined) {
  // Public handles/instance URLs are part of native post identities. Protect
  // actual secret fields (at every length) and private filesystem/session
  // settings, using the incumbent field metadata rather than every value.
  const privateValues = configFields.flatMap((field) => {
    const values = [config.values[field.name], environmentValue(field.name), field.defaultValue,
      typeof config[field.name] === "string" ? config[field.name] as string : undefined,
      ...Object.values(config.profiles).flatMap((profiles) => profiles.map((profile) => profile.values[field.name]))];
    return values.filter((value): value is string => Boolean(value?.trim()) && (Boolean(field.secret)
      || /(?:_DIR|_ROOT|_PATH)$/.test(field.name)
      || (field.name.endsWith("_COMMAND") && /[/\\]/.test(value ?? ""))));
  }).flatMap((value) => [value, value.trim(), value.replaceAll("\\", "/")]).filter(Boolean);
  const containsPrivate = (value: string) => privateValues.some((secret) => value.includes(secret));
  const label = (value: string) => containsPrivate(value) ? "Account" : value;
  const publicUrl = (value?: string, outcome = false) => {
    if (!value) return null;
    try {
      const url = new URL(value);
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
      if (outcome) {
        const credentialKey = (key: string) => /password|passwd|token|secret|cookie|authorization|credential|session|signature|api[_-]?key|access[_-]?key|^(?:auth|key|sig)$/i.test(key);
        for (const key of [...url.searchParams.keys()]) if (credentialKey(key)) url.searchParams.delete(key);
        const fragment = new URLSearchParams(url.hash.slice(1));
        if ([...fragment.keys()].some(credentialKey)) {
          for (const key of [...fragment.keys()]) if (credentialKey(key)) fragment.delete(key);
          url.hash = fragment.toString();
        }
      }
      const rendered = outcome ? url.toString() : value;
      let decoded = rendered;
      for (let depth = 0; depth < 2; depth++) {
        if (containsPrivate(decoded)) return null;
        const next = decodeURIComponent(decoded);
        if (next === decoded) break;
        decoded = next;
      }
      return containsPrivate(decoded) ? null : rendered;
    } catch { return null; }
  };
  const baseValue = (name: string) => config.values[name] || (typeof config[name] === "string" ? config[name] as string : undefined) || environmentValue(name);
  const fieldsFor = (platform: Platform) => configFields.filter((field) => field.requiredFor?.includes(platform) || field.showFor?.includes(platform));
  const targets: ControlTarget[] = platformIds.flatMap((platform) => {
    const fields = fieldsFor(platform);
    const saved = config.profiles[platform] ?? [];
    const choices = saved.map((profile) => ({ id: `${platform}:${profile.id}`, platform,
      profileId: profile.id as string | null, label: label(profile.label), values: profile.values }));
    // A legacy base target is explicit, never an alias for the active profile.
    if (fields.some((field) => Boolean(baseValue(field.name)))) choices.push({
      id: `${platform}:base`, platform, profileId: null, label: platformLabels[platform],
      values: Object.fromEntries(fields.map((field) => [field.name, baseValue(field.name) ?? field.defaultValue ?? ""]))
    });
    return choices.map((choice) => ({ id: choice.id, platform, profileId: choice.profileId, label: choice.label,
      readiness: validatePlatformConfig(platform, choice.values).length === 0 ? "configured" : "incomplete",
      readinessBasis: "configuration_only", capabilities: controlCapabilities(platform)
    } satisfies ControlTarget));
  }).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  if (new Set(targets.map((target) => target.id)).size !== targets.length) throw new ControlError("storage_corrupt");
  const identity = (target: { platform: Platform; profileId?: string; profileLabel?: string }) => ({
    id: `${target.platform}:${target.profileId || "base"}`, platform: target.platform, profileId: target.profileId || null,
    label: label(target.profileLabel || targets.find((item) => item.id === `${target.platform}:${target.profileId || "base"}`)?.label || platformLabels[target.platform])
  });
  const content = (record: ControlReadConfig["draft"]): ControlContent => ({
    title: record.title ?? "", text: record.text ?? "", linkUrl: publicUrl(record.linkUrl || record.url) ?? "", mediaId: record.media?.id ?? null
  });
  function retained(record: RetainedPost | QueuedPost) {
    const results = record.results ?? [];
    const selected: PublishTarget[] = record.targets?.length ? record.targets : (record.platforms?.length && !results.some((result) => result.profileId)
      ? record.platforms.map((platform) => ({ id: platform, platform }))
      : results.map((result) => ({ id: result.targetId ?? `${result.platform}:${result.profileId || "base"}`, ...result })));
    const identities = selected.map(identity);
    if (!identities.length || new Set(identities.map((item) => item.id)).size !== identities.length) throw new ControlError("storage_corrupt");
    const byTarget = new Map<number, ControlOutcome>();
    for (const result of results) {
      let indexes = selected.flatMap((target, index) =>
        (result.targetId ? target.id === result.targetId : target.platform === result.platform && (target.profileId || "") === (result.profileId || "")) ? [index] : []);
      // Legacy history may have a platform-only target and no result target ID.
      if (!indexes.length && !result.targetId && !result.profileId) indexes = selected.flatMap((target, index) => target.platform === result.platform ? [index] : []);
      if (indexes.length !== 1 || byTarget.has(indexes[0])
        || selected[indexes[0]].platform !== result.platform
        || (result.profileId && selected[indexes[0]].profileId !== result.profileId)) throw new ControlError("storage_corrupt");
      const state = result.uncertain ? "uncertain" : result.ok ? "succeeded" : "failed";
      byTarget.set(indexes[0], { target: identities[indexes[0]], state, message: state === "succeeded" ? "Publication succeeded."
        : state === "uncertain" ? "Publication outcome is uncertain. Inspect the account before another attempt." : "Publication failed.",
      url: result.ok && !result.uncertain ? publicUrl(result.url, true) : null });
    }
    // Legacy queue status/attempt counters are not a durable per-target
    // dispatch journal. A missing result cannot establish never-dispatched.
    const outcomes: ControlOutcome[] = identities.map((target, index) => byTarget.get(index) ?? {
      target, state: "uncertain", message: "No retained result establishes this target's publication outcome.", url: null
    });
    return { targets: identities, outcomes };
  }
  return { targets, content, retained, baseValue, containsPrivate, publicUrl };
}

export function projectControlDraft(config: ControlReadConfig, dto: ReturnType<typeof projectControlConfig>, mediaDigest: string | null,
  recovery?: { allowMissingTargets: boolean; missingMediaRevision?: string }) {
  const selected = config.draft.targets?.length ? config.draft.targets.map((target) => `${target.platform}:${target.profileId || "base"}`)
    : (config.draft.platforms ?? []).map((platform) => `${platform}:base`);
  const missingTargetIds = selected.filter((id) => !dto.targets.some((target) => target.id === id));
  if (missingTargetIds.length && !recovery?.allowMissingTargets) throw new ControlError("target_missing");
  const draft = { content: dto.content(config.draft), targetIds: [...new Set(selected)],
    updatedAt: config.draft.updatedAt ? new Date(config.draft.updatedAt).toISOString() : null };
  // A recovery token binds unavailable references without claiming that their
  // bytes or account readiness were verified. Healthy revisions stay identical
  // to the strict projection used by publication preparation.
  return { ...draft, revision: payloadDigest({ ...draft, mediaDigest,
    ...(missingTargetIds.length ? { missingTargetIds } : {}),
    ...(recovery?.missingMediaRevision ? { missingMediaRevision: recovery.missingMediaRevision } : {}) }) };
}
export function projectControlSchedule(post: QueuedPost, dto: ReturnType<typeof projectControlConfig>) {
  const projected = { id: post.id, createdAt: new Date(post.createdAt).toISOString(), updatedAt: new Date(post.updatedAt).toISOString(),
    scheduledFor: new Date(post.scheduledFor).toISOString(), content: dto.content(post), ...dto.retained(post),
    status: post.status, attempts: post.attempts, actionId: post.authorization?.actionId ?? null, publishedPostId: post.publishedPostId ?? null };
  return { ...projected, revision: payloadDigest(projected) };
}

export function projectControlMedia(media: ControlMedia, dto: ReturnType<typeof projectControlConfig>): ControlMedia {
  if (dto.containsPrivate(media.contentType)) throw new ControlError("storage_corrupt");
  return { id: media.id, filename: dto.containsPrivate(media.filename) ? "upload" : media.filename,
    contentType: media.contentType, size: media.size, kind: media.kind, digest: media.digest, url: media.url };
}
