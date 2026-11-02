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
import { controlFailure, controlSuccess } from "./http";
import { controlMediaRevision, readControlConfig, readControlMedia } from "./read-storage";

async function jsonBody(request: Request): Promise<unknown> {
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
    if (name === "prepare_action") return controlSuccess(name, await service.prepare(await jsonBody(request)));
    const input = controlTools.get_action.inputSchema.safeParse(params);
    if (!input.success) throw new ControlError("validation_failed");
    return controlSuccess(name, await service.get(input.data.actionId));
  } catch (error) { return controlFailure(error); }
}
