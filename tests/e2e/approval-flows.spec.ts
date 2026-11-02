import { test, expect, approvalFixture, fixtureOwnerPassword, fixtureOwnerSession } from "./approval-fixtures";
import { approvalFixtureTime } from "../app/support/approval-fixture";
import { writeFileSync } from "node:fs";

test.beforeEach(async ({ page }) => { await page.clock.setFixedTime(new Date(approvalFixtureTime)); });
test("native credential submission uses a fixed POST endpoint and fails closed without putting the password in the URL", async ({ page, approval }) => {
  approval.authenticated = false; await page.goto(`/approvals/${approval.action.id}`);
  await page.getByLabel("Local owner password").fill(fixtureOwnerPassword);
  const [response, request] = await Promise.all([
    page.waitForNavigation({ waitUntil: "domcontentloaded" }),
    page.waitForRequest((request) => request.isNavigationRequest() && request.frame() === page.mainFrame()),
    page.getByLabel("Local owner password").evaluate((input) => HTMLFormElement.prototype.submit.call((input as HTMLInputElement).form))
  ]);
  const url = new URL(request.url()); const body = new URLSearchParams(request.postData() || "");
  writeFileSync(test.info().outputPath("native-form-observation.json"), JSON.stringify({ method: request.method(), path: url.pathname,
    queryKeys: [...url.searchParams.keys()], bodyKeys: [...body.keys()], bodyPasswordMatchesFixture: body.get("password") === fixtureOwnerPassword,
    responseStatus: response?.status() }, null, 2));
  expect(request.method()).toBe("POST"); expect(url.pathname).toBe("/api/approvals/session"); expect(url.search).toBe("");
  expect(request.url()).not.toContain(fixtureOwnerPassword); expect(body.get("password")).toBe(fixtureOwnerPassword);
  expect(response!.status()).toBe(400); expect((await response!.json()).error.code).toBe("validation_failed"); expect(approval.authenticated).toBe(false);
  await page.goto(`/approvals/${approval.action.id}`); await page.getByLabel("Local owner password").fill(fixtureOwnerPassword);
  await page.getByRole("button", { name: "Sign in to review" }).click();
  await expect(page.getByRole("heading", { name: "Ready for your decision" })).toBeFocused(); expect(approval.authenticated).toBe(true);
  expect(approval.decisions).toHaveLength(0);
});
test("owner signs in with the keyboard, inspects exact data, approves and reloads the durable result", async ({ page, approval }) => {
  approval.authenticated = false; await page.goto(`/approvals/${approval.action.id}`);
  const password = page.getByLabel("Local owner password"); await expect(password).toBeVisible();
  await password.focus(); await page.keyboard.type(fixtureOwnerPassword); await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Sign in to review" })).toBeFocused(); await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Ready for your decision" })).toBeFocused();
  for (const target of approval.action.payload.targets) await expect(page.getByText(target.id, { exact: true })).toBeVisible();
  await expect(page.getByText(approval.action.payloadDigest, { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: approval.action.payload.content.linkUrl })).toHaveAttribute("href", approval.action.payload.content.linkUrl);
  const approve = page.getByRole("button", { name: "Approve", exact: true }); await approve.focus(); await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Approved for later commit" })).toBeFocused(); expect(approval.decisions).toHaveLength(1);
  await page.reload(); await expect(page.getByRole("heading", { name: "Approved for later commit" })).toBeVisible();
  await expect(approve).toBeDisabled(); await expect(page.getByText(/Approval is not evidence of publication/).first()).toBeVisible();
});
test("incorrect password, absent setup and loading errors provide recovery", async ({ page, approval }) => {
  approval.authenticated = false; await page.goto(`/approvals/${approval.action.id}`);
  await page.getByLabel("Local owner password").fill("wrong"); await page.getByRole("button", { name: "Sign in to review" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "password was not accepted" })).toBeVisible(); await expect(page.getByLabel("Local owner password")).toHaveValue("");
  approval.setup = false; await page.getByRole("button", { name: "Reload approval" }).click(); await expect(page.getByRole("heading", { name: "Owner approval is not configured" })).toBeVisible();
  await expect(page.getByLabel("Local owner password")).toHaveCount(0);
  approval.setup = true; approval.authenticated = true; approval.loadError = "storage_unavailable";
  await page.getByRole("button", { name: "Reload approval" }).click(); await expect(page.getByRole("alert").filter({ hasText: "cannot be read safely" })).toBeVisible();
  approval.loadError = null; await page.getByRole("button", { name: "Reload approval" }).click(); await expect(page.getByRole("heading", { name: "Ready for your decision" })).toBeVisible();
});
test("a pending decision disables all mutation controls and double clicks submit once", async ({ page, approval }) => {
  approval.holdDecision = true; await page.goto(`/approvals/${approval.action.id}`);
  const reject = page.getByRole("button", { name: "Reject", exact: true }); await expect(reject).toBeEnabled();
  try {
    await reject.evaluate((element) => { (element as HTMLButtonElement).click(); (element as HTMLButtonElement).click(); });
    await expect.poll(() => approval.decisions.length).toBe(1); await expect(reject).toBeDisabled(); await expect(page.getByRole("button", { name: "Sign out" })).toBeDisabled();
    approval.releaseDecision(); await expect(page.getByRole("heading", { name: "Rejected", exact: true })).toBeFocused();
    await page.reload(); await expect(page.getByRole("heading", { name: "Rejected", exact: true })).toBeVisible();
  } finally { approval.releaseDecision(); }
});
test("changed preparations fail closed and refresh exposes their conflicting state", async ({ page, approval }) => {
  approval.decisionError = "action_conflict"; await page.goto(`/approvals/${approval.action.id}`); await page.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Preparation changed" })).toBeVisible(); await expect(page.getByRole("button", { name: "Approve", exact: true })).toBeDisabled();
  approval.action = approvalFixture({ state: "conflicting" }); await page.getByRole("button", { name: "Refresh status" }).click(); await expect(page.getByRole("heading", { name: "Preparation changed" })).toBeVisible();
  expect(approval.decisions).toHaveLength(1);
});
test("session and preparation deadlines remove decision authority in the open page", async ({ page, approval }) => {
  await page.clock.install({ time: new Date(approvalFixtureTime) }); await page.goto(`/approvals/${approval.action.id}`);
  await expect(page.getByRole("button", { name: "Approve", exact: true })).toBeEnabled();
  await page.clock.fastForward(Date.parse(fixtureOwnerSession.expiresAt) - Date.parse(approvalFixtureTime) + 2);
  await expect(page.getByLabel("Local owner password")).toBeVisible(); expect(approval.decisions).toHaveLength(0);
  await page.clock.setSystemTime(new Date(approvalFixtureTime)); approval.action = approvalFixture({ expiresAt: "2026-10-28T12:00:01.000Z" }); await page.reload();
  await expect(page.getByRole("button", { name: "Approve", exact: true })).toBeEnabled(); await page.clock.fastForward(1002);
  await expect(page.getByRole("heading", { name: "Preparation expired" })).toBeVisible(); await expect(page.getByRole("button", { name: "Approve", exact: true })).toBeDisabled();
});
test("production page headers prevent same-origin framing", async ({ page, approval }) => {
  const response = await page.goto(`/approvals/${approval.action.id}`); expect(response!.headers()["x-frame-options"]).toBe("DENY");
  expect(response!.headers()["content-security-policy"]).toContain("frame-ancestors 'none'");
  await page.evaluate((id) => { const frame = document.createElement("iframe"); frame.id = "blocked-frame"; frame.src = `/approvals/${id}`; document.body.append(frame); }, approval.action.id);
  await expect.poll(() => page.frames().filter((frame) => frame.url().includes("/approvals/")).length).toBe(1);
  await expect.poll(() => page.evaluate(() => (document.querySelector("#blocked-frame") as HTMLIFrameElement).contentDocument === null)).toBe(true);
});
