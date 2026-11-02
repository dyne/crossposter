import { test as base, expect } from "@playwright/test";
import { approvalFixture, fixtureOwnerPassword, fixtureOwnerSession } from "../app/support/approval-fixture";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import type { ControlAction } from "@/lib/control/contracts";

export type ApprovalFixtureState = {
  authenticated: boolean; action: ControlAction; setup: boolean; loginError: boolean;
  loadError: string | null; decisionError: string | null; decisions: unknown[];
  holdDecision: boolean; releaseDecision: () => void;
};
const mediaBytes = readFileSync(path.resolve("public/assets/logo-crossposter.png"));
export const approvalMedia = { id: "00000000-0000-0000-0000-000000000000.png", filename: "synthetic-crossposter-logo.png", kind: "image" as const,
  contentType: "image/png", size: mediaBytes.length, url: "/api/media/00000000-0000-0000-0000-000000000000.png", digest: `sha256:${createHash("sha256").update(mediaBytes).digest("hex")}` };
export const test = base.extend<{ approval: ApprovalFixtureState }>({
  approval: async ({ context }, runFixture) => {
    const state: ApprovalFixtureState = { authenticated: true, action: approvalFixture(), setup: true, loginError: false,
      loadError: null, decisionError: null, decisions: [], holdDecision: false, releaseDecision: () => {} };
    const unexpected: string[] = []; const held: Array<() => void> = [];
    await context.route("**/*", async (route) => {
      const request = route.request(); const url = new URL(request.url());
      if (url.origin !== "http://127.0.0.1:4173") { unexpected.push(`${request.method()} ${url.origin}${url.pathname}`); await route.abort(); return; }
      if (!url.pathname.startsWith("/api/")) { await route.continue(); return; }
      const ok = (data: unknown) => route.fulfill({ json: { ok: true, data } });
      const fail = (code: string, status: number) => route.fulfill({ status, json: { ok: false, error: { code } } });
      if (url.pathname === "/api/approvals/session") {
        if (!state.setup) { await fail("approval_setup_required", 409); return; }
        if (request.method() === "POST") {
          if (request.headers()["content-type"]?.split(";")[0] !== "application/json") { await fail("validation_failed", 400); return; }
          if (state.loginError || request.postDataJSON().password !== fixtureOwnerPassword) { await fail("approval_required", 401); return; }
          state.authenticated = true;
        }
        if (request.method() === "DELETE") { state.authenticated = false; await ok({ authenticated: false }); return; }
        await (state.authenticated ? ok(fixtureOwnerSession) : fail("approval_required", 401)); return;
      }
      if (url.pathname === `/api/approvals/actions/${state.action.id}`) {
        if (!state.authenticated) { await fail("approval_required", 401); return; }
        if (state.loadError) { await fail(state.loadError, 503); return; }
        if (request.method() === "POST") {
          const body = request.postDataJSON(); state.decisions.push(body);
          if (state.holdDecision) await new Promise<void>((resolve) => { held.push(resolve); state.releaseDecision = resolve; });
          if (state.decisionError) { await fail(state.decisionError, 409); return; }
          if (request.headers()["x-crossposter-csrf"] !== fixtureOwnerSession.csrf) { await fail("forbidden", 403); return; }
          if (body.expectedRevision !== state.action.revision || body.expectedDigest !== state.action.payloadDigest || body.expiresAt !== state.action.expiresAt) { await fail("revision_conflict", 409); return; }
          state.action = approvalFixture({ ...state.action, state: body.decision === "approve" ? "approved" : "rejected" });
        }
        await ok(state.action); return;
      }
      if (state.action.payload.media && url.pathname === state.action.payload.media.url && request.method() === "GET") {
        await route.fulfill({ body: mediaBytes, contentType: "image/png" }); return;
      }
      unexpected.push(`${request.method()} ${url.pathname}`); await route.abort();
    });
    await context.routeWebSocket(/.*/, (socket) => { unexpected.push(`WebSocket ${socket.url()}`); socket.close(); });
    try { await runFixture(state); } finally { for (const release of held) release(); }
    expect(unexpected, "Approval browser traffic must use explicit local fixtures").toEqual([]);
  }
});
export { expect, approvalFixture, fixtureOwnerPassword, fixtureOwnerSession };
