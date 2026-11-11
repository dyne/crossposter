import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test, expect, fixturePng } from "./fixtures";

declare global {
  interface Window {
    fixtureEncoding: { armed: boolean; pending: number; completed: number; release: () => void };
  }
}

const dribbble = { profiles: { dribbble: [{ id: "fixture", label: "Fixture Dribbble", values: { DRIBBBLE_ACCESS_TOKEN: "fixture-only-token", DRIBBBLE_TAGS: "fixture" } }] } };
const artifactRoot = path.resolve(process.env.MEDIA_VISUAL_DIR || "output/playwright/media-lifecycle");

for (const kind of ["compression", "crop"] as const) {
  for (const change of ["selection", "removal", "clear", "unmount"] as const) {
    test(`late canvas ${kind} cannot undo ${change} or upload obsolete media`, async ({ page, fixtureState }) => {
      if (kind === "crop") await page.route("**/api/config", (route) => route.fulfill({ json: dribbble }));
      await page.addInitScript(() => {
        const callbacks: Array<() => void> = [];
        const state = { armed: false, pending: 0, completed: 0, release: () => { for (const callback of callbacks.splice(0)) callback(); } };
        window.fixtureEncoding = state;
        const original = HTMLCanvasElement.prototype.toBlob;
        HTMLCanvasElement.prototype.toBlob = function(callback, type, quality) {
          const hold = state.armed;
          if (hold) state.armed = false;
          original.call(this, (blob) => {
            if (!hold) { callback(blob); return; }
            state.pending++;
            callbacks.push(() => { callback(blob); state.pending--; state.completed++; });
          }, type, quality);
        };
      });
      await page.goto("/");
      await expect(page.getByRole("checkbox")).toBeChecked();
      await page.getByLabel("Title", { exact: true }).fill("Fixture media title");
      await page.getByLabel("Post", { exact: true }).fill("Fixture media post");
      const input = page.locator("#mediaFile");
      await input.setInputFiles({ name: kind === "compression" ? "A.bmp" : "A.png", mimeType: kind === "compression" ? "image/bmp" : "image/png", buffer: fixturePng });
      await expect(page.locator(".media-meta")).toContainText("1x1");
      if (kind === "compression") await expect(page.locator(".compression-panel")).not.toContainText("calculating...");
      else await page.getByRole("button", { name: "Crop for Dribbble" }).click();
      await page.evaluate(() => { window.fixtureEncoding.armed = true; });
      let uploadBody = "";
      await page.route("**/api/media", async (route) => { uploadBody = route.request().postDataBuffer()?.toString("utf8") || ""; await route.fallback(); });
      try {
        await page.getByRole("button", { name: kind === "compression" ? "Compress image" : "Apply crop", exact: true }).click();
        await expect.poll(() => page.evaluate(() => window.fixtureEncoding.pending)).toBe(1);
        if (change === "selection") await input.setInputFiles({ name: "B.png", mimeType: "image/png", buffer: fixturePng });
        else if (change === "removal") await page.getByRole("button", { name: "Remove media file" }).click();
        else if (change === "clear") await page.getByRole("button", { name: "Clear draft", exact: true }).click();
        else { await page.getByRole("link", { name: "Scheduler", exact: true }).click(); await expect(page).toHaveURL(/\/scheduled$/); }
        await page.evaluate(() => window.fixtureEncoding.release());
        await expect.poll(() => page.evaluate(() => window.fixtureEncoding.completed)).toBe(1);
        await expect(page.locator(".media-progress")).toHaveCount(0);
        expect(fixtureState.mediaUploads).toBe(0);
        expect(fixtureState.publishRequests).toEqual([]);
        if (change === "selection") {
          await expect(page.getByAltText("B.png", { exact: true })).toBeVisible();
          await expect(page.locator(".media-meta")).toContainText("1x1");
          if (kind === "crop") {
            // Dribbble requires a valid current crop before an upload.
            expect(uploadBody).toBe("");
          } else {
            await page.getByRole("button", { name: "Publish draft", exact: true }).click();
            await expect.poll(() => fixtureState.mediaUploads).toBe(1);
            expect(uploadBody).toContain('filename="B.png"');
            expect(uploadBody).not.toContain("A-compressed.jpg");
          }
        } else if (change !== "unmount") {
          await expect(page.getByText("Drop or paste a file", { exact: true })).toBeVisible();
          await expect(page.getByRole("button", { name: "Remove media file" })).toHaveCount(0);
        }
      } finally {
        await page.evaluate(() => window.fixtureEncoding.release());
        await expect.poll(() => page.evaluate(() => window.fixtureEncoding.pending)).toBe(0);
      }
    });
  }
}

for (const theme of ["light", "dark"] as const) {
  for (const viewport of [{ width: 390, height: 844 }, { width: 1440, height: 900 }]) {
    for (const scale of [1, 2]) {
      test(`media crop editor ${theme} ${viewport.width}x${viewport.height} font ${scale * 100}%`, async ({ page }) => {
        await page.setViewportSize(viewport);
        await page.route("**/api/config", (route) => route.fulfill({ json: dribbble }));
        await page.addInitScript((mode) => localStorage.setItem("crossposter:theme", mode), theme);
        await page.goto("/");
        await expect(page.getByRole("checkbox")).toBeChecked();
        await page.getByLabel("Title", { exact: true }).fill("Fixture crop title");
        await page.getByLabel("Post", { exact: true }).fill("Fixture crop description");
        const png = await page.evaluate(() => {
          const canvas = document.createElement("canvas"); canvas.width = 1200; canvas.height = 600;
          const context = canvas.getContext("2d")!;
          context.fillStyle = "#dae8dc"; context.fillRect(0, 0, 1200, 600);
          context.fillStyle = "#217341"; context.fillRect(200, 100, 800, 400);
          return canvas.toDataURL("image/png").split(",")[1];
        });
        await page.locator("#mediaFile").setInputFiles({ name: "wide-fixture.png", mimeType: "image/png", buffer: Buffer.from(png, "base64") });
        await expect(page.locator(".media-meta")).toContainText("1200x600");
        await page.getByRole("button", { name: "Crop for Dribbble" }).click();
        await expect(page.getByLabel("Drag Dribbble crop preview")).toBeVisible();
        const fonts = await page.evaluate((fontScale) => {
          const originals = Array.from(document.querySelectorAll<HTMLElement>("body, body *"))
            .filter((element) => element instanceof HTMLElement)
            .map((element) => [element, parseFloat(getComputedStyle(element).fontSize)] as const);
          for (const [element, size] of originals) element.style.fontSize = `${size * fontScale}px`;
          const panel = document.querySelector<HTMLElement>(".crop-panel")!;
          return { body: getComputedStyle(document.body).fontSize, crop: getComputedStyle(panel).fontSize,
            panelWidth: panel.clientWidth, panelScrollWidth: panel.scrollWidth };
        }, scale);
        await page.evaluate(() => document.fonts.ready);
        await page.evaluate(() => window.scrollTo(0, 0));
        mkdirSync(artifactRoot, { recursive: true });
        const filename = `${theme}-${viewport.width}x${viewport.height}-font${scale * 100}-media.png`;
        await page.screenshot({ path: path.join(artifactRoot, filename), fullPage: true, animations: "disabled" });
        writeFileSync(path.join(artifactRoot, `${filename}.json`), JSON.stringify({ filename, theme, viewport, fontScale: scale,
          computed: fonts, capturedAt: new Date().toISOString(), sha256: createHash("sha256").update(readFileSync(path.join(artifactRoot, filename))).digest("hex"),
          fontMethod: "Each element's baseline computed font-size times scale; unchanged viewport/device/page zoom", inspected: false }, null, 2));
        await page.getByRole("button", { name: "Apply crop" }).focus();
        await page.keyboard.press("Enter");
        await expect(page.getByAltText("wide-fixture-dribbble-800x600.jpg", { exact: true })).toBeVisible();
        await expect(page.locator(".media-meta")).toContainText("800x600");
        await expect(page.locator(".crop-panel")).toHaveCount(0);
      });
    }
  }
}
