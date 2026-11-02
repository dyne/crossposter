import "server-only";
import { randomUUID } from "node:crypto";
import { dataRoot } from "@/lib/runtime-paths";
import { readControlCredential } from "./auth";
import { assertBackendMutation } from "./backend-mutation";
import { createActionStore, readActionJournal } from "./action-store";
import { createActionService } from "./action-service";
import { bindControlAccount } from "./account-binding";
import { actionSchema, idSchema } from "./contracts";
import { ownerLoginSchema } from "./approval-contracts";
import { ControlError } from "./errors";
import { controlFailure, readControlJson } from "./http";
import { authenticateOwner, checkOwnerRequest, loginOwner, logoutOwner } from "./owner-auth";
import { controlMediaRevision, readControlConfig, readControlMedia } from "./read-storage";

const headers = { "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" };
const success = (data: unknown, cookie?: string) => Response.json({ ok: true, data }, { headers: { ...headers, ...(cookie ? { "set-cookie": cookie } : {}) } });
export async function ownerSession(request: Request, operation: "read" | "login" | "logout") {
  try {
    const root = dataRoot();
    if (operation === "read") return success({ authenticated: true, ...authenticateOwner(request, root) });
    checkOwnerRequest(request, root, true);
    if (operation === "logout") return success({ authenticated: false }, logoutOwner(request, root));
    const input = ownerLoginSchema.safeParse(await readControlJson(request));
    if (!input.success) throw new ControlError("validation_failed");
    const { cookie, ...session } = loginOwner(request, root, input.data.password);
    return success({ authenticated: true, ...session }, cookie);
  } catch (error) { return controlFailure(error); }
}
export async function ownerAction(request: Request, actionId: string, operation: "read" | "decide") {
  try {
    const root = dataRoot();
    const assertAuthority = () => { authenticateOwner(request, root, operation === "decide"); };
    assertAuthority();
    if (!idSchema.safeParse(actionId).success) throw new ControlError("validation_failed");
    const { canonicalRoot, credential } = readControlCredential(root);
    const owner = () => { const claim = assertBackendMutation(canonicalRoot); if (!claim) throw new ControlError("ownership_conflict"); return claim; };
    const service = createActionService({ readConfig: () => readControlConfig(canonicalRoot), readRecords: () => readActionJournal(canonicalRoot).records,
      saveRecord: (record, revision = null) => createActionStore(canonicalRoot, owner()).save(record, revision), assertMutation: () => { owner(); },
      readMedia: (id) => readControlMedia(canonicalRoot, id), mediaRevision: (id) => controlMediaRevision(canonicalRoot, id),
      bindAccount: (target) => bindControlAccount(canonicalRoot, credential.token, target), environmentValue: (name) => process.env[name],
      timezone: () => process.env.CROSSPOSTER_TIMEZONE || "Europe/Berlin", now: () => new Date(), createId: randomUUID });
    const action = operation === "read" ? await service.get(actionId) : await service.decide(actionId, await readControlJson(request), assertAuthority);
    assertAuthority();
    return success(actionSchema.parse(action));
  } catch (error) { return controlFailure(error); }
}
