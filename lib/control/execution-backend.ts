import "server-only";
import { backendActionDependencies } from "./action-backend";
import { createActionService } from "./action-service";
import { createExecutionService } from "./execution-service";
import { executionBackends } from "./execution-state";
import { createApprovedPublisher } from "./approved-publisher";
import { readControlCredential } from "./auth";
import { ControlError } from "./errors";
import { providers } from "@/lib/providers";
import { getUploadedMedia } from "@/lib/media-store";
import { appendPublishedPost } from "@/lib/local-config";

export function backendExecution(root: string, token: string) {
  const existing = executionBackends.get(root);
  if (existing && existing.token !== token) throw new ControlError("instance_mismatch");
  if (!existing) {
    const deps = backendActionDependencies(root, token);
    const actions = createActionService(deps);
    const assertContext = () => {
      if (readControlCredential(root).credential.token !== token) throw new ControlError("instance_mismatch");
    };
    const run = createApprovedPublisher({ ...deps, providers, readUploadedMedia: getUploadedMedia, appendHistory: appendPublishedPost, assertContext });
    const backend = createExecutionService({ ...deps, snapshot: async (record) => {
      const snapshot = await actions.executionSnapshot(record);
      return { ...snapshot, assertUnchanged: () => { assertContext(); return snapshot.assertUnchanged(); } };
    }, run });
    executionBackends.set(root, { token, service: backend });
  }
  return executionBackends.get(root)!.service;
}
export async function shutdownControlExecutions() {
  await Promise.allSettled([...executionBackends.values()].map((backend) => backend.service.shutdown()));
}
const shutdownKey = Symbol.for("crossposter.control-execution-shutdown.v1");
const globals = globalThis as typeof globalThis & { [shutdownKey]?: boolean };
if (!globals[shutdownKey]) {
  globals[shutdownKey] = true;
  // Next owns process exit. Stop new dispatch immediately; its grace period
  // may settle in-flight calls. Forced exit leaves durable intent for recovery.
  for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => { void shutdownControlExecutions(); });
}
