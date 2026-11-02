import { actionRevision, type ActionRecord, type StoredAction } from "./action-store";
import { controlTools } from "./contracts";
import { ControlError } from "./errors";
import type { ControlReadConfig } from "./read-storage";
import type { ApprovedQueue } from "./queue-service";
import type { ScheduledPost } from "@/lib/types";

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
  queue?: ApprovedQueue;
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
      if (current.action.state === "executing" && !tasks.has(current.action.id)) {
        if (current.queueIntent && !current.action.postId) deps.queue?.reconcile(current);
        else interrupt(current);
      }
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
        if (claim.queueIntent) deps.queue!.assertDispatch(current);
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
  function start(claim: ActionRecord) {
    const actionId = claim.action.id;
    const task = Promise.resolve().then(() => work(claim)).catch(() => {
      // The retained claim or terminal action is the only recovery path.
    }).finally(() => { tasks.delete(actionId); });
    tasks.set(actionId, task);
  }
  function scheduledRecord(post: ScheduledPost) {
    if (!deps.queue || !post.authorization) throw new ControlError("action_conflict");
    const current = record(post.authorization.actionId);
    if (current.action.payloadDigest !== post.authorization.payloadDigest || current.action.scheduleId !== post.id
      || !current.queueIntent || current.ownerDecision?.decision !== "approve") throw new ControlError("action_conflict");
    return current;
  }
  return {
    recover,
    recoverScheduled(post: ScheduledPost): StoredAction | null {
      deps.assertMutation(); const current = scheduledRecord(post);
      if (tasks.has(current.action.id)) return null;
      if (["scheduled", "rescheduled"].includes(current.action.state)) {
        // Queue ownership survived, but no execution claim/provider intent did.
        // Record that distinction and stop; recovery never initiates dispatch.
        deps.queue!.assertDispatch(current);
        const claim = save(current, { ...current.action, state: "executing", postId: `action-${current.action.id}` });
        return interrupt(claim).action;
      }
      if (current.action.state === "executing" && current.action.postId) return interrupt(current).action;
      if (current.action.postId && ["succeeded", "partial", "failed", "uncertain"].includes(current.action.state)) return current.action;
      throw new ControlError("action_conflict");
    },
    async dispatchScheduled(post: ScheduledPost): Promise<StoredAction> {
      if (stopping || !deps.queue || !deps.run || !post.authorization) throw new ControlError("backend_unavailable");
      deps.assertMutation();
      const current = scheduledRecord(post);
      if (!["scheduled", "rescheduled"].includes(current.action.state)) throw new ControlError("action_conflict");
      deps.queue.assertDispatch(current);
      // The accepted job keeps its authorization beyond the preparation
      // deadline, while account/media identities remain bound at dispatch.
      const claim = save(current, { ...current.action, state: "executing", postId: `action-${current.action.id}` });
      start(claim);
      await tasks.get(claim.action.id);
      return record(claim.action.id).action;
    },
    async commit(raw: unknown): Promise<StoredAction> {
      const parsed = controlTools.commit_action.inputSchema.safeParse(raw);
      if (!parsed.success) throw new ControlError("validation_failed");
      const { actionId, expectedDigest } = parsed.data;
      try {
        if (stopping) throw new ControlError("backend_unavailable");
        recover();
        const current = record(actionId);
        if (current.action.payloadDigest !== expectedDigest) throw new ControlError("action_conflict");
        const pendingQueue = current.action.state === "executing" && current.queueIntent && !current.action.postId;
        if (replayable.has(current.action.state) && !pendingQueue) return current.action;
        if (current.action.state === "rejected") throw new ControlError("approval_rejected");
        if (current.action.state === "expired") throw new ControlError("approval_expired");
        if (current.action.state === "conflicting") throw new ControlError("action_conflict");
        if ((!pendingQueue && current.action.state !== "approved") || current.ownerDecision?.decision !== "approve") throw new ControlError("approval_required");
        if (current.action.payload.mode !== "publish" && !deps.queue) throw new ControlError("backend_unavailable");
        const snapshot = await deps.snapshot(current);
        if (snapshot.action.state === "expired") throw new ControlError("approval_expired");
        if (snapshot.action.state !== (pendingQueue ? "executing" : "approved")) throw new ControlError("action_conflict");
        // No await may separate these checks and the durable claim. This also
        // closes the final Promise gap after account/media/session IO.
        deps.assertMutation();
        const latest = record(actionId);
        if (latest.action.revision !== current.action.revision) {
          if (replayable.has(latest.action.state)) return latest.action;
          throw new ControlError("revision_conflict");
        }
        const config = snapshot.assertUnchanged();
        if (deps.now().getTime() >= Date.parse(current.action.expiresAt)) throw new ControlError("approval_expired");
        if (current.action.payload.mode !== "publish") {
          const payload = current.action.payload;
          if (payload.mode !== "cancel" && deps.now().getTime() >= Date.parse(payload.scheduledFor)) throw new ControlError("approval_expired");
          if (stopping) throw new ControlError("backend_unavailable");
          const intent = pendingQueue ? current : deps.queue!.intent(current, config);
          const claim = pendingQueue ? current : save(intent, { ...intent.action, state: "executing" });
          return deps.queue!.apply(claim, () => { if (stopping) throw new ControlError("backend_unavailable"); snapshot.assertUnchanged(); });
        }
        if (stopping || !deps.run) throw new ControlError("backend_unavailable");
        const claim = save(current, { ...current.action, state: "executing", postId: current.action.postId ?? `action-${current.action.id}` });
        // Register before the first worker continuation and before returning to
        // any caller. Concurrent commits observe exactly this retained claim.
        start(claim);
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
