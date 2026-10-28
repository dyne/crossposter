import { z } from "zod";
import { platformIds } from "@/lib/platform-catalog";
import { postLimitIssuesForTargets, titleLimitIssues } from "@/lib/platform-limits";
import type { Platform, PublishTarget } from "@/lib/types";

export const platformSchema = z.enum(platformIds);

const targetSchema = z.object({
  id: z.string().min(1).max(180),
  platform: platformSchema,
  profileId: z.string().max(120).optional(),
  profileLabel: z.string().max(180).optional()
});

function normalizeOptionalUrl(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }

  const trimmed = value.trim();

  if (!trimmed) {
    return undefined;
  }

  if (/^[a-z][a-z\d+\-.]*:\/\//i.test(trimmed)) {
    return trimmed;
  }

  return `https://${trimmed}`;
}

const optionalUrlSchema = z.preprocess(
  normalizeOptionalUrl,
  z.string().url().refine((value) => {
    try {
      const parsed = new URL(value);
      const isHttp = parsed.protocol === "http:" || parsed.protocol === "https:";
      const isPublicLike = parsed.hostname === "localhost" || parsed.hostname.includes(".");

      return isHttp && isPublicLike && !parsed.username && !parsed.password;
    } catch {
      return false;
    }
  }).optional()
);

type TargetSelection = {
  platforms?: Platform[];
  targets?: PublishTarget[];
};

type RequestContent = TargetSelection & {
  title?: string;
  text: string;
};

export type ConfigValueLookup = (name: string, profileId?: string) => string | undefined;

function requestedPlatforms(value: TargetSelection): Platform[] {
  const platforms = value.targets?.length
    ? value.targets.map((target) => target.platform)
    : value.platforms || [];

  return Array.from(new Set(platforms));
}

export function defaultTargets(value: TargetSelection): PublishTarget[] {
  return value.targets?.length
    ? value.targets
    : (value.platforms || []).map((platform) => ({ id: platform, platform }));
}

function canPublishWithoutText(value: RequestContent): boolean {
  const platforms = requestedPlatforms(value);

  return platforms.length > 0 && Boolean(value.title?.trim()) && platforms.every(
    (platform) => platform === "hackernews" || platform === "dribbble" || platform === "pinterest"
  );
}

export function targetLimitInput(target: PublishTarget, getConfigValue: ConfigValueLookup) {
  return {
    platform: target.platform,
    profileLabel: target.profileLabel,
    xPremium: target.platform === "x" && getConfigValue("X_PREMIUM_LONG_POSTS", target.profileId) === "true"
  };
}

const contentFields = {
  title: z.string().max(300).optional(),
  text: z.string().max(100_000).default(""),
  linkUrl: optionalUrlSchema,
  mediaId: z.string().max(80).optional().or(z.literal(""))
};

const selectionFields = {
  platforms: z.array(platformSchema).max(30).optional(),
  targets: z.array(targetSchema).max(30).optional()
};

function contentRules(value: RequestContent, ctx: z.RefinementCtx) {
  // Preserve the original refinement order: every failed rule contributes a form error.
  if ((value.targets?.length || value.platforms?.length || 0) === 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Select at least one channel." });
  }

  if (requestedPlatforms(value).includes("hackernews") && !value.title?.trim()) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Hacker News requires a title." });
  }

  if (requestedPlatforms(value).includes("youtube") && !value.title?.trim()) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "YouTube requires a title." });
  }

  if (requestedPlatforms(value).includes("dribbble") && !value.title?.trim()) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Dribbble requires a title." });
  }

  if (!value.text.trim() && !canPublishWithoutText(value)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Write post text, or add a title for title-only channels." });
  }
}

function limitRules(getConfigValue: ConfigValueLookup) {
  return (value: RequestContent, ctx: z.RefinementCtx) => {
    const issues = [
      ...titleLimitIssues(requestedPlatforms(value), value.title || ""),
      ...postLimitIssuesForTargets(defaultTargets(value).map((target) => targetLimitInput(target, getConfigValue)), value.text)
    ];

    for (const issue of issues) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [issue.field], message: issue.message });
    }
  };
}

export function createPublishRequestSchema(getConfigValue: ConfigValueLookup) {
  return z.object({
    adminPassword: z.string().optional(),
    ...contentFields,
    mediaUrl: optionalUrlSchema,
    ...selectionFields
  }).superRefine(contentRules).superRefine(limitRules(getConfigValue));
}

export function createScheduleRequestSchema(getConfigValue: ConfigValueLookup) {
  return z.object({
    ...contentFields,
    ...selectionFields,
    scheduledFor: z.string().min(1).max(80)
  })
    .superRefine(contentRules)
    .refine((value) => Number.isFinite(Date.parse(value.scheduledFor)), {
      message: "Choose a valid scheduled time."
    })
    .superRefine(limitRules(getConfigValue));
}

export function requestValidationMessage(error: z.ZodError, variant: "publish" | "schedule"): string {
  const { fieldErrors: fields, formErrors } = error.flatten();

  if (fields.linkUrl?.length) {
    return "Link is invalid. Use a URL like https://example.com, or leave Link empty.";
  }

  if (fields.title?.length) {
    return fields.title.join(" ");
  }

  if (fields.text?.length) {
    return fields.text.join(" ");
  }

  if (variant === "publish" && fields.mediaUrl?.length) {
    return "Media URL is invalid. Upload a local file instead.";
  }

  if (formErrors.length) {
    return formErrors.join(" ");
  }

  return variant === "publish"
    ? "Publish request is invalid. Check the highlighted fields and try again."
    : "Schedule request is invalid. Check the fields and try again.";
}
