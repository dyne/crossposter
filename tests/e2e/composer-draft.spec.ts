import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test, expect, fixturePng } from "./fixtures";

const artifactRoot = path.resolve(process.env.DRAFT_VISUAL_DIR || "output/playwright/composer-draft");
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

test("typing and target selection survive a held initial draft response", async ({ page, fixtureState }) => {
  const held = gate();
  let requested = false;
  let settled = false;
  await page.route("**/api/draft", async (route) => {
    if (route.request().method() !== "GET") { await route.fallback(); return; }
    requested = true;
    await held.promise;
    await route.fulfill({ json: { draft: { title: "Old title", text: "Old post", linkUrl: "https://old.example", platforms: ["bluesky"], updatedAt: "2026-01-01T00:00:00Z" }, revision: "fixture-0" } });
    settled = true;
  });
  try {
    await page.goto("/");
    await expect.poll(() => requested).toBe(true);
    await expect(page.getByLabel("Draft persistence")).toContainText("Loading draft…");
    await expect(page.getByText("Profile: Fixture Bluesky")).toBeVisible();
    await page.getByLabel("Title", { exact: true }).fill("My title");
    await page.getByLabel("Link", { exact: true }).fill("https://my.example");
    await page.getByLabel("Post", { exact: true }).fill("My post");
    await page.getByRole("button", { name: "None", exact: true }).click();
    held.release();
    await expect.poll(() => fixtureState.draft.text).toBe("My post");
    await expect(page.getByLabel("Draft persistence")).toContainText("Draft saved");
    await expect(page.getByLabel("Title", { exact: true })).toHaveValue("My title");
    await expect(page.getByLabel("Link", { exact: true })).toHaveValue("https://my.example");
    await expect(page.getByLabel("Post", { exact: true })).toHaveValue("My post");
    await expect(page.getByRole("checkbox")).not.toBeChecked();
    expect(fixtureState.draft).toMatchObject({ title: "My title", text: "My post", linkUrl: "https://my.example", targets: [] });
  } finally { held.release(); await expect.poll(() => !requested || settled).toBe(true); }
});

test("a held media import cannot replace typing or media selected while loading", async ({ page, fixtureState }) => {
  fixtureState.draft = { title: "Server title", text: "Server post", linkUrl: "", platforms: ["bluesky"], updatedAt: "2026-01-01T00:00:00Z",
    media: { id: "fixture-media", filename: "old.png", contentType: "image/png", size: fixturePng.length, kind: "image", url: "/api/media/fixture-media" } };
  const held = gate(); let requested = false; let settled = false;
  await page.route("**/api/media/fixture-media", async (route) => {
    requested = true; await held.promise;
    await route.fulfill({ body: fixturePng, contentType: "image/png" }); settled = true;
  });
  try {
    await page.goto("/");
    await expect.poll(() => requested).toBe(true);
    await expect(page.getByLabel("Title", { exact: true })).toHaveValue("Server title");
    await page.getByLabel("Post", { exact: true }).fill("Edited during media import");
    await page.locator("#mediaFile").setInputFiles({ name: "new.png", mimeType: "image/png", buffer: fixturePng });
    await expect(page.getByAltText("new.png")).toBeVisible();
    held.release();
    await expect.poll(() => fixtureState.draft.text).toBe("Edited during media import");
    await expect(page.getByLabel("Draft persistence")).toContainText("Draft saved");
    await expect(page.getByLabel("Post", { exact: true })).toHaveValue("Edited during media import");
    await expect(page.getByAltText("new.png")).toBeVisible();
    await expect(page.getByAltText("old.png")).toHaveCount(0);
    expect(fixtureState.draft.text).toBe("Edited during media import");
    expect(fixtureState.draft.media).toBeUndefined();
  } finally { held.release(); await expect.poll(() => !requested || settled).toBe(true); }
});

test("valid server text survives a failed media import and IndexedDB recovery", async ({ page, fixtureState }) => {
  fixtureState.draft = { title: "Valid server title", text: "Valid server text", linkUrl: "", platforms: ["bluesky"], updatedAt: "2026-01-01T00:00:00Z",
    media: { id: "fixture-media", filename: "old.png", contentType: "image/png", size: fixturePng.length, kind: "image", url: "/api/media/fixture-media" } };
  await page.addInitScript(() => {
    localStorage.setItem("crossposter:compose-draft-server-revision:v1", "fixture-0");
    localStorage.setItem("crossposter:compose-draft:v1", JSON.stringify({ text: "Obsolete browser text", updatedAt: "2099-01-01T00:00:00Z" }));
    Object.defineProperty(window, "indexedDB", { get() { throw new Error("Fixture IndexedDB unavailable"); } });
  });
  await page.route("**/api/media/fixture-media", (route) => route.fulfill({ status: 500, body: "Fixture media unavailable" }));
  await page.goto("/");
  await expect(page.getByLabel("Post", { exact: true })).toHaveValue("Valid server text");
  await expect(page.getByLabel("Draft persistence")).toContainText("Fixture IndexedDB unavailable");
  await expect.poll(() => fixtureState.draftRevision).toBeGreaterThan(0);
  expect(fixtureState.draft.text).toBe("Valid server text");
  expect(fixtureState.draft.media?.id).toBe("fixture-media");
});

for (const theme of ["light", "dark"] as const) {
  for (const viewport of [{ width: 390, height: 844 }, { width: 1440, height: 900 }]) {
    for (const scale of [1, 2]) {
      test(`draft conflict recovery ${theme} ${viewport.width}x${viewport.height} font ${scale * 100}%`, async ({ page, context, fixtureState }) => {
        await page.setViewportSize(viewport);
        await context.grantPermissions(["clipboard-read", "clipboard-write"]);
        await page.addInitScript((mode) => localStorage.setItem("crossposter:theme", mode), theme);
        await page.goto("/");
        await expect(page.getByRole("checkbox")).toBeChecked();
        await page.getByLabel("Title", { exact: true }).fill("My unsaved title");
        await page.getByLabel("Link", { exact: true }).fill("https://fixture.example/article");
        await page.getByLabel("Post", { exact: true }).fill("Initial shared draft");
        await expect.poll(() => fixtureState.draft.text).toBe("Initial shared draft");
        fixtureState.draft = { ...fixtureState.draft, text: "Newer MCP draft", updatedAt: "2026-11-02T15:00:00Z" };
        fixtureState.draftRevision++;
        await page.getByLabel("Post", { exact: true }).fill("Keep this unsaved browser post.");
        const status = page.getByLabel("Draft persistence");
        await expect(status).toContainText("Draft conflict");
        await expect(status.getByRole("status").first()).toHaveAttribute("aria-live", "polite");
        await expect(page.getByRole("button", { name: "Reload shared draft" })).toHaveCount(0);
        await status.getByRole("button", { name: "Copy draft text" }).focus();
        await page.keyboard.press("Enter");
        await expect(status).toContainText("Draft text copied.");
        expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("Title: My unsaved title\nLink: https://fixture.example/article\n\nKeep this unsaved browser post.");
        const fonts = await page.evaluate((fontScale) => {
          const original = Array.from(document.querySelectorAll<HTMLElement>("body, body *"))
            .filter((element) => element instanceof HTMLElement)
            .map((element) => [element, parseFloat(getComputedStyle(element).fontSize)] as const);
          for (const [element, size] of original) element.style.fontSize = `${size * fontScale}px`;
          const status = document.querySelector<HTMLElement>(".draft-status")!;
          return { body: getComputedStyle(document.body).fontSize, status: getComputedStyle(status).fontSize,
            color: getComputedStyle(status).color, background: getComputedStyle(document.querySelector(".compose-panel")!).backgroundColor,
            statusWidth: status.clientWidth, statusScrollWidth: status.scrollWidth };
        }, scale);
        expect(fonts.statusScrollWidth).toBeLessThanOrEqual(fonts.statusWidth);
        await page.evaluate(() => document.fonts.ready);
        await page.evaluate(() => window.scrollTo(0, 0));
        mkdirSync(artifactRoot, { recursive: true });
        const filename = `${theme}-${viewport.width}x${viewport.height}-font${scale * 100}-conflict.png`;
        await page.screenshot({ path: path.join(artifactRoot, filename), fullPage: true, animations: "disabled" });
        const bytes = readFileSync(path.join(artifactRoot, filename));
        writeFileSync(path.join(artifactRoot, `${filename}.json`), JSON.stringify({ filename, viewport, theme, fontScale: scale,
          computed: fonts, capturedAt: new Date().toISOString(), sha256: createHash("sha256").update(bytes).digest("hex"),
          fontMethod: "Each element's baseline computed font-size times scale; unchanged viewport/device/page zoom", inspected: false }, null, 2));
        const downloaded = page.waitForEvent("download");
        await status.getByRole("link", { name: "Download text" }).focus();
        await page.keyboard.press("Enter");
        const download = await downloaded;
        expect(download.suggestedFilename()).toBe("crossposter-draft.txt");
        expect(readFileSync((await download.path())!, "utf8")).toContain("Keep this unsaved browser post.");
        expect(fixtureState.draft.text).toBe("Newer MCP draft");
        await status.getByRole("button", { name: "Reload shared draft" }).focus();
        await page.keyboard.press("Enter");
        await expect(page.getByLabel("Post", { exact: true })).toHaveValue("Newer MCP draft");
      });
    }
  }
}
