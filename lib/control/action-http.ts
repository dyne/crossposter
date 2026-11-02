import "server-only";
import { dataRoot } from "@/lib/runtime-paths";
import { authenticateControl, readControlCredential } from "./auth";
import { backendActionService } from "./action-backend";
import { controlTools } from "./contracts";
import { ControlError } from "./errors";
import { controlFailure, controlSuccess, readControlJson } from "./http";

export async function controlAction(request: Request, name: "prepare_action" | "get_action", params: Record<string, string> = {}) {
  try {
    const auth = authenticateControl(request, dataRoot()); const root = auth.canonicalRoot;
    if (new URL(request.url).searchParams.size) throw new ControlError("validation_failed");
    const { credential } = readControlCredential(root);
    if (credential.instanceId !== auth.instanceId) throw new ControlError("instance_mismatch");
    const service = backendActionService(root, credential.token);
    if (name === "prepare_action") return controlSuccess(name, await service.prepare(await readControlJson(request)));
    const input = controlTools.get_action.inputSchema.safeParse(params);
    if (!input.success) throw new ControlError("validation_failed");
    return controlSuccess(name, await service.get(input.data.actionId));
  } catch (error) { return controlFailure(error); }
}
