import "server-only";
import { dataRoot } from "@/lib/runtime-paths";
import { authenticateControl, readControlCredential } from "./auth";
import { controlTools } from "./contracts";
import { ControlError } from "./errors";
import { controlFailure, controlSuccess, readControlJson } from "./http";
import { backendExecution } from "./execution-backend";

export async function controlCommit(request: Request, actionId: string) {
  let knownId: string | undefined;
  try {
    const auth = authenticateControl(request, dataRoot());
    if (new URL(request.url).searchParams.size) throw new ControlError("validation_failed");
    const raw = await readControlJson(request);
    // The route path carries the ID. A second body ID is never substituted.
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).some((key) => key !== "expectedDigest")) throw new ControlError("validation_failed");
    const parsed = controlTools.commit_action.inputSchema.safeParse({ ...raw, actionId });
    if (!parsed.success) throw new ControlError("validation_failed");
    knownId = parsed.data.actionId;
    const { credential } = readControlCredential(auth.canonicalRoot);
    if (credential.instanceId !== auth.instanceId) throw new ControlError("instance_mismatch");
    return controlSuccess("commit_action", await backendExecution(auth.canonicalRoot, credential.token).commit(parsed.data));
  } catch (error) {
    return controlFailure(knownId ? new ControlError(error instanceof ControlError ? error.code : "internal_error", knownId) : error);
  }
}
