import "server-only";
import type { ActionRecord } from "./action-store";
import { readActionJournal } from "./action-store";
import { dataRoot } from "@/lib/runtime-paths";
import type { PublishedPost, ScheduledPost } from "@/lib/types";
import type { OutcomeView } from "@/lib/publication-outcomes";

// Observation stays passive. Unavailable journal evidence is never replaced by
// a guessed not-dispatched result, nor persisted back to the original record.
export function dashboardOutcomeRecords(): ActionRecord[] {
  try { return readActionJournal(dataRoot()).records; } catch { return []; }
}
export function publicationOutcomeView<T extends PublishedPost | ScheduledPost>(post: T, records: ActionRecord[]): OutcomeView<T> {
  const record = "scheduledFor" in post
    ? records.find(({ action }) => post.authorization && action.id === post.authorization.actionId
      && action.payloadDigest === post.authorization.payloadDigest && action.scheduleId === post.id)
    : records.find(({ action }) => action.postId === post.id);
  return record ? { ...post, outcomes: record.action.outcomes } : post;
}
