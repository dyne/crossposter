import { test, expect, fixturePng } from "./fixtures";

test("keyboard compose/target selection/upload/publish restores mixed history and clears it", async ({ page, fixtureState }) => {
  fixtureState.publishResponse = {
    publishedPost: {
      id: "fixture-published", createdAt: "2026-10-28T12:00:00Z",
      title: "Fixture keyboard title", text: "Fixture keyboard post", platforms: ["bluesky"],
      media: { id: "fixture-media", filename: "published-fixture.png", contentType: "image/png", kind: "image", size: fixturePng.length, url: "/api/media/fixture-media" },
      results: [
        { platform: "bluesky", targetId: "bluesky:fixture", ok: true, message: "Fixture published", url: "https://fixture.example/post" },
        { platform: "bluesky", targetId: "bluesky:unknown", profileLabel: "Fixture uncertain", ok: false, uncertain: true, message: "Fixture unknown; check profile" },
        { platform: "bluesky", targetId: "bluesky:failed", profileLabel: "Fixture failed", ok: false, message: "Fixture rejected" }
      ]
    }
  };
  await page.goto("/");
  await expect(page.getByText("Profile: Fixture Bluesky")).toBeVisible();
  await expect(page.getByRole("checkbox")).toBeChecked();
  const title = page.getByLabel("Title", { exact: true });
  await title.focus();
  await title.fill("Fixture keyboard title");
  await title.press("Tab");
  await expect(page.getByLabel("Link", { exact: true })).toBeFocused();
  await page.getByLabel("Link", { exact: true }).press("Tab");
  const text = page.getByPlaceholder("Write the post once.");
  await expect(text).toBeFocused();
  await text.fill("Fixture keyboard post");
  await text.press("Tab");
  await expect(page.getByLabel("Drop or paste media file")).toBeFocused();
  const checkbox = page.getByRole("checkbox");
  await checkbox.focus();
  await checkbox.press("Space");
  await expect(checkbox).not.toBeChecked();
  await expect(page.getByRole("button", { name: "Publish draft", exact: true })).toBeDisabled();
  await checkbox.press("Space");
  await expect(checkbox).toBeChecked();
  await page.locator("#mediaFile").setInputFiles({ name: "fixture.png", mimeType: "image/png", buffer: fixturePng });
  await expect(page.getByAltText("fixture.png")).toBeVisible();
  await expect.poll(() => fixtureState.draft.text).toBe("Fixture keyboard post");
  await page.getByRole("button", { name: "Publish draft", exact: true }).focus();
  await page.keyboard.press("Enter");
  const history = page.getByLabel("Published posts");
  await expect(history).toContainText("1/3 ok · 1 check");
  await expect(history.getByAltText("published-fixture.png")).toBeVisible();
  await expect(history.getByTitle("Fixture unknown; check profile")).toHaveClass(/unknown/);
  expect(fixtureState.mediaUploads).toBe(1);
  expect(fixtureState.publishRequests).toEqual([expect.objectContaining({ text: "Fixture keyboard post", mediaId: "fixture-media" })]);
  await page.reload();
  await expect(page.getByLabel("Published posts")).toContainText("Fixture keyboard post");
  await page.getByRole("button", { name: "Clear history" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByText("No published post yet", { exact: true })).toBeVisible();
  expect(fixtureState.publishedPosts).toEqual([]);
});

test("keyboard schedule controls close and confirm the fixture draft", async ({ page, fixtureState }) => {
  await page.clock.setFixedTime(new Date("2026-10-28T12:00:00Z"));
  await page.goto("/");
  await expect(page.getByText("Profile: Fixture Bluesky")).toBeVisible();
  await expect(page.getByRole("checkbox")).toBeChecked();
  await page.getByPlaceholder("Write the post once.").fill("Fixture keyboard schedule");
  const open = page.getByRole("button", { name: "Schedule draft", exact: true });
  await open.focus();
  await page.keyboard.press("Enter");
  const close = page.getByRole("button", { name: "Close schedule popup" });
  await close.focus();
  await page.keyboard.press("Enter");
  await expect(close).toHaveCount(0);
  await open.focus();
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: "30 min", exact: true }).focus();
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: "Confirm schedule", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("status").filter({ hasText: "Scheduled for" })).toBeVisible();
  expect(fixtureState.scheduledPosts).toHaveLength(1);
  expect(fixtureState.scheduledPosts[0]).toMatchObject({ text: "Fixture keyboard schedule", scheduledFor: "2026-10-28T12:30:00.000Z" });
});
