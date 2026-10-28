import type { Platform } from "@/lib/types";
import type { UploadedMedia } from "./client";
import { fileKind, type MediaDimensions } from "./media-conversion";
import { formatBytes } from "./presentation";
import {
  instagramPhotoMediaSizeLimit, instagramVideoMediaSizeLimit, dribbbleImageMediaSizeLimit,
  pinterestImageMediaSizeLimit, pinterestVideoMediaSizeLimit, xMediaSizeLimit, youtubeVideoMediaSizeLimit
} from "@/lib/platform-limits";

const blueskyMaxImageSize = 1_000_000;
const blueskyCompressTargetSize = 950_000;
const blueskyImageTypes = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
const instagramImageTypes = new Set(["image/jpeg", "image/png", "image/webp"]);
const instagramVideoTypes = new Set(["video/mp4", "video/quicktime"]);
const youtubeVideoTypes = new Set([
  "video/3gpp",
  "video/avi",
  "video/mp4",
  "video/mpeg",
  "video/quicktime",
  "video/webm",
  "video/x-flv",
  "video/x-m4v",
  "video/x-matroska",
  "video/x-ms-wmv",
  "video/x-msvideo"
]);
const youtubeVideoExtensions = new Set([
  ".3gp",
  ".avi",
  ".cineform",
  ".dnxhr",
  ".flv",
  ".hevc",
  ".m4v",
  ".mkv",
  ".mov",
  ".mp4",
  ".mpeg",
  ".mpg",
  ".mts",
  ".mxf",
  ".prores",
  ".ts",
  ".webm",
  ".wmv"
]);
const dribbbleImageTypes = new Set(["image/jpeg", "image/png", "image/gif"]);
const dribbbleImageTargetSize = 7.5 * 1024 * 1024;
const pinterestImageTypes = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
const pinterestVideoTypes = new Set(["video/mp4", "video/quicktime"]);
const pinterestImageTargetSize = 19 * 1024 * 1024;
const pinterestVideoTargetSize = 95 * 1024 * 1024;
const linkedInImageTypes = new Set(["image/jpeg", "image/png", "image/gif"]);
const linkedInVideoTypes = new Set(["video/mp4"]);
const xImageTypes = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
const xVideoTypes = new Set(["video/mp4"]);
const linkedInMinVideoSize = 75 * 1024;
const linkedInMaxVideoSize = 500 * 1024 * 1024;
const linkedInVideoTargetSize = 490 * 1024 * 1024;
const instagramImageTargetSize = 7.5 * 1024 * 1024;
const instagramVideoTargetSize = 290 * 1024 * 1024;
const mastodonImageSizeLimit = 16_777_216;
const mastodonVideoSizeLimit = 103_809_024;
const mastodonImageTargetSize = 15 * 1024 * 1024;
const mastodonVideoTargetSize = 95 * 1024 * 1024;
export const maxManualVideoTargetSize = 500 * 1024 * 1024;

export type PreflightIssue = {
  id: string;
  message: string;
  compress?: "image" | "video";
  crop?: "dribbble";
};

export type MediaPreflightTarget = {
  platform: Platform;
  xPremium?: boolean;
};

export function fileExtension(filename: string): string {
  const dotIndex = filename.lastIndexOf(".");

  return dotIndex >= 0 ? filename.slice(dotIndex).toLowerCase() : "";
}

export function mediaKindLabel(kind: UploadedMedia["kind"]): string {
  return kind === "file" ? "file" : `${kind} file`;
}

export function mediaPreflightIssues(
  targets: MediaPreflightTarget[],
  file: File | null,
  dimensions?: MediaDimensions | null
): PreflightIssue[] {
  const issues: PreflightIssue[] = [];
  const kind = fileKind(file);
  const platforms = Array.from(new Set(targets.map((target) => target.platform)));

  if (!file) {
    return issues;
  }

  if (platforms.includes("linkedin")) {
    if (kind === "image" && !linkedInImageTypes.has(file.type)) {
      issues.push({
        id: "linkedin-image-type",
        message: `LinkedIn supports JPG, PNG, and GIF images; selected file is ${file.type || "unknown"}.`,
        compress: "image"
      });
    } else if (kind === "video" && !linkedInVideoTypes.has(file.type)) {
      issues.push({
        id: "linkedin-video-type",
        message: `LinkedIn supports MP4 videos; selected file is ${file.type || "unknown"}.`,
        compress: "video"
      });
    } else if (kind === "video" && (file.size < linkedInMinVideoSize || file.size > linkedInMaxVideoSize)) {
      issues.push({
        id: "linkedin-video-size",
        message: `LinkedIn video size must be between 75 KB and 500 MB; selected file is ${formatBytes(file.size)}.`,
        compress: file.size > linkedInMaxVideoSize ? "video" : undefined
      });
    } else if (kind !== "image" && kind !== "video") {
      issues.push({
        id: "linkedin-kind",
        message: `LinkedIn can upload images and MP4 videos only; selected media is a ${mediaKindLabel(kind)}.`
      });
    }
  }

  if (platforms.includes("x")) {
    const xTargets = targets.filter((target) => target.platform === "x");
    const xPremium = xTargets.length > 0 && xTargets.every((target) => target.xPremium);
    const sizeLimit = xMediaSizeLimit(kind, file.type, xPremium);

    if (kind === "image" && !xImageTypes.has(file.type)) {
      issues.push({
        id: "x-image-type",
        message: `X supports JPG, PNG, WebP, and GIF images; selected file is ${file.type || "unknown"}.`,
        compress: "image"
      });
    } else if (kind === "video" && !xVideoTypes.has(file.type)) {
      issues.push({
        id: "x-video-type",
        message: `X supports MP4 video; selected file is ${file.type || "unknown"}.`,
        compress: "video"
      });
    } else if (kind !== "image" && kind !== "video") {
      issues.push({
        id: "x-kind",
        message: `X can upload images, GIFs, and MP4 video only; selected media is a ${mediaKindLabel(kind)}.`
      });
    } else if (sizeLimit && file.size > sizeLimit.bytes) {
      issues.push({
        id: "x-media-size",
        message: `${sizeLimit.label} limit is ${formatBytes(sizeLimit.bytes)}; selected file is ${formatBytes(file.size)}.`,
        compress:
          kind === "video" ? "video" : kind === "image" && file.type !== "image/gif" ? "image" : undefined
      });
    }
  }

  if (platforms.includes("instagram")) {
    if (kind === "image" && !instagramImageTypes.has(file.type)) {
      issues.push({
        id: "instagram-image-type",
        message: `Instagram supports JPG, PNG, and WebP images; selected file is ${file.type || "unknown"}.`,
        compress: file.type === "image/gif" ? undefined : "image"
      });
    } else if (kind === "image" && file.size > instagramPhotoMediaSizeLimit) {
      issues.push({
        id: "instagram-image-size",
        message: `Instagram photo limit is 8 MB; selected file is ${formatBytes(file.size)}.`,
        compress: "image"
      });
    } else if (kind === "video" && !instagramVideoTypes.has(file.type)) {
      issues.push({
        id: "instagram-video-type",
        message: `Instagram supports MP4 and MOV videos; selected file is ${file.type || "unknown"}.`,
        compress: "video"
      });
    } else if (kind === "video" && file.size > instagramVideoMediaSizeLimit) {
      issues.push({
        id: "instagram-video-size",
        message: `Instagram video limit is 300 MB; selected file is ${formatBytes(file.size)}.`,
        compress: "video"
      });
    } else if (kind !== "image" && kind !== "video") {
      issues.push({
        id: "instagram-kind",
        message: `Instagram can upload images and videos only; selected media is a ${mediaKindLabel(kind)}.`
      });
    }
  }

  if (platforms.includes("pinterest")) {
    if (kind === "image" && !pinterestImageTypes.has(file.type)) {
      issues.push({
        id: "pinterest-image-type",
        message: `Pinterest supports JPG, PNG, GIF, and WebP images through py3-pinterest; selected file is ${file.type || "unknown"}.`,
        compress: file.type === "image/gif" ? undefined : "image"
      });
    } else if (kind === "image" && file.size > pinterestImageMediaSizeLimit) {
      issues.push({
        id: "pinterest-image-size",
        message: `Pinterest image limit is 20 MB; selected file is ${formatBytes(file.size)}.`,
        compress: file.type === "image/gif" ? undefined : "image"
      });
    } else if (kind === "video" && !pinterestVideoTypes.has(file.type)) {
      issues.push({
        id: "pinterest-video-type",
        message: `Pinterest supports MP4 and MOV videos through py3-pinterest; selected file is ${file.type || "unknown"}.`,
        compress: "video"
      });
    } else if (kind === "video" && file.size > pinterestVideoMediaSizeLimit) {
      issues.push({
        id: "pinterest-video-size",
        message: `Pinterest video limit is 100 MB; selected file is ${formatBytes(file.size)}.`,
        compress: "video"
      });
    } else if (kind !== "image" && kind !== "video") {
      issues.push({
        id: "pinterest-kind",
        message: `Pinterest can upload images and MP4/MOV videos only; selected media is a ${mediaKindLabel(kind)}.`
      });
    }
  }

  if (platforms.includes("youtube")) {
    const extension = fileExtension(file.name);
    const supportedExtension = youtubeVideoExtensions.has(extension);
    const supportedContentType = youtubeVideoTypes.has(file.type);

    if (kind !== "video" && !supportedExtension) {
      issues.push({
        id: "youtube-kind",
        message: `YouTube can upload video files only; selected media is a ${mediaKindLabel(kind)}.`
      });
    } else if (!supportedContentType && !supportedExtension) {
      issues.push({
        id: "youtube-video-type",
        message: `YouTube supports common video formats such as MP4, MOV, WebM, AVI, WMV, MPEG, FLV, and 3GPP; selected file is ${file.type || extension || "unknown"}.`,
        compress: "video"
      });
    } else if (file.size > youtubeVideoMediaSizeLimit) {
      issues.push({
        id: "youtube-video-size",
        message: `YouTube video limit is 256 GB; selected file is ${formatBytes(file.size)}.`,
        compress: "video"
      });
    }
  }

  if (platforms.includes("dribbble")) {
    if (kind !== "image") {
      issues.push({
        id: "dribbble-kind",
        message: `Dribbble can upload shot images only; selected media is a ${mediaKindLabel(kind)}.`
      });
    } else if (!dribbbleImageTypes.has(file.type)) {
      issues.push({
        id: "dribbble-image-type",
        message: `Dribbble supports JPG, PNG, and GIF shot images; selected file is ${file.type || "unknown"}.`,
        compress: file.type === "image/gif" ? undefined : "image"
      });
    } else if (
      dimensions &&
      !(
        (dimensions.width === 400 && dimensions.height === 300) ||
        (dimensions.width === 800 && dimensions.height === 600)
      )
    ) {
      issues.push({
        id: "dribbble-image-dimensions",
        message: `Dribbble shot images must be exactly 400x300 or 800x600; selected image is ${dimensions.width}x${dimensions.height}.`,
        crop: file.type === "image/gif" ? undefined : "dribbble"
      });
    } else if (file.size > dribbbleImageMediaSizeLimit) {
      issues.push({
        id: "dribbble-image-size",
        message: `Dribbble shot image limit is 8 MB; selected file is ${formatBytes(file.size)}.`,
        compress: file.type === "image/gif" ? undefined : "image"
      });
    }
  }

  if (platforms.includes("bluesky")) {
    if (kind !== "image") {
      issues.push({
        id: "bluesky-kind",
        message: `Bluesky can upload images only; selected media is a ${mediaKindLabel(kind)}.`
      });
    } else if (!blueskyImageTypes.has(file.type)) {
      issues.push({
        id: "bluesky-type",
        message: `Bluesky supports JPEG, PNG, WebP, and GIF images; selected file is ${file.type || "unknown"}.`,
        compress: "image"
      });
    } else if (file.size > blueskyMaxImageSize) {
      issues.push({
        id: "bluesky-size",
        message: `Bluesky image limit is 1 MB; selected file is ${formatBytes(file.size)}.`,
        compress: "image"
      });
    }
  }

  if (platforms.includes("mastodon")) {
    if (kind === "image" && file.size > mastodonImageSizeLimit) {
      issues.push({
        id: "mastodon-image-size",
        message: `Mastodon image limit on mastodon.social is 16 MB; selected file is ${formatBytes(file.size)}.`,
        compress: "image"
      });
    }

    if (kind === "video" && file.size > mastodonVideoSizeLimit) {
      issues.push({
        id: "mastodon-video-size",
        message: `Mastodon video limit on mastodon.social is about 99 MB; selected file is ${formatBytes(file.size)}.`,
        compress: "video"
      });
    }
  }

  return issues;
}

export function imageTargetBytesForPlatforms(platforms: Platform[], file: File): number | undefined {
  const targets: number[] = [];

  if (platforms.includes("bluesky")) {
    targets.push(blueskyCompressTargetSize);
  }

  if (platforms.includes("instagram") && file.size > instagramPhotoMediaSizeLimit) {
    targets.push(instagramImageTargetSize);
  }

  if (platforms.includes("pinterest") && file.size > pinterestImageMediaSizeLimit) {
    targets.push(pinterestImageTargetSize);
  }

  if (platforms.includes("mastodon") && file.size > mastodonImageSizeLimit) {
    targets.push(mastodonImageTargetSize);
  }

  if (platforms.includes("dribbble") && file.size > dribbbleImageMediaSizeLimit) {
    targets.push(dribbbleImageTargetSize);
  }

  return targets.length ? Math.min(...targets) : undefined;
}

export function videoTargetBytesForPlatforms(platforms: Platform[], file: File, requestedBytes: number): number {
  const targets = [requestedBytes];

  if (platforms.includes("mastodon")) {
    targets.push(mastodonVideoTargetSize);
  }

  if (platforms.includes("linkedin") && file.size > linkedInMaxVideoSize) {
    targets.push(linkedInVideoTargetSize);
  }

  if (platforms.includes("instagram") && file.size > instagramVideoMediaSizeLimit) {
    targets.push(instagramVideoTargetSize);
  }

  if (platforms.includes("youtube") && file.size > youtubeVideoMediaSizeLimit) {
    targets.push(youtubeVideoMediaSizeLimit);
  }

  if (platforms.includes("pinterest") && file.size > pinterestVideoMediaSizeLimit) {
    targets.push(pinterestVideoTargetSize);
  }

  return Math.min(...targets);
}
