import { isPlatform, platformLabels } from "@/lib/platform-catalog";
import type { PublishResult, PublishTarget, PublishedPost, ScheduledPost } from "@/lib/types";
import type { ControlOutcome } from "@/lib/control/contracts";

// Response-only journal projection. Storage codecs deliberately ignore it;
// presentation evidence never authorizes a mutation or a retry.
export type OutcomeView<T> = T & { outcomes?: ControlOutcome[] };
export type PublicationView = OutcomeView<PublishedPost>;
export type ScheduleView = OutcomeView<ScheduledPost>;
export type OutcomeRow = { key: string; label: string; state: "Published" | "Failed" | "Outcome unknown" | "Not sent"; message: string; url?: string };

export const inspectBeforeNewAttempt = "Inspect the remote account before composing a deliberate new attempt. It may already contain this post; do not repeat published accounts.";

export function publicationRows(results: PublishResult[], targets: PublishTarget[] = [], outcomes?: ControlOutcome[], waiting = false): OutcomeRow[] {
  const entries = outcomes?.length ? outcomes.map((outcome) => ({ platform: outcome.target.platform, targetId: outcome.target.id,
    profileId: outcome.target.profileId ?? undefined, profileLabel: outcome.target.label, ok: outcome.state === "succeeded",
    uncertain: outcome.state === "uncertain" || outcome.state === "dispatching", message: outcome.message, url: outcome.url ?? undefined,
    notSent: outcome.state === "not_dispatched" })) : results.map((result) => ({ ...result, notSent: false }));
  for (const target of outcomes?.length ? [] : targets) {
    const matches = entries.filter((entry) => entry.targetId ? entry.targetId === target.id
      : entry.platform === target.platform && (entry.profileId ?? null) === (target.profileId ?? null));
    if (matches.length === 0) entries.push({ platform: target.platform, targetId: target.id, profileId: target.profileId,
      profileLabel: target.profileLabel, ok: false, uncertain: !waiting, notSent: waiting,
      message: waiting ? "Waiting for the scheduled time. No attempt has started." : "No definitive result is retained for this account.", url: undefined });
  }
  return entries.map((entry, index) => {
    const channel = isPlatform(entry.platform) ? platformLabels[entry.platform] : entry.platform;
    const profile = entry.profileLabel || entry.profileId || (entries.filter((item) => item.platform === entry.platform).length > 1 ? entry.targetId : "");
    const state = entry.uncertain ? "Outcome unknown" : entry.notSent ? "Not sent" : entry.ok ? "Published" : "Failed";
    return { key: `${entry.targetId || entry.platform}:${index}`, label: profile && profile !== channel ? `${channel} · ${profile}` : channel,
      state, message: entry.message || (state === "Published" ? "Publication succeeded." : "No additional message was retained."),
      ...(entry.url ? { url: entry.url } : {}) };
  });
}

export function outcomeSummary(rows: OutcomeRow[]): string {
  return (["Published", "Failed", "Outcome unknown", "Not sent"] as const).flatMap((state) => {
    const count = rows.filter((row) => row.state === state).length;
    return count ? [`${count} ${state.toLowerCase()}`] : [];
  }).join(" · ");
}
