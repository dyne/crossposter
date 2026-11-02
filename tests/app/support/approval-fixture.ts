import type { ControlAction } from "@/lib/control/contracts";
import { payloadDigest } from "@/lib/control/canonical";

export const approvalFixtureTime = "2026-10-28T12:00:00.000Z";
export const fixtureOwnerPassword = "synthetic-owner-password";
export const fixtureOwnerSession = { authenticated: true as const, csrf: "cd".repeat(32), expiresAt: "2026-10-28T12:15:00.000Z" };
export function approvalFixture(overrides: Partial<ControlAction> = {}): ControlAction {
  const targets = [{ id: "bluesky:editorial", platform: "bluesky" as const, profileId: "editorial", label: "Editorial account", identityRevision: payloadDigest("editorial") },
    { id: "mastodon:community", platform: "mastodon" as const, profileId: "community", label: "Community account", identityRevision: payloadDigest("community") }];
  const payload = { mode: "schedule" as const, content: { title: "Synthetic approval fixture", text: "Exact fixture text.\nA second line stays intact.", linkUrl: "https://example.test/fixture?edition=2#details", mediaId: null }, targets,
    media: null, draftRevision: null, scheduledFor: "2026-10-28T13:00:00.000Z" };
  const action: ControlAction = { id: "fixture-approval", state: "prepared", revision: "", payload, payloadDigest: payloadDigest(payload),
    createdAt: approvalFixtureTime, expiresAt: "2026-10-28T12:30:00.000Z", approvalUrl: "/approvals/fixture-approval", timezone: "Europe/Berlin",
    scheduledLocal: "28/10/2026, 14:00:00 GMT+01:00 [Europe/Berlin]", warnings: ["Synthetic fixture. Provider authentication is not independently verified."],
    outcomes: targets.map((target) => ({ target: { id: target.id, platform: target.platform, profileId: target.profileId, label: target.label }, state: "not_dispatched", message: "No execution has been authorized or dispatched.", url: null })), postId: null, scheduleId: null, ...overrides };
  action.payloadDigest = payloadDigest(action.payload); const revisionFields: Partial<ControlAction> = { ...action }; delete revisionFields.revision;
  action.revision = payloadDigest(revisionFields); return action;
}
