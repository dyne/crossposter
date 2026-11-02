import "server-only";
import { dataRoot } from "@/lib/runtime-paths";
import packageInfo from "@/package.json";
import { authenticateControl } from "./auth";
import { controlTools } from "./contracts";
import { ControlError, publicError } from "./errors";
import { createControlReadService, type ReadToolName } from "./read-service";
import { readControlConfig, readControlMedia } from "./read-storage";

const statuses: Partial<Record<ReturnType<typeof publicError>["code"], number>> = {
  validation_failed: 400, unauthorized: 401, forbidden: 403, instance_mismatch: 409,
  target_missing: 404, media_missing: 404, post_missing: 404,
  cursor_invalid: 400, cursor_stale: 409, storage_corrupt: 500, storage_unavailable: 503
};
const headers = { "cache-control": "no-store", "x-content-type-options": "nosniff" };

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
      instanceId: auth.instanceId, backendVersion: packageInfo.version,
      schedulerEnabled: process.env.POSTER_DISABLE_SCHEDULER !== "true",
      environmentValue: (field) => process.env[field]
    });
    const data = await service.read(name, parsed.data);
    const output = spec.outputSchema.safeParse({ ok: true, data });
    if (!output.success) throw new ControlError("storage_corrupt");
    return Response.json(output.data, { headers });
  } catch (error) {
    const failure = publicError(error);
    return Response.json({ ok: false, error: failure }, { status: statuses[failure.code] ?? 500, headers });
  }
}
