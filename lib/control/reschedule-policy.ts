import "server-only";
import type { ScheduledPost } from "@/lib/types";
import type { QueuedPost } from "./read-storage";
import type { ActionRecord } from "./action-store";
import { payloadDigest } from "./canonical";
import { neverAttemptedSchedule } from "@/lib/scheduling/reschedule-policy";

type Post = QueuedPost | ScheduledPost;

// A token binds eligibility to the journal evidence as well as queue bytes.
// Only terminal, all-not-dispatched failures prove a failed attempt safe.
export function rescheduleBinding(post: Post, records: ActionRecord[]): string | null {
  if (!["scheduled", "failed"].includes(post.status) || ("publishedAt" in post && post.publishedAt)
    || post.results?.some((result) => result.ok || result.uncertain || result.url)) return null;
  const linked = records.filter((record) => record.queueIntent && record.action.scheduleId === post.id);
  if (linked.some(({ action }) => action.state === "uncertain" || action.outcomes.length === 0
    || action.outcomes.some((outcome) => outcome.state !== "not_dispatched"))) return null;
  const authorized = post.authorization && linked.find(({ action }) => action.id === post.authorization!.actionId
    && action.payloadDigest === post.authorization!.payloadDigest);
  if ((post.authorization || linked.length) && !authorized) return null;
  if (authorized && (post.status === "failed" ? authorized.action.state !== "failed"
    : !["scheduled", "rescheduled", "failed"].includes(authorized.action.state))) return null;
  const untouched = neverAttemptedSchedule(post);
  if (!untouched && post.attempts < 1) return null;
  function provenAttempts(record: ActionRecord, visited = new Set<string>()): number | null {
    const intent = record.queueIntent;
    if (!intent || visited.has(record.action.id) || record.ownerDecision?.decision !== "approve") return null;
    visited.add(record.action.id);
    if (intent.attempts > 0) {
      const prior = linked.find((item) => item.action.id === intent.supersedes);
      if (!prior || provenAttempts(prior, visited) !== intent.attempts) return null;
    } else if (intent.publishedPostId || intent.results?.length) return null;
    if (record.action.state === "failed" && record.action.postId) return intent.attempts + 1;
    return ["scheduled", "rescheduled", "canceled"].includes(record.action.state) ? intent.attempts : null;
  }
  const proven = authorized && provenAttempts(authorized) === post.attempts
    && (!post.publishedPostId || linked.some(({ action }) => action.state === "failed" && action.postId === post.publishedPostId));
  if (!untouched && !proven) return null;
  if (untouched && authorized && !["scheduled", "rescheduled"].includes(authorized.action.state)) return null;
  return payloadDigest({ post, evidence: linked.map(({ action }) => [action.id, action.revision]) });
}
