import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test, expect, approvalFixture, approvalMedia } from "./approval-fixtures";
import { approvalFixtureTime } from "../app/support/approval-fixture";
import type { ControlAction } from "@/lib/control/contracts";

const phase = process.env.APPROVAL_VISUAL_PHASE || "after";
const root = path.resolve("output/playwright", `approvals-${phase}`);
for (const theme of ["light", "dark"]) for (const viewport of [{ width: 390, height: 844 }, { width: 1440, height: 900 }]) for (const scale of [1, 2]) {
  test(`approval visual ${theme} ${viewport.width}x${viewport.height} font ${scale * 100}%`, async ({ page, approval }) => {
    const base = approvalFixture();
    const text = "Synthetic fixture for a complete owner review.\n\n" +
      "The local publishing workflow keeps the exact title, complete post, selected accounts and stored media together. Read every paragraph before deciding.\n\n".repeat(5) +
      "Final fixture paragraph: the end of this content must stay visible without truncation.";
    const prepared = approvalFixture({ payload: { ...base.payload, content: { ...base.payload.content, text, mediaId: approvalMedia.id }, media: approvalMedia } });
    approval.action = prepared;
    await page.setViewportSize(viewport); await page.addInitScript((mode) => localStorage.setItem("crossposter:theme", mode), theme);
    await page.clock.setFixedTime(new Date(approvalFixtureTime)); await page.goto(`/approvals/${approval.action.id}`);
    await expect(page.getByRole("heading", { name: "Ready for your decision" })).toBeVisible();
    await expect(page.getByAltText(`Prepared media: ${approvalMedia.filename}`)).toBeVisible();
    async function capture(state: string) {
      await page.evaluate(() => document.fonts.ready);
      const metrics = await page.evaluate((factor) => {
        const nodes = Array.from(document.querySelectorAll<HTMLElement>("body, body *")).filter((element) => element instanceof HTMLElement);
        for (const node of nodes) if (node.dataset.fixtureFontSize) node.style.fontSize = node.dataset.fixtureFontSize;
        const originals = nodes.map((node) => { const size = node.dataset.fixtureFontSize || getComputedStyle(node).fontSize; node.dataset.fixtureFontSize = size; return [node, parseFloat(size)] as const; });
        for (const [node, size] of originals) node.style.fontSize = `${size * factor}px`;
        const button = document.querySelector<HTMLButtonElement>("footer button");
        return { width: innerWidth, scrollWidth: document.documentElement.scrollWidth, bodyFont: getComputedStyle(document.body).fontSize,
          buttonFont: button ? getComputedStyle(button).fontSize : null, buttonHeight: button?.getBoundingClientRect().height ?? null,
          background: getComputedStyle(document.body).backgroundColor, ink: getComputedStyle(document.body).color };
      }, scale);
      expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.width);
      await page.evaluate(() => window.scrollTo(0, 0));
      const filename = `${theme}-${viewport.width}x${viewport.height}-font${scale * 100}-${state}.png`; mkdirSync(root, { recursive: true });
      await page.screenshot({ path: path.join(root, filename), fullPage: true, animations: "disabled" });
      const bytes = readFileSync(path.join(root, filename));
      writeFileSync(path.join(root, `${filename}.json`), JSON.stringify({ filename, phase, theme, viewport, fontScale: scale, state, metrics,
        fixedDate: approvalFixtureTime, capturedAt: new Date().toISOString(), sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length,
        fontMethod: "Each HTML element baseline computed font-size times scale; no viewport/device/page zoom" }, null, 2));
    }
    await capture("prepared");
    // The full layout matrix uses the long, multi-target/media preparation.
    // State captures share one deterministic desktop/theme fixture in this batch.
    if (theme === "light" && viewport.width === 1440 && scale === 1) {
      for (const state of ["approved", "rejected", "expired", "conflicting", "executing", "succeeded"] as ControlAction["state"][]) {
        approval.action = approvalFixture({ ...prepared, state, outcomes: prepared.outcomes.map((outcome) => ({ ...outcome,
          state: state === "succeeded" ? "succeeded" : state === "executing" ? "dispatching" : "not_dispatched",
          message: state === "succeeded" ? "Synthetic recorded success." : state === "executing" ? "Synthetic dispatch in progress." : outcome.message })) });
        await page.getByRole("button", { name: "Refresh status" }).click(); await expect(page.getByRole("button", { name: "Approve", exact: true })).toBeDisabled();
        await capture(state === "succeeded" ? "completed" : state);
      }
      approval.authenticated = false; await page.reload(); await expect(page.getByLabel("Local owner password")).toBeVisible(); await capture("signin");
      approval.setup = false; await page.getByRole("button", { name: "Reload approval" }).click(); await expect(page.getByRole("heading", { name: "Owner approval is not configured" })).toBeVisible(); await capture("setup");
      approval.setup = true; approval.authenticated = true; approval.loadError = "storage_unavailable";
      await page.getByRole("button", { name: "Reload approval" }).click(); await expect(page.getByRole("alert").filter({ hasText: "cannot be read safely" })).toBeVisible(); await capture("error");
    }
  });
}
