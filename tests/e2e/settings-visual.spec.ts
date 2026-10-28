import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test, expect } from "./settings-fixtures";

const phase = process.env.SETTINGS_VISUAL_PHASE || "after";
const artifactRoot = path.resolve("output/playwright", `settings-${phase}`);
const baselineRoot = process.env.SETTINGS_VISUAL_BASELINE;
for (const viewport of [{ width: 390, height: 844 }, { width: 1440, height: 900 }]) {
  for (const scale of [1, 2]) {
    test(`settings visual ${viewport.width}x${viewport.height} font ${scale * 100}%`, async ({ page, settingsState }) => {
      expect(settingsState.config.profiles.bluesky[0].values.BLUESKY_APP_PASSWORD).toBe("fixture-only-token");
      await page.setViewportSize(viewport);
      await page.clock.setFixedTime(new Date("2026-10-28T12:00:00.000Z"));
      for (const view of ["socials", "storage", "settings"]) {
        await page.goto(view === "settings" ? "/settings" : `/settings/${view}`);
        await expect(page.getByRole("button", { name: "Save config" })).toBeVisible();
        await expect(page.getByText(view === "socials" ? "Fixture Bluesky" : view === "storage" ? "/fixture/uploads" : "Crossposter 1.1.16", { exact: true })).toBeVisible();
        const fonts = await page.evaluate((fontScale) => {
          const elements = Array.from(document.querySelectorAll<HTMLElement>("body, body *")).filter((e) => e instanceof HTMLElement);
          const baseline = elements.map((e) => [e, parseFloat(getComputedStyle(e).fontSize)] as const);
          for (const [element, size] of baseline) element.style.fontSize = `${size * fontScale}px`;
          return { body: getComputedStyle(document.body).fontSize, input: getComputedStyle(document.querySelector("input") || document.body).fontSize };
        }, scale);
        await page.evaluate(() => document.fonts.ready);
        await page.evaluate(() => window.scrollTo(0, 0));
        const filename = `${viewport.width}x${viewport.height}-font${scale * 100}-${view}.png`;
        mkdirSync(artifactRoot, { recursive: true });
        await page.screenshot({ path: path.join(artifactRoot, filename), fullPage: true, animations: "disabled" });
        const bytes = readFileSync(path.join(artifactRoot, filename));
        const baseline = baselineRoot ? readFileSync(path.join(baselineRoot, filename)) : undefined;
        if (baseline) expect(bytes.equals(baseline), `${filename} must match the retained baseline exactly`).toBe(true);
        writeFileSync(path.join(artifactRoot, `${filename}.json`), JSON.stringify({ filename, phase, viewport, fontScale: scale, fonts,
          capturedAt: new Date().toISOString(), sha256: createHash("sha256").update(bytes).digest("hex"),
          baselineSha256: baseline ? createHash("sha256").update(baseline).digest("hex") : null, byteIdentical: baseline ? bytes.equals(baseline) : null,
          fontMethod: "Each HTML element baseline computed font-size times scale; viewport/device/page zoom fixed", secrets: "Synthetic fixture placeholders; secret inputs remain masked" }, null, 2));
      }
    });
  }
}
