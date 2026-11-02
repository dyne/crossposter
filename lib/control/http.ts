import "server-only";
import { dataRoot } from "@/lib/runtime-paths";
import packageInfo from "@/package.json";
import { authenticateControl } from "./auth";
import { controlTools } from "./contracts";
import { ControlError, publicError } from "./errors";
import { createControlReadService, type ReadToolName } from "./read-service";
import { controlMediaRevision, readControlConfig, readControlMedia } from "./read-storage";
import { ownerApprovalConfigured } from "./owner-auth";

const statuses: Partial<Record<ReturnType<typeof publicError>["code"], number>> = {
  validation_failed: 400, unauthorized: 401, forbidden: 403, instance_mismatch: 409,
  target_missing: 404, media_missing: 404, post_missing: 404,
  action_missing: 404, schedule_missing: 404, revision_conflict: 409, ownership_conflict: 409,
  idempotency_conflict: 409, action_conflict: 409,
  approval_required: 401, approval_setup_required: 409, approval_expired: 409, approval_rejected: 409,
  cursor_invalid: 400, cursor_stale: 409, storage_corrupt: 500, storage_unavailable: 503
};
const headers = { "cache-control": "no-store", "x-content-type-options": "nosniff" };

export async function readControlJson(request: Request): Promise<unknown> {
  const reader = request.body?.getReader();
  if (!reader) throw new ControlError("validation_failed");
  const chunks: Uint8Array[] = []; let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      bytes += value.byteLength;
      if (bytes > 1024 * 1024) { await reader.cancel(); throw new ControlError("validation_failed"); }
      chunks.push(value);
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
  } catch { throw new ControlError("validation_failed"); }
  finally { reader.releaseLock(); }
}

export function controlSuccess(name: keyof typeof controlTools, data: unknown) {
  const output = controlTools[name].outputSchema.safeParse({ ok: true, data });
  if (!output.success) throw new ControlError("storage_corrupt");
  return Response.json(output.data, { headers });
}
export function controlFailure(error: unknown) {
  const failure = publicError(error);
  return Response.json({ ok: false, error: failure }, { status: statuses[failure.code] ?? 500, headers });
}

// Routes choose one fixed operation. No client-controlled URL/method dispatch.
export async function controlRead(request: Request, name: ReadToolName, params: Record<string, string> = {}) {
  const spec = controlTools[name];
  try {
    const auth = authenticateControl(request, dataRoot());
    const url = new URL(request.url);
    const input: Record<string, unknown> = { ...params };
    const list = name === "list_targets" || name === "list_posts" || name === "list_scheduled_posts";
    for (const [key, value] of url.searchParams) {
      if (!list || !["limit", "cursor"].includes(key) || key in input) throw new ControlError("validation_failed");
      if (key === "limit") {
        if (!/^[1-9][0-9]*$/.test(value)) throw new ControlError("validation_failed");
        input.limit = Number(value);
      } else input.cursor = value;
    }
    const parsed = spec.inputSchema.safeParse(input);
    if (!parsed.success) throw new ControlError("validation_failed");
    const service = createControlReadService({
      readConfig: () => readControlConfig(auth.canonicalRoot),
      readMedia: (id) => readControlMedia(auth.canonicalRoot, id),
      mediaRevision: (id) => controlMediaRevision(auth.canonicalRoot, id, true),
      instanceId: auth.instanceId, backendVersion: packageInfo.version,
      schedulerEnabled: process.env.POSTER_DISABLE_SCHEDULER !== "true",
      approvalConfigured: () => ownerApprovalConfigured(auth.canonicalRoot),
      environmentValue: (field) => process.env[field]
    });
    const data = await service.read(name, parsed.data);
    return controlSuccess(name, data);
  } catch (error) {
    return controlFailure(error);
  }
}
