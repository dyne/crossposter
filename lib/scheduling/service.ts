import "server-only";
import type { PublishRunInput, PublishRunResult } from "@/lib/publishing/service";
import type { ScheduledPost } from "@/lib/types";
import { dueScheduledPosts, failedExceptionPost, failedPublishPost, publishingPost } from "./policy";

export interface ScheduledQueueStore {
  getScheduledPosts(): ScheduledPost[];
  updateScheduledPost(id: string, update: (current: ScheduledPost) => ScheduledPost): ScheduledPost | undefined;
  removeScheduledPost(id: string): ScheduledPost[];
}

export type ScheduledClaim =
  | { kind: "claimed" | "already-publishing"; post: ScheduledPost }
  | { kind: "skipped"; reason: "missing" | "not-publishing" };

export type ScheduledTickState = { running: boolean };

export type ScheduledTickDependencies = {
  store: ScheduledQueueStore;
  publish: (input: PublishRunInput) => Promise<PublishRunResult>;
  now: () => Date;
  state: ScheduledTickState;
};

// This is a synchronous local update, not a lock or an ownership token.
export function claimScheduledPost(store: ScheduledQueueStore, id: string, now: Date): ScheduledClaim {
  let transitioned = false;
  const saved = store.updateScheduledPost(id, (current) => {
    transitioned = current.status === "scheduled";
    return publishingPost(current, now);
  });

  if (!saved) return { kind: "skipped", reason: "missing" };
  if (saved.status !== "publishing") return { kind: "skipped", reason: "not-publishing" };
  return { kind: transitioned ? "claimed" : "already-publishing", post: saved };
}

export function createScheduledTickService(dependencies: ScheduledTickDependencies) {
  const { store, publish, now, state } = dependencies;

  return async function runScheduledTick(requestUrl = "http://localhost:2004/api/scheduled/tick") {
    if (state.running) return { processed: 0, skipped: true };
    state.running = true;

    try {
      const tickTime = now();
      const due = dueScheduledPosts(store.getScheduledPosts(), tickTime);
      let processed = 0;

      for (const post of due) {
        const claim = claimScheduledPost(store, post.id, tickTime);
        if (claim.kind === "skipped") continue;

        // Preserve the legacy dispatch of already-publishing entries from a stale
        // due snapshot. The explicit claim result does not add ownership guarantees.
        const locked = claim.post;
        try {
          const result = await publish({
            title: locked.title,
            text: locked.text,
            linkUrl: locked.linkUrl,
            mediaId: locked.media?.id,
            platforms: locked.platforms,
            targets: locked.targets,
            requestUrl,
            now: now()
          });
          const ok = result.results.some((item) => item.ok);
          const completedAt = now();

          if (ok) {
            store.removeScheduledPost(locked.id);
          } else {
            store.updateScheduledPost(locked.id, (current) => failedPublishPost(current, result, completedAt));
          }
        } catch (error) {
          const failedAt = now();
          store.updateScheduledPost(locked.id, (current) => failedExceptionPost(current, error, failedAt));
        }

        processed += 1;
      }

      return { processed, skipped: false };
    } finally {
      state.running = false;
    }
  };
}
