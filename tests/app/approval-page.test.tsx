// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ApprovalPage, approvalState } from "@/components/approvals/approval-page";
import { approvalFixture, approvalFixtureTime, fixtureOwnerPassword, fixtureOwnerSession } from "./support/approval-fixture";

beforeEach(() => { vi.spyOn(Date, "now").mockReturnValue(Date.parse(approvalFixtureTime)); });
afterEach(() => { cleanup(); localStorage.clear(); document.documentElement.removeAttribute("data-theme"); });
function api(authenticated = true, action = approvalFixture()) {
  const decisions: unknown[] = []; let current = action; let failure: string | null = null;
  let release: (() => void) | null = null; let held = false;
  const fetch = vi.fn(async (url: string, options: RequestInit = {}) => {
    const ok = (data: unknown) => Response.json({ ok: true, data });
    const fail = (code: string, status = 401) => Response.json({ ok: false, error: { code } }, { status });
    if (url.endsWith("/session")) {
      if (options.method === "POST") { if (JSON.parse(String(options.body)).password !== fixtureOwnerPassword) return fail("approval_required"); authenticated = true; }
      if (options.method === "DELETE") { authenticated = false; return ok({ authenticated: false }); }
      return authenticated ? ok(fixtureOwnerSession) : fail("approval_required");
    }
    if (options.method === "POST") {
      decisions.push(JSON.parse(String(options.body)));
      if (held) await new Promise<void>((resolve) => { release = resolve; });
      if (failure) return fail(failure, 409);
      current = approvalFixture({ ...current, state: JSON.parse(String(options.body)).decision === "approve" ? "approved" : "rejected" });
    }
    return ok(current);
  });
  vi.stubGlobal("fetch", fetch);
  return { fetch, decisions, hold: () => { held = true; }, release: () => release?.(), fail: (code: string) => { failure = code; } };
}
it("authenticates directly, clears the password field and submits only the exact decision binding", async () => {
  const f = api(false); render(<ApprovalPage actionId="fixture-approval" />);
  const password = await screen.findByLabelText("Local owner password");
  expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
  fireEvent.change(password, { target: { value: fixtureOwnerPassword } }); fireEvent.submit(password.closest("form")!);
  expect(password).toHaveValue("");
  await screen.findByRole("heading", { name: "Ready for your decision" });
  fireEvent.click(screen.getByRole("button", { name: "Approve" }));
  expect(await screen.findByRole("heading", { name: "Approved for later commit" })).toHaveFocus();
  const action = approvalFixture(); expect(f.decisions).toEqual([{ decision: "approve", expectedDigest: action.payloadDigest, expectedRevision: action.revision, expiresAt: action.expiresAt }]);
  const request = f.fetch.mock.calls.find(([, options]) => options?.method === "POST" && String(options.body).includes("expectedDigest"))![1]!;
  expect(request.headers).toMatchObject({ "x-crossposter-csrf": fixtureOwnerSession.csrf });
  expect(localStorage.getItem("crossposter:theme")).toBeNull();
});
it("shows exact multiline content, target identities, UTC/local time, warnings and full digests", async () => {
  api(); const action = approvalFixture(); const { container } = render(<ApprovalPage actionId={action.id} />);
  await screen.findByRole("heading", { name: "Exact content" });
  expect([...container.querySelectorAll("p")].some((element) => element.textContent === action.payload.content.text)).toBe(true);
  for (const value of ["bluesky:editorial", "mastodon:community", action.payloadDigest, action.revision, action.expiresAt, action.scheduledLocal!]) expect(screen.getByText(value, { exact: true })).toBeVisible();
  expect(screen.getByRole("link", { name: action.payload.content.linkUrl })).toHaveAttribute("rel", "noreferrer");
  expect(screen.getByText(action.warnings[0])).toBeVisible();
});
it.each(["approved", "rejected", "expired", "conflicting", "executing", "scheduled", "rescheduled", "canceled", "succeeded", "partial", "failed", "uncertain"] as const)("renders %s with decision controls disabled", async (state) => {
  api(true, approvalFixture({ state })); render(<ApprovalPage actionId="fixture-approval" />);
  await screen.findByRole("heading", { name: "Exact content" });
  expect(screen.getByRole("button", { name: "Approve" })).toBeDisabled(); expect(screen.getByRole("button", { name: "Reject" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Refresh status" })).toBeEnabled();
});
it("guards double clicks synchronously and focuses the durable result", async () => {
  const f = api(); f.hold(); render(<ApprovalPage actionId="fixture-approval" />);
  const button = await screen.findByRole("button", { name: "Reject" });
  try {
    fireEvent.click(button); fireEvent.click(button);
    await waitFor(() => expect(f.decisions).toHaveLength(1)); expect(button).toBeDisabled();
    await act(async () => { f.release(); }); expect(await screen.findByRole("heading", { name: "Rejected" })).toHaveFocus();
  } finally { await act(async () => { f.release(); }); }
});
it("shows safe sign-in failures and allows another attempt", async () => {
  api(false); render(<ApprovalPage actionId="fixture-approval" />); const password = await screen.findByLabelText("Local owner password");
  fireEvent.change(password, { target: { value: "wrong" } }); fireEvent.submit(password.closest("form")!);
  expect(await screen.findByRole("alert")).toHaveTextContent("password was not accepted"); expect(password).toHaveValue("");
  fireEvent.change(password, { target: { value: fixtureOwnerPassword } }); fireEvent.submit(password.closest("form")!);
  await screen.findByRole("heading", { name: "Ready for your decision" }); expect(screen.queryByRole("alert")).toBeNull();
});
it("blocks changed decisions and explains recovery without dispatching again", async () => {
  const f = api(); f.fail("action_conflict"); render(<ApprovalPage actionId="fixture-approval" />);
  fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
  expect(await screen.findByRole("heading", { name: "Preparation changed" })).toBeVisible(); expect(screen.getByRole("alert")).toHaveTextContent("request a new preparation");
  expect(screen.getByRole("button", { name: "Approve" })).toBeDisabled(); expect(f.decisions).toHaveLength(1);
});
it("signs out and removes the protected preview", async () => {
  api(); render(<ApprovalPage actionId="fixture-approval" />); fireEvent.click(await screen.findByRole("button", { name: "Sign out" }));
  await screen.findByLabelText("Local owner password"); expect(screen.queryByRole("heading", { name: "Exact content" })).toBeNull();
});
it("derives expiry only for preparatory states and preserves accepted schedules", () => {
  const action = approvalFixture(); expect(approvalState(action, Date.parse(action.expiresAt), null)).toBe("expired");
  expect(approvalState({ ...action, state: "scheduled" }, Date.parse(action.expiresAt) + 1000, null)).toBe("scheduled");
  expect(approvalState(action, 0, "revision_conflict")).toBe("conflicting");
  expect(approvalState(action, 0, "approval_expired")).toBe("expired");
});
