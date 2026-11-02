import type { ExecutionService } from "./execution-service";
import type { StoredAction } from "./action-store";
import { actionRevision } from "./action-store";

type Entry = { token: string; service: ExecutionService };
const key = Symbol.for("crossposter.control-executions.v1");
const globals = globalThis as typeof globalThis & { [key]?: Map<string, Entry> };
export const executionBackends = globals[key] ??= new Map<string, Entry>();

// Pure projection: a newly started backend never promises to resume orphaned
// work. Persisting this recovery happens at the next authenticated mutation.
export function interruptedAction(action: StoredAction): StoredAction {
  const view = { ...action, state: "uncertain" as const, outcomes: action.outcomes.map((outcome) =>
    outcome.state === "dispatching" ? { ...outcome, state: "uncertain" as const, message: "Publication may have completed. Reconcile the account before preparing another attempt." }
      : outcome.state === "not_dispatched" ? { ...outcome, message: "Execution stopped before this target was dispatched. It will not resume automatically." } : outcome) };
  return { ...view, revision: actionRevision(view) };
}
export function executionView(root: string, action: StoredAction) {
  return action.state === "executing" && !executionBackends.get(root)?.service.has(action.id) ? interruptedAction(action) : action;
}
