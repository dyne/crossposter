import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test, expect } from "./scheduled-fixtures";
import { calendarNow } from "../app/support/scheduled-fixture";

test.use({ timezoneId: "Europe/Berlin", locale: "en-US", colorScheme: "light" });
const phase = process.env.SCHEDULED_VISUAL_PHASE || "after";
const artifactRoot = path.resolve("output/playwright", `scheduled-${phase}`);
for (const viewport of [{ width: 390, height: 844 }, { width: 1440, height: 900 }]) {
  for (const scale of [1, 2]) {
    test(`scheduled calendar/list ${viewport.width}x${viewport.height} font ${scale * 100}%`, async ({ page, scheduleState }) => {
      expect(scheduleState.posts.some((post) => post.results?.some((result) => result.uncertain))).toBe(true);
      await page.setViewportSize(viewport);
      await page.clock.setFixedTime(new Date(calendarNow));
      await page.goto("/scheduled");
      await expect(page.getByText("Check uncertain result", { exact: true })).toBeVisible();
      await expect(page.locator(".scheduled-card")).toHaveCount(4);
      const fonts = await page.evaluate((fontScale) => {
        const elements = Array.from(document.querySelectorAll<HTMLElement>("body, body *")).filter((e) => e instanceof HTMLElement);
        const baseline = elements.map((e) => [e, parseFloat(getComputedStyle(e).fontSize)] as const);
        for (const [element, size] of baseline) element.style.fontSize = `${size * fontScale}px`;
        return { body: getComputedStyle(document.body).fontSize, input: getComputedStyle(document.querySelector("input")!).fontSize };
      }, scale);
      await page.evaluate(() => document.fonts.ready);
      await page.evaluate(() => window.scrollTo(0, 0));
      const filename = `${viewport.width}x${viewport.height}-font${scale * 100}-calendar-list.png`;
      mkdirSync(artifactRoot, { recursive: true });
      await page.screenshot({ path: path.join(artifactRoot, filename), fullPage: true, animations: "disabled" });
      const bytes = readFileSync(path.join(artifactRoot, filename));
      const baseline = process.env.SCHEDULED_VISUAL_BASELINE ? readFileSync(path.join(process.env.SCHEDULED_VISUAL_BASELINE, filename)) : undefined;
      writeFileSync(path.join(artifactRoot, `${filename}.json`), JSON.stringify({ filename, phase, viewport, fontScale: scale, fonts, capturedAt: new Date().toISOString(), clock: calendarNow, timezone: "Europe/Berlin", locale: "en-US", sha256: createHash("sha256").update(bytes).digest("hex"), baselineSha256: baseline ? createHash("sha256").update(baseline).digest("hex") : null, byteIdentical: baseline ? bytes.equals(baseline) : null, fontMethod: "Each HTML element baseline computed font-size times scale; viewport/device/page zoom fixed", coverage: "Full calendar and complete four-item list including failed/uncertain, publishing and due items" }, null, 2));
      if (baseline) expect(bytes.equals(baseline), `${filename} must match the retained original baseline exactly`).toBe(true);
    });
  }
}
