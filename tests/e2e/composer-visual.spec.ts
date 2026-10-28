import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test, expect, fixturePng } from "./fixtures";

const fixedDate = "2026-10-28T12:00:00.000Z";
const phase = process.env.COMPOSER_VISUAL_PHASE || "after";
const artifactRoot = path.resolve("output/playwright", `composer-${phase}`);

for (const viewport of [{ width: 390, height: 844 }, { width: 1440, height: 900 }]) {
  for (const scale of [1, 2]) {
    test(`composer visual ${viewport.width}x${viewport.height} font ${scale * 100}%`, async ({ page, fixtureState }) => {
      await page.setViewportSize(viewport);
      await page.clock.setFixedTime(new Date(fixedDate));
      await page.goto("/");
      await expect(page.getByText("Profile: Fixture Bluesky")).toBeVisible();
      await expect(page.getByRole("checkbox")).toBeChecked();
      await page.getByLabel("Title", { exact: true }).fill("Fixture composer title");
      await page.getByPlaceholder("Write the post once.").fill("Fixture composer text for visual comparison.");
      await expect.poll(() => fixtureState.draft.text).toBe("Fixture composer text for visual comparison.");

      async function capture(state: string) {
        // Text-only scaling: snapshot computed font sizes BEFORE changing any
        // ancestor. Every HTML element receives its own 1x/2x original size.
        // Viewport, device scale, spacing, images and browser zoom stay fixed.
        const fonts = await page.evaluate((fontScale) => {
          const elements = Array.from(document.querySelectorAll<HTMLElement>("body, body *"))
            .filter((element) => element instanceof HTMLElement);
          for (const element of elements) {
            if (element.dataset.fixtureFontSize) element.style.fontSize = element.dataset.fixtureFontSize;
          }
          const original = elements.map((element) => {
            const size = element.dataset.fixtureFontSize || getComputedStyle(element).fontSize;
            element.dataset.fixtureFontSize = size;
            return [element, parseFloat(size)] as const;
          });
          for (const [element, size] of original) element.style.fontSize = `${size * fontScale}px`;
          return { root: getComputedStyle(document.body).fontSize, textarea: getComputedStyle(document.querySelector("textarea")!).fontSize };
        }, scale);
        await page.evaluate(() => document.fonts.ready);
        await page.evaluate(() => window.scrollTo(0, 0));
        const filename = `${viewport.width}x${viewport.height}-font${scale * 100}-${state}.png`;
        mkdirSync(artifactRoot, { recursive: true });
        await page.screenshot({ path: path.join(artifactRoot, filename), fullPage: true, animations: "disabled" });
        const bytes = readFileSync(path.join(artifactRoot, filename));
        writeFileSync(path.join(artifactRoot, `${filename}.json`), JSON.stringify({
          filename, phase, viewport, fontScale: scale, computedFonts: fonts,
          fixedDate, capturedAt: new Date().toISOString(),
          sha256: createHash("sha256").update(bytes).digest("hex"),
          fontMethod: "Each HTML element's baseline computed font-size times scale; no viewport/device/page zoom"
        }, null, 2));
      }

      await capture("composer");
      await page.locator("#mediaFile").setInputFiles({ name: "fixture.png", mimeType: "image/png", buffer: fixturePng });
      await expect(page.getByAltText("fixture.png", { exact: true })).toBeVisible();
      await expect(page.locator(".media-meta")).toContainText("1x1");
      await capture("media");
      await page.getByRole("button", { name: "Publish draft", exact: true }).click();
      await expect(page.getByLabel("Latest publish result")).toContainText("Fixture outcome unknown");
      await expect(page.locator(".progress-box")).toHaveCount(0);
      await capture("results");
    });
  }
}
