import type { ScheduledPost } from "@/lib/types";

type TimingPost = Pick<ScheduledPost, "status" | "attempts" | "publishedPostId" | "publishedAt"> & { results?: readonly unknown[] };

// Browser-safe conservative fallback. A failed label or an empty URL never
// establishes that a provider was not called.
export function neverAttemptedSchedule(post: TimingPost): boolean {
  return post.status === "scheduled" && post.attempts === 0 && !post.results?.length
    && !post.publishedPostId && !post.publishedAt;
}
