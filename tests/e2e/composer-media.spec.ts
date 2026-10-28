import { test, expect, fixturePng } from "./fixtures";

test("browser draft media migrates from the legacy IndexedDB, survives reload, and is removed", async ({ page, fixtureState }) => {
  await page.goto("/");
  await expect(page.getByText("Profile: Fixture Bluesky")).toBeVisible();
  await expect.poll(() => fixtureState.draft.platforms).toEqual(["bluesky"]);
  await page.evaluate(async (bytes) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("personal-crossposter-drafts", 1);
      request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains("media")) request.result.createObjectStore("media", { keyPath: "id" }); };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const transaction = db.transaction("media", "readwrite");
    transaction.objectStore("media").put({ id: "compose-media", blob: new Blob([new Uint8Array(bytes)], { type: "image/png" }), name: "legacy-fixture.png", type: "image/png", lastModified: 123 });
    await new Promise<void>((resolve, reject) => { transaction.oncomplete = () => resolve(); transaction.onerror = () => reject(transaction.error); });
    db.close();
  }, [...fixturePng]);
  await page.reload();
  await expect(page.getByAltText("legacy-fixture.png")).toBeVisible();
  await expect(page.locator(".media-meta")).toContainText("1x1");
  await expect.poll(async () => page.evaluate(async () => {
    const read = (name: string) => new Promise<unknown>((resolve, reject) => {
      const open = indexedDB.open(name, 1);
      open.onsuccess = () => {
        const db = open.result;
        const request = db.transaction("media").objectStore("media").get("compose-media");
        request.onsuccess = () => { resolve(request.result ? { name: request.result.name, type: request.result.type, lastModified: request.result.lastModified } : null); db.close(); };
        request.onerror = () => { reject(request.error); db.close(); };
      };
      open.onerror = () => reject(open.error);
    });
    return { current: await read("crossposter-drafts"), legacy: await read("personal-crossposter-drafts") };
  })).toEqual({ current: { name: "legacy-fixture.png", type: "image/png", lastModified: 123 }, legacy: null });
  await page.reload();
  await expect(page.getByAltText("legacy-fixture.png")).toBeVisible();
  await page.getByRole("button", { name: "Remove media file" }).click();
  await expect(page.getByText("Drop or paste a file", { exact: true })).toBeVisible();
  // Let the asynchronous IndexedDB delete finish before testing a new load.
  await expect.poll(async () => page.evaluate(async () => new Promise<boolean>((resolve, reject) => {
    const open = indexedDB.open("crossposter-drafts", 1);
    open.onsuccess = () => {
      const db = open.result;
      const get = db.transaction("media").objectStore("media").get("compose-media");
      get.onsuccess = () => { resolve(!get.result); db.close(); };
      get.onerror = () => { reject(get.error); db.close(); };
    };
    open.onerror = () => reject(open.error);
  }))).toBe(true);
  await page.reload();
  await expect(page.getByText("Drop or paste a file", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Remove media file" })).toHaveCount(0);
});

test("server-staged media resolves the current-origin path and restores compose text", async ({ page, fixtureState }) => {
  fixtureState.draft = {
    title: "Staged fixture", text: "Server fixture with media", linkUrl: "", platforms: ["bluesky"],
    targets: [{ id: "bluesky:fixture", platform: "bluesky", profileId: "fixture" }],
    updatedAt: "2026-10-28T12:00:00Z",
    media: { id: "fixture-media", filename: "staged-fixture.png", contentType: "image/png", size: fixturePng.length, kind: "image", url: "http://0.0.0.0:3000/api/media/fixture-media" }
  };
  await page.goto("/");
  await expect(page.getByPlaceholder("Write the post once.")).toHaveValue("Server fixture with media");
  await expect(page.getByAltText("staged-fixture.png")).toBeVisible();
  await expect(page.locator(".media-meta")).toContainText("1x1");
  await page.getByRole("button", { name: "Publish draft", exact: true }).click();
  await expect(page.getByLabel("Latest publish result")).toContainText("Fixture outcome unknown");
  expect(fixtureState.publishRequests).toEqual([expect.objectContaining({ mediaId: "fixture-media", text: "Server fixture with media" })]);
});
