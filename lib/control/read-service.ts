import { z } from "zod-control";
import { isPlaceholderValue } from "@/lib/config-validation";
import { CONTROL_API_VERSION, digestSchema } from "./contracts";
import { payloadDigest } from "./canonical";
import { ControlError } from "./errors";
import type { RetainedPost } from "./read-storage";
import { projectControlConfig, projectControlMedia, projectControlSchedule } from "./read-projections";
import { readControlDraftSnapshot, type DraftReadDependencies } from "./draft-snapshot";

type ReadDependencies = DraftReadDependencies & {
  instanceId: string; backendVersion: string; schedulerEnabled: boolean;
};
export type ReadToolName = "get_status" | "list_targets" | "get_draft" | "get_media" | "list_posts" | "get_post" | "list_scheduled_posts";
type PageInput = { limit: number; cursor?: string };
const cursorPayload = z.strictObject({ version: z.literal(1), instanceId: digestSchema,
  collection: z.enum(["targets", "posts", "scheduled"]), snapshot: digestSchema, lastId: z.string().min(1).max(180) });

export function createControlReadService(deps: ReadDependencies) {
  function paginate<T extends { id: string }>(collection: "targets" | "posts" | "scheduled", items: T[], input: PageInput) {
    const snapshot = payloadDigest(items);
    let offset = 0;
    if (input.cursor) {
      let cursor: z.infer<typeof cursorPayload>;
      try { cursor = cursorPayload.parse(JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8"))); }
      catch { throw new ControlError("cursor_invalid"); }
      if (cursor.collection !== collection || cursor.instanceId !== deps.instanceId) throw new ControlError("cursor_invalid");
      if (cursor.snapshot !== snapshot) throw new ControlError("cursor_stale");
      const index = items.findIndex((item) => item.id === cursor.lastId);
      if (index < 0) throw new ControlError("cursor_invalid");
      offset = index + 1;
    }
    const page = items.slice(offset, offset + input.limit);
    const last = page.at(-1);
    const nextCursor = last && offset + page.length < items.length
      ? Buffer.from(JSON.stringify({ version: 1, instanceId: deps.instanceId, collection, snapshot, lastId: last.id })).toString("base64url") : null;
    return { items: page, nextCursor };
  }
  return {
    async read(name: ReadToolName, input: Record<string, unknown>) {
      if (name === "get_draft") return (await readControlDraftSnapshot(deps)).draft;
      const config = deps.readConfig();
      const dto = projectControlConfig(config, deps.environmentValue);
      switch (name) {
        case "get_status": return { apiVersion: CONTROL_API_VERSION, backendVersion: deps.backendVersion,
          instanceId: deps.instanceId, scheduler: deps.schedulerEnabled ? "enabled" : "disabled",
          approvalConfigured: !isPlaceholderValue(dto.baseValue("POSTER_ADMIN_PASSWORD")), readinessBasis: "configuration_only" };
        case "list_targets": return paginate("targets", dto.targets, input as PageInput);
        case "get_media": {
          const media = await deps.readMedia(input.mediaId as string);
          return projectControlMedia(media as Parameters<typeof projectControlMedia>[0], dto);
        }
        case "get_post":
        case "list_posts": {
          const project = (post: RetainedPost) => {
            const { targets, outcomes } = dto.retained(post);
            const successes = outcomes.filter((outcome) => outcome.state === "succeeded").length;
            const state = outcomes.some((outcome) => outcome.state === "uncertain") ? "uncertain"
              : successes === targets.length && successes === outcomes.length ? "succeeded" : successes ? "partial" : "failed";
            return { id: post.id, createdAt: new Date(post.createdAt).toISOString(), content: dto.content(post), targets, outcomes, state, actionId: null };
          };
          if (name === "get_post") {
            const post = config.publishedPosts.find((item) => item.id === input.postId);
            if (!post) throw new ControlError("post_missing");
            return project(post);
          }
          const posts = config.publishedPosts.map(project).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
          return paginate("posts", posts, input as PageInput);
        }
        case "list_scheduled_posts": {
          const scheduled = config.scheduledPosts.map((post) => projectControlSchedule(post, dto))
            .sort((a, b) => a.scheduledFor.localeCompare(b.scheduledFor) || a.id.localeCompare(b.id));
          return paginate("scheduled", scheduled, input as PageInput);
        }
      }
    }
  };
}
