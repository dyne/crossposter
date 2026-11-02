import type { PublishRunResult } from "@/lib/publishing/service";
import type { PublishResult, PublishTarget, ScheduledPost } from "@/lib/types";

// An internal snapshot token; field order in this tuple is deliberate. It is
// never exposed as a public control revision or used as provider authority.
export function scheduledClaimRevision(post: ScheduledPost): string {
  return JSON.stringify([post.id, post.createdAt, post.updatedAt, post.scheduledFor, post.title, post.text, post.linkUrl,
    post.platforms, post.targets, post.media, post.status, post.attempts, post.lastError, post.results,
    post.publishedPostId, post.publishedAt, post.authorization]);
}

export function dueScheduledPosts(posts: ScheduledPost[], now: Date): ScheduledPost[] {
  return posts
    .filter((post) => post.status === "scheduled" && Date.parse(post.scheduledFor) <= now.getTime())
    .sort((a, b) => Date.parse(a.scheduledFor) - Date.parse(b.scheduledFor));
}

export function publishingPost(current: ScheduledPost, now: Date): ScheduledPost {
  if (current.status !== "scheduled") {
    return current;
  }

  return { ...current, status: "publishing", updatedAt: now.toISOString(), lastError: undefined };
}

export function failedPublishPost(current: ScheduledPost, result: PublishRunResult, completedAt: Date): ScheduledPost {
  const success = result.results.some((item) => item.ok);
  return {
    ...current,
    status: "failed",
    attempts: current.attempts + 1,
    updatedAt: completedAt.toISOString(),
    ...(result.publishedPost ? { publishedPostId: result.publishedPost.id } : {}),
    results: result.results,
    lastError: result.results.some((item) => item.uncertain)
      ? "Publish outcome is unknown. Check the profile before rescheduling; it may already be live."
      : success ? "Publication results are retained. Do not repeat successful targets."
        : "No selected channel published successfully."
  };
}

export function interruptedScheduledPost(current: ScheduledPost, now: Date): ScheduledPost {
  const targets: PublishTarget[] = current.targets?.length ? current.targets : current.platforms.map((platform) => ({ id: platform, platform }));
  const matches = (result: PublishResult, target: PublishTarget) => result.platform === target.platform
    && (result.targetId ? result.targetId === target.id && (!result.profileId || result.profileId === target.profileId)
      : (result.profileId ?? null) === (target.profileId ?? null));
  return { ...current, status: "failed", attempts: current.attempts + 1, updatedAt: now.toISOString(),
    lastError: "Scheduled execution was interrupted. Inspect retained outcomes before preparing another attempt.",
    results: targets.map((target) => {
      const known = (current.results ?? []).filter((result) => matches(result, target) && targets.filter((item) => matches(result, item)).length === 1);
      return known.length === 1 ? known[0] : { platform: target.platform, targetId: target.id, ...(target.profileId ? { profileId: target.profileId } : {}),
        ok: false, uncertain: true, message: "Interrupted execution has no definitive retained result. Inspect the account before another attempt." };
    }) };
}

export function failedExceptionPost(current: ScheduledPost, error: unknown, failedAt: Date): ScheduledPost {
  return {
    ...current,
    status: "failed",
    attempts: current.attempts + 1,
    updatedAt: failedAt.toISOString(),
    lastError: error instanceof Error ? error.message : "Scheduled publish failed"
  };
}
