import "server-only";
import { randomUUID } from "node:crypto";
import { dataRoot } from "@/lib/runtime-paths";
import { authenticateControl, readControlCredential } from "./auth";
import { assertBackendMutation } from "./backend-mutation";
import { createActionStore, readActionJournal } from "./action-store";
import { createActionService } from "./action-service";
import { bindControlAccount } from "./account-binding";
import { controlTools } from "./contracts";
import { ControlError } from "./errors";
import { controlFailure, controlSuccess, readControlJson } from "./http";
import { controlMediaRevision, readControlConfig, readControlMedia } from "./read-storage";

export async function controlAction(request: Request, name: "prepare_action" | "get_action", params: Record<string, string> = {}) {
  try {
    const auth = authenticateControl(request, dataRoot()); const root = auth.canonicalRoot;
    if (new URL(request.url).searchParams.size) throw new ControlError("validation_failed");
    const { credential } = readControlCredential(root);
    if (credential.instanceId !== auth.instanceId) throw new ControlError("instance_mismatch");
    const owner = () => { const claim = assertBackendMutation(root); if (!claim) throw new ControlError("ownership_conflict"); return claim; };
    const service = createActionService({
      readConfig: () => readControlConfig(root), readRecords: () => readActionJournal(root).records,
      saveRecord: (record) => createActionStore(root, owner()).save(record, null), assertMutation: () => { owner(); },
      readMedia: (id) => readControlMedia(root, id), mediaRevision: (id) => controlMediaRevision(root, id),
      bindAccount: (target) => bindControlAccount(root, credential.token, target), environmentValue: (field) => process.env[field],
      timezone: () => process.env.CROSSPOSTER_TIMEZONE || "Europe/Berlin", now: () => new Date(), createId: randomUUID
    });
    if (name === "prepare_action") return controlSuccess(name, await service.prepare(await readControlJson(request)));
    const input = controlTools.get_action.inputSchema.safeParse(params);
    if (!input.success) throw new ControlError("validation_failed");
    return controlSuccess(name, await service.get(input.data.actionId));
  } catch (error) { return controlFailure(error); }
}
