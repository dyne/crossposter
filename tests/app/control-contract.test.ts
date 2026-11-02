import { describe, expect, it } from "vitest";
import { z } from "zod-control";
import {
  actionPayloadSchema, actionSchema, controlTools, errorCodes, platformSchema,
  timestampSchema, targetSchema, publishInputSchema, type ControlContent
} from "@/lib/control/contracts";
import { canonicalJson, payloadDigest } from "@/lib/control/canonical";
import { validateResolvedContent } from "@/lib/control/content-validation";
import { platformIds } from "@/lib/platform-catalog";
import { controlCapabilities } from "@/lib/control/capabilities";

const digest = `sha256:${"a".repeat(64)}`;
const content: ControlContent = { title: "", text: "Fixture", linkUrl: "", mediaId: null };
const target = { id: "bluesky:fixture", platform: "bluesky" as const, profileId: "fixture", label: "Fixture account" };
const outcome = { target, state: "succeeded", message: "Publication succeeded.", url: "https://fixture.example/post" };
const post = { id: "post-1", createdAt: "2026-11-02T12:00:00Z", content,
  targets: [target], outcomes: [outcome], state: "succeeded", actionId: null };
const action = {
  id: "action-1", revision: digest, payloadDigest: digest,
  payload: { mode: "publish", content, targets: [{ ...target, identityRevision: digest }], media: null, draftRevision: null },
  state: "prepared", createdAt: "2026-11-02T12:00:00Z", expiresAt: "2026-11-02T12:30:00Z",
  approvalUrl: "/approvals/action-1", timezone: "Europe/Berlin", scheduledLocal: null,
  warnings: [], outcomes: [], postId: null, scheduleId: null
};

describe("frozen control API v1", () => {
  it("has precisely thirteen explicit tools and preserves all incumbent platform IDs", () => {
    expect(Object.keys(controlTools).sort()).toEqual([
      "clear_draft", "commit_action", "get_action", "get_draft", "get_media", "get_post", "get_status",
      "list_posts", "list_scheduled_posts", "list_targets", "prepare_action", "save_draft", "upload_media"
    ]);
    expect(platformSchema.options).toEqual(platformIds);
    for (const spec of Object.values(controlTools)) {
      expect(spec.route.startsWith("/")).toBe(true);
      expect(spec.annotations.readOnlyHint).toBe(spec.effects === "none");
      expect(spec.approval).toBe(spec === controlTools.commit_action);
    }
  });

  it("publishes JSON schemas without credential, approval or arbitrary request arguments", () => {
    for (const tool of Object.values(controlTools)) {
      const schema = JSON.parse(JSON.stringify(tool.publishedInputSchema));
      expect(schema.type).toBe("object");
      const names: string[] = [];
      function visit(value: unknown) {
        if (!value || typeof value !== "object") return;
        const record = value as Record<string, unknown>;
        if (record.properties) names.push(...Object.keys(record.properties));
        for (const child of Object.values(record)) visit(child);
      }
      visit(schema);
      for (const name of names) expect(name).not.toMatch(/password|token|cookie|secret|approved|profileLabel|profileId|^url$|^method$|headers/i);
      expect(z.toJSONSchema(tool.outputSchema)).toBeDefined();
    }
    expect(controlTools.commit_action.inputSchema.safeParse({ actionId: "a", expectedDigest: digest, approved: true }).success).toBe(false);
  });

  it("publishes prepare_action as an object root with all four strict variants intact", () => {
    const schema = JSON.parse(JSON.stringify(controlTools.prepare_action.publishedInputSchema));
    expect(schema.type).toBe("object");
    const branches = schema.oneOf ?? schema.anyOf;
    expect(branches).toHaveLength(4);
    expect(branches.map((branch: { properties: { mode: { const: string } } }) => branch.properties.mode.const))
      .toEqual(["publish", "schedule", "reschedule", "cancel"]);
    for (const branch of branches) expect(branch).toMatchObject({ type: "object", additionalProperties: false });
    expect(controlTools.list_targets.publishedInputSchema.required ?? []).not.toContain("limit");
    expect(() => publishInputSchema(z.string())).toThrow("Tool inputs must be objects");
  });

  it.each([
    { platform: "devto" as const, capabilities: { text: true, title: true, singleMedia: false } },
    { platform: "hackernews" as const, capabilities: { text: true, title: true, singleMedia: false } },
    { platform: "nostr" as const, capabilities: { text: true, title: false, singleMedia: false } },
    { platform: "bluesky" as const, capabilities: { text: true, title: false, singleMedia: true } }
  ])("represents the fields $platform actually consumes", ({ platform, capabilities }) => {
    expect(controlCapabilities(platform)).toEqual(capabilities);
    const result = targetSchema.parse({ ...target, id: `${platform}:fixture`, platform,
      readiness: "configured", readinessBasis: "configuration_only", capabilities });
    expect(result.capabilities).toEqual(capabilities);
  });

  it("rejects unknown input fields at the envelope, nested content and each action mode", () => {
    expect(controlTools.get_status.inputSchema.safeParse({ verbose: true }).success).toBe(false);
    expect(controlTools.save_draft.inputSchema.safeParse({ expectedRevision: digest,
      content: { ...content, path: "/private/file" }, targetIds: [] }).success).toBe(false);
    for (const mode of ["publish", "schedule", "reschedule", "cancel"] as const) {
      const input = mode === "publish" || mode === "schedule"
        ? { mode, requestKey: "fixture-key", content, targetIds: [target.id], ...(mode === "schedule" ? { scheduledFor: "2026-11-03T12:00:00Z" } : {}) }
        : { mode, requestKey: "fixture-key", scheduleId: "s", expectedRevision: digest,
          ...(mode === "reschedule" ? { scheduledFor: "2026-11-03T12:00:00Z" } : {}) };
      expect(controlTools.prepare_action.inputSchema.safeParse(input).success).toBe(true);
      expect(controlTools.prepare_action.inputSchema.safeParse({ ...input, password: "fixture" }).success).toBe(false);
    }
    expect(controlTools.commit_action.inputSchema.safeParse({ actionId: "a", expectedDigest: digest, content }).success).toBe(false);
  });

  it("allows empty and title-only drafts without claiming publishability", () => {
    for (const next of [{ ...content, text: "" }, { ...content, title: "Title", text: "" }]) {
      expect(controlTools.save_draft.inputSchema.safeParse({ expectedRevision: digest, content: next, targetIds: [] }).success).toBe(true);
    }
    expect(validateResolvedContent({ ...content, text: "" }, [{ id: "b", platform: "bluesky" }], () => undefined).valid).toBe(false);
    for (const platform of ["hackernews", "dribbble", "pinterest"] as const) {
      expect(validateResolvedContent({ ...content, title: "Title", text: "" }, [{ id: platform, platform }], () => undefined).valid).toBe(true);
    }
    expect(validateResolvedContent(content, [], () => undefined).valid).toBe(false);
  });

  it("checks each same-platform profile independently without changing legacy validators", () => {
    const profiles = [
      { id: "x:premium", platform: "x" as const, profileId: "premium" },
      { id: "x:free", platform: "x" as const, profileId: "free" }
    ];
    const lookup = (_name: string, profile?: string) => profile === "premium" ? "true" : "false";
    expect(validateResolvedContent({ ...content, text: "x".repeat(281) }, profiles, lookup).valid).toBe(false);
    expect(validateResolvedContent({ ...content, text: "x".repeat(281) }, [profiles[0]], lookup).valid).toBe(true);
    const input = { mode: "publish", requestKey: "one", content, targetIds: profiles.map((p) => p.id) };
    expect(controlTools.prepare_action.inputSchema.safeParse(input).success).toBe(true);
    expect(controlTools.prepare_action.inputSchema.safeParse({ ...input, targetIds: ["x:free", "x:free"] }).success).toBe(false);
    expect(controlTools.prepare_action.inputSchema.safeParse({ ...input, targetIds: [] }).success).toBe(false);
  });

  it.each(["not-a-date", "2026-11-02T12:00:00", "2026-02-30T12:00:00Z", "2026-11-02", "2026-11-02T25:00:00Z", "2026-11-02T12:00:00+25:00"])("rejects malformed or offset-free time %s", (value) => {
    expect(timestampSchema.safeParse(value).success).toBe(false);
  });

  it("retains explicit Berlin DST offsets as distinct unambiguous instants", () => {
    const summer = timestampSchema.parse("2026-10-25T02:30:00+02:00");
    const winter = timestampSchema.parse("2026-10-25T02:30:00+01:00");
    expect(new Date(winter).getTime() - new Date(summer).getTime()).toBe(3600000);
    expect(timestampSchema.parse("2026-03-29T03:30:00+02:00")).toBeDefined();
  });

  it("bounds pagination, rejects extra fields and retains an explicit continuation", () => {
    expect(controlTools.list_posts.inputSchema.parse({})).toEqual({ limit: 25 });
    for (const limit of [0, 101, 1.5, "2"]) expect(controlTools.list_posts.inputSchema.safeParse({ limit }).success).toBe(false);
    expect(controlTools.list_posts.inputSchema.safeParse({ cursor: "bad=", limit: 10 }).success).toBe(false);
    const response = { ok: true, data: { items: [post], nextCursor: "opaque_cursor" } };
    expect(controlTools.list_posts.outputSchema.safeParse(response).success).toBe(true);
    expect(controlTools.list_posts.outputSchema.safeParse({ ...response, data: { ...response.data, total: 1 } }).success).toBe(false);
    expect(controlTools.list_posts.outputSchema.safeParse({ ok: true, data: { items: Array(101).fill(post), nextCursor: null } }).success).toBe(false);
  });

  it("represents partial, uncertain and not-dispatched target outcomes without a success boolean", () => {
    for (const state of ["partial", "uncertain"]) {
      const outcomes = [outcome, { ...outcome, state: "uncertain", url: null }, { ...outcome, state: "not_dispatched", url: null }];
      expect(controlTools.get_post.outputSchema.safeParse({ ok: true, data: { ...post, state, outcomes } }).success).toBe(true);
      expect(actionSchema.safeParse({ ...action, state, outcomes }).success).toBe(true);
    }
    expect(controlTools.get_post.outputSchema.safeParse({ ok: true, data: { ...post, config: { token: "private" } } }).success).toBe(false);
    expect(targetSchema.safeParse({ ...target, readiness: "configured", readinessBasis: "verified_login",
      capabilities: { text: true, title: true, singleMedia: true } }).success).toBe(false);
  });

  it("defines stable errors separately from target failures and rejects raw exception fields", () => {
    for (const code of errorCodes) {
      expect(controlTools.get_status.outputSchema.safeParse({ ok: false, error: { code, message: "Operation unavailable.", retryable: false } }).success).toBe(true);
    }
    expect(controlTools.get_status.outputSchema.safeParse({ ok: false, error: { code: "storage_corrupt", message: "Unavailable", retryable: false, stack: "private" } }).success).toBe(false);
    expect(controlTools.get_status.outputSchema.safeParse({ ok: false, error: { code: "invented", message: "Unavailable", retryable: false } }).success).toBe(false);
  });

  it("freezes full backend-resolved previews while commit accepts only identity and digest", () => {
    expect(actionSchema.safeParse(action).success).toBe(true);
    expect(actionPayloadSchema.safeParse({ ...action.payload, targets: [{ ...target, identityRevision: digest, values: {} }] }).success).toBe(false);
    expect(actionSchema.safeParse({ ...action, approvalUrl: "/approvals/action-1?token=secret" }).success).toBe(false);
    expect(controlTools.commit_action.inputSchema.parse({ actionId: "action-1", expectedDigest: digest })).toEqual({ actionId: "action-1", expectedDigest: digest });
  });

  it("uses canonical JSON v1 for stable payload/revision SHA-256 digests", () => {
    expect(canonicalJson({ z: [2, 1], a: { y: true, x: "é" } })).toBe('{"a":{"x":"é","y":true},"z":[2,1]}');
    expect(payloadDigest({ b: 2, a: 1 })).toBe(payloadDigest({ a: 1, b: 2 }));
    expect(payloadDigest([1, 2])).not.toBe(payloadDigest([2, 1]));
    expect(payloadDigest({ text: " x " })).not.toBe(payloadDigest({ text: "x" }));
    expect(payloadDigest(null)).toMatch(/^sha256:[a-f0-9]{64}$/);
    for (const invalid of [undefined, Number.NaN, Number.POSITIVE_INFINITY, new Date(), { x: undefined }]) {
      expect(() => canonicalJson(invalid)).toThrow("only JSON values");
    }
  });
});
