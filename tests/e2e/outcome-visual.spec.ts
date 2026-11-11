import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test, expect } from "./fixtures";
import type { PublicationView, ScheduleView } from "@/lib/publication-outcomes";

test.use({ timezoneId: "UTC", locale: "en-US" });

const clock = "2026-10-28T12:00:00.000Z";
const longError = `The response could not be read after possible acceptance. ${"Preserve this diagnostic and inspect the remote account before composing a new attempt. ".repeat(5)} ${"long-reference-".repeat(16)}`;
const results = [
  { platform: "bluesky" as const, targetId: "bluesky:north", profileLabel: "North account", ok: true, message: "Published; the provider returned no URL." },
  { platform: "bluesky" as const, targetId: "bluesky:south", profileLabel: "South account", ok: false, message: longError },
  { platform: "bluesky" as const, targetId: "bluesky:east", profileLabel: "East account", ok: false, uncertain: true, message: "The response was lost. Publication may have completed.", url: "https://fixture.example/inspect" }
];
const retained: PublicationView = { id: "outcome-history", createdAt: clock, title: "Retained account outcomes", text: "Original post and account evidence remain retained.", platforms: ["bluesky"], results,
  outcomes: [
    { target: { id: "bluesky:north", platform: "bluesky", profileId: "north", label: "North account" }, state: "succeeded", message: "Publication succeeded without a returned URL.", url: null },
    { target: { id: "bluesky:south", platform: "bluesky", profileId: "south", label: "South account" }, state: "failed", message: "The provider returned an unsuccessful result. Inspect the account before another attempt.", url: null },
    { target: { id: "bluesky:east", platform: "bluesky", profileId: "east", label: "East account" }, state: "uncertain", message: "Publication may have completed. Inspect the remote account.", url: "https://fixture.example/inspect" },
    { target: { id: "bluesky:west", platform: "bluesky", profileId: "west", label: "West account" }, state: "not_dispatched", message: "Execution stopped before this account was sent to the provider.", url: null }
  ] };

for (const theme of ["light", "dark"] as const) for (const viewport of [{ width: 390, height: 844 }, { width: 1440, height: 900 }]) for (const scale of [1, 2]) {
  test(`account outcomes ${theme} ${viewport.width}x${viewport.height} font${scale * 100}`, async ({ page, fixtureState }) => {
    await page.setViewportSize(viewport); await page.emulateMedia({ colorScheme: theme });
    await page.addInitScript((mode) => localStorage.setItem("crossposter:theme", mode), theme);
    await page.clock.setFixedTime(new Date(clock));
    fixtureState.publishedPosts = [structuredClone(retained)]; fixtureState.publishResponse = { results };
    await page.goto("/"); await expect(page.getByRole("checkbox")).toBeChecked();
    await page.getByPlaceholder("Write the post once.").fill("Deliberate fixture publication");
    await page.getByRole("button", { name: "Publish draft", exact: true }).click();
    const latest = page.getByLabel("Latest publish result"); const history = page.getByLabel("Published posts");
    for (const status of ["Published", "Failed", "Outcome unknown"]) await expect(latest.getByText(status, { exact: true })).toBeVisible();
    await expect(history.getByText("Not sent", { exact: true })).toBeVisible();
    const disclosure = latest.getByText("Details for Bluesky · South account", { exact: true });
    await disclosure.focus(); await expect(disclosure).toBeFocused(); await page.keyboard.press("Enter");
    await expect(latest.getByText(longError, { exact: true })).toBeVisible();
    await expect(latest.locator("details")).toHaveAttribute("open", "");
    const link = history.getByRole("link", { name: "Inspect retained link for Bluesky · East account" }); await link.focus(); await expect(link).toBeFocused();
    expect(fixtureState.publishRequests).toHaveLength(1);

    async function capture(surface: string, target: ReturnType<typeof page.locator>) {
      const fonts = await page.evaluate((fontScale) => {
        const all = Array.from(document.querySelectorAll<HTMLElement>("body, body *"));
        const baseline = all.map((element) => [element, parseFloat(getComputedStyle(element).fontSize)] as const);
        for (const [element, size] of baseline) element.style.fontSize = `${size * fontScale}px`;
        return { body: getComputedStyle(document.body).fontSize };
      }, scale);
      await page.evaluate(() => document.fonts.ready);
      const overflow = await target.evaluate((root) => {
        const bounds = root.getBoundingClientRect();
        return Array.from(root.querySelectorAll<HTMLElement>("strong, p, summary, input, output, button, .badge")).filter((element) => {
          const rect = element.getBoundingClientRect(); return rect.width > 0 && (rect.left < bounds.left - 1 || rect.right > bounds.right + 1);
        }).map((element) => ({ tag: element.tagName, text: element.textContent?.slice(0, 80) }));
      });
      expect(overflow, `${surface} text and controls remain within the surface`).toEqual([]);
      const root = path.resolve(process.env.CROSSPOSTER_OUTCOME_SCREENSHOTS || "output/playwright/outcomes"); mkdirSync(root, { recursive: true });
      const filename = `${surface}-${theme}-${viewport.width}x${viewport.height}-font${scale * 100}.png`; const pathname = path.join(root, filename);
      await page.evaluate(() => window.scrollTo(0, 0));
      const clip = await target.evaluate((element) => { const rect = element.getBoundingClientRect(); return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }; });
      await page.screenshot({ path: pathname, fullPage: true, clip, animations: "disabled" }); const bytes = readFileSync(pathname);
      writeFileSync(`${pathname}.json`, JSON.stringify({ filename, surface, theme, viewport, fontScale: scale, fonts, clock, capturedAt: new Date().toISOString(),
        candidate: process.env.CROSSPOSTER_VISUAL_CANDIDATE || null, sha256: createHash("sha256").update(bytes).digest("hex"),
        fontMethod: "Each element baseline computed font-size multiplied once; fixed viewport/device scale", captureMode: "Document-coordinate clip from full-page capture at scroll0; no hidden styles or masks", overflow }, null, 2));
    }
    await capture("results", latest);
    // A fresh navigation restores unscaled computed fonts for each surface.
    await page.reload(); await expect(page.getByLabel("Published posts")).toBeVisible(); await capture("history", page.getByLabel("Published posts"));
    const queue: ScheduleView = { ...retained, id: "outcome-schedule", title: `Scheduled account evidence ${"long-title-".repeat(8)}`, createdAt: clock, updatedAt: clock,
      scheduledFor: clock, status: "failed", attempts: 1, lastError: longError, authorization: { actionId: "fixture-frozen-action", payloadDigest: "sha256:fixture" } };
    const untouched: ScheduleView = { id: "untouched", createdAt: clock, updatedAt: clock, scheduledFor: clock, text: "Untouched schedule", platforms: ["bluesky"], status: "scheduled", attempts: 0 };
    fixtureState.scheduledPosts = [queue, untouched];
    await page.goto("/scheduled"); const cards = page.locator(".scheduler-list");
    await expect(cards.getByText("Not sent", { exact: true })).toHaveCount(2);
    const failed = page.locator(".scheduled-card").filter({ hasText: queue.title });
    await expect(failed.getByRole("button", { name: "Save timing" })).toHaveCount(0);
    await expect(failed.getByText(/requires a new reschedule preparation and owner approval/)).toBeVisible();
    const scheduleError = failed.getByText("Schedule error details", { exact: true }); await scheduleError.focus(); await page.keyboard.press("Enter");
    await expect(failed.getByText(longError, { exact: true })).toBeVisible(); await page.keyboard.press("Enter");
    await expect(page.locator(".schedule-edit-value")).toHaveText("2026-10-28 at 12:00");
    const discard = failed.getByRole("button", { name: "Discard" }); await discard.focus(); await expect(discard).toBeFocused();
    await capture("schedule", cards);
    expect(fixtureState.publishRequests).toHaveLength(1); expect(fixtureState.publishedPosts).toEqual([retained]);
  });
}
