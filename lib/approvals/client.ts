import { z } from "zod-control";
import { actionSchema, timestampSchema, type ControlAction } from "@/lib/control/contracts";
import type { OwnerDecisionInput } from "@/lib/control/approval-contracts";

const sessionSchema = z.strictObject({ authenticated: z.literal(true), csrf: z.string().regex(/^[a-f0-9]{64}$/), expiresAt: timestampSchema });
export type OwnerSession = z.infer<typeof sessionSchema>;
export class ApprovalError extends Error {
  constructor(readonly code: string) { super(code); }
}
async function call(endpoint: string, options: RequestInit = {}) {
  let response: Response;
  try { response = await fetch(`/api/approvals/${endpoint}`, { ...options, credentials: "same-origin", cache: "no-store", redirect: "error" }); }
  catch (error) { if (error instanceof Error && error.name === "AbortError") throw error; throw new ApprovalError("backend_unavailable"); }
  let body;
  try { body = await response.json(); } catch { throw new ApprovalError("backend_unavailable"); }
  if (!response.ok || body?.ok !== true) throw new ApprovalError(typeof body?.error?.code === "string" ? body.error.code : "backend_unavailable");
  return body.data;
}
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new ApprovalError("storage_corrupt");
  return result.data;
}
export const approvalClient = {
  async session(signal: AbortSignal) { return parse(sessionSchema, await call("session", { signal })); },
  async login(password: string, signal: AbortSignal) {
    return parse(sessionSchema, await call("session", { method: "POST", signal,
      headers: { "content-type": "application/json" }, body: JSON.stringify({ password }) }));
  },
  async logout(session: OwnerSession, signal: AbortSignal) {
    await call("session", { method: "DELETE", signal, headers: { "content-type": "application/json", "x-crossposter-csrf": session.csrf }, body: "{}" });
  },
  async action(id: string, signal: AbortSignal): Promise<ControlAction> { return parse(actionSchema, await call(`actions/${encodeURIComponent(id)}`, { signal })); },
  async decide(id: string, input: OwnerDecisionInput, session: OwnerSession, signal: AbortSignal): Promise<ControlAction> {
    return parse(actionSchema, await call(`actions/${encodeURIComponent(id)}`, { method: "POST", signal,
      headers: { "content-type": "application/json", "x-crossposter-csrf": session.csrf }, body: JSON.stringify(input) }));
  }
};
export function approvalMessage(code: string) {
  switch (code) {
    case "approval_required": return "Your password was not accepted, your session expired, or sign-in attempts are temporarily limited. Sign in again or wait up to 15 minutes.";
    case "approval_setup_required": return "Set POSTER_ADMIN_PASSWORD locally outside your MCP client, then reload this page. Use the independent local approval setup in the README.";
    case "forbidden": return "Open the exact local approval URL supplied with this action. If you are already there, sign in again and retry.";
    case "approval_expired": return "This preparation expired. Request a new preparation and review it again.";
    case "action_conflict": case "revision_conflict": return "The preparation changed while you were reviewing it. Refresh its status and request a new preparation.";
    case "action_missing": return "This prepared action was not found. Check the approval URL or request a new preparation.";
    case "ownership_conflict": return "Another backend owns this local data. Restore the original backend, then refresh.";
    case "storage_corrupt": case "storage_unavailable": return "The saved action cannot be read safely. Check the local backend before trying again.";
    default: return "The local backend could not complete this request. Check that it is running, then refresh.";
  }
}
