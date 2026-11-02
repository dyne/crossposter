import { z } from "zod-control";
import { platformIds } from "@/lib/platform-catalog";

// Browser/bridge-safe contract only. No storage, environment or provider imports.
export const CONTROL_API_VERSION = "1" as const;
export const idSchema = z.string().min(1).max(180);
export const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const revisionSchema = digestSchema;
export const timestampSchema = z.iso.datetime({ offset: true });
export const platformSchema = z.enum(platformIds);
export const cursorSchema = z.string().min(1).max(4096).regex(/^[A-Za-z0-9_-]+$/);
export const pageInputSchema = z.strictObject({
  limit: z.number().int().min(1).max(100).default(25),
  cursor: cursorSchema.optional()
});
const emptyInput = z.strictObject({});
const uniqueIds = z.array(idSchema).max(30).refine(
  (ids) => new Set(ids).size === ids.length, "Target IDs must be unique."
);
const httpUrl = z.url().max(2048).refine((value) => {
  const url = new URL(value);
  return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password;
});

export const errorCodes = [
  "validation_failed", "unauthorized", "forbidden", "instance_mismatch",
  "target_missing", "media_missing", "post_missing", "action_missing", "schedule_missing",
  "revision_conflict", "cursor_invalid", "cursor_stale", "approval_setup_required",
  "approval_required", "approval_expired", "approval_rejected", "idempotency_conflict",
  "action_conflict", "backend_unavailable", "storage_unavailable", "storage_corrupt",
  "ownership_conflict", "internal_error"
] as const;
export const controlErrorSchema = z.strictObject({
  code: z.enum(errorCodes),
  message: z.string().min(1).max(300),
  retryable: z.boolean(),
  actionId: idSchema.optional()
});
export type ControlErrorCode = z.infer<typeof controlErrorSchema>["code"];
export function resultSchema<T extends z.ZodType>(data: T) {
  return z.discriminatedUnion("ok", [
    z.strictObject({ ok: z.literal(true), data }),
    z.strictObject({ ok: z.literal(false), error: controlErrorSchema })
  ]);
}

export const targetIdentitySchema = z.strictObject({
  id: idSchema,
  platform: platformSchema,
  profileId: z.string().min(1).max(120).nullable(),
  label: z.string().min(1).max(180)
});
export const targetSchema = targetIdentitySchema.extend({
  readiness: z.enum(["configured", "incomplete"]),
  readinessBasis: z.literal("configuration_only"),
  capabilities: z.strictObject({
    text: z.boolean(), title: z.boolean(), singleMedia: z.boolean()
  })
});
export type ControlTarget = z.infer<typeof targetSchema>;

// Drafts may be empty and incomplete. Publishability is checked after resolving
// each selected target, using the incumbent provider rules (see content-validation).
export const contentSchema = z.strictObject({
  title: z.string().max(300),
  text: z.string().max(100_000),
  linkUrl: z.string().max(2048),
  mediaId: z.string().min(1).max(80).nullable()
});
export const draftSchema = z.strictObject({
  revision: revisionSchema,
  content: contentSchema,
  targetIds: uniqueIds,
  updatedAt: timestampSchema.nullable()
});
export const mediaSchema = z.strictObject({
  id: z.string().min(1).max(80),
  filename: z.string().min(1).max(240),
  contentType: z.string().max(160),
  size: z.number().int().nonnegative(),
  kind: z.enum(["image", "video", "audio", "file"]),
  url: z.string().regex(/^\/api\/media\/[A-Za-z0-9_-]+(?:\.[a-z0-9]{1,12})?$/i),
  digest: digestSchema
});
export const outcomeStates = ["not_dispatched", "dispatching", "succeeded", "failed", "uncertain"] as const;
export const targetOutcomeSchema = z.strictObject({
  target: targetIdentitySchema,
  state: z.enum(outcomeStates),
  // Controlled summaries, never raw provider errors or config values.
  message: z.string().max(300),
  url: httpUrl.nullable()
});
export const executionStates = ["pending", "running", "succeeded", "partial", "failed", "uncertain"] as const;
export const postSchema = z.strictObject({
  id: idSchema,
  createdAt: timestampSchema,
  content: contentSchema,
  targets: z.array(targetIdentitySchema).max(30),
  outcomes: z.array(targetOutcomeSchema).max(30),
  state: z.enum(executionStates),
  actionId: idSchema.nullable()
});
export const scheduledPostSchema = z.strictObject({
  id: idSchema,
  revision: revisionSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  scheduledFor: timestampSchema,
  content: contentSchema,
  targets: z.array(targetIdentitySchema).max(30),
  status: z.enum(["scheduled", "publishing", "published", "failed", "canceled"]),
  attempts: z.number().int().nonnegative(),
  outcomes: z.array(targetOutcomeSchema).max(30),
  actionId: idSchema.nullable(),
  publishedPostId: idSchema.nullable()
});
export function pageSchema<T extends z.ZodType>(item: T) {
  return z.strictObject({ items: z.array(item).max(100), nextCursor: cursorSchema.nullable() });
}

const requestKey = z.string().min(1).max(120).regex(/^[A-Za-z0-9._:-]+$/);
const publicationInput = {
  requestKey,
  content: contentSchema,
  targetIds: uniqueIds.refine((ids) => ids.length > 0, "Select at least one target.")
};
export const prepareActionInputSchema = z.discriminatedUnion("mode", [
  z.strictObject({ mode: z.literal("publish"), ...publicationInput }),
  z.strictObject({ mode: z.literal("schedule"), ...publicationInput, scheduledFor: timestampSchema }),
  z.strictObject({ mode: z.literal("reschedule"), requestKey, scheduleId: idSchema,
    expectedRevision: revisionSchema, scheduledFor: timestampSchema }),
  z.strictObject({ mode: z.literal("cancel"), requestKey, scheduleId: idSchema, expectedRevision: revisionSchema })
]);
const previewPublication = {
  content: contentSchema,
  // These identities and revisions are always resolved by the backend.
  targets: z.array(targetIdentitySchema.extend({ identityRevision: revisionSchema })).min(1).max(30),
  media: mediaSchema.nullable(),
  draftRevision: revisionSchema.nullable()
};
export const actionPayloadSchema = z.discriminatedUnion("mode", [
  z.strictObject({ mode: z.literal("publish"), ...previewPublication }),
  z.strictObject({ mode: z.literal("schedule"), ...previewPublication, scheduledFor: timestampSchema }),
  z.strictObject({ mode: z.literal("reschedule"), ...previewPublication, scheduleId: idSchema,
    expectedRevision: revisionSchema, scheduledFor: timestampSchema }),
  z.strictObject({ mode: z.literal("cancel"), ...previewPublication, scheduleId: idSchema,
    expectedRevision: revisionSchema, scheduledFor: timestampSchema })
]);
export const actionStates = [
  "prepared", "approved", "rejected", "expired", "conflicting", "executing",
  "succeeded", "partial", "failed", "uncertain", "scheduled", "rescheduled", "canceled"
] as const;
export const actionSchema = z.strictObject({
  id: idSchema,
  revision: revisionSchema,
  payloadDigest: digestSchema,
  payload: actionPayloadSchema,
  state: z.enum(actionStates),
  createdAt: timestampSchema,
  expiresAt: timestampSchema,
  approvalUrl: z.string().regex(/^\/approvals\/[A-Za-z0-9_-]+$/),
  timezone: z.string().min(1).max(100),
  scheduledLocal: z.string().max(180).nullable(),
  warnings: z.array(z.string().max(300)).max(30),
  outcomes: z.array(targetOutcomeSchema).max(30),
  postId: idSchema.nullable(),
  scheduleId: idSchema.nullable()
});
export const statusSchema = z.strictObject({
  apiVersion: z.literal(CONTROL_API_VERSION),
  backendVersion: z.string().min(1).max(80),
  instanceId: digestSchema,
  scheduler: z.enum(["enabled", "disabled"]),
  approvalConfigured: z.boolean(),
  readinessBasis: z.literal("configuration_only")
});

// MCP requires an explicit object root even for a union of strict objects.
// Keep the full generated composition; io:input preserves optional defaults.
export function publishInputSchema(inputSchema: z.ZodType) {
  const schema = z.toJSONSchema(inputSchema, { io: "input" });
  const branches = schema.oneOf ?? schema.anyOf;
  if (schema.type !== "object" && !(branches?.length && branches.every((branch) =>
    typeof branch === "object" && branch.type === "object"
  ))) {
    throw new TypeError("Tool inputs must be objects or a union of objects.");
  }
  return { ...schema, type: "object" as const };
}

function tool<I extends z.ZodType, O extends z.ZodType>(
  inputSchema: I, dataSchema: O, method: "GET" | "POST" | "PUT" | "DELETE",
  route: string, effects: "none" | "local" | "external", approval: boolean,
  idempotent: boolean, destructive = false
) {
  return {
    inputSchema, publishedInputSchema: publishInputSchema(inputSchema), dataSchema,
    outputSchema: resultSchema(dataSchema), method, route, effects, approval,
    annotations: { readOnlyHint: effects === "none", destructiveHint: destructive,
      idempotentHint: idempotent, openWorldHint: effects === "external" }
  };
}

// Exactly this catalog is public; definitions do not enable future write routes.
export const controlTools = {
  get_status: tool(emptyInput, statusSchema, "GET", "/status", "none", false, true),
  list_targets: tool(pageInputSchema, pageSchema(targetSchema), "GET", "/targets", "none", false, true),
  get_draft: tool(emptyInput, draftSchema, "GET", "/draft", "none", false, true),
  save_draft: tool(z.strictObject({ expectedRevision: revisionSchema, content: contentSchema,
    targetIds: uniqueIds }), draftSchema, "PUT", "/draft", "local", false, true),
  clear_draft: tool(z.strictObject({ expectedRevision: revisionSchema }), draftSchema,
    "DELETE", "/draft", "local", false, true, true),
  upload_media: tool(z.strictObject({ localPath: z.string().min(1).max(4096).startsWith("/") }),
    mediaSchema, "POST", "/media", "local", false, false),
  get_media: tool(z.strictObject({ mediaId: z.string().min(1).max(80) }), mediaSchema,
    "GET", "/media/:mediaId", "none", false, true),
  prepare_action: tool(prepareActionInputSchema, actionSchema, "POST", "/actions", "local", false, true),
  get_action: tool(z.strictObject({ actionId: idSchema }), actionSchema,
    "GET", "/actions/:actionId", "none", false, true),
  commit_action: tool(z.strictObject({ actionId: idSchema, expectedDigest: digestSchema }), actionSchema,
    "POST", "/actions/:actionId/commit", "external", true, true, true),
  list_posts: tool(pageInputSchema, pageSchema(postSchema), "GET", "/posts", "none", false, true),
  get_post: tool(z.strictObject({ postId: idSchema }), postSchema, "GET", "/posts/:postId", "none", false, true),
  list_scheduled_posts: tool(pageInputSchema, pageSchema(scheduledPostSchema),
    "GET", "/scheduled", "none", false, true)
} as const;
export type ControlToolName = keyof typeof controlTools;
export type ControlContent = z.infer<typeof contentSchema>;
export type ControlMedia = z.infer<typeof mediaSchema>;
export type ControlOutcome = z.infer<typeof targetOutcomeSchema>;
export type ControlPost = z.infer<typeof postSchema>;
export type ControlScheduledPost = z.infer<typeof scheduledPostSchema>;
export type ControlAction = z.infer<typeof actionSchema>;
