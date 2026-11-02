import { actionRevision, type ActionRecord, type StoredAction } from "./action-store";
import { controlTools } from "./contracts";
import { ControlError } from "./errors";
import type { ControlReadConfig } from "./read-storage";

type Snapshot = { action: StoredAction; assertUnchanged: () => ControlReadConfig };
export type ExecutionDependencies = {
  readRecords: () => ActionRecord[];
  saveRecord: (record: ActionRecord, expectedRevision: string) => ActionRecord;
  assertMutation: () => void;
  snapshot: (record: ActionRecord) => Promise<Snapshot>;
  now: () => Date;
  // No request/signal is passed to the backend-owned worker. Until the
  // per-target provider adapter is installed, commit fails before a claim.
  run?: (record: ActionRecord, assertCurrent: () => void) => Promise<void>;
};

const replayable = new Set<StoredAction["state"]>(["executing", "succeeded", "partial", "failed", "uncertain", "scheduled", "rescheduled", "canceled"]);

// One service per owned backend root. The journal, rather than this task map,
// suppresses duplicate dispatch after a process exits or a response is lost.
export function createExecutionService(deps: ExecutionDependencies) {
  const tasks = new Map<string, Promise<void>>();
  let stopping = false;
  function record(id: string) {
    const found = deps.readRecords().find((item) => item.action.id === id);
    if (!found) throw new ControlError("action_missing", id);
    return found;
  }
  function save(current: ActionRecord, action: StoredAction) {
    deps.assertMutation();
    action.revision = actionRevision(action);
    return deps.saveRecord({ ...current, action }, current.action.revision);
  }
  function interrupt(current: ActionRecord) {
    // A retained claim is never replayed, even if it had not reached a provider.
    // A dispatching intent is positive evidence of a possibly external write.
    return save(current, { ...current.action, state: "uncertain", outcomes: current.action.outcomes.map((outcome) =>
      outcome.state === "dispatching" ? { ...outcome, state: "uncertain", message: "Publication may have completed. Reconcile the account before preparing another attempt." }
        : outcome.state === "not_dispatched" ? { ...outcome, message: "Execution stopped before this target was dispatched. It will not resume automatically." } : outcome) });
  }
  function recover() {
    deps.assertMutation();
    for (const current of deps.readRecords()) {
      if (current.action.state === "executing" && !tasks.has(current.action.id)) interrupt(current);
    }
  }
  async function work(claim: ActionRecord) {
    try {
      const snapshot = await deps.snapshot(claim);
      if (snapshot.action.state !== "executing") throw new ControlError("action_conflict");
      const assertCurrent = () => {
        if (stopping) throw new ControlError("backend_unavailable");
        deps.assertMutation();
        const current = record(claim.action.id);
        if (current.action.state !== "executing") throw new ControlError("action_conflict");
        snapshot.assertUnchanged();
      };
      assertCurrent();
      await deps.run!(claim, assertCurrent);
    } finally {
      // A runner which exits, throws or fails to retain a final result cannot
      // leave an executable claim behind. Storage/ownership errors are kept as
      // a claim for conservative recovery by the next healthy backend.
      const current = record(claim.action.id);
      if (current.action.state === "executing") interrupt(current);
    }
  }
  return {
    recover,
    async commit(raw: unknown): Promise<StoredAction> {
      const parsed = controlTools.commit_action.inputSchema.safeParse(raw);
      if (!parsed.success) throw new ControlError("validation_failed");
      const { actionId, expectedDigest } = parsed.data;
      try {
        if (stopping) throw new ControlError("backend_unavailable");
        recover();
        const current = record(actionId);
        if (current.action.payloadDigest !== expectedDigest) throw new ControlError("action_conflict");
        if (replayable.has(current.action.state)) return current.action;
        if (current.action.state === "rejected") throw new ControlError("approval_rejected");
        if (current.action.state === "expired") throw new ControlError("approval_expired");
        if (current.action.state === "conflicting") throw new ControlError("action_conflict");
        if (current.action.state !== "approved" || current.ownerDecision?.decision !== "approve") throw new ControlError("approval_required");
        // L7 adds queue modes; they must never fall through to immediate publish.
        if (current.action.payload.mode !== "publish") throw new ControlError("validation_failed");
        const snapshot = await deps.snapshot(current);
        if (snapshot.action.state === "expired") throw new ControlError("approval_expired");
        if (snapshot.action.state !== "approved") throw new ControlError("action_conflict");
        // No await may separate these checks and the durable claim. This also
        // closes the final Promise gap after account/media/session IO.
        deps.assertMutation();
        const latest = record(actionId);
        if (latest.action.revision !== current.action.revision) {
          if (replayable.has(latest.action.state)) return latest.action;
          throw new ControlError("revision_conflict");
        }
        snapshot.assertUnchanged();
        if (deps.now().getTime() >= Date.parse(current.action.expiresAt)) throw new ControlError("approval_expired");
        if (stopping || !deps.run) throw new ControlError("backend_unavailable");
        const claim = save(current, { ...current.action, state: "executing", postId: current.action.postId ?? `action-${current.action.id}` });
        // Register before the first worker continuation and before returning to
        // any caller. Concurrent commits observe exactly this retained claim.
        const task = Promise.resolve().then(() => work(claim)).catch(() => {
          // Never log provider/storage exception text. The retained claim or
          // terminal action is the observation and recovery path.
        }).finally(() => { tasks.delete(actionId); });
        tasks.set(actionId, task);
        return claim.action;
      } catch (error) {
        throw new ControlError(error instanceof ControlError ? error.code : "internal_error", actionId);
      }
    },
    active: () => tasks.size,
    has: (id: string) => tasks.has(id),
    // Stop new claims and further dispatch, then settle work already in flight.
    // A forced process exit leaves intent for restart reconciliation.
    async shutdown() { stopping = true; await Promise.allSettled(tasks.values()); },
    async settled() { await Promise.allSettled(tasks.values()); }
  };
}
export type ExecutionService = ReturnType<typeof createExecutionService>;
