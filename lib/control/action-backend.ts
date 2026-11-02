import "server-only";
import { randomUUID } from "node:crypto";
import { assertBackendMutation } from "./backend-mutation";
import { createActionStore, readActionJournal } from "./action-store";
import { createActionService, type ActionDependencies } from "./action-service";
import { bindControlAccount } from "./account-binding";
import { ControlError } from "./errors";
import { controlMediaRevision, readControlConfig, readControlMedia } from "./read-storage";
import { executionView } from "./execution-state";

export function backendActionDependencies(root: string, token: string): ActionDependencies {
  const owner = () => { const claim = assertBackendMutation(root); if (!claim) throw new ControlError("ownership_conflict"); return claim; };
  return {
    readConfig: () => readControlConfig(root), readRecords: () => readActionJournal(root).records,
    saveRecord: (record, revision = null) => createActionStore(root, owner()).save(record, revision), assertMutation: () => { owner(); },
    readMedia: (id) => readControlMedia(root, id), mediaRevision: (id) => controlMediaRevision(root, id),
    bindAccount: (target) => bindControlAccount(root, token, target), environmentValue: (field) => process.env[field],
    timezone: () => process.env.CROSSPOSTER_TIMEZONE || "Europe/Berlin", now: () => new Date(), createId: randomUUID,
    executionView: (action) => executionView(root, action)
  };
}
export function backendActionService(root: string, token: string) {
  return createActionService(backendActionDependencies(root, token));
}
