import type { Platform } from "@/lib/types";
import type { PreflightIssue } from "./media-policy";
import {
  devtoBodyBytesLimit, postLimitIssuesForTargets, postTextLimitForPlatform,
  platformLabel, textBytes, textLength, titleLengthForPlatform, titleLimitForPlatform, titleLimitIssues
} from "@/lib/platform-limits";

export type LimitHint = { id: string; label: string; length: number; limit: number; isWarning: boolean };
export type LimitTarget = { platform: Platform; profileLabel?: string; xPremium?: boolean };
type Input = {
  title: string; text: string; selectedPlatforms: Platform[]; selectedLimitTargets: LimitTarget[];
  selectedTargetCount: number; mediaFile: File | null; preflightIssues: PreflightIssue[]; isBusy: boolean;
};

// Keep composer enablement separate from route validation: title-only channels,
// first-target limit evaluation and existing message precedence stay unchanged.
export function getDraftValidation({
  title, text, selectedPlatforms, selectedLimitTargets, selectedTargetCount, mediaFile, preflightIssues, isBusy
}: Input) {
  const postLength = textLength(text.trim());
  const postBytes = textBytes(text.trim());
  const titleLimitHints = selectedPlatforms
    .map((platform) => {
      const limit = titleLimitForPlatform(platform);

      if (!limit) {
        return null;
      }

      const length = titleLengthForPlatform(platform, title);

      return {
        id: `${platform}-title`,
        label: platformLabel(platform),
        length,
        limit,
        isWarning: length > limit
      };
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item));
  const titleLimitWarnings = titleLimitHints.filter((hint) => hint.isWarning);
  const postLimitHints = selectedLimitTargets
    .map((target) => {
      const limit = postTextLimitForPlatform(target.platform, target.xPremium);

      if (!limit) {
        return null;
      }

      const label =
        target.platform === "x" &&
        target.profileLabel &&
        target.profileLabel !== platformLabel(target.platform)
          ? `${platformLabel(target.platform)} · ${target.profileLabel}`
          : platformLabel(target.platform);

      return {
        id: `${target.platform}:${target.profileLabel || "default"}-post`,
        label,
        length: postLength,
        limit,
        isWarning: postLength > limit
      };
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item));
  const postLimitWarnings = postLimitHints.filter((hint) => hint.isWarning);
  const devtoBodyLimitWarning = selectedPlatforms.includes("devto") && postBytes > devtoBodyBytesLimit
    ? {
        id: "devto-body",
        label: "Dev.to body",
        length: postBytes,
        limit: devtoBodyBytesLimit,
        isWarning: true
      }
    : null;
  const showHackerNewsLink = selectedPlatforms.includes("hackernews");
  const hasInstagram = selectedPlatforms.includes("instagram");
  const hasYouTube = selectedPlatforms.includes("youtube");
  const hasDribbble = selectedPlatforms.includes("dribbble");
  const hasPinterest = selectedPlatforms.includes("pinterest");
  const isHackerNewsOnly = showHackerNewsLink && selectedPlatforms.length === 1;
  const hasOnlyTextOptionalPlatforms = selectedPlatforms.every((platform) =>
    platform === "hackernews" ||
    platform === "dribbble" ||
    platform === "pinterest"
  );
  const hasRequiredHackerNewsTitle = !showHackerNewsLink || Boolean(title.trim());
  const hasRequiredYouTubeTitle = !hasYouTube || Boolean(title.trim());
  const hasRequiredDribbbleTitle = !hasDribbble || Boolean(title.trim());
  const hasRequiredInstagramMedia = !hasInstagram || Boolean(mediaFile);
  const hasRequiredYouTubeMedia = !hasYouTube || Boolean(mediaFile);
  const hasRequiredDribbbleMedia = !hasDribbble || Boolean(mediaFile);
  const hasRequiredPinterestMedia = !hasPinterest || Boolean(mediaFile);
  const hasRequiredPostText =
    Boolean(text.trim()) ||
    (isHackerNewsOnly && Boolean(title.trim())) ||
    (hasOnlyTextOptionalPlatforms && Boolean(title.trim()));
  const draftLimitIssues = [
    ...titleLimitIssues(selectedPlatforms, title),
    ...postLimitIssuesForTargets(selectedLimitTargets, text)
  ];
  const hasLimitIssues = draftLimitIssues.length > 0;
  const canSubmitDraft =
    selectedTargetCount > 0 &&
    hasRequiredHackerNewsTitle &&
    hasRequiredYouTubeTitle &&
    hasRequiredDribbbleTitle &&
    hasRequiredInstagramMedia &&
    hasRequiredYouTubeMedia &&
    hasRequiredDribbbleMedia &&
    hasRequiredPinterestMedia &&
    hasRequiredPostText &&
    preflightIssues.length === 0 &&
    !hasLimitIssues &&
    !isBusy;

  return { postLength, titleLimitWarnings, postLimitWarnings, devtoBodyLimitWarning, isHackerNewsOnly, canSubmitDraft };
}
