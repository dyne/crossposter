"use client";

import { useEffect, useRef, useState } from "react";
import type { PublishResult, PublishedPost } from "@/lib/types";
import { composeClient, formatApiError, type UploadedMedia } from "@/lib/compose/client";
import type { ProgressState } from "@/lib/compose/media-conversion";
import { mediaPreflightIssues } from "@/lib/compose/media-policy";
import { publishTargetFromCard, type ChannelTarget } from "@/lib/compose/channels";
import { datetimeLocalToIso, datetimeLocalValue, formatDateTime, futureScheduleValue, isAbortError, type ProgressPlacement } from "@/lib/compose/presentation";
import { postLimitIssuesForTargets, titleLimitIssues } from "@/lib/platform-limits";
import type { LimitTarget } from "@/lib/compose/validation";
import type { useComposerDraft } from "./use-composer-draft";
import type { useComposerMedia } from "./use-composer-media";

type Draft = Pick<ReturnType<typeof useComposerDraft>, "title" | "text" | "linkUrl" | "setPublishedPosts" | "clearDraft">;
type Media = Pick<ReturnType<typeof useComposerMedia>,
  "mediaFile" | "isUploadingMedia" | "isCompressingMedia" | "isCroppingMedia" |
  "mediaDimensionsForPreflight" | "uploadSelectedMedia" | "clearProgressLater"
>;
type Options = { draft: Draft; media: Media; selectedTargets: ChannelTarget[]; selectedLimitTargets: LimitTarget[] };

export function useComposerActions({ draft, media, selectedTargets, selectedLimitTargets }: Options) {
  const { title, text, linkUrl, setPublishedPosts } = draft;
  const { mediaFile, isUploadingMedia, isCompressingMedia, isCroppingMedia, mediaDimensionsForPreflight, uploadSelectedMedia } = media;
  const [error, setError] = useState("");
  const [scheduleStatus, setScheduleStatus] = useState("");
  const [isPublishing, setIsPublishing] = useState(false);
  const [isScheduling, setIsScheduling] = useState(false);
  const [progress, setProgress] = useState<ProgressState | null>(null);
  const [progressPlacement, setProgressPlacement] = useState<ProgressPlacement>("top");
  const publishAbortRef = useRef<AbortController | null>(null);
  useEffect(() => () => publishAbortRef.current?.abort(), []);
  const [schedulePanelPlacement, setSchedulePanelPlacement] = useState<ProgressPlacement | null>(null);
  const [scheduleStatusPlacement, setScheduleStatusPlacement] = useState<ProgressPlacement>("top");
  const [scheduledForInput, setScheduledForInput] = useState("");
  const [results, setResults] = useState<PublishResult[]>([]);

  useEffect(() => {
    setScheduledForInput((current) => current || datetimeLocalValue());
  }, []);

  function resetFeedback() { setError(""); setResults([]); setScheduleStatus(""); }
  async function clearDraft() { resetFeedback(); await draft.clearDraft(); }
  function toggleSchedulePanel(placement: ProgressPlacement) {
    setScheduledForInput((current) => futureScheduleValue(current));
    setSchedulePanelPlacement((current) => (current === placement ? null : placement));
    setScheduleStatusPlacement(placement);
    setScheduleStatus("");
  }

  function closeSchedulePanel() {
    setSchedulePanelPlacement(null);
  }

  async function clearPublishedPosts() {
    setProgressPlacement("top");
    setProgress({ label: "Clearing publish history", value: 60 });
    setPublishedPosts([]);
    await composeClient.clearHistory().catch(() => undefined);
    setProgress(null);
  }

  function cancelPublishAction() {
    const controller = publishAbortRef.current;

    if (!controller) {
      return;
    }

    setProgress((current) =>
      current ? { ...current, label: "Cancelling" } : { label: "Cancelling", value: 10 }
    );
    controller.abort();
  }

  async function publish(placement: ProgressPlacement = "top") {
    setError("");
    setScheduleStatus("");
    setResults([]);
    setProgress(null);
    setProgressPlacement(placement);
    let uploadedMedia: UploadedMedia | undefined;
    const publishTargets = selectedTargets.map(publishTargetFromCard);
    const publishPlatforms = Array.from(new Set(publishTargets.map((target) => target.platform)));

    if (publishTargets.length === 0) {
      setError("Select at least one connected social profile.");
      return;
    }

    const hasHackerNews = publishPlatforms.includes("hackernews");
    const hasInstagram = publishPlatforms.includes("instagram");
    const hasYouTube = publishPlatforms.includes("youtube");
    const hasDribbble = publishPlatforms.includes("dribbble");
    const hasPinterest = publishPlatforms.includes("pinterest");
    const hasOnlyTextOptionalPlatforms = publishPlatforms.every((platform) =>
      platform === "hackernews" ||
      platform === "dribbble" ||
      platform === "pinterest"
    );

    if ((hasHackerNews || hasYouTube || hasDribbble) && !title.trim()) {
      setError(
        [hasHackerNews ? "Hacker News" : "", hasYouTube ? "YouTube" : "", hasDribbble ? "Dribbble" : ""]
          .filter(Boolean)
          .join(", ") + " require a title."
      );
      return;
    }

    if (!text.trim() && !hasOnlyTextOptionalPlatforms) {
      setError(
        hasDribbble && publishPlatforms.length === 1
          ? "Write post text for the Dribbble description, or leave it empty to publish without a description."
          : hasHackerNews
            ? "Write post text before publishing, or select only Hacker News and add a title."
            : "Write post text before publishing."
      );
      return;
    }

    if (hasInstagram && !mediaFile) {
      setError("Instagram requires a local image or video file.");
      return;
    }

    if (hasYouTube && !mediaFile) {
      setError("YouTube requires a local video file.");
      return;
    }

    if (hasDribbble && !mediaFile) {
      setError("Dribbble requires a local shot image.");
      return;
    }

    if (hasPinterest && !mediaFile) {
      setError("Pinterest requires a local image or video file.");
      return;
    }

    const limitIssues = [
      ...titleLimitIssues(publishPlatforms, title),
      ...postLimitIssuesForTargets(selectedLimitTargets, text)
    ];

    if (limitIssues.length > 0) {
      setError(limitIssues[0].message);
      return;
    }

    const dimensions = await mediaDimensionsForPreflight(mediaFile);
    const preflightIssues = mediaPreflightIssues(selectedLimitTargets, mediaFile, dimensions);

    if (preflightIssues.length > 0) {
      setError(preflightIssues[0].message);
      return;
    }

    setIsPublishing(true);
    setProgress({ label: mediaFile ? "Preparing media upload" : "Preparing publish", value: 8 });
    const controller = new AbortController();

    publishAbortRef.current = controller;

    try {
      uploadedMedia = await uploadSelectedMedia(controller.signal);
      setProgress({ label: "Sending to selected channels", value: uploadedMedia ? 45 : 25 });
      const { ok, body } = await composeClient.publish({
        title: title.trim() || undefined,
        text,
        linkUrl: linkUrl.trim() || undefined,
        mediaId: uploadedMedia?.id,
        platforms: publishPlatforms,
        targets: publishTargets
        }, controller.signal);

      if (!ok) {
        setError(formatApiError(body.error));
        return;
      }

      setProgress({ label: "Saving publish output", value: 90 });
      if (body.publishedPost) {
        setResults([]);
        setPublishedPosts((current) => [
          body.publishedPost as PublishedPost,
          ...current.filter((post) => post.id !== body.publishedPost?.id)
        ]);
      } else {
        setResults(body.results || []);
      }
      setProgress({ label: "Publish complete", value: 100 });
    } catch (publishError) {
      setError(
        isAbortError(publishError)
          ? "Publish cancelled."
          : publishError instanceof Error
            ? publishError.message
            : "Publish failed"
      );
    } finally {
      if (publishAbortRef.current === controller) {
        publishAbortRef.current = null;
      }

      setIsPublishing(false);
      media.clearProgressLater();
    }
  }

  async function scheduleDraft(placement: ProgressPlacement = "top") {
    setError("");
    setScheduleStatus("");
    setResults([]);
    setProgress(null);
    setProgressPlacement(placement);
    let uploadedMedia: UploadedMedia | undefined;
    const publishTargets = selectedTargets.map(publishTargetFromCard);
    const publishPlatforms = Array.from(new Set(publishTargets.map((target) => target.platform)));
    const scheduledFor = datetimeLocalToIso(scheduledForInput);

    if (publishTargets.length === 0) {
      setError("Select at least one connected social profile.");
      return;
    }

    const hasHackerNews = publishPlatforms.includes("hackernews");
    const hasInstagram = publishPlatforms.includes("instagram");
    const hasYouTube = publishPlatforms.includes("youtube");
    const hasDribbble = publishPlatforms.includes("dribbble");
    const hasPinterest = publishPlatforms.includes("pinterest");
    const hasOnlyTextOptionalPlatforms = publishPlatforms.every((platform) =>
      platform === "hackernews" ||
      platform === "dribbble" ||
      platform === "pinterest"
    );

    if ((hasHackerNews || hasYouTube || hasDribbble) && !title.trim()) {
      setError(
        [hasHackerNews ? "Hacker News" : "", hasYouTube ? "YouTube" : "", hasDribbble ? "Dribbble" : ""]
          .filter(Boolean)
          .join(", ") + " require a title."
      );
      return;
    }

    if (!text.trim() && !hasOnlyTextOptionalPlatforms) {
      setError(
        hasDribbble && publishPlatforms.length === 1
          ? "Write post text for the Dribbble description, or leave it empty to schedule without a description."
          : hasHackerNews
            ? "Write post text before scheduling, or select only Hacker News and add a title."
            : "Write post text before scheduling."
      );
      return;
    }

    if (hasInstagram && !mediaFile) {
      setError("Instagram requires a local image or video file.");
      return;
    }

    if (hasYouTube && !mediaFile) {
      setError("YouTube requires a local video file.");
      return;
    }

    if (hasDribbble && !mediaFile) {
      setError("Dribbble requires a local shot image.");
      return;
    }

    if (hasPinterest && !mediaFile) {
      setError("Pinterest requires a local image or video file.");
      return;
    }

    if (!scheduledFor) {
      setError("Choose a valid scheduled time.");
      return;
    }

    if (Date.parse(scheduledFor) < Date.now() - 60_000) {
      setError("Choose a scheduled time in the future.");
      return;
    }

    const limitIssues = [
      ...titleLimitIssues(publishPlatforms, title),
      ...postLimitIssuesForTargets(selectedLimitTargets, text)
    ];

    if (limitIssues.length > 0) {
      setError(limitIssues[0].message);
      return;
    }

    const dimensions = await mediaDimensionsForPreflight(mediaFile);
    const preflightIssues = mediaPreflightIssues(selectedLimitTargets, mediaFile, dimensions);

    if (preflightIssues.length > 0) {
      setError(preflightIssues[0].message);
      return;
    }

    setIsScheduling(true);
    setProgress({ label: mediaFile ? "Preparing scheduled media" : "Saving schedule", value: 8 });
    const controller = new AbortController();

    publishAbortRef.current = controller;

    try {
      uploadedMedia = await uploadSelectedMedia(controller.signal);
      setProgress({ label: "Writing scheduled post", value: uploadedMedia ? 58 : 35 });
      const { ok, body } = await composeClient.schedule({
        title: title.trim() || undefined,
        text,
        linkUrl: linkUrl.trim() || undefined,
        mediaId: uploadedMedia?.id,
        platforms: publishPlatforms,
        targets: publishTargets,
        scheduledFor
        }, controller.signal);

      if (!ok) {
        setError(formatApiError(body.error));
        return;
      }

      setProgress({ label: "Scheduled", value: 100 });
      setScheduleStatusPlacement(placement);
      setScheduleStatus(`Scheduled for ${formatDateTime(body.scheduledPost?.scheduledFor || scheduledFor)}.`);
      setScheduledForInput(datetimeLocalValue());
      setSchedulePanelPlacement(null);
    } catch (scheduleError) {
      setError(
        isAbortError(scheduleError)
          ? "Schedule cancelled."
          : scheduleError instanceof Error
            ? scheduleError.message
            : "Scheduling failed"
      );
    } finally {
      if (publishAbortRef.current === controller) {
        publishAbortRef.current = null;
      }

      setIsScheduling(false);
      media.clearProgressLater();
    }
  }

  const actionProgress = progress && !isCompressingMedia && !isCroppingMedia ? progress : null;
  const topActionProgress = actionProgress && progressPlacement === "top" ? actionProgress : null;
  const publishButtonLabel = isCompressingMedia
    ? "Compressing..."
    : isCroppingMedia
      ? "Cropping..."
      : isUploadingMedia
      ? "Uploading..."
      : isPublishing
        ? "Publishing..."
        : "Publish draft";
  const cancelProgressAction =
    publishAbortRef.current && (isPublishing || isScheduling || isUploadingMedia)
      ? cancelPublishAction
      : undefined;


  const scheduledForIso = datetimeLocalToIso(scheduledForInput);
  return {
    error, results, progress, setError, setProgress, resetFeedback,
    isPublishing, isScheduling, scheduleStatus, scheduleStatusPlacement,
    schedulePanelPlacement, scheduledForInput, setScheduledForInput, setScheduleStatus,
    scheduledForIso, toggleSchedulePanel, closeSchedulePanel, clearDraft, clearPublishedPosts,
    publish, scheduleDraft, topActionProgress, publishButtonLabel, cancelProgressAction
  };
}
