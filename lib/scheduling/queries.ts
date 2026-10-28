import type { ScheduledPost } from "@/lib/types";

export function scheduledQueue(posts: ScheduledPost[]): ScheduledPost[] {
  return posts
    .filter((post) => post.status === "scheduled" || post.status === "publishing" || post.status === "failed")
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

export function findScheduledPost(posts: ScheduledPost[], id: string): ScheduledPost | undefined {
  return posts.find((post) => post.id === id);
}
