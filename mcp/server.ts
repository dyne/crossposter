import { McpServer, type StandardSchemaWithJSON } from "@modelcontextprotocol/server";
import { z } from "zod-control";
import { controlTools, type ControlToolName } from "../lib/control/contracts";
import { backendClient } from "./backend";
import type { BridgeConfig } from "./config";

const descriptions: Record<ControlToolName, string> = {
  get_status: "Read backend identity/version and configured scheduler/approval state. Configuration readiness is not provider authentication.",
  list_targets: "List existing account targets with stable IDs and configuration-only readiness. Continue with nextCursor; restart on cursor_stale.",
  get_draft: "Read the one shared composer draft and its current revision.",
  save_draft: "Replace the shared local draft using its expectedRevision. No publication or approval occurs.",
  clear_draft: "Clear the shared local draft using its expectedRevision. Does not delete history or published posts.",
  upload_media: "Stream one absolute regular file inside configured local media roots. Returns stored metadata; no publishing or conversion.",
  get_media: "Read safe metadata and byte digest for an existing stored media ID.",
  prepare_action: "Prepare an immutable publish, schedule, reschedule or cancel action with a stable requestKey. Review the complete preview and open the returned local approval path separately. Preparation never publishes or enqueues; owner approval expires after 30 minutes.",
  get_action: "Inspect a saved action and every target outcome. Poll this ID after commit, disconnect or timeout; never infer rollback or retry uncertain destinations.",
  commit_action: "Commit only the stored actionId and expectedDigest after independent owner approval in the local browser. Cannot approve or substitute content. Replays return the same durable execution. Scheduled is not published; partial/uncertain outcomes require inspection, never automatic retries.",
  list_posts: "Read bounded retained history including complete target outcomes and uncertainty. Continue with nextCursor; restart on cursor_stale.",
  get_post: "Inspect one retained post and its linked action and target outcomes. Partial/uncertain is not successful publication.",
  list_scheduled_posts: "Read queued/failed posts and revisions without starting a scheduler or invoking a tick. Backend lifetime owns approved schedules."
};

function sdkSchema(schema: z.ZodType, json: Record<string, unknown>): StandardSchemaWithJSON<unknown, Record<string, unknown>> {
  return { "~standard": { version: 1, vendor: "crossposter",
    validate(value) {
      const parsed = schema.safeParse(value);
      return parsed.success ? { value: parsed.data as Record<string, unknown> } : { issues: [{ message: "Control request is invalid." }] };
    },
    jsonSchema: { input: () => json, output: () => json }
  } };
}

export function createBridgeServer(config: BridgeConfig, version: string, lifetime?: AbortSignal) {
  const server = new McpServer({ name: "crossposter", version }, { capabilities: { tools: {} },
    instructions: "One owner, existing accounts, one draft and one media item. Prepare, obtain separate local owner approval, then commit the exact stored digest. The backend owns all publication and scheduled work; disconnect never rolls back. Use get_action to reconcile uncertainty. No onboarding, bulk posting, automatic retries or native post deletion." });
  const backend = backendClient(config, version, lifetime);
  function register(name: ControlToolName) {
    const spec = controlTools[name];
    server.registerTool(name, {
      description: descriptions[name], annotations: spec.annotations,
      inputSchema: sdkSchema(spec.inputSchema, spec.publishedInputSchema),
      outputSchema: sdkSchema(spec.outputSchema, { ...z.toJSONSchema(spec.outputSchema), type: "object" })
    }, async (input, context) => {
      const output = await backend.invoke(name, input, context.mcpReq.signal);
      const structuredContent = spec.outputSchema.parse(output) as Record<string, unknown>;
      const data = output.ok ? output.data as Record<string, unknown> : undefined;
      const state = typeof data?.state === "string" ? data.state : undefined;
      const summary = !output.ok ? output.error.message : state ? `${name}: ${state}. Inspect the structured target outcomes.`
        : Array.isArray(data?.items) ? `${name}: ${data.items.length} items; ${data.nextCursor ? "more available" : "end of collection"}.`
          : `${name}: complete. See structured data.`;
      // Publication state is data, distinct from failure to execute the tool.
      return { structuredContent, content: [{ type: "text", text: summary }], isError: !output.ok };
    });
  }
  register("get_status"); register("list_targets"); register("get_draft");
  register("save_draft"); register("clear_draft"); register("upload_media"); register("get_media");
  register("prepare_action"); register("get_action"); register("commit_action");
  register("list_posts"); register("get_post"); register("list_scheduled_posts");
  return server;
}
