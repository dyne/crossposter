import type { ScheduledPost } from "@/lib/types";
import { actionRevision, type ActionRecord, type StoredAction } from "./action-store";
import { payloadDigest } from "./canonical";
import { ControlError } from "./errors";
import type { ControlReadConfig } from "./read-storage";
import { rescheduleBinding } from "./reschedule-policy";
import { publishingPost } from "@/lib/scheduling/policy";

export type QueueDependencies = {
  readConfig: () => ControlReadConfig;
  readRecords: () => ActionRecord[];
  saveRecord: (record: ActionRecord, expectedRevision: string) => ActionRecord;
  assertMutation: () => void;
  now: () => Date;
  replace: (id: string, post: ScheduledPost | null) => void;
};
export function approvedScheduleId(action: StoredAction) {
  return action.payload.mode === "schedule" ? `schedule-${payloadDigest({ actionId: action.id }).slice(7)}` : action.payload.mode === "publish" ? null : action.payload.scheduleId;
}
const retained = (post: ScheduledPost) => ({ ...post, ...(post.media ? { media: { id: post.media.id } } : {}) });
function desired(record: ActionRecord): ScheduledPost | null {
  const { action, queueIntent: intent } = record; const payload = action.payload;
  if (!intent || payload.mode === "publish") throw new ControlError("storage_corrupt");
  if (payload.mode === "cancel") return null;
  return { id: approvedScheduleId(action)!, createdAt: intent.createdAt, updatedAt: intent.updatedAt,
    scheduledFor: payload.scheduledFor, ...(payload.content.title ? { title: payload.content.title } : {}), text: payload.content.text,
    ...(payload.content.linkUrl ? { linkUrl: payload.content.linkUrl } : {}),
    platforms: [...new Set(payload.targets.map((target) => target.platform))],
    targets: payload.targets.map((target) => ({ id: target.id, platform: target.platform,
      ...(target.profileId ? { profileId: target.profileId } : {}), profileLabel: target.label })),
    ...(payload.media ? { media: { id: payload.media.id, filename: payload.media.filename, contentType: payload.media.contentType,
      size: payload.media.size, kind: payload.media.kind, url: payload.media.url } } : {}),
    status: "scheduled", attempts: intent.attempts,
    ...(intent.results ? { results: intent.results.map((result) => ({ ...result, message: result.message ?? "" })) } : {}),
    ...(intent.lastError ? { lastError: intent.lastError } : {}),
    ...(intent.publishedPostId ? { publishedPostId: intent.publishedPostId } : {}),
    authorization: { actionId: action.id, payloadDigest: action.payloadDigest } };
}
const finalState = (record: ActionRecord) => record.action.payload.mode === "schedule" ? "scheduled" as const
  : record.action.payload.mode === "reschedule" ? "rescheduled" as const : "canceled" as const;
function deadlinePassed(action: StoredAction, now: Date) {
  return now.getTime() >= Date.parse(action.expiresAt) || ((action.payload.mode === "schedule" || action.payload.mode === "reschedule")
    && now.getTime() >= Date.parse(action.payload.scheduledFor));
}
function inspectIntent(record: ActionRecord, config: ControlReadConfig) {
  const existing = config.scheduledPosts.find((post) => post.id === approvedScheduleId(record.action));
  const replacement = desired(record); const digest = existing ? payloadDigest(existing) : null;
  const after = replacement ? payloadDigest(retained(replacement)) : null;
  return { kind: digest === after ? "applied" as const : digest === record.queueIntent!.beforeDigest ? "pending" as const : "conflicting" as const, replacement };
}
// Pure reads explain an orphaned queue intent without repairing either file.
// Exact accepted bytes take precedence over expiry; changed bytes conflict.
export function queueIntentView(record: ActionRecord, config: ControlReadConfig, now: Date): StoredAction {
  const action = record.action; const current = inspectIntent(record, config);
  const state: StoredAction["state"] = current.kind === "applied" ? finalState(record) : current.kind === "conflicting" ? "conflicting"
    : deadlinePassed(action, now) ? "expired" : "executing";
  if (state === action.state) return action;
  const view = { ...action, state, ...(state === "expired" ? { outcomes: action.outcomes.map((outcome) => outcome.state === "not_dispatched"
    ? { ...outcome, message: "This approved queue change expired before it was applied." } : outcome) } : {}) };
  return { ...view, revision: actionRevision(view) };
}

// Queue intent and queue replacement are separate durable writes. The stable
// ID, frozen replacement and retained before-image digest make that gap
// recoverable without inserting or applying the same change a second time.
export function createApprovedQueue(deps: QueueDependencies) {
  function save(record: ActionRecord, state: StoredAction["state"]) {
    deps.assertMutation();
    const action = { ...record.action, state }; action.revision = actionRevision(action);
    return deps.saveRecord({ ...record, action }, record.action.revision).action;
  }
  function inspect(record: ActionRecord) {
    const current = inspectIntent(record, deps.readConfig());
    if (current.kind === "conflicting") {
      save(record, "conflicting"); throw new ControlError("action_conflict");
    }
    return { applied: current.kind === "applied", replacement: current.replacement };
  }
  function expire(record: ActionRecord) {
    const action = queueIntentView(record, deps.readConfig(), deps.now());
    if (action.state !== "expired") throw new ControlError("action_conflict");
    deps.assertMutation(); return deps.saveRecord({ ...record, action }, record.action.revision).action;
  }
  function finalize(record: ActionRecord) {
    const previous = deps.readRecords().find((item) => item.action.id === record.queueIntent?.supersedes);
    if (previous && ["scheduled", "rescheduled"].includes(previous.action.state)) save(previous, "canceled");
    return save(record, finalState(record));
  }
  return {
    assertDispatch(record: ActionRecord) {
      const post = deps.readConfig().scheduledPosts.find((item) => item.id === approvedScheduleId(record.action));
      const expected = desired(record);
      const claimed = expected && post && publishingPost(expected, new Date(post.updatedAt));
      // Match the durable claim: JSON storage omits the cleared error field.
      if (claimed && claimed.lastError === undefined) delete claimed.lastError;
      if (!post || !expected || post.status !== "publishing" || Date.parse(post.scheduledFor) > deps.now().getTime()
        || !claimed || payloadDigest(post) !== payloadDigest(retained(claimed))) throw new ControlError("action_conflict");
    },
    intent(record: ActionRecord, config: ControlReadConfig): ActionRecord {
      if (record.action.payload.mode === "publish") throw new ControlError("validation_failed");
      const id = approvedScheduleId(record.action)!;
      const previous = config.scheduledPosts.find((post) => post.id === id);
      if (record.action.payload.mode === "schedule" ? Boolean(previous) : !previous || !["scheduled", "failed"].includes(previous.status)) throw new ControlError("revision_conflict");
      if (record.action.payload.mode === "reschedule" && (!previous
        || rescheduleBinding(previous, deps.readRecords()) !== record.scheduleBinding)) throw new ControlError("action_conflict");
      const now = deps.now().toISOString();
      return { ...record, action: { ...record.action, scheduleId: id }, queueIntent: {
        beforeDigest: previous ? payloadDigest(previous) : null, createdAt: previous?.createdAt ?? now,
        updatedAt: now, attempts: previous?.attempts ?? 0, ...(previous?.publishedPostId ? { publishedPostId: previous.publishedPostId } : {}),
        ...(previous?.results ? { results: previous.results } : {}),
        ...(previous && "lastError" in previous && typeof previous.lastError === "string" ? { lastError: previous.lastError } : {}),
        ...(previous?.authorization ? { supersedes: previous.authorization.actionId } : {}) } };
    },
    reconcile(record: ActionRecord): StoredAction | null {
      if (!record.queueIntent) throw new ControlError("storage_corrupt");
      if (inspect(record).applied) return finalize(record);
      return deadlinePassed(record.action, deps.now()) ? expire(record) : null;
    },
    apply(record: ActionRecord, assertCurrent: () => void): StoredAction {
      const current = inspect(record);
      if (current.applied) return finalize(record);
      assertCurrent(); deps.assertMutation();
      if (deadlinePassed(record.action, deps.now())) { expire(record); throw new ControlError("approval_expired"); }
      deps.replace(approvedScheduleId(record.action)!, current.replacement);
      // If replacement succeeded but acknowledgement/finalization failed,
      // restart recognizes these exact bytes and only finishes the journal.
      if (!inspect(record).applied) throw new ControlError("storage_unavailable");
      return finalize(record);
    }
  };
}
export type ApprovedQueue = ReturnType<typeof createApprovedQueue>;
