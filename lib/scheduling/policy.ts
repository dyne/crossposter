import type { PublishRunResult } from "@/lib/publishing/service";
import type { ScheduledPost } from "@/lib/types";

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
  return {
    ...current,
    status: "failed",
    attempts: current.attempts + 1,
    updatedAt: completedAt.toISOString(),
    ...(result.publishedPost ? { publishedPostId: result.publishedPost.id } : {}),
    results: result.results,
    lastError: result.results.some((item) => item.uncertain)
      ? "Publish outcome is unknown. Check the profile before rescheduling; it may already be live."
      : "No selected channel published successfully."
  };
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
