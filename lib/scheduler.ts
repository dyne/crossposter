import "server-only";
import { getScheduledPosts, removeScheduledPost, updateScheduledPost } from "@/lib/local-config";
import { runPublish } from "@/lib/publish-runner";
import { schedulerState, startSchedulerTimer } from "@/lib/scheduling/lifecycle";
import { createScheduledTickService } from "@/lib/scheduling/service";
import { assertBackendMutation } from "@/lib/control/backend-mutation";
import { dataRoot } from "@/lib/runtime-paths";

export async function runScheduledTick(requestUrl = "http://localhost:2004/api/scheduled/tick") {
  assertBackendMutation(dataRoot());
  return createScheduledTickService({
    store: { getScheduledPosts, updateScheduledPost, removeScheduledPost },
    publish: runPublish,
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
