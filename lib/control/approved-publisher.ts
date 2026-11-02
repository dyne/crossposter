import "server-only";
import { createPublishService } from "@/lib/publishing/service";
import { withPublicationConfig } from "@/lib/publishing/config-context";
import type { ProviderRegistry } from "@/lib/publishing/provider";
import type { ProviderContext, PublishedPost, PublishResult, PublishTarget } from "@/lib/types";
import { platformIds } from "@/lib/platform-catalog";
import { actionRevision, type ActionRecord, type StoredAction } from "./action-store";
import { createActionService, type ActionDependencies } from "./action-service";
import { resolveControlTarget } from "./account-binding";
import { projectControlConfig } from "./read-projections";
import { ControlError } from "./errors";
import type { ControlOutcome } from "./contracts";
import { interruptedAction } from "./execution-state";

export type ApprovedPublishDependencies = ActionDependencies & {
  providers: ProviderRegistry;
  readUploadedMedia: (id: string) => Promise<ProviderContext["media"]>;
  appendHistory: (post: PublishedPost) => PublishedPost | undefined;
  assertContext: () => void;
};
function summary(outcomes: ControlOutcome[]): StoredAction["state"] {
  if (outcomes.some((outcome) => outcome.state === "uncertain" || outcome.state === "dispatching")) return "uncertain";
  const successes = outcomes.filter((outcome) => outcome.state === "succeeded").length;
  return successes === outcomes.length ? "succeeded" : successes ? "partial" : "failed";
}
export function actionHistory(action: StoredAction): PublishedPost {
  const payload = action.payload;
  return { id: action.postId!, createdAt: action.createdAt, title: payload.content.title, text: payload.content.text, linkUrl: payload.content.linkUrl,
    platforms: [...new Set(payload.targets.map((target) => target.platform))],
    targets: payload.targets.map((target) => ({ id: target.id, platform: target.platform, ...(target.profileId ? { profileId: target.profileId } : {}), profileLabel: target.label })),
    results: action.outcomes.map((outcome) => ({ platform: outcome.target.platform, targetId: outcome.target.id,
      ...(outcome.target.profileId ? { profileId: outcome.target.profileId } : {}), profileLabel: outcome.target.label,
      ok: outcome.state === "succeeded", ...(outcome.state === "uncertain" || outcome.state === "dispatching" ? { uncertain: true } : {}),
      message: outcome.message, ...(outcome.url ? { url: outcome.url } : {}) })),
    ...(payload.media ? { media: { id: payload.media.id, filename: payload.media.filename, contentType: payload.media.contentType,
      size: payload.media.size, kind: payload.media.kind, url: payload.media.url } } : {}) };
}

// Reuse incumbent validation, provider invocation and exception mapping. This
// adapter owns only approved configuration, durable boundaries and safe results.
export function createApprovedPublisher(deps: ApprovedPublishDependencies) {
  const actions = createActionService(deps);
  return async (claim: ActionRecord, assertCurrent: () => void) => {
    const id = claim.action.id;
    const read = () => {
      const record = deps.readRecords().find((item) => item.action.id === id);
      if (!record) throw new ControlError("action_missing");
      return record;
    };
    const save = (record: ActionRecord, action: StoredAction) => {
      deps.assertMutation(); action.revision = actionRevision(action);
      return deps.saveRecord({ ...record, action }, record.action.revision);
    };
    try {
      const config = deps.readConfig();
      const redactor = projectControlConfig(config, deps.environmentValue);
      const resolved = claim.action.payload.targets.map((target) => resolveControlTarget(config, target.id, deps.environmentValue));
      const providers = Object.fromEntries(platformIds.map((platform) => [platform, async (ctx: ProviderContext) => {
        const exact = resolved.find((item) => item.target.id === ctx.target?.id && item.target.platform === platform);
        if (!exact) throw new ControlError("action_conflict");
        return withPublicationConfig(exact.values, () => deps.providers[platform](ctx));
      }])) as ProviderRegistry;
      const targetLifecycle = {
        // Dispatch intent already exists. A rejection without a returned
        // definitive result can follow remote acceptance, even for non-Errors.
        classifyException: () => "uncertain" as const,
        beforeDispatch: async (target: PublishTarget) => {
          const before = read(); const snapshot = await actions.executionSnapshot(before);
          if (snapshot.action.state !== "executing") throw new ControlError("action_conflict");
          return () => {
            deps.assertContext(); assertCurrent(); snapshot.assertUnchanged();
            const current = read();
            if (current.action.revision !== before.action.revision) throw new ControlError("revision_conflict");
            const outcome = current.action.outcomes.find((item) => item.target.id === target.id);
            if (outcome?.state !== "not_dispatched") throw new ControlError("action_conflict");
            save(current, { ...current.action, outcomes: current.action.outcomes.map((item) => item === outcome
              ? { ...item, state: "dispatching", message: "Provider dispatch is in progress." } : item) });
            // Ownership/context may also have failed during durable replacement.
            // A visible intent then remains conservative, with no provider call.
            deps.assertContext(); assertCurrent(); snapshot.assertUnchanged();
          };
        },
        afterResult: (target: PublishTarget, result: PublishResult) => {
          const current = read();
          if (current.action.outcomes.find((item) => item.target.id === target.id)?.state !== "dispatching") throw new ControlError("action_conflict");
          const contradictory = result.targetId !== target.id || result.platform !== target.platform
            || (result.profileId ?? null) !== (target.profileId ?? null) || (result.ok && result.uncertain === true);
          const state = contradictory || result.uncertain ? "uncertain" : result.ok ? "succeeded" : "failed";
          // Use both the frozen and latest configuration when possible. Raw
          // exception text and private URLs never reach the journal or history.
          let url = state === "succeeded" ? redactor.publicUrl(result.url, true) : null;
          if (url && url.length > 2048) url = null;
          if (url) { try { url = projectControlConfig(deps.readConfig(), deps.environmentValue).publicUrl(url, true); } catch { url = null; } }
          const message = state === "succeeded" ? "Publication succeeded." : state === "failed" ? "Publication failed."
            : "Publication outcome is uncertain. Inspect the account before another attempt.";
          save(current, { ...current.action, outcomes: current.action.outcomes.map((outcome) => outcome.target.id === target.id ? { ...outcome, state, message, url } : outcome) });
        }
      };
      const publish = createPublishService({ providers, targetLifecycle,
        getConfigValue: (name, profileId) => resolved.find((item) => (item.target.profileId ?? undefined) === profileId && Object.hasOwn(item.values, name))?.values[name] || undefined,
        getProfileConfigIssues: () => [], getUploadedMedia: deps.readUploadedMedia,
        appendPublishedPost: () => undefined, now: deps.now, createId: () => claim.action.postId!,
        assertCanPublish: deps.assertMutation });
      const content = claim.action.payload.content;
      await publish({ title: content.title, text: content.text, linkUrl: content.linkUrl, ...(content.mediaId ? { mediaId: content.mediaId } : {}),
        targets: claim.action.payload.targets.map((target) => ({ id: target.id, platform: target.platform,
          ...(target.profileId ? { profileId: target.profileId } : {}), profileLabel: target.label })),
        platforms: [...new Set(claim.action.payload.targets.map((target) => target.platform))] });
    } finally {
      let current = read();
      if (current.action.state === "executing") {
        const recovered = interruptedAction(current.action);
        current = save(current, { ...recovered, state: summary(recovered.outcomes) });
      }
      // The action journal is authoritative even if the compatible legacy
      // history write fails. The stable post ID also has a journal-backed read.
      if (current.action.postId && !deps.readConfig().publishedPosts.some((post) => post.id === current.action.postId)) deps.appendHistory(actionHistory(current.action));
    }
  };
}
