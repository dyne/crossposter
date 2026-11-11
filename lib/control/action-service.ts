import { z } from "zod-control";
import { normalizeOptionalUrl, normalizePublishContent } from "@/lib/publishing/contracts";
import { mediaPreflightIssues, requiresLocalMedia } from "@/lib/compose/media-policy";
import { prepareActionInputSchema, type ControlContent, type ControlMedia } from "./contracts";
import { payloadDigest } from "./canonical";
import { ControlError } from "./errors";
import { validateResolvedContent } from "./content-validation";
import { resolveControlTarget, type ResolvedControlTarget } from "./account-binding";
import { actionRevision, type ActionRecord, type StoredAction } from "./action-store";
import { projectControlConfig, projectControlDraft, projectControlMedia, projectControlSchedule } from "./read-projections";
import type { ControlReadConfig, QueuedPost } from "./read-storage";
import { ownerDecisionInputSchema } from "./approval-contracts";
import { queueIntentView } from "./queue-service";
import { rescheduleBinding } from "./reschedule-policy";

type Input = z.infer<typeof prepareActionInputSchema>;
type PublicationInput = Exclude<Input, { mode: "cancel" }>;
type Media = ControlMedia & { dimensions?: { width: number; height: number } };
export type ActionDependencies = {
  readConfig: () => ControlReadConfig;
  readRecords: () => ActionRecord[];
  saveRecord: (record: ActionRecord, expectedRevision?: string | null) => ActionRecord;
  assertMutation: () => void;
  readMedia: (id: string) => Promise<Media>;
  mediaRevision: (id: string) => string;
  bindAccount: (target: ResolvedControlTarget) => string;
  environmentValue: (name: string) => string | undefined;
  timezone: () => string;
  now: () => Date;
  createId: () => string;
  executionView?: (action: StoredAction) => StoredAction;
};

export function normalizeControlContent(content: ControlContent): ControlContent {
  const url = normalizeOptionalUrl(content.linkUrl);
  const normalized = normalizePublishContent({ ...content, linkUrl: typeof url === "string" ? url : undefined });
  return { title: normalized.title ?? "", text: normalized.text, linkUrl: normalized.linkUrl ?? "", mediaId: content.mediaId };
}
function normalizeInput(input: Input): Input {
  if (input.mode === "publish" || input.mode === "schedule") return {
    ...input, content: normalizeControlContent(input.content), ...(input.mode === "schedule" ? { scheduledFor: new Date(input.scheduledFor).toISOString() } : {})
  };
  return input.mode === "reschedule" ? { ...input, scheduledFor: new Date(input.scheduledFor).toISOString() } : input;
}
function scheduledLocal(instant: string, timezone: string): string {
  try { return `${new Intl.DateTimeFormat("en-GB", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23", timeZoneName: "longOffset" }).format(new Date(instant))} [${timezone}]`; }
  catch { throw new ControlError("storage_corrupt"); }
}
const preparatory = new Set(["prepared", "approved"]);

// Cancellation binds the retained queue item, never live publication readiness.
// Keep this private: it also detects raw queue changes hidden by public redaction.
export function cancellationQueueBindings(post: QueuedPost, targetIds: string[]): ActionRecord["accountBindings"] {
  const snapshot = payloadDigest({ purpose: "cancel_queue_v1", post });
  return Object.fromEntries(targetIds.map((targetId) => [targetId, payloadDigest({ snapshot, targetId })]));
}
type PreparationSnapshot = {
  content: ControlContent; targets: StoredAction["outcomes"][number]["target"][];
  media: ControlMedia | null; draftRevision: string | null; bindings: ActionRecord["accountBindings"];
  scheduledFor?: string; timezone: string; local: string | null; warnings: string[]; now: Date;
  scheduleBinding?: string;
};

export function createActionService(deps: ActionDependencies) {
  function selected(config: ControlReadConfig, ids: string[]) {
    const resolved = ids.map((id) => resolveControlTarget(config, id, deps.environmentValue));
    if (resolved.some((item) => !item.valid)) throw new ControlError("validation_failed");
    const bindings = Object.fromEntries(resolved.map((item) => [item.target.id, deps.bindAccount(item)]));
    return { resolved, bindings };
  }
  function retainedSchedule(config: ControlReadConfig, scheduleId: string, expectedRevision: string) {
    const dto = projectControlConfig(config, deps.environmentValue);
    const post = config.scheduledPosts.find((item) => item.id === scheduleId);
    if (!post) throw new ControlError("schedule_missing");
    const schedule = projectControlSchedule(post, dto);
    if (schedule.revision !== expectedRevision || !["scheduled", "failed"].includes(post.status)) throw new ControlError("revision_conflict");
    return { dto, post, schedule };
  }
  function source(config: ControlReadConfig, input: PublicationInput) {
    const dto = projectControlConfig(config, deps.environmentValue);
    if (input.mode === "publish" || input.mode === "schedule") return { dto, content: input.content, ids: input.targetIds, scheduleRevision: null };
    const { post, schedule } = retainedSchedule(config, input.scheduleId, input.expectedRevision);
    const queueBinding = rescheduleBinding(post, deps.readRecords());
    if (!queueBinding) throw new ControlError("revision_conflict");
    const rawContent = { title: post.title ?? "", text: post.text ?? "", linkUrl: post.linkUrl || post.url || "", mediaId: post.media?.id ?? null };
    return { dto, content: normalizeControlContent(rawContent), ids: schedule.targets.map((target) => target.id), scheduleRevision: schedule.revision,
      scheduledFor: schedule.scheduledFor, queueBinding };
  }
  function relevantDraft(config: ControlReadConfig, content: ControlContent, ids: string[], mediaDigest: string | null) {
    const dto = projectControlConfig(config, deps.environmentValue);
    const draftIds = config.draft.targets?.length ? config.draft.targets.map((target) => `${target.platform}:${target.profileId || "base"}`)
      : (config.draft.platforms ?? []).map((platform) => `${platform}:base`);
    if (payloadDigest(normalizeControlContent(dto.content(config.draft))) !== payloadDigest(content) || payloadDigest([...new Set(draftIds)]) !== payloadDigest(ids)) return null;
    return projectControlDraft(config, dto, mediaDigest).revision;
  }
  function validate(content: ControlContent, resolved: ResolvedControlTarget[], media: Media | null, dto: ReturnType<typeof projectControlConfig>) {
    if (content.linkUrl && dto.publicUrl(content.linkUrl) === null) throw new ControlError("validation_failed");
    for (const item of resolved) {
      const target = { id: item.target.id, platform: item.target.platform, ...(item.target.profileId !== null ? { profileId: item.target.profileId } : {}), profileLabel: item.target.label };
      if (!validateResolvedContent(content, [target], (field) => item.values[field]).valid
        || (requiresLocalMedia(target.platform) && !media)) throw new ControlError("validation_failed");
      if (media && (mediaPreflightIssues([{ platform: target.platform, xPremium: item.values.X_PREMIUM_LONG_POSTS === "true" }],
        { name: media.filename, type: media.contentType, size: media.size }, media.dimensions).length
        || (target.platform === "dribbble" && !media.dimensions))) throw new ControlError("validation_failed");
    }
  }
  function safeView(record: ActionRecord, config: ControlReadConfig, state = record.action.state): StoredAction {
    const dto = projectControlConfig(config, deps.environmentValue); const action = record.action;
    if (action.payload.targets.some((target) => dto.containsPrivate(target.label))
      || (action.payload.media && (dto.containsPrivate(action.payload.media.filename) || dto.containsPrivate(action.payload.media.contentType)))
      || action.outcomes.some((outcome) => outcome.url !== null && dto.publicUrl(outcome.url, true) !== outcome.url)
      || (action.payload.content.linkUrl && dto.publicUrl(action.payload.content.linkUrl) === null)) throw new ControlError("storage_corrupt");
    if (state === action.state) return action;
    const view = { ...action, state }; return { ...view, revision: actionRevision(view) };
  }
  function expired(action: StoredAction) {
    return preparatory.has(action.state) && (deps.now().getTime() >= Date.parse(action.expiresAt)
      || ((action.payload.mode === "schedule" || action.payload.mode === "reschedule") && deps.now().getTime() >= Date.parse(action.payload.scheduledFor)));
  }
  function persist(input: Input, inputDigest: string, config: ControlReadConfig, snapshot: PreparationSnapshot): StoredAction {
    const id = deps.createId();
    const publication = { content: snapshot.content, targets: snapshot.targets.map((target) => ({ ...target, identityRevision: payloadDigest({ actionId: id, target }) })),
      media: snapshot.media, draftRevision: snapshot.draftRevision };
    const payload: StoredAction["payload"] = input.mode === "publish" ? { mode: "publish", ...publication }
      : input.mode === "schedule" ? { mode: "schedule", ...publication, scheduledFor: snapshot.scheduledFor! }
        : { mode: input.mode, ...publication, scheduleId: input.scheduleId, expectedRevision: input.expectedRevision, scheduledFor: snapshot.scheduledFor! };
    const action: StoredAction = { id, revision: "", payloadDigest: payloadDigest(payload), payload, state: "prepared", createdAt: snapshot.now.toISOString(),
      expiresAt: new Date(snapshot.now.getTime() + 30 * 60_000).toISOString(), approvalUrl: `/approvals/${id}`, timezone: snapshot.timezone, scheduledLocal: snapshot.local,
      warnings: snapshot.warnings, outcomes: snapshot.targets.map((target) => ({ target, state: "not_dispatched", message: "No execution has been authorized or dispatched.", url: null })), postId: null,
      scheduleId: input.mode === "reschedule" || input.mode === "cancel" ? input.scheduleId : null };
    action.revision = actionRevision(action);
    const saved = deps.saveRecord({ requestKey: input.requestKey, inputDigest, action, accountBindings: snapshot.bindings,
      ...(snapshot.scheduleBinding ? { scheduleBinding: snapshot.scheduleBinding } : {}) });
    return safeView(saved, config, expired(saved.action) ? "expired" : saved.action.state);
  }
  function prepareCancellation(input: Extract<Input, { mode: "cancel" }>, inputDigest: string): StoredAction {
    const initial = retainedSchedule(deps.readConfig(), input.scheduleId, input.expectedRevision);
    const ids = initial.schedule.targets.map((target) => target.id);
    const bindings = cancellationQueueBindings(initial.post, ids);
    deps.assertMutation();
    const latest = deps.readConfig(); const current = retainedSchedule(latest, input.scheduleId, input.expectedRevision);
    if (payloadDigest(cancellationQueueBindings(current.post, ids)) !== payloadDigest(bindings)) throw new ControlError("action_conflict");
    const warnings = ["Cancellation removes only the retained queue item after independent approval and commit. Live account readiness and media bytes are not verified."];
    const content = { ...current.schedule.content };
    if ((current.post.linkUrl || current.post.url) && !content.linkUrl) warnings.push("A retained link cannot be shown safely and is omitted from this cancellation preview.");
    if (content.mediaId && current.dto.containsPrivate(content.mediaId)) {
      content.mediaId = null; warnings.push("A retained media reference cannot be shown safely and is omitted from this cancellation preview.");
    }
    const timezone = deps.timezone();
    return persist(input, inputDigest, latest, { content, targets: current.schedule.targets, bindings,
      media: null, draftRevision: null, scheduledFor: current.schedule.scheduledFor, timezone,
      local: scheduledLocal(current.schedule.scheduledFor, timezone), warnings, now: deps.now() });
  }
  async function readSnapshot(record: ActionRecord, execution = false): Promise<{ action: StoredAction; assertUnchanged: () => ControlReadConfig }> {
    const config = deps.readConfig(); const action = record.action;
    const result = (current: ControlReadConfig, state = action.state, assertUnchanged = () => deps.readConfig()) => ({
      action: safeView(record, current, state), assertUnchanged
    });
    if (record.queueIntent && action.state === "executing" && action.postId === null) {
      const view = queueIntentView(record, config, deps.now());
      if (!execution || view.state !== "executing") return { action: safeView({ ...record, action: view }, config), assertUnchanged: () => deps.readConfig() };
    }
    if (expired(action)) return result(config, "expired");
    if (!preparatory.has(action.state) && !execution) {
      const view = deps.executionView?.(action) ?? action;
      return { action: safeView({ ...record, action: view }, config), assertUnchanged: () => deps.readConfig() };
    }
    if (action.payload.mode === "cancel") {
      const scheduleId = action.payload.scheduleId;
      const unchanged = (latest: ControlReadConfig) => {
        const post = latest.scheduledPosts.find((item) => item.id === scheduleId);
        return post && ["scheduled", "failed"].includes(post.status)
          && payloadDigest(cancellationQueueBindings(post, action.payload.targets.map((target) => target.id))) === payloadDigest(record.accountBindings);
      };
      const assertUnchanged = () => {
        const latest = deps.readConfig();
        if (!unchanged(latest)) throw new ControlError("action_conflict");
        safeView(record, latest); return latest;
      };
      return result(config, unchanged(config) ? action.state : "conflicting", assertUnchanged);
    }
    try {
      const allIds = action.payload.targets.map((target) => target.id);
      const checkedIds = () => {
        // Approval and claim always bind every target. Once executing, a
        // completed provider may legitimately have changed its own session.
        // Re-read outcomes synchronously so an older worker assertion also
        // checks only pending/current targets, never weakening their bindings.
        if (!execution || action.state !== "executing") return allIds;
        const live = deps.readRecords().find((item) => item.action.id === action.id);
        if (!live || live.action.state !== "executing" || live.action.payloadDigest !== action.payloadDigest) throw new ControlError("action_conflict");
        return live.action.outcomes.filter((outcome) => ["not_dispatched", "dispatching"].includes(outcome.state)).map((outcome) => outcome.target.id);
      };
      const unchangedBindings = (bindings: ActionRecord["accountBindings"], ids: string[]) => payloadDigest(bindings)
        === payloadDigest(Object.fromEntries(ids.map((id) => [id, record.accountBindings[id]])));
      const initialIds = checkedIds(); const current = selected(config, initialIds);
      if (!unchangedBindings(current.bindings, initialIds)) return result(config, "conflicting");
      const mediaId = action.payload.content.mediaId;
      const before = mediaId ? deps.mediaRevision(mediaId) : null;
      const media = mediaId ? await deps.readMedia(mediaId) : null;
      // Keep the byte-verified media and its pre-read identity in this closure.
      // A decision invokes it again synchronously after its final await, just
      // before the journal CAS. Account binding also rereads local sessions.
      const assertUnchanged = () => {
        try {
          const latest = deps.readConfig();
          const ids = checkedIds(); const again = selected(latest, ids);
          if (!unchangedBindings(again.bindings, ids)
            || (mediaId && deps.mediaRevision(mediaId) !== before)
            || payloadDigest(media ? projectControlMedia(media, projectControlConfig(latest, deps.environmentValue)) : null) !== payloadDigest(action.payload.media)) throw new ControlError("action_conflict");
          const acceptedQueue = record.queueIntent && (action.state === "scheduled" || action.state === "rescheduled" || action.postId !== null);
          if (!acceptedQueue && action.payload.draftRevision !== null && relevantDraft(latest, action.payload.content, action.payload.targets.map((target) => target.id), media?.digest ?? null) !== action.payload.draftRevision) throw new ControlError("action_conflict");
          if (action.payload.mode === "reschedule" && !acceptedQueue) {
            const payload = action.payload;
            const post = latest.scheduledPosts.find((item) => item.id === payload.scheduleId);
            if (!post || !["scheduled", "failed"].includes(post.status)
              || projectControlSchedule(post, projectControlConfig(latest, deps.environmentValue)).revision !== action.payload.expectedRevision
              || rescheduleBinding(post, deps.readRecords().filter((item) => item.action.id !== action.id)) !== record.scheduleBinding) throw new ControlError("action_conflict");
          }
          safeView(record, latest); return latest;
        } catch (error) {
          if (error instanceof ControlError && ["target_missing", "media_missing", "validation_failed"].includes(error.code)) throw new ControlError("action_conflict");
          throw error;
        }
      };
      return result(assertUnchanged(), expired(action) ? "expired" : action.state, assertUnchanged);
    } catch (error) {
      if (error instanceof ControlError && ["target_missing", "media_missing", "action_conflict", "validation_failed"].includes(error.code)) return result(deps.readConfig(), "conflicting");
      throw error;
    }
  }
  async function view(record: ActionRecord): Promise<StoredAction> { return (await readSnapshot(record)).action; }
  return {
    // Execution reuses the same immutable dependency checks. The caller must
    // invoke assertUnchanged synchronously after its last await before claiming
    // or dispatching. Already claimed work may outlive the approval deadline.
    executionSnapshot: (record: ActionRecord) => readSnapshot(record, true),
    async decide(actionId: string, raw: unknown, assertAuthority: () => void): Promise<StoredAction> {
      const input = ownerDecisionInputSchema.safeParse(raw);
      if (!input.success) throw new ControlError("validation_failed");
      const decision = input.data;
      const record = deps.readRecords().find((item) => item.action.id === actionId);
      if (!record) throw new ControlError("action_missing");
      if (record.action.payloadDigest !== decision.expectedDigest || record.action.expiresAt !== decision.expiresAt) throw new ControlError("action_conflict");
      const previous = record.ownerDecision;
      if (previous ? previous.preparationRevision !== decision.expectedRevision || previous.decision !== decision.decision
        : record.action.revision !== decision.expectedRevision || record.action.state !== "prepared") throw new ControlError("revision_conflict");
      // Reuse the same account/media/draft/queue and deadline validation as the
      // immutable preview. No provider or scheduler is reachable from here.
      const snapshot = await readSnapshot(record); const current = snapshot.action;
      if (current.state === "expired") throw new ControlError("approval_expired");
      if (current.state !== (previous ? (previous.decision === "approve" ? "approved" : "rejected") : "prepared")) throw new ControlError("action_conflict");
      deps.assertMutation();
      // Authentication can expire or be revoked while stored media is read.
      assertAuthority();
      const latest = deps.readRecords().find((item) => item.action.id === actionId);
      if (!latest || latest.action.revision !== record.action.revision) throw new ControlError("revision_conflict");
      const config = snapshot.assertUnchanged();
      const now = deps.now();
      if (now.getTime() >= Date.parse(record.action.expiresAt) || ((record.action.payload.mode === "schedule"
        || record.action.payload.mode === "reschedule") && now.getTime() >= Date.parse(record.action.payload.scheduledFor))) throw new ControlError("approval_expired");
      if (previous) return current;
      const action: StoredAction = { ...record.action, state: decision.decision === "approve" ? "approved" : "rejected" };
      action.revision = actionRevision(action);
      const saved = deps.saveRecord({ ...record, action, ownerDecision: { actionId, payloadDigest: action.payloadDigest,
        preparationRevision: decision.expectedRevision, expiresAt: action.expiresAt, decision: decision.decision, decidedAt: now.toISOString() } }, record.action.revision);
      return safeView(saved, config);
    },
    async get(actionId: string) {
      const record = deps.readRecords().find((item) => item.action.id === actionId);
      if (!record) throw new ControlError("action_missing");
      return view(record);
    },
    async prepare(raw: unknown): Promise<StoredAction> {
      const parsed = prepareActionInputSchema.safeParse(raw);
      if (!parsed.success) throw new ControlError("validation_failed");
      const input = normalizeInput(parsed.data); const inputDigest = payloadDigest(input);
      deps.assertMutation();
      const replay = deps.readRecords().find((item) => item.requestKey === input.requestKey);
      if (replay) {
        if (replay.inputDigest !== inputDigest) throw new ControlError("idempotency_conflict");
        return view(replay);
      }
      if (input.mode === "cancel") return prepareCancellation(input, inputDigest);
      const config = deps.readConfig(); const initial = source(config, input); const accounts = selected(config, initial.ids);
      const instant = input.mode === "schedule" || input.mode === "reschedule" ? input.scheduledFor : undefined;
      if ((input.mode === "schedule" || input.mode === "reschedule") && Date.parse(instant!) <= deps.now().getTime()) throw new ControlError("validation_failed");
      const timezone = deps.timezone(); const displayTime = scheduledLocal(instant ?? deps.now().toISOString(), timezone);
      const local = instant ? displayTime : null;
      const mediaId = initial.content.mediaId; const before = mediaId ? deps.mediaRevision(mediaId) : null;
      const media = mediaId ? await deps.readMedia(mediaId) : null;
      validate(initial.content, accounts.resolved, media, initial.dto);
      const draftRevision = input.mode === "publish" || input.mode === "schedule"
        ? relevantDraft(config, initial.content, initial.ids, media?.digest ?? null) : null;
      const verifiedMedia = mediaId ? await deps.readMedia(mediaId) : null;
      if (payloadDigest(media ? projectControlMedia(media, initial.dto) : null)
        !== payloadDigest(verifiedMedia ? projectControlMedia(verifiedMedia, initial.dto) : null)) throw new ControlError("action_conflict");
      deps.assertMutation();
      const raced = deps.readRecords().find((item) => item.requestKey === input.requestKey);
      if (raced) { if (raced.inputDigest !== inputDigest) throw new ControlError("idempotency_conflict"); return view(raced); }
      const latest = deps.readConfig(); const current = source(latest, input); const latestAccounts = selected(latest, current.ids);
      if (payloadDigest(accounts.bindings) !== payloadDigest(latestAccounts.bindings)
        || payloadDigest(current.content) !== payloadDigest(initial.content) || payloadDigest(current.ids) !== payloadDigest(initial.ids)
        || ("queueBinding" in initial && initial.queueBinding !== ("queueBinding" in current ? current.queueBinding : null))
        || (mediaId && deps.mediaRevision(mediaId) !== before) || deps.timezone() !== timezone
        || (draftRevision !== null && relevantDraft(latest, initial.content, initial.ids, media?.digest ?? null) !== draftRevision)) throw new ControlError("action_conflict");
      const now = deps.now();
      if ((input.mode === "schedule" || input.mode === "reschedule") && Date.parse(instant!) <= now.getTime()) throw new ControlError("validation_failed");
      const identities = accounts.resolved.map(({ target }) => ({ id: target.id, platform: target.platform, profileId: target.profileId, label: target.label }));
      return persist(input, inputDigest, latest, { content: initial.content, targets: identities, media: media ? projectControlMedia(media, current.dto) : null,
        ...("queueBinding" in initial ? { scheduleBinding: initial.queueBinding } : {}),
        draftRevision, bindings: accounts.bindings, scheduledFor: instant, timezone, local, now,
        warnings: ["Provider authentication and account identity are not independently verified. Approval binds the selected configuration and local session snapshot."] });
    }
  };
}
