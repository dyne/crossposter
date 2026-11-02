import "server-only";
import { getScheduledPosts, removeScheduledPost, updateScheduledPost } from "@/lib/local-config";
import { runPublish } from "@/lib/publish-runner";
import { schedulerState, startSchedulerTimer, stopSchedulerTimer } from "@/lib/scheduling/lifecycle";
import { createScheduledTickService } from "@/lib/scheduling/service";
import { assertBackendMutation } from "@/lib/control/backend-mutation";
import { dataRoot } from "@/lib/runtime-paths";
import { readControlCredential } from "@/lib/control/auth";
import { backendExecution } from "@/lib/control/execution-backend";
import { actionHistory } from "@/lib/control/approved-publisher";
import { readActionJournal } from "@/lib/control/action-store";
import { failedPublishPost, interruptedScheduledPost } from "@/lib/scheduling/policy";
import { ControlError } from "@/lib/control/errors";

const shutdownKey = Symbol.for("crossposter.scheduler-shutdown.v1");
const globals = globalThis as typeof globalThis & { [shutdownKey]?: boolean };
if (!globals[shutdownKey]) {
  globals[shutdownKey] = true;
  for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => stopSchedulerTimer(schedulerState()));
}

export async function runScheduledTick(requestUrl = "http://localhost:2004/api/scheduled/tick") {
  const owner = assertBackendMutation(dataRoot());
  return createScheduledTickService({
    store: { getScheduledPosts, updateScheduledPost, removeScheduledPost },
    publish: runPublish,
    recover: () => {
      const backend = owner ? backendExecution(dataRoot(), readControlCredential(dataRoot()).credential.token) : null;
      try { backend?.recover(); }
      catch (error) { if (!(error instanceof ControlError) || error.code !== "action_conflict") throw error; }
      const records = owner ? readActionJournal(dataRoot()).records : [];
      for (const post of getScheduledPosts()) {
        const linked = records.find((record) => record.queueIntent && record.action.scheduleId === post.id
          && (!post.authorization || record.action.id === post.authorization.actionId));
        if (post.status !== "publishing" && !(post.status === "failed" && linked?.action.postId)) continue;
        if (post.authorization || linked) {
          let action;
          try { action = backend?.recoverScheduled(post); }
          catch (error) {
            if (!(error instanceof ControlError) || !["action_conflict", "action_missing"].includes(error.code)) throw error;
            if (post.status === "publishing") updateScheduledPost(post.id, (current) => interruptedScheduledPost(current, new Date()));
            continue;
          }
          if (!action) continue;
          const publishedPost = actionHistory(action); const result = { results: publishedPost.results, publishedPost };
          const completed = { ...failedPublishPost(post, result, new Date()), attempts: post.status === "publishing" ? post.attempts + 1 : Math.max(post.attempts, 1),
            ...(action.outcomes.every((outcome) => outcome.state === "not_dispatched")
              ? { lastError: "Execution stopped before any target was dispatched. It will not resume automatically." } : {}) };
          if (post.status !== "failed" || JSON.stringify([post.results, post.publishedPostId, post.lastError]) !== JSON.stringify([completed.results, completed.publishedPostId, completed.lastError])) {
            updateScheduledPost(post.id, () => completed);
          }
          if (result.results.some((outcome) => outcome.ok)) removeScheduledPost(post.id);
        } else updateScheduledPost(post.id, (current) => interruptedScheduledPost(current, new Date()));
      }
    },
    isApproved: (post) => Boolean(owner && readActionJournal(dataRoot()).records.some((record) => record.queueIntent && record.action.scheduleId === post.id)),
    publishApproved: async (post) => {
      const credential = readControlCredential(dataRoot()).credential;
      const action = await backendExecution(dataRoot(), credential.token).dispatchScheduled(post);
      const publishedPost = actionHistory(action);
      return { results: publishedPost.results, publishedPost };
    },
    now: () => new Date(),
    state: schedulerState()
  })(requestUrl);
}

export function ensureSchedulerStarted(requestUrl = "http://localhost:2004/api/scheduled/tick") {
  if (process.env.POSTER_DISABLE_SCHEDULER === "true") {
    return;
  }

  assertBackendMutation(dataRoot());

  startSchedulerTimer(schedulerState(), runScheduledTick, requestUrl);
}
