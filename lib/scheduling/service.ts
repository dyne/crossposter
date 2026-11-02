import "server-only";
import type { PublishRunInput, PublishRunResult } from "@/lib/publishing/service";
import type { ScheduledPost } from "@/lib/types";
import { dueScheduledPosts, failedExceptionPost, failedPublishPost, publishingPost, scheduledClaimRevision } from "./policy";

export interface ScheduledQueueStore {
  getScheduledPosts(): ScheduledPost[];
  updateScheduledPost(id: string, update: (current: ScheduledPost) => ScheduledPost): ScheduledPost | undefined;
  removeScheduledPost(id: string): ScheduledPost[];
}

export type ScheduledClaim =
  | { kind: "claimed"; post: ScheduledPost }
  | { kind: "skipped"; reason: "missing" | "not-scheduled" | "not-due" | "changed" };

export type ScheduledTickState = { running: boolean };

export type ScheduledTickDependencies = {
  store: ScheduledQueueStore;
  publish: (input: PublishRunInput) => Promise<PublishRunResult>;
  publishApproved?: (post: ScheduledPost) => Promise<PublishRunResult>;
  isApproved?: (post: ScheduledPost) => boolean;
  recover?: () => void;
  now: () => Date;
  state: ScheduledTickState;
};

// This is a synchronous local update, not a lock or an ownership token.
export function claimScheduledPost(store: ScheduledQueueStore, id: string, now: Date, expected?: ScheduledPost): ScheduledClaim {
  let transitioned = false;
  let reason: Extract<ScheduledClaim, { kind: "skipped" }>["reason"] = "not-scheduled";
  const saved = store.updateScheduledPost(id, (current) => {
    if (current.status !== "scheduled") return current;
    if (!(Date.parse(current.scheduledFor) <= now.getTime())) { reason = "not-due"; return current; }
    if (expected && scheduledClaimRevision(current) !== scheduledClaimRevision(expected)) { reason = "changed"; return current; }
    transitioned = true;
    return publishingPost(current, now);
  });

  if (!saved) return { kind: "skipped", reason: "missing" };
  if (!transitioned || saved.status !== "publishing") return { kind: "skipped", reason };
  return { kind: "claimed", post: saved };
}

export function createScheduledTickService(dependencies: ScheduledTickDependencies) {
  const { store, publish, now, state } = dependencies;

  return async function runScheduledTick(requestUrl = "http://localhost:2004/api/scheduled/tick") {
    if (state.running) return { processed: 0, skipped: true };
    state.running = true;

    try {
      dependencies.recover?.();
      const tickTime = now();
      const due = dueScheduledPosts(store.getScheduledPosts(), tickTime);
      let processed = 0;

      for (const post of due) {
        const claim = claimScheduledPost(store, post.id, now(), post);
        if (claim.kind === "skipped") continue;

        const locked = claim.post;
        let retainedResult: PublishRunResult | undefined;
        let attemptNumber = locked.attempts + 1;
        try {
          const approved = locked.authorization || dependencies.isApproved?.(locked);
          const result = approved ? await (dependencies.publishApproved?.(locked) ?? Promise.reject(new Error("Approved scheduling is unavailable."))) : await publish({
            title: locked.title,
            text: locked.text,
            linkUrl: locked.linkUrl,
            mediaId: locked.media?.id,
            platforms: locked.platforms,
            targets: locked.targets,
            requestUrl,
            now: now()
          });
          retainedResult = result;
          const ok = result.results.some((item) => item.ok);
          const completedAt = now();

          // The complete result is durable in the queue before removal. A
          // returned history record (or approved action-backed equivalent)
          // establishes the retained observation after that removal.
          store.updateScheduledPost(locked.id, (current) => {
            const completed = failedPublishPost(current, result, completedAt);
            attemptNumber = completed.attempts; return completed;
          });
          if (ok && result.publishedPost) {
            store.removeScheduledPost(locked.id);
          }
        } catch (error) {
          const failedAt = now();
          store.updateScheduledPost(locked.id, (current) => retainedResult
            ? { ...failedPublishPost(current, retainedResult, failedAt), attempts: Math.max(current.attempts, attemptNumber),
              lastError: error instanceof Error ? error.message : "Scheduled result cleanup failed" }
            : failedExceptionPost(current, error, failedAt));
        }

        processed += 1;
      }

      return { processed, skipped: false };
    } finally {
      state.running = false;
    }
  };
}
